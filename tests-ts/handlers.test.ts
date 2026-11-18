import fixture from "./fixtures/messages-parity.json";
import { runStats } from "../src/bot/handlers/stats";
vi.mock("../src/bot/services/chat-access", async (original) => ({
  ...(await original<typeof import("../src/bot/services/chat-access")>()),
  isChatApproved: vi.fn().mockResolvedValue(true),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import type { Session } from "../src/bot/db";
import { GROUP_COMMANDS } from "../src/bot/commands";
import {
  registerHandlers,
  buildWeeklyView,
  appendTeamAnalysis,
} from "../src/bot/handlers";

vi.mock("@vercel/connect", () => ({
  getToken: vi.fn().mockRejectedValue(new Error("connection missing")),
}));
vi.mock("../src/bot/storage", () => ({
  maybeCurrent: () => undefined,
  getRoastState: () => ({ history: [], message_ids: [], last_roast: null }),
}));

const state = vi.hoisted(() => ({
  sessions: new Map<string, Session>(),
  saveResponse: vi.fn(),
  snapshot: vi.fn(),
  epicLinks: vi.fn(),
  stats: vi.fn(),
  provider: vi.fn(),
  analysis: vi.fn(),
  callbackError: null as { error_code: number; description: string } | null,
  calls: [] as { method: string; payload: Record<string, unknown> }[],
}));
vi.mock("../src/bot/db", () => ({
  getSessions: () => state.sessions,
  load_session: async () => null,
  save_response: (...args: unknown[]) => state.saveResponse(...args),
  get_lifetime_snapshots: (...args: unknown[]) => state.snapshot(...args),
  get_chat_epic_links: (...args: unknown[]) => state.epicLinks(...args),
  get_chat_stats: (...args: unknown[]) => state.stats(...args),
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
vi.mock("../src/bot/fortnite", async (original) => ({
  ...(await original<typeof import("../src/bot/fortnite")>()),
  fetchLifetimeStats: state.provider,
}));
vi.mock("../src/bot/roast", async (original) => ({
  ...(await original<typeof import("../src/bot/roast")>()),
  generateTeamStatsRoast: state.analysis,
}));
vi.mock("../src/bot/work", () => ({
  valueCheckpoint: async (_name: string, factory: () => unknown) => factory(),
  externalCheckpoint: async (_name: string, factory: () => Promise<unknown>) =>
    factory(),
}));
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
  state.snapshot.mockResolvedValue([]);
  state.stats.mockReset();
  state.stats.mockResolvedValue(fixture.stats);
  state.epicLinks.mockReset();
  state.epicLinks.mockResolvedValue([]);
  state.provider.mockReset();
  state.analysis.mockReset();
});
it("does not advertise or process the retired personal statistics command", async () => {
  expect(
    GROUP_COMMANDS.some((command) => command.command === "myfnstats"),
  ).toBe(false);
  await bot().handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: -100, type: "supergroup", title: "friends" },
      from: { id: 1, is_bot: false, first_name: "user1" },
      text: "/myfnstats",
      entities: [{ type: "bot_command", offset: 0, length: 10 }],
    },
  });
  expect(state.calls).toEqual([]);
});
it.each(["/fort", "/fort через час"])(
  "redirects %s to GTA without creating a gathering",
  async (text) => {
    await bot().handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1,
        chat: { id: -100, type: "supergroup", title: "friends" },
        from: { id: 1, is_bot: false, first_name: "user1" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      },
    });
    expect(state.sessions.size).toBe(0);
    expect(state.saveResponse).not.toHaveBeenCalled();
    expect(state.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(state.calls[0]!.payload.text).toContain("GTA 6");
    expect(state.calls[0]!.payload.reply_markup).toBeUndefined();
  },
);
it.each(["/warcraft", "/warcraft 19", "/afk 1d", "/rm"])(
  "ignores retired command %s",
  async (text) => {
    await bot().handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1,
        chat: { id: -100, type: "supergroup", title: "friends" },
        from: { id: 1, is_bot: false, first_name: "user1" },
        text,
        entities: [
          {
            type: "bot_command",
            offset: 0,
            length: text.split(" ")[0]!.length,
          },
        ],
      },
    });
    expect(state.calls).toEqual([]);
    expect(state.sessions.size).toBe(0);
  },
);
it.each([
  "go",
  "pass",
  "gready:20",
  "gtime",
  "gat:30",
  "gconfirm:old",
  "gdismiss:old",
  "slot:30",
  "gslot:30",
])("disables old gathering button %s", async (data) => {
  await bot().handleUpdate(callback(1, data));
  expect(state.saveResponse).not.toHaveBeenCalled();
  expect(state.calls.map((c) => c.method)).toEqual([
    "answerCallbackQuery",
    "editMessageReplyMarkup",
  ]);
  expect(state.calls[0]!.payload.text).toContain("Сборы отключены");
  expect(state.calls[1]!.payload.reply_markup).toEqual({ inline_keyboard: [] });
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

afterEach(() => vi.unstubAllEnvs());
describe("unified stats command", () => {
  it("serves gatherings even without configured game statistics and does not handle teamstats", async () => {
    vi.stubEnv("FORTNITE_API_KEY", "");
    await runStats(bot(), -100);
    expect(state.calls.filter((c) => c.method === "sendMessage")).toHaveLength(
      1,
    );
    expect(state.calls[0]!.payload.text).toContain("Сборы Fortnite");
    expect(state.calls[0]!.payload.text).toContain("не настроена");
    expect(state.stats).toHaveBeenCalledWith(
      -100,
      expect.objectContaining({
        from: expect.any(Number),
        to: expect.any(Number),
      }),
    );
    state.calls = [];
    await bot().handleUpdate({
      update_id: 2,
      message: {
        message_id: 12,
        date: 1,
        chat: { id: -100, type: "supergroup", title: "friends" },
        from: { id: 1, is_bot: false, first_name: "one" },
        text: "/teamstats",
        entities: [{ type: "bot_command", offset: 0, length: 10 }],
      },
    });
    expect(state.calls).toEqual([]);
  });
  it("reports provider failures explicitly without hiding gatherings", async () => {
    vi.stubEnv("FORTNITE_API_KEY", "test");
    const { StatsPrivate } = await import("../src/bot/fortnite");
    state.epicLinks.mockResolvedValue([fixture.link]);
    state.provider.mockRejectedValue(new StatsPrivate("private"));
    await runStats(bot(), -100);
    const text = state.calls.find((c) => c.method === "sendMessage")!.payload
      .text as string;
    expect(text).toContain("Сборы Fortnite");
    expect(text).toContain("Профиль закрыт");
    expect(text).not.toContain("история ещё копится");
  });
  it("limits Grok to two sentences in the combined message", async () => {
    vi.stubEnv("FORTNITE_API_KEY", "test");
    const now = Date.now() / 1000;
    state.epicLinks.mockResolvedValue([fixture.link]);
    state.provider.mockResolvedValue({
      ...fixture.player,
      time_window: "lifetime",
      fetched_at: now,
    });
    state.snapshot.mockResolvedValue([
      {
        fetched_at: now - 604800 - 60,
        matches: 1,
        wins: 0,
        kills: 0,
        deaths_est: 0,
      },
    ]);
    state.analysis.mockResolvedValue(
      "Первое предложение. Второе предложение. Третье предложение.",
    );
    await runStats(bot(), -100);
    const text = state.calls.find((c) => c.method === "sendMessage")!.payload
      .text as string;
    expect(text).toContain("Второе предложение.");
    expect(text).not.toContain("Третье предложение.");
  });
  it("sends weekly facts even if Grok fails", async () => {
    vi.stubEnv("FORTNITE_API_KEY", "test");
    const now = Date.now() / 1000;
    state.epicLinks.mockResolvedValue([fixture.link]);
    state.provider.mockResolvedValue({
      ...fixture.player,
      time_window: "lifetime",
      fetched_at: now,
    });
    state.snapshot.mockResolvedValue([
      {
        fetched_at: now - 604800 - 60,
        matches: 1,
        wins: 0,
        kills: 0,
        deaths_est: 0,
      },
    ]);
    state.analysis.mockRejectedValue(new Error("Grok unavailable"));
    await runStats(bot(), -100);
    expect(state.analysis).toHaveBeenCalledOnce();
    const text = state.calls.find((c) => c.method === "sendMessage")!.payload
      .text as string;
    expect(text).toContain("MVP недели");
    expect(text).toContain("Сборы Fortnite");
    expect(text).not.toContain("Grok unavailable");
  });
});
