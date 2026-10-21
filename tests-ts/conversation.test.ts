import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import type { Update } from "grammy/types";
import {
  createBot,
  enqueue,
  executeItem,
  processUpdate,
} from "../src/bot/runtime";
import { invocation, raw, withWork } from "../src/bot/storage";
import { Work, telegramTransformer } from "../src/bot/work";
import {
  sourceByRef,
  rememberSource,
  forgetSource,
  recentSources,
  searchSources,
  cleanupConversations,
  memoryEpoch,
} from "../src/bot/services/conversation-store";
import {
  extractConversationMemory,
  enqueueConversationMemory,
  retryMemoryDeletions,
} from "../src/bot/services/conversation-memory";
import { DEFAULT_ROAST_POLICY } from "../src/bot/services/roast-policy";
const mocks = vi.hoisted(() => ({
  intent: vi.fn(),
  decision: vi.fn(),
  extract: vi.fn(),
  remove: vi.fn(),
  store: vi.fn(),
  legacy: vi.fn(),
  search: vi.fn(),
}));
vi.mock("../src/bot/services/conversation-model", async (original) => ({
  ...(await original<
    typeof import("../src/bot/services/conversation-model")
  >()),
  interpretConversation: mocks.intent,
  decideConversation: mocks.decision,
  extractFacts: mocks.extract,
}));
vi.mock("../src/bot/memory", () => ({
  searchMemories: mocks.search,
  storeMemoryTurn: mocks.store,
  confirmMemoryTurn: vi.fn(),
  deleteMemoryScope: mocks.remove,
}));
vi.mock("../src/bot/roast", async (original) => ({
  ...(await original<typeof import("../src/bot/roast")>()),
  generateRoastDecision: mocks.legacy,
}));
vi.mock("../src/bot/flags", () => ({
  getRoastPolicy: async () => DEFAULT_ROAST_POLICY,
}));
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "contextual conversation in the durable queue",
  () => {
    const chat = -10012345,
      now = Date.parse("2026-10-21T15:00:00Z") / 1000;
    let sentId = 10000;
    let allowed = ["🌚", "🌭", "🗿"];
    let rejectReply = false,
      rejectReaction = false,
      uncertain = false;
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    beforeAll(() => {
      const target = new URL(url!);
      if (
        !["localhost", "127.0.0.1"].includes(target.hostname) ||
        target.pathname !== "/fortnite_test"
      )
        throw Error("disposable localhost fortnite_test required");
      process.env.DATABASE_URL = url;
      process.env.DATABASE_LOCAL_TEST = "1";
    });
    beforeEach(async () => {
      vi.clearAllMocks();
      vi.spyOn(Date, "now").mockReturnValue(now * 1000);
      vi.stubEnv("ADMIN_USER_ID", "1");
      vi.stubEnv("BOT_TOKEN", "123:fake");
      calls.length = 0;
      sentId = 10000;
      allowed = ["🌚", "🌭", "🗿"];
      rejectReply = false;
      rejectReaction = false;
      uncertain = false;
      mocks.intent.mockResolvedValue({
        addressed: false,
        operation: "reply",
        search: { queries: [] },
      });
      mocks.decision.mockResolvedValue({ action: "skip" });
      mocks.extract.mockResolvedValue([]);
      mocks.remove.mockResolvedValue(true);
      mocks.store.mockResolvedValue(null);
      mocks.search.mockResolvedValue([]);
      mocks.legacy.mockResolvedValue({ action: "skip" });
      await invocation(null, async () => {
        await raw(
          "TRUNCATE approved_chats,sessions,responses,roast_state,roast_profiles,work_steps,work_items,service_state CASCADE",
        );
        await raw(
          "INSERT INTO approved_chats(chat_id,approved_by) VALUES($1,1),(-10067890,1)",
          [chat],
        );
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    function update(
      id: number,
      text: string,
      user = 7,
      thread = 0,
      age = 0,
    ): Update {
      return {
        update_id: id,
        message: {
          message_id: id,
          date: now - age,
          chat: { id: chat, type: "supergroup", title: "Friends" },
          from: {
            id: user,
            is_bot: false,
            first_name: user === 7 ? "Даня" : "Саша",
          },
          text,
          ...(thread ? { message_thread_id: thread } : {}),
        },
      };
    }
    function bot() {
      const bot = createBot();
      bot.botInfo = {
        id: 123,
        is_bot: true,
        first_name: "Fort",
        username: "fort_bot",
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
      bot.api.config.use(async (_previous, method, payload) => {
        calls.push({
          method,
          payload: payload as unknown as Record<string, unknown>,
        });
        if (method === "getChat")
          return {
            ok: true,
            result: {
              id: chat,
              type: "supergroup",
              title: "Friends",
              available_reactions: allowed.map((emoji) => ({
                type: "emoji",
                emoji,
              })),
            },
          } as never;
        if (method === "sendMessage") {
          if (uncertain) throw new Error("connection lost");
          if (
            rejectReply &&
            (payload as { reply_parameters?: { message_id: number } })
              .reply_parameters?.message_id === 1
          )
            return {
              ok: false,
              error_code: 400,
              description: "Bad Request: message to be replied not found",
            } as never;
          return {
            ok: true,
            result: {
              message_id: sentId++,
              date: Date.now() / 1000,
              chat: { id: chat, type: "supergroup" },
              text: (payload as { text: string }).text,
            },
          } as never;
        }
        if (method === "setMessageReaction" && rejectReaction)
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: REACTION_INVALID",
          } as never;
        return { ok: true, result: true } as never;
      });
      bot.api.config.use(telegramTransformer);
      return bot;
    }
    async function run(payload: Update, version = 2) {
      const client = bot();
      const item = {
        id: `update:${payload.update_id}`,
        kind: "update",
        chat_id: chat,
        status: "pending",
        payload: payload as unknown as Record<string, unknown>,
      };
      const result = await invocation(chat, async () => {
        await enqueue(item.id, "update", chat, payload);
        await raw("UPDATE work_items SET conversation_version=$2 WHERE id=$1", [
          item.id,
          version,
        ]);
        return executeItem(item, client);
      });
      return { item, client, result };
    }
    async function source(id: number, thread = 0) {
      return invocation(chat, () => sourceByRef(chat, thread, `s:${id}`, now));
    }
    it("archives silent messages, replies to an older post with escaped links, and replays once", async () => {
      expect(
        (await run(update(1, "Смогу только после девяти", 7, 0, 86400))).result,
      ).toBe("complete");
      expect(await source(1)).toMatchObject({
        user_id: 7,
        text: "Смогу только после девяти",
      });
      mocks.intent.mockResolvedValue({
        addressed: true,
        operation: "reply",
        search: { queries: ["после"] },
      });
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "Вчера говорил <после девяти>",
        reply_ref: "s:1",
        sources: ["s:1"],
      });
      const { item, client, result } = await run(
        update(2, "Грок, что Даня говорил вчера?"),
      );
      expect(result).toBe("complete");
      const sent = calls.find((c) => c.method === "sendMessage")!.payload;
      expect(sent.reply_parameters).toEqual({ message_id: 1 });
      expect(sent.text).toContain("&lt;после девяти&gt;");
      expect(sent.text).toContain("https://t.me/c/12345/1");
      const count = mocks.decision.mock.calls.length;
      expect(await invocation(chat, () => executeItem(item, client))).toBe(
        "complete",
      );
      expect(mocks.decision).toHaveBeenCalledTimes(count);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    });

    it("uses the original Telegram reply even when never seen and older than the search window", async () => {
      mocks.intent.mockResolvedValue({
        addressed: true,
        operation: "reply",
        search: { queries: [] },
      });
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "Ты писал, что после девяти",
        reply_ref: "s:42",
        sources: ["s:42"],
      });
      const payload = update(1, "Грок, что я тут обещал?");
      payload.message!.reply_to_message = {
        ...update(42, "После девяти", 7, 0, 40 * 86400).message!,
        reply_to_message: undefined,
      };
      expect((await run(payload)).result).toBe("complete");
      expect(mocks.decision.mock.calls[0][0].candidates).toContainEqual(
        expect.objectContaining({
          ref: "s:42",
          text: "После девяти",
          ts: now - 40 * 86400,
        }),
      );
      expect(
        calls.find((c) => c.method === "sendMessage")!.payload.reply_parameters,
      ).toEqual({ message_id: 42 });
    });
    it("resolves citations of the previous answer when its old source left the recent context", async () => {
      await run(update(1, "Обычно после девяти", 7, 0, 86400));
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "После девяти",
        sources: ["s:1"],
      });
      await run(update(2, "Грок, когда я играю?"));
      await invocation(chat, async () => {
        for (let i = 100; i < 135; i++)
          await raw(
            `INSERT INTO conversation_messages(chat_id,message_id,user_id,name,text,sent_at) VALUES($1,$2,8,'Саша','новый разговор',to_timestamp($3))`,
            [chat, i, now],
          );
      });
      mocks.intent.mockResolvedValue({
        addressed: true,
        operation: "reply",
        search: { queries: ["несуществующее"] },
      });
      await run(update(3, "Откуда ты это знаешь?"));
      expect(mocks.decision.mock.calls.at(-1)![0].candidates).toContainEqual(
        expect.objectContaining({ ref: "s:1" }),
      );
    });
    it("binds continuation and clarification to the author and topic while respecting mute", async () => {
      mocks.decision.mockResolvedValue({
        action: "clarify",
        text: "Какую договорённость?",
        sources: [],
      });
      await run(update(1, "Грок, вспомни", 7, 10));
      await invocation(chat, () =>
        raw(
          `INSERT INTO roast_profiles(chat_id,preferences) VALUES($1,'{"proactive":false}')`,
          [chat],
        ),
      );
      await run(update(2, "ту самую", 8, 10));
      await run(update(3, "ту самую", 7, 20));
      expect(mocks.decision).toHaveBeenCalledOnce();
      mocks.intent.mockResolvedValue({
        addressed: true,
        operation: "reply",
        search: { queries: [] },
      });
      await run(update(4, "ту самую", 7, 10));
      expect(mocks.intent.mock.calls.at(-1)![0]).toMatchObject({
        direct: false,
        continuation: true,
        pending: "Какую договорённость?",
      });
      expect(mocks.decision).toHaveBeenCalledTimes(2);
      vi.mocked(Date.now).mockReturnValue((now + 301) * 1000);
      await run(update(5, "а дальше?", 7, 10));
      expect(mocks.decision).toHaveBeenCalledTimes(2);
    });
    it("reacts with moyai instead of sending text, honors chat restrictions and replay", async () => {
      mocks.decision.mockResolvedValue({
        action: "react",
        emoji: "🗿",
        source_ref: "s:1",
      });
      const { item, client, result } = await run(update(1, "Победил киркой"));
      expect(result).toBe("complete");
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
      expect(
        calls.find((c) => c.method === "setMessageReaction")!.payload,
      ).toMatchObject({
        message_id: 1,
        reaction: [{ type: "emoji", emoji: "🗿" }],
      });
      await invocation(chat, () => executeItem(item, client));
      expect(
        calls.filter((c) => c.method === "setMessageReaction"),
      ).toHaveLength(1);
      vi.mocked(Date.now).mockReturnValue((now + 301) * 1000);
      allowed = ["🌚"];
      mocks.decision.mockResolvedValue({
        action: "react",
        emoji: "🌭",
        source_ref: "s:2",
      });
      await run(update(2, "Интересный пост"));
      expect(
        calls.filter((c) => c.method === "setMessageReaction"),
      ).toHaveLength(1);
      expect(mocks.decision.mock.calls.at(-1)![0].allowed_reactions).toEqual([
        "🌚",
      ]);
    });
    it("reacts to captioned posts and treats a denied reaction as nonessential", async () => {
      const payload = update(1, "Победа");
      payload.message!.caption = "Победа";
      delete payload.message!.text;
      mocks.decision.mockResolvedValue({
        action: "react",
        emoji: "🌭",
        source_ref: "s:1",
      });
      rejectReaction = true;
      expect((await run(payload)).result).toBe("complete");
      expect(await source(1)).toMatchObject({ text: "Победа" });
    });
    it("limits evaluations across topics, but permits reactions while text is cooling down", async () => {
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "Удачно",
        sources: [],
      });
      await run(update(1, "Победа", 7));
      await run(update(2, "Ещё победа", 8, 10));
      expect(mocks.decision).toHaveBeenCalledOnce();
      vi.mocked(Date.now).mockReturnValue((now + 301) * 1000);
      mocks.decision.mockResolvedValue({
        action: "react",
        emoji: "🌚",
        source_ref: "s:3",
      });
      await run(update(3, "Ну конечно", 8, 10));
      expect(mocks.decision.mock.calls.at(-1)![0].allow_proactive_reply).toBe(
        false,
      );
      expect(
        calls.filter((c) => c.method === "setMessageReaction"),
      ).toHaveLength(1);
    });
    it("falls back only on confirmed missing reply targets and leaves uncertain sends ambiguous", async () => {
      await run(update(1, "После девяти", 7, 0, 86400));
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "В девять",
        reply_ref: "s:1",
        sources: [],
      });
      rejectReply = true;
      expect((await run(update(2, "Грок, когда?"))).result).toBe("complete");
      expect(
        calls
          .filter((c) => c.method === "sendMessage")
          .map((c) => c.payload.reply_parameters),
      ).toEqual([{ message_id: 1 }, { message_id: 2 }]);
      uncertain = true;
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "Ответ",
        sources: [],
      });
      const { item, client, result } = await run(update(3, "Грок, ещё"));
      expect(result).toBe("ambiguous");
      const count = calls.filter((c) => c.method === "sendMessage").length;
      expect(await invocation(chat, () => executeItem(item, client))).toBe(
        "ambiguous",
      );
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(
        count,
      );
    });
    it("saves explicit memories and prevents other users forgetting them", async () => {
      mocks.intent.mockResolvedValue({
        addressed: true,
        operation: "remember",
        search: { queries: [] },
      });
      mocks.decision.mockResolvedValue({
        action: "remember",
        text: "Ок",
        source_ref: "s:1",
        content: "Даня обычно играет после девяти",
        expires_at: null,
        sources: [],
      });
      expect(
        (await run(update(1, "Запомни: я обычно после девяти"))).result,
      ).toBe("complete");
      const memories = await invocation(chat, () =>
        searchSources(chat, 0, now, { queries: ["девяти"] }),
      );
      expect(memories.some((m) => m.ref.startsWith("m:"))).toBe(true);
      const fact = memories.find((m) => m.ref.startsWith("m:"))!;
      expect(await invocation(chat, () => forgetSource(chat, fact, 8))).toBe(
        false,
      );
      expect(await invocation(chat, () => forgetSource(chat, fact, 1))).toBe(
        true,
      );
      expect(await source(1)).toBeUndefined();
    });
    it("forgets both local derivations and the provider epoch, redacts bot quotes and prevents edit resurrection", async () => {
      await run(update(1, "Обычно после девяти"));
      const original = (await source(1))!;
      await invocation(chat, () =>
        rememberSource(chat, original, "После девяти", null, false),
      );
      mocks.decision.mockResolvedValue({
        action: "reply",
        text: "Помню: после девяти",
        sources: ["s:1"],
      });
      await run(update(2, "Грок, когда я играю?"));
      mocks.intent.mockResolvedValue({
        addressed: true,
        operation: "forget",
        search: { queries: ["девяти"] },
      });
      mocks.decision.mockResolvedValue({
        action: "forget",
        text: "Ок",
        source_ref: "s:1",
        sources: [],
      });
      mocks.remove.mockResolvedValue(false);
      expect((await run(update(3, "Забудь, когда я играю"))).result).toBe(
        "complete",
      );
      expect(await source(1)).toBeUndefined();
      expect(await invocation(chat, () => memoryEpoch(chat, 7))).toBe(1);
      expect(mocks.remove).toHaveBeenCalledWith(chat, 7, 0);
      expect(
        calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.text,
      ).toContain("ещё не завершено");
      expect(
        (await invocation(chat, () => recentSources(chat, 0, now))).some((s) =>
          s.text.includes("Помню:"),
        ),
      ).toBe(false);
      const edited = update(4, "новый секрет");
      edited.edited_message = {
        ...edited.message!,
        message_id: 1,
        edit_date: now + 10,
      };
      delete edited.message;
      expect((await run(edited)).result).toBe("complete");
      expect(await source(1)).toBeUndefined();
      mocks.remove.mockResolvedValue(true);
      expect(
        await invocation(chat, () => retryMemoryDeletions(chat, now + 601)),
      ).toBe(true);
    });
    it("invalidates changed facts on edit, ignores stale edits and never responds to edits", async () => {
      await run(update(1, "Я после девяти"));
      await invocation(chat, () =>
        rememberSource(
          chat,
          {
            ref: "s:1",
            message_id: 1,
            user_id: 7,
            name: "Даня",
            text: "Я после девяти",
            ts: now,
            thread_id: 0,
          },
          "После девяти",
          null,
          false,
        ),
      );
      const edited = update(2, "Я после десяти");
      edited.edited_message = {
        ...edited.message!,
        message_id: 1,
        edit_date: now + 10,
      };
      delete edited.message;
      await run(edited);
      expect(await source(1)).toMatchObject({ text: "Я после десяти" });
      expect(
        await invocation(chat, () =>
          searchSources(chat, 0, now, { queries: ["девяти"] }),
        ),
      ).toEqual([]);
      expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
      expect(mocks.decision).toHaveBeenCalledOnce();
    });
    it("extracts silent messages in bounded batches and keeps the queue moving on provider outages", async () => {
      await run(update(1, "Обычно играю после девяти"));
      mocks.extract.mockResolvedValue([
        { source_ref: "s:1", content: "Обычно после девяти", expires_at: null },
      ]);
      await invocation(chat, () => extractConversationMemory(chat, now));
      expect(
        (
          await invocation(chat, () =>
            searchSources(chat, 0, now, { queries: ["девяти"] }),
          )
        ).some((s) => s.ref.startsWith("m:")),
      ).toBe(true);
      await run(update(2, "Обычно до десяти", 8));
      mocks.extract.mockResolvedValue(null);
      await invocation(chat, () => extractConversationMemory(chat, now + 601));
      expect(
        (
          await invocation(chat, () =>
            raw(
              "SELECT processed FROM conversation_messages WHERE chat_id=$1 AND message_id=2",
              [chat],
            ),
          )
        ).rows[0].processed,
      ).toBe(false);
      await invocation(chat, () => enqueueConversationMemory(now + 1202));
      expect(
        (
          await invocation(chat, () =>
            raw("SELECT id FROM work_items WHERE kind='conversation-memory'"),
          )
        ).rows,
      ).toHaveLength(1);
    });
    it("filters expired history immediately, retains lasting facts and isolates topics/chats/authors", async () => {
      await run(update(1, "Люблю скуады"));
      const original = (await source(1))!;
      await invocation(chat, async () => {
        await rememberSource(chat, original, "Люблю скуады", null, false);
        await rememberSource(chat, original, "Временный план", now - 1, false);
        expect(await searchSources(-10067890, 0, now, { queries: [] })).toEqual(
          [],
        );
        expect(await searchSources(chat, 99, now, { queries: [] })).toEqual([]);
        expect(
          await searchSources(chat, 0, now, { queries: [], user_id: 8 }),
        ).toEqual([]);
        expect(
          (await searchSources(chat, 0, now, { queries: [], author: "Даня" }))
            .length,
        ).toBe(2);
        await raw(
          "UPDATE conversation_messages SET sent_at=now()-interval '31 days' WHERE chat_id=$1",
          [chat],
        );
        expect(await recentSources(chat, 0, now)).toEqual([]);
        await cleanupConversations();
        expect(
          (
            await raw("SELECT 1 FROM conversation_messages WHERE chat_id=$1", [
              chat,
            ])
          ).rows,
        ).toEqual([]);
        expect(
          (await searchSources(chat, 0, now, { queries: [] })).map(
            (s) => s.text,
          ),
        ).toEqual(["Люблю скуады"]);
      });
    });
    it("uses the legacy checkpoint handler for old work and refuses unapproved ingestion", async () => {
      expect((await run(update(1, "Грок, привет"), 1)).result).toBe("complete");
      expect(mocks.legacy).toHaveBeenCalledOnce();
      expect(mocks.intent).not.toHaveBeenCalled();
      expect(await source(1)).toBeUndefined();
      const unapproved = update(2, "private");
      unapproved.message!.chat.id = -999;
      expect(await processUpdate(unapproved)).toBe("complete");
      expect(
        (
          await invocation(null, () =>
            raw("SELECT 1 FROM work_items WHERE id=$1", ["update:2"]),
          )
        ).rows,
      ).toEqual([]);
    });
    it("replays memory mutation atomically without advancing the provider epoch twice", async () => {
      await run(update(1, "Секрет"));
      const original = (await source(1))!;
      await invocation(chat, async () => {
        await enqueue("forget-work", "update", chat, {});
        for (let i = 0; i < 2; i++)
          await withWork(new Work("forget-work"), () =>
            forgetSource(chat, original, 7),
          );
        expect(await memoryEpoch(chat, 7)).toBe(1);
      });
    });
  },
);
