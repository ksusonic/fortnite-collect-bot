import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { beforeEach, expect, it, vi } from "vitest";
import { registerHandlers } from "../src/bot/handlers";

const state = vi.hoisted(() => ({
  enabled: true,
  reply: "<sharp reply>",
  failSend: false,
  events: [] as string[],
  generate: vi.fn(),
  store: vi.fn(),
}));
vi.mock("../src/bot/storage", () => ({ getRoastState: () => ({}) }));
vi.mock("../src/bot/db", () => ({
  is_feature_enabled: async () => state.enabled,
  get_feature_value: async () => 1,
}));
vi.mock("../src/bot/work", () => ({
  valueCheckpoint: async (_name: string, factory: () => unknown) => factory(),
  externalCheckpoint: async (name: string, factory: () => Promise<unknown>) => {
    state.events.push(name);
    return factory();
  },
}));
vi.mock("../src/bot/roast", () => ({
  rememberMessage: vi.fn(),
  rememberBotMessage: vi.fn(),
  rememberRoastMessage: vi.fn(),
  isRoastMessage: () => false,
  shouldRoast: () => true,
  TELEGRAM_MAX_MESSAGE_LEN: 4096,
  generateRoast: (...args: unknown[]) => state.generate(...args),
}));
vi.mock("../src/bot/memory", () => ({
  storeMemoryTurn: (...args: unknown[]) => state.store(...args),
}));

function bot() {
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
  instance.api.config.use(async (_previous, method, payload) => {
    state.events.push(method);
    if (method === "sendMessage") {
      if (state.failSend) throw new Error("Telegram failed");
      expect((payload as { text: string }).text).toBe("&lt;sharp reply&gt;");
      return {
        ok: true,
        result: {
          message_id: 43,
          date: 1,
          chat: { id: -100, type: "supergroup" },
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  registerHandlers(instance);
  return instance;
}
const update: Update = {
  update_id: 1,
  message: {
    message_id: 42,
    date: 1,
    chat: { id: -100, type: "supergroup", title: "Friends" },
    from: { id: 7, is_bot: false, first_name: "one" },
    text: "play?",
  },
};

beforeEach(() => {
  state.enabled = true;
  state.failSend = false;
  state.events = [];
  state.generate.mockReset().mockResolvedValue(state.reply);
  state.store.mockReset().mockResolvedValue(true);
});

it("passes Telegram identity to generation and stores only after a successful send", async () => {
  await bot().handleUpdate(update);
  expect(state.generate).toHaveBeenCalledWith(
    -100,
    "one",
    "play?",
    expect.any(Number),
    42,
    undefined,
    7,
  );
  expect(state.store).toHaveBeenCalledWith(-100, 7, "play?", state.reply, 42);
  expect(state.events).toEqual([
    "sendChatAction",
    "roast",
    "sendMessage",
    "roast-memory-add",
  ]);
});

it("does not store turns when Telegram send fails", async () => {
  state.failSend = true;
  await expect(bot().handleUpdate(update)).rejects.toThrow("Telegram failed");
  expect(state.store).not.toHaveBeenCalled();
});

it("does not generate or store when roast is disabled", async () => {
  state.enabled = false;
  await bot().handleUpdate(update);
  expect(state.generate).not.toHaveBeenCalled();
  expect(state.store).not.toHaveBeenCalled();
});

it("does not store a failed generation", async () => {
  state.generate.mockResolvedValue(null);
  await bot().handleUpdate(update);
  expect(state.store).not.toHaveBeenCalled();
  expect(state.events).not.toContain("sendMessage");
});
