import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const checkpointState = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
}));
const invocation = vi.hoisted(() => ({
  signal: undefined as AbortSignal | undefined,
}));
const saveSnapshot = vi.hoisted(() => vi.fn());
vi.mock("../src/bot/work", () => ({
  externalCheckpoint: async (key: string, action: () => Promise<unknown>) => {
    if (checkpointState.saved.has(key)) return checkpointState.saved.get(key);
    const result = JSON.parse(JSON.stringify(await action()));
    checkpointState.saved.set(key, result);
    return result;
  },
}));
vi.mock("../src/bot/storage", () => ({ maybeCurrent: () => invocation }));
vi.mock("../src/bot/transport", () => ({
  scopedFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
vi.mock("../src/bot/db", () => ({ save_squad_snapshot: saveSnapshot }));
beforeEach(() => {
  checkpointState.saved.clear();
  saveSnapshot.mockReset();
  invocation.signal = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
import {
  callApi,
  fetchStats,
  EpicNameNotFound,
  FortniteUnavailable,
  StatsEmpty,
  StatsPrivate,
  toPlayerStats,
  type RawPlayerStats,
} from "../src/bot/fortnite";

const raw: RawPlayerStats = {
  account: { id: "account", name: "Epic" },
  image: "https://example.com/image.png",
  stats: {
    all: {
      overall: {
        matches: 10,
        wins: 2,
        kills: 40,
        kd: 4,
        winRate: 0.2,
        minutesPlayed: 120,
      },
      solo: {
        matches: 0,
        wins: 0,
        kills: 0,
        kd: 0,
        winRate: 0,
        minutesPlayed: 0,
      },
    },
  },
};
describe("Fortnite API parity", () => {
  it("normalizes provider percentages and prevents lifetime from entering durable season fetches", async () => {
    const withPercent = {
      ...raw,
      stats: { all: { overall: { ...raw.stats!.all!.overall!, winRate: 20 } } },
    };
    expect(toPlayerStats(withPercent, false).overall.win_rate).toBe(0.2);
    await expect(
      fetchStats({ account_id: "account", time_window: "lifetime" }),
    ).rejects.toThrow("require season window");
  });

  it("maps overall stats and optional modes/image with normalized win-rate ratios", () => {
    expect(toPlayerStats(raw, true, 100)).toEqual({
      epic_account_id: "account",
      epic_name: "Epic",
      overall: {
        matches: 10,
        wins: 2,
        kills: 40,
        kd: 4,
        win_rate: 0.2,
        minutes_played: 120,
      },
      solo: null,
      duo: null,
      squad: null,
      fetched_at: 100,
      image_url: "https://example.com/image.png",
    });
    expect(toPlayerStats(raw, false, 100).image_url).toBeNull();
  });
  it("retains account identity on empty profiles", () => {
    try {
      toPlayerStats({ account: raw.account, stats: null }, false);
      throw new Error("expected StatsEmpty");
    } catch (err) {
      expect(err).toBeInstanceOf(StatsEmpty);
      expect((err as StatsEmpty).epic_account_id).toBe("account");
    }
  });
  it("requests exact name and account-id routes, season and provider card", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: raw }), { status: 200 }),
    );
    await callApi({ name: "Epic & Name", with_image: true }, fetcher);
    const nameUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(nameUrl.pathname).toBe("/v2/stats/br/v2");
    expect(nameUrl.searchParams.get("name")).toBe("Epic & Name");
    expect(nameUrl.searchParams.get("timeWindow")).toBe("season");
    expect(nameUrl.searchParams.get("image")).toBe("all");
    await callApi({ account_id: "account" }, fetcher);
    const idUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(idUrl.pathname).toBe("/v2/stats/br/v2/account");
    expect(idUrl.searchParams.get("image")).toBe("none");
    expect(idUrl.searchParams.has("name")).toBe(false);
  });
  for (const [status, cls] of [
    [404, EpicNameNotFound],
    [403, StatsPrivate],
    [429, FortniteUnavailable],
    [500, FortniteUnavailable],
  ] as const)
    it(`maps HTTP ${status} to durable domain errors`, async () => {
      await expect(
        callApi({ account_id: "id" }, async () => new Response("", { status })),
      ).rejects.toBeInstanceOf(cls);
    });
  it("cancels error bodies before returning domain errors", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), {
      status: 429,
    });
    await expect(
      callApi({ account_id: "id" }, async () => response),
    ).rejects.toThrow("rate limited");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid lookup selectors before external I/O", async () => {
    const fetcher = vi.fn();
    await expect(callApi({}, fetcher)).rejects.toThrow("exactly one");
    await expect(
      callApi({ name: "x", account_id: "id" }, fetcher),
    ).rejects.toThrow("exactly one");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("maps network failures to retryable provider unavailability", async () => {
    await expect(
      callApi({ account_id: "id" }, async () => {
        throw new TypeError("network");
      }),
    ).rejects.toThrow("network error");
  });
});

describe("Fortnite invocation and recovery", () => {
  it("propagates invocation cancellation while receiving the response body", async () => {
    const controller = new AbortController();
    invocation.signal = controller.signal;
    let receivedSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_url, options) => {
      receivedSignal = options?.signal;
      return {
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            receivedSignal!.addEventListener(
              "abort",
              () => reject(receivedSignal!.reason),
              { once: true },
            );
            controller.abort();
          }),
      } as Response;
    };
    await expect(callApi({ account_id: "id" }, fetcher)).rejects.toThrow(
      "request aborted",
    );
    expect(receivedSignal!.aborted).toBe(true);
  });
  it("keeps the request timeout active until JSON body consumption finishes", async () => {
    vi.stubEnv("FORTNITE_REQUEST_TIMEOUT", "0.001");
    const fetcher: typeof fetch = async (_url, options) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            options!.signal!.addEventListener(
              "abort",
              () => reject(options!.signal!.reason),
              { once: true },
            );
          }),
      }) as Response;
    // AbortSignal.timeout uses an unref'ed native timer; Vitest owns the test timeout.
    await expect(callApi({ account_id: "id" }, fetcher)).rejects.toThrow(
      "timeout",
    );
  });
  it("replays a saved success without refetching or duplicating its snapshot", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: raw }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = await fetchStats({ account_id: "account", with_image: true });
    const second = await fetchStats({
      account_id: "account",
      with_image: true,
    });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).toHaveBeenCalledWith(
      "account",
      first.fetched_at,
      0,
      0,
      0,
      0,
      0,
      10,
      2,
      40,
      10,
      4,
    );
  });
  it("reconstructs a checkpointed empty-profile error with its Epic identity", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ data: { account: raw.account, stats: null } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchStats({ name: "Epic" })).rejects.toMatchObject({
      name: "StatsEmpty",
      epic_account_id: "account",
      epic_name: "Epic",
    });
    await expect(fetchStats({ name: "Epic" })).rejects.toMatchObject({
      name: "StatsEmpty",
      epic_account_id: "account",
      epic_name: "Epic",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).not.toHaveBeenCalled();
  });
  it("keeps image and text-only lookups distinct when replaying checkpoints", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: raw }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await fetchStats({ account_id: "account", with_image: false }))
        .image_url,
    ).toBeNull();
    expect(
      (await fetchStats({ account_id: "account", with_image: true })).image_url,
    ).toBe(raw.image);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
