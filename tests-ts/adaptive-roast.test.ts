vi.mock("../src/bot/transport", async (original) => ({
  ...(await original<typeof import("../src/bot/transport")>()),
  scopedFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Update } from "grammy/types";
import { invocation, migrate, raw, withWork } from "../src/bot/storage";
import { Work } from "../src/bot/work";
import { createBot, enqueue, executeItem } from "../src/bot/runtime";
import { loadRoastProfile } from "../src/bot/services/roast-profile";
import { getRoastPolicy } from "../src/bot/flags";
import { DEFAULT_ROAST_POLICY } from "../src/bot/services/roast-policy";

const mocks = vi.hoisted(() => ({
  decision: vi.fn(),
  evaluate: vi.fn(),
  shutdown: vi.fn(),
}));
vi.mock("../src/bot/roast", async (original) => ({
  ...(await original<typeof import("../src/bot/roast")>()),
  generateRoastDecision: mocks.decision,
}));
vi.mock("@vercel/flags-core", () => ({
  createClient: () => ({ evaluate: mocks.evaluate, shutdown: mocks.shutdown }),
}));
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "adaptive roast with Postgres and work replay",
  () => {
    const telegram: { method: string; body: Record<string, unknown> }[] = [];
    beforeAll(async () => {
      const target = new URL(url!);
      if (
        !["127.0.0.1", "localhost"].includes(target.hostname) ||
        target.pathname !== "/fortnite_test"
      )
        throw new Error("disposable localhost fortnite_test required");
      process.env.DATABASE_URL = url;
      process.env.DATABASE_LOCAL_TEST = "1";
      await migrate();
    });
    beforeEach(async () => {
      vi.clearAllMocks();
      telegram.length = 0;
      vi.stubEnv("BOT_TOKEN", "123:test-token");
      vi.spyOn(Date, "now").mockReturnValue(2_000_000);
      mocks.evaluate.mockResolvedValue({ value: DEFAULT_ROAST_POLICY });
      mocks.decision.mockResolvedValue({ action: "reply", text: "шутка" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown, init: RequestInit) => {
          const method = String(input).split("/").at(-1)!;
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          telegram.push({ method, body });
          // Confirm preference writes precede the Telegram confirmation.
          if (method === "sendMessage" && body.text === "Буду короче")
            expect(
              (
                await raw(
                  "SELECT preferences FROM roast_profiles WHERE chat_id=-10",
                )
              ).rows[0]?.preferences,
            ).toMatchObject({ length: "brief" });
          return new Response(
            JSON.stringify({
              ok: true,
              result:
                method === "sendMessage"
                  ? {
                      message_id: 100 + telegram.length,
                      date: 2000,
                      chat: { id: body.chat_id, type: "group" },
                      text: body.text,
                    }
                  : true,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }),
      );
      await invocation(null, () =>
        raw(
          "TRUNCATE approved_chats,roast_profiles,roast_state,chat_features,work_steps,work_items,service_state,sessions,responses CASCADE",
        ),
      );
      await invocation(null, () =>
        raw(
          "INSERT INTO approved_chats(chat_id,approved_by) VALUES (-10,1),(-11,1),(-12,1),(-13,1),(-20,1),(-100,1),(-200,1)",
        ),
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    function update(
      id: number,
      text: string,
      addressed = true,
      chat = -10,
    ): Update {
      return {
        update_id: id,
        message: {
          message_id: id,
          date: 2000,
          chat: { id: chat, type: "group", title: "friends" },
          from: { id: 7, is_bot: false, first_name: "Друг" },
          text,
          ...(addressed
            ? {
                reply_to_message: {
                  message_id: 99,
                  reply_to_message: undefined,
                  date: 1999,
                  chat: { id: chat, type: "group", title: "friends" },
                  from: { id: 123, is_bot: true, first_name: "Bot" },
                  text: "Предыдущий ответ",
                },
              }
            : {}),
        },
      };
    }
    async function run(payload: Update) {
      const bot = createBot();
      bot.botInfo = {
        id: 123,
        is_bot: true,
        first_name: "Bot",
        username: "test_bot",
        can_join_groups: true,
        can_read_all_group_messages: true,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      };
      const item = {
        id: `adaptive:${payload.update_id}`,
        kind: "update",
        chat_id: payload.message!.chat.id,
        status: "pending",
        payload: payload as unknown as Record<string, unknown>,
      };
      const result = await invocation(item.chat_id, async () => {
        await enqueue(item.id, "update", item.chat_id, payload);
        return executeItem(item, bot);
      });
      return { item, bot, result };
    }
    it("retains enabled and disabled legacy preferences after a late import", async () => {
      await invocation(null, async () => {
        await raw(
          "INSERT INTO chat_features(chat_id,feature,enabled) VALUES (-10,'roast',true),(-11,'roast',false)",
        );
      });
      expect(await invocation(-10, () => loadRoastProfile(-10))).toMatchObject({
        preferences: { proactive: true },
      });
      expect(await invocation(-11, () => loadRoastProfile(-11))).toMatchObject({
        preferences: { proactive: false },
      });
    });
    it("persists a request before confirming and replays without new Flags, model, or sends", async () => {
      mocks.decision.mockResolvedValue({
        action: "update",
        patch: { length: "brief" },
        text: "Буду короче",
      });
      const { item, bot, result } = await run(update(1, "покороче"));
      expect(result).toBe("complete");
      expect(await invocation(-10, () => loadRoastProfile(-10))).toMatchObject({
        preferences: { length: "brief" },
      });
      mocks.evaluate.mockResolvedValue({
        value: { ...DEFAULT_ROAST_POLICY, proactiveAllowed: false },
      });
      expect(await invocation(-10, () => executeItem(item, bot))).toBe(
        "complete",
      );
      expect(mocks.decision).toHaveBeenCalledOnce();
      expect(mocks.evaluate).toHaveBeenCalledOnce();
      expect(telegram.filter((c) => c.method === "sendMessage")).toHaveLength(
        1,
      );
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "Новая шутка",
      });
      expect((await run(update(2, "ещё"))).result).toBe("complete");
      expect(mocks.decision.mock.calls.at(-1)![4]).toMatchObject({
        length: "brief",
      });
    });
    it("stores an ambiguous clarification across restarts and applies the next addressed answer", async () => {
      mocks.decision.mockResolvedValue({
        action: "clarify",
        text: "Короче или реже?",
      });
      await run(update(1, "меньше говори"));
      expect(await invocation(-10, () => loadRoastProfile(-10))).toMatchObject({
        preferences: {},
        pending_question: "Короче или реже?",
      });
      mocks.decision.mockResolvedValue({
        action: "update",
        patch: { frequency: "rare" },
        text: "Буду реже",
      });
      await run(update(2, "реже"));
      expect(mocks.decision.mock.calls.at(-1)![6]).toBe("Короче или реже?");
      expect(await invocation(-10, () => loadRoastProfile(-10))).toMatchObject({
        preferences: { frequency: "rare" },
        pending_question: null,
      });
    });
    it("keeps new chats quiet, isolates chats, and processes direct replies while muted", async () => {
      await run(update(1, "покороче", false));
      expect(mocks.decision).not.toHaveBeenCalled();
      mocks.decision.mockResolvedValue({
        action: "update",
        patch: { proactive: false },
        text: "Ок",
      });
      await run(update(2, "замолчи"));
      await run(update(3, "привет", false));
      expect(mocks.decision).toHaveBeenCalledTimes(1);
      mocks.decision.mockResolvedValue({
        action: "update",
        patch: { proactive: true, frequency: "rare" },
        text: "Буду иногда комментировать",
      });
      await run(update(4, "можешь иногда комментировать"));
      expect(await invocation(-11, () => loadRoastProfile(-11))).toMatchObject({
        preferences: {},
      });
      expect(await invocation(-10, () => loadRoastProfile(-10))).toMatchObject({
        preferences: { proactive: true, frequency: "rare" },
      });
    });
    it("limits evaluation attempts even when the model chooses silence or fails", async () => {
      await invocation(-10, () =>
        raw(
          "INSERT INTO chat_features(chat_id,feature,enabled) VALUES (-10,'roast',true)",
        ),
      );
      mocks.decision.mockResolvedValue({ action: "skip" });
      await run(update(1, "контекст", false));
      await run(update(2, "контекст 2", false));
      expect(mocks.decision).toHaveBeenCalledOnce();
      expect(telegram).toHaveLength(0);
      vi.spyOn(Date, "now").mockReturnValue(2_601_000);
      mocks.decision.mockResolvedValue(null);
      await run(update(3, "контекст 3", false));
      await run(update(4, "контекст 4", false));
      expect(mocks.decision).toHaveBeenCalledTimes(2);
      expect(telegram).toHaveLength(0);
    });
    it("keeps preferences unchanged after provider failure and a one-off request", async () => {
      mocks.decision.mockResolvedValue(null);
      await run(update(1, "без мата"));
      expect(await invocation(-10, () => loadRoastProfile(-10))).toMatchObject({
        preferences: {},
      });
      expect(telegram.at(-1)?.body.text).toContain("Настройки не изменены");
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "Разовая шутка",
      });
      await run(update(2, "разнеси его"));
      expect(await invocation(-10, () => loadRoastProfile(-10))).toMatchObject({
        preferences: {},
      });
    });
    it("reuses a policy snapshot on replay and reads updated Flags for new work", async () => {
      await invocation(-10, async () => {
        await enqueue("policy", "update", -10, {});
        expect(await withWork(new Work("policy"), getRoastPolicy)).toEqual(
          DEFAULT_ROAST_POLICY,
        );
        const next = { ...DEFAULT_ROAST_POLICY, proactiveAllowed: false };
        mocks.evaluate.mockResolvedValue({ value: next });
        expect(await withWork(new Work("policy"), getRoastPolicy)).toEqual(
          DEFAULT_ROAST_POLICY,
        );
        await enqueue("policy-next", "update", -10, {});
        expect(await withWork(new Work("policy-next"), getRoastPolicy)).toEqual(
          next,
        );
        expect(mocks.evaluate).toHaveBeenCalledTimes(2);
      });
    });
  },
);
