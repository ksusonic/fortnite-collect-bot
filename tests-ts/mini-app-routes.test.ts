import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  discover: vi.fn(),
  profile: vi.fn(),
  link: vi.fn(),
  weekly: vi.fn(),
  gatherings: vi.fn(),
  analysis: vi.fn(),
}));
vi.mock("../src/bot/storage", () => ({
  invocation: async (_chat: unknown, load: () => Promise<unknown>) => load(),
}));
vi.mock("../src/mini-app/access", () => ({
  authorizeChat: mocks.authorize,
  discoverChats: mocks.discover,
}));
vi.mock("../src/bot/db", () => ({ get_chat_epic_links: mocks.link }));
vi.mock("../src/statistics/service", () => ({
  accountProfile: mocks.profile,
  weeklyReport: mocks.weekly,
  gatheringReport: mocks.gatherings,
  teamAnalysis: mocks.analysis,
  lockedChat: async (_chat: number, load: () => Promise<unknown>) => load(),
  failureReason: () => "Unavailable",
  FortniteError: class extends Error {},
}));
import { miniAppEndpoint } from "../src/mini-app/api";
import { HttpError } from "../src/bot/http";
function request(resource: string, query = "chat=-100", method = "GET") {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 7 }),
  });
  const secret = createHmac("sha256", "WebAppData")
    .update("test-token")
    .digest();
  params.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...params.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return new Request(`https://example.com/api/mini-app/${resource}?${query}`, {
    method,
    headers: { "x-telegram-init-data": params.toString() },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BOT_TOKEN", "test-token");
  mocks.authorize.mockResolvedValue({ id: -100 });
  mocks.weekly.mockResolvedValue({ facts: "facts" });
  mocks.link.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());
describe("Mini App API boundaries", () => {
  it("rejects missing initData before storage or services", async () => {
    const response = await miniAppEndpoint(
      new Request("https://example.com/api/mini-app/weekly?chat=-100"),
      "weekly",
    );
    expect(response.status).toBe(401);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.weekly).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });
  it("rejects a forged viewer or an expired session before authorization", async () => {
    const valid = request("weekly");
    const signed = valid.headers.get("x-telegram-init-data")!;
    const expired = new URLSearchParams({ auth_date: "1", user: '{"id":7}' });
    const secret = createHmac("sha256", "WebAppData")
      .update("test-token")
      .digest();
    expired.set(
      "hash",
      createHmac("sha256", secret)
        .update('auth_date=1\nuser={"id":7}')
        .digest("hex"),
    );
    for (const data of [signed.replace("%3A7", "%3A8"), expired.toString()]) {
      const response = await miniAppEndpoint(
        new Request(valid.url, {
          headers: { "x-telegram-init-data": data },
        }),
        "weekly",
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.weekly).not.toHaveBeenCalled();
    }
  });
  for (const resource of [
    "weekly",
    "profile",
    "gatherings",
    "analysis",
    "refresh",
  ])
    it(`checks membership before ${resource}, including cached data`, async () => {
      mocks.authorize.mockRejectedValue(new HttpError(403, "departed"));
      const response = await miniAppEndpoint(
        request(resource, "chat=-200", resource === "refresh" ? "POST" : "GET"),
        resource,
      );
      expect(response.status).toBe(403);
      expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), -200, 7);
      for (const fn of [
        mocks.profile,
        mocks.link,
        mocks.weekly,
        mocks.gatherings,
        mocks.analysis,
      ])
        expect(fn).not.toHaveBeenCalled();
    });
  it("limits player lookup to links in selected chat", async () => {
    const response = await miniAppEndpoint(
      request("profile", "chat=-100&user=88"),
      "profile",
    );
    expect(response.status).toBe(200);
    expect(mocks.link).toHaveBeenCalledWith(-100);
    expect(await response.json()).toMatchObject({ linked: false });
    expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("does not resolve an unrelated user through global Epic links", async () => {
    mocks.link.mockResolvedValue([{ user_id: 7, epic_account_id: "account" }]);
    const response = await miniAppEndpoint(
      request("profile", "chat=-100&user=88"),
      "profile",
    );
    expect(await response.json()).toMatchObject({ linked: false });
    expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("passes only validated windows to account cache", async () => {
    mocks.link.mockResolvedValue([
      {
        user_id: 7,
        epic_account_id: "account",
        user_name: "User",
      },
    ]);
    const response = await miniAppEndpoint(
      request("profile", "chat=-100&window=weekly"),
      "profile",
    );
    expect(response.status).toBe(400);
    expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("analysis uses server facts instead of supplied navigation parameters", async () => {
    mocks.analysis.mockResolvedValue(null);
    const response = await miniAppEndpoint(
      request("analysis", "chat=-100&facts=forged"),
      "analysis",
    );
    expect(response.status).toBe(200);
    expect(mocks.analysis).toHaveBeenCalledWith(-100, { facts: "facts" });
  });
});
