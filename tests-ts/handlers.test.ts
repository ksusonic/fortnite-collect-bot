import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import type { Session } from "../src/bot/db";
import {
  registerHandlers,
  buildWeeklyView,
  appendTeamAnalysis,
  computeTeamDeltas,
} from "../src/bot/handlers";

vi.mock("@vercel/connect", () => ({
  getToken: vi.fn().mockRejectedValue(new Error("connection missing")),
}));
vi.mock("../src/bot/storage", () => ({
  getRoastState: () => ({ history: [], message_ids: [], last_roast: null }),
}));

const state = vi.hoisted(() => ({
  sessions: new Map<string, Session>(),
  saveResponse: vi.fn(),
  snapshot: vi.fn(),
  callbackError: null as { error_code: number; description: string } | null,
  calls: [] as { method: string; payload: Record<string, unknown> }[],
}));
vi.mock("../src/bot/db", () => ({
  getSessions: () => state.sessions,
  load_session: async () => null,
  save_response: (...args: unknown[]) => state.saveResponse(...args),
  get_snapshot_before: (...args: unknown[]) => state.snapshot(...args),
  get_fort_cooldown: async () => null,
  set_fort_cooldown: async () => undefined,
  get_chat_participants: async () => [],
  get_fort_title: async () => null,
  save_session: async () => undefined,
  newSession: (fields: Partial<Session>) => ({
    go_players: new Map(),
    pass_players: new Map(),
    player_slots: new Map(),
    tagged_users: new Map(),
    is_complete: false,
    is_closed: false,
    is_expired: false,
    completed_at: null,
    llm_header: null,
    fort_title: null,
    ...fields,
  }),
}));
vi.mock("../src/bot/work", () => ({
  valueCheckpoint: async (_name: string, factory: () => unknown) => factory(),
  externalCheckpoint: async (_name: string, factory: () => Promise<unknown>) =>
    factory(),
}));
function session(): Session {
  return {
    chat_id: -100,
    message_id: 20,
    initiator_id: 1,
    initiator_name: "one",
    style: 0,
    created_at: Date.now() / 1000,
    completed_at: null,
    is_complete: true,
    is_closed: false,
    is_expired: false,
    time_slots: ["now", "30"],
    go_players: new Map([
      [1, "one"],
      [2, "two"],
      [3, "three"],
      [4, "four"],
      [5, "five"],
    ]),
    pass_players: new Map(),
    player_slots: new Map(),
    tagged_users: new Map(),
    llm_header: null,
    fort_title: null,
  };
}
function bot(): Bot {
  const instance = new Bot("123:fake", {
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "Fort",
      username: "fort_test_bot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  instance.api.config.use(async (_prev, method, payload) => {
    state.calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "answerCallbackQuery" && state.callbackError)
      return { ok: false, ...state.callbackError } as never;
    if (method === "sendMessage")
      return {
        ok: true,
        result: {
          message_id: 20,
          date: 1,
          chat: { id: -100, type: "supergroup", title: "friends" },
          text: "collection",
        },
      } as never;
    return { ok: true, result: true } as never;
  });
  registerHandlers(instance);
  return instance;
}
function callback(id: number, data: string): Update {
  return {
    update_id: 1,
    callback_query: {
      id: "callback",
      chat_instance: "chat",
      from: { id, is_bot: false, first_name: `user${id}` },
      data,
      message: {
        message_id: 20,
        date: 1,
        chat: { id: -100, type: "supergroup", title: "friends" },
      },
    },
  };
}
beforeEach(() => {
  state.sessions.clear();
  state.calls = [];
  state.callbackError = null;
  state.saveResponse.mockReset();
  state.saveResponse.mockResolvedValue(undefined);
  state.snapshot.mockReset();
});
it("deletes the command after saving the gathering and before pinning or Grok", async () => {
  await bot().handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: -100, type: "supergroup", title: "friends" },
      from: { id: 1, is_bot: false, first_name: "one" },
      text: "/fort",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    },
  });
  expect(state.sessions.has("-100:20")).toBe(true);
  expect(state.calls.map((call) => call.method)).toEqual([
    "sendMessage",
    "deleteMessage",
    "pinChatMessage",
  ]);
});
describe("gathering callbacks", () => {
  it("finishes a persisted response when Telegram rejects an expired acknowledgement", async () => {
    const current = session();
    state.sessions.set("-100:20", current);
    state.callbackError = {
      error_code: 400,
      description:
        "Bad Request: query is too old and response timeout expired or query ID is invalid",
    };
    await bot().handleUpdate(callback(2, "pass"));
    expect(current.pass_players.get(2)).toBe("user2");
    expect([...current.go_players.keys()]).toEqual([1, 3, 4, 5]);
    expect(state.saveResponse).toHaveBeenCalledTimes(1);
    expect(state.calls.map((call) => call.method)).toEqual([
      "editMessageText",
      "answerCallbackQuery",
    ]);
    // The same terminal rejection is harmless on an early-return branch too.
    await bot().handleUpdate(callback(2, "pass"));
    expect(state.saveResponse).toHaveBeenCalledTimes(1);
  });
  it.each([
    [400, "Bad Request: message is too long"],
    [403, "Forbidden"],
    [429, "Too Many Requests: retry after 1"],
    [500, "Internal Server Error"],
  ])(
    "propagates other acknowledgement failures (%s)",
    async (error_code, description) => {
      state.sessions.set("-100:20", session());
      state.callbackError = { error_code, description };
      await expect(bot().handleUpdate(callback(2, "pass"))).rejects.toThrow(
        description,
      );
    },
  );
  it("promotes the earliest reserve when a squad member passes", async () => {
    const current = session();
    state.sessions.set("-100:20", current);
    await bot().handleUpdate(callback(2, "pass"));
    expect([...current.go_players.keys()]).toEqual([1, 3, 4, 5]);
    expect(current.pass_players.get(2)).toBe("user2");
    expect(state.saveResponse).toHaveBeenCalledWith(
      20,
      2,
      "user2",
      "pass",
      expect.objectContaining({ chat_id: -100 }),
    );
    expect(state.calls.some((call) => call.method === "editMessageText")).toBe(
      true,
    );
  });
  it("changing readiness preserves FIFO position in the reserve", async () => {
    const current = session();
    current.go_players.set(6, "six");
    state.sessions.set("-100:20", current);
    await bot().handleUpdate(callback(5, "slot:30"));
    expect([...current.go_players.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(current.player_slots.get(5)).toMatch(/^\d\d:\d\d$/);
    expect(
      state.calls.find((call) => call.method === "answerCallbackQuery")?.payload
        .text,
    ).toContain("резерве №1");
  });
  it("rejects excess reserve players without modifying state", async () => {
    const current = session();
    for (let id = 6; id <= 8; id++) current.go_players.set(id, String(id));
    state.sessions.set("-100:20", current);
    await bot().handleUpdate(callback(9, "go"));
    expect(current.go_players.size).toBe(8);
    expect(state.saveResponse).not.toHaveBeenCalled();
    expect(
      state.calls.find((call) => call.method === "answerCallbackQuery")?.payload
        .text,
    ).toBe("Резерв заполнен.");
  });
  it("restores invocation state and propagates persistence failures", async () => {
    const current = session();
    state.sessions.set("-100:20", current);
    state.saveResponse.mockRejectedValue(new Error("database unavailable"));
    await expect(bot().handleUpdate(callback(2, "pass"))).rejects.toThrow(
      "database unavailable",
    );
    expect([...current.go_players.keys()]).toEqual([1, 2, 3, 4, 5]);
    expect(current.pass_players.size).toBe(0);
    expect(state.calls).toHaveLength(0);
  });
});
it("excludes missing and inactive weekly baselines from rankings", () => {
  const mode = {
    matches: 100,
    wins: 10,
    kills: 200,
    kd: 2,
    win_rate: 0.1,
    minutes_played: 1000,
  };
  const successes = [1, 2, 3].map(
    (id) =>
      [
        {
          chat_id: -100,
          user_id: id,
          user_name: String(id),
          linked_at: 1,
          epic_name: String(id),
          epic_account_id: String(id),
        },
        {
          epic_name: String(id),
          epic_account_id: String(id),
          overall: mode,
          solo: null,
          duo: null,
          squad: mode,
          fetched_at: 1,
          image_url: null,
        },
      ] as Parameters<typeof buildWeeklyView>[0][number],
  );
  const [weekly, missing] = buildWeeklyView(
    successes,
    new Map([
      ["1", [5, 2, 12, 3]],
      ["2", [0, 0, 0, 0]],
    ]),
  );
  expect(weekly).toHaveLength(1);
  expect(weekly[0]![1].overall.matches).toBe(5);
  expect(missing.map((entry) => entry[1])).toEqual([
    "не играл за неделю",
    "нет данных за неделю",
  ]);
});
it("escapes analysis without splitting HTML entities at the message limit", () => {
  const result = appendTeamAnalysis("x".repeat(3950), "<&".repeat(200));
  expect(result.length).toBeLessThanOrEqual(4096);
  expect(result).not.toMatch(/&(amp|lt)?<\/i>/);
});
it("bounds daily and weekly baselines and skips counters that rolled back", async () => {
  const mode = {
    matches: 100,
    wins: 10,
    kills: 200,
    kd: 2,
    win_rate: 0.1,
    minutes_played: 1000,
  };
  const successes: Parameters<typeof computeTeamDeltas>[0] = [
    [
      {
        chat_id: -100,
        user_id: 1,
        user_name: "one",
        linked_at: 1,
        epic_name: "one",
        epic_account_id: "one",
      },
      {
        epic_name: "one",
        epic_account_id: "one",
        overall: mode,
        solo: null,
        duo: null,
        squad: mode,
        fetched_at: 1,
        image_url: null,
      },
    ],
  ];
  state.snapshot
    .mockResolvedValueOnce({
      overall_matches: 95,
      overall_wins: 9,
      overall_kills: 188,
      overall_deaths_est: 96,
    })
    .mockResolvedValueOnce({
      overall_matches: 200,
      overall_wins: 20,
      overall_kills: 400,
      overall_deaths_est: 200,
    });
  const [daily, weekly] = await computeTeamDeltas(successes, 1000000);
  expect(daily.get("one")).toEqual([5, 1, 12, 3]);
  expect(weekly.size).toBe(0);
  expect(state.snapshot).toHaveBeenNthCalledWith(
    1,
    "one",
    1000000 - 86400,
    1000000 - 129600,
  );
  expect(state.snapshot).toHaveBeenNthCalledWith(
    2,
    "one",
    1000000 - 604800,
    1000000 - 864000,
  );
});
