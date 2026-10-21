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
import { invocation, raw } from "../src/bot/storage";
import * as db from "../src/bot/db";
import {
  processUpdate,
  createBot,
  enqueue,
  drainChat,
} from "../src/bot/runtime";
import {
  changePlayer,
  eveningEnd,
  parseGatheringTime,
  rosterTimes,
} from "../src/bot/services/gathering";
import { buildGatheringKeyboard, buildGatherText } from "../src/bot/messages";

const mocks = vi.hoisted(() => ({ intent: vi.fn(), roast: vi.fn() }));
vi.mock("../src/bot/transport", async (original) => ({
  ...(await original<typeof import("../src/bot/transport")>()),
  scopedFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
vi.mock("../src/bot/gathering-intent", () => ({
  interpretGatheringMessage: mocks.intent,
}));
vi.mock("../src/bot/handlers/roast", () => ({ maybeRoast: mocks.roast }));
vi.mock("../src/bot/roast", async (original) => ({
  ...(await original<typeof import("../src/bot/roast")>()),
  generateFortHeader: async () => null,
}));
const at = (time: string) => Date.parse(`2026-10-21T${time}+03:00`) / 1000;
it("parses command times without losing minutes or rolling into tomorrow", () => {
  expect(parseGatheringTime("через час", at("16:00:00"))).toBe(at("17:00:00"));
  expect(parseGatheringTime("через полтора часа", at("16:00:00"))).toBe(
    at("17:30:00"),
  );
  expect(parseGatheringTime("через 30 минут", at("16:00:00"))).toBe(
    at("16:30:00"),
  );
  expect(parseGatheringTime("в 19:32", at("16:00:00"))).toBe(at("19:32:00"));
  expect(parseGatheringTime("24:00", at("16:00:00"))).toBeNaN();
  expect(parseGatheringTime("вчера в 19", at("16:00:00"))).toBeNull();
  expect(eveningEnd(at("23:59:59"))).toBe(at("23:59:59") + 1);
});
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "gathering conversation with Postgres and durable updates",
  () => {
    let updateId = 0,
      messageId = 100;
    const chat = -100123456;
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let reject: string | undefined;
    let failEdit = false;
    let failNotice = false;
    beforeAll(() => {
      const target = new URL(url!);
      if (
        !["localhost", "127.0.0.1"].includes(target.hostname) ||
        target.pathname !== "/fortnite_test"
      )
        throw new Error("disposable localhost fortnite_test required");
      process.env.DATABASE_URL = url;
      process.env.DATABASE_LOCAL_TEST = "1";
    });
    beforeEach(async () => {
      updateId = 0;
      messageId = 100;
      calls.length = 0;
      reject = undefined;
      failEdit = false;
      failNotice = false;
      vi.stubEnv("BOT_TOKEN", "123:fake-test-token");
      vi.spyOn(Date, "now").mockReturnValue(at("16:00:00") * 1000);
      mocks.intent.mockReset();
      mocks.intent.mockResolvedValue({ action: "ignore" });
      mocks.roast.mockReset();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown, init: RequestInit) => {
          const method = String(input).split("/").at(-1)!;
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          calls.push({ method, body });
          if (method === "editMessageText" && failEdit) {
            failEdit = false;
            throw new Error("interrupted edit");
          }
          if (
            method === "sendMessage" &&
            failNotice &&
            String(body.text).startsWith("🎮 Можно начинать")
          )
            throw new Error("uncertain send");
          if (method === reject)
            return new Response(
              JSON.stringify({
                ok: false,
                error_code: 403,
                description: "Forbidden",
              }),
            );
          const result =
            method === "getMe"
              ? {
                  id: 123,
                  is_bot: true,
                  first_name: "Bot",
                  username: "fort_test_bot",
                }
              : method === "sendMessage"
                ? {
                    message_id: ++messageId,
                    date: Date.now() / 1000,
                    chat: { id: chat, type: "supergroup" },
                    text: body.text,
                  }
                : true;
          return new Response(JSON.stringify({ ok: true, result }), {
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      await invocation(null, async () => {
        await raw(
          "TRUNCATE approved_chats,sessions,responses,work_items,work_steps,fort_cooldowns,roast_state CASCADE",
        );
        await raw(
          "INSERT INTO approved_chats(chat_id,approved_by) VALUES ($1,1)",
          [chat],
        );
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    function text(value: string, user = 1, reply?: number): Update {
      return {
        update_id: ++updateId,
        message: {
          message_id: 10000 + updateId,
          date: Date.now() / 1000,
          chat: { id: chat, type: "supergroup", title: "Friends" },
          from: { id: user, is_bot: false, first_name: `user${user}` },
          text: value,
          ...(value.startsWith("/")
            ? {
                entities: [
                  {
                    type: "bot_command" as const,
                    offset: 0,
                    length: value.split(" ")[0]!.length,
                  },
                ],
              }
            : {}),
          ...(reply
            ? {
                reply_to_message: {
                  reply_to_message: undefined,
                  from: { id: 123, is_bot: true, first_name: "Bot" },
                  message_id: reply,
                  date: 1,
                  chat: {
                    id: chat,
                    type: "supergroup" as const,
                    title: "Friends",
                  },
                },
              }
            : {}),
        },
      };
    }
    async function current() {
      return invocation(
        chat,
        async () => (await db.load_active_sessions(chat))[0]!,
      );
    }
    async function click(data: string, user = 1, mid?: number) {
      const session = await current();
      return processUpdate({
        update_id: ++updateId,
        callback_query: {
          id: `callback${updateId}`,
          chat_instance: "chat",
          data,
          from: { id: user, is_bot: false, first_name: `user${user}` },
          message: {
            message_id: mid ?? session.message_id,
            date: 1,
            chat: { id: chat, type: "supergroup", title: "Friends" },
          },
        },
      });
    }
    async function tick(id: string) {
      const session = await current();
      await invocation(chat, () =>
        enqueue(id, "gathering", chat, { message_id: session.message_id }),
      );
      return drainChat(chat, createBot());
    }
    it("creates and pins one card, records its author, and updates only the command caller", async () => {
      expect(await processUpdate(text("/fort через час"))).toBe("complete");
      const initial = await current();
      expect(initial.availability?.get(1)).toBe(at("17:00:00"));
      expect(initial.ready_players?.size).toBe(0);
      expect(calls.find((c) => c.method === "pinChatMessage")?.body).toEqual({
        chat_id: chat,
        message_id: initial.message_id,
        disable_notification: true,
      });
      await processUpdate(text("/fort через 30 минут", 2));
      await processUpdate(text("/fort в 18:32", 1));
      await processUpdate(text("/fort", 3));
      const updated = await current();
      expect(updated.message_id).toBe(initial.message_id);
      expect([...updated.go_players.keys()]).toEqual([1, 2]);
      expect(updated.availability?.get(1)).toBe(at("18:32:00"));
      expect(updated.availability?.get(2)).toBe(at("16:30:00"));
      expect(calls.filter((c) => c.method === "pinChatMessage")).toHaveLength(
        1,
      );
      expect(mocks.intent).not.toHaveBeenCalled();
    });
    it("keeps exact personal times and offers the earliest shared five-minute slot", async () => {
      await processUpdate(text("/fort 16:14"));
      await processUpdate(text("/fort 16:32", 2));
      const session = await current();
      expect(rosterTimes(session)).toMatchObject({
        start: at("16:15:00"),
        all: at("16:35:00"),
        ready: 0,
      });
      const button = buildGatheringKeyboard(session, at("16:00:00"))
        .inline_keyboard[0]![0]!;
      expect(button.text).toBe("👍 Смогу к 16:15");
      await click(button.callback_data, 3);
      expect((await current()).availability?.get(3)).toBe(at("16:15:00"));
      vi.mocked(Date.now).mockReturnValue(at("16:16:00") * 1000);
      await click(button.callback_data, 4);
      expect((await current()).go_players.has(4)).toBe(false);
    });
    it("preserves FIFO, promotes reserve, and rejoining starts at the back", async () => {
      for (let id = 1; id <= 6; id++) await processUpdate(text("/fort 19", id));
      await click("gslot:30", 5);
      await click("pass", 2);
      expect([...(await current()).go_players.keys()]).toEqual([1, 3, 4, 5, 6]);
      await processUpdate(text("/fort 20", 2));
      expect([...(await current()).go_players.keys()]).toEqual([
        1, 3, 4, 5, 6, 2,
      ]);
    });
    it("applies clear messages, keeps readiness until changed, and never roasts a handled reply", async () => {
      await processUpdate(text("/fort 18"));
      mocks.intent.mockResolvedValueOnce({ action: "ready" });
      await processUpdate(text("зашёл"));
      expect((await current()).ready_players?.has(1)).toBe(true);
      expect(calls.some((c) => c.method === "setMessageReaction")).toBe(true);
      expect(mocks.roast).not.toHaveBeenCalled();
      mocks.intent.mockResolvedValueOnce({ action: "ignore" });
      await processUpdate(text("зашёл в магазин"));
      expect((await current()).ready_players?.has(1)).toBe(true);
      mocks.intent.mockResolvedValueOnce({
        action: "away",
        at: at("16:20:00"),
      });
      await processUpdate(text("отошёл на 20 минут"));
      expect((await current()).ready_players?.has(1)).toBe(false);
      expect((await current()).availability?.get(1)).toBe(at("16:20:00"));
    });
    it("accepts newcomers only when addressed and does not accidentally rejoin a passer", async () => {
      await processUpdate(text("/fort 18"));
      await processUpdate(text("зашёл", 2));
      expect(mocks.intent).not.toHaveBeenCalled();
      mocks.intent.mockResolvedValueOnce({
        action: "set_time",
        at: at("19:00:00"),
      });
      await processUpdate(
        text("буду в девять", 2, (await current()).message_id),
      );
      expect((await current()).go_players.has(2)).toBe(true);
      await click("pass", 2);
      mocks.intent.mockResolvedValueOnce({ action: "ready", rejoin: false });
      await processUpdate(text("зашёл", 2));
      expect((await current()).go_players.has(2)).toBe(false);
      mocks.intent.mockResolvedValueOnce({ action: "ready", rejoin: true });
      await processUpdate(text("всё-таки буду, я в лобби", 2));
      expect((await current()).ready_players?.has(2)).toBe(true);
    });
    it("binds confirmations to the author and invalidates them after a newer status", async () => {
      await processUpdate(text("/fort 18"));
      mocks.intent.mockResolvedValueOnce({
        action: "set_time",
        at: at("19:00:00"),
        confirm: true,
      });
      await processUpdate(text("наверное в девять"));
      const prompt = messageId;
      await click(`gconfirm:${(await current()).message_id}`, 2, prompt);
      expect((await current()).availability?.get(1)).toBe(at("18:00:00"));
      await processUpdate(text("/fort 20"));
      await click(`gconfirm:${(await current()).message_id}`, 1, prompt);
      expect((await current()).availability?.get(1)).toBe(at("20:00:00"));
    });
    it("lets only the prompt author answer own-time and rejects an expired prompt", async () => {
      await processUpdate(text("/fort 18"));
      await click("gtime");
      const prompt = messageId;
      await processUpdate(text("19:30", 2, prompt));
      expect((await current()).go_players.has(2)).toBe(false);
      await processUpdate(text("19:30", 1, prompt));
      expect((await current()).availability?.get(1)).toBe(at("19:30:00"));
      await click("gtime");
      const expired = messageId;
      vi.mocked(Date.now).mockReturnValue(at("16:11:00") * 1000);
      await processUpdate(text("20:00", 1, expired));
      expect((await current()).availability?.get(1)).toBe(at("19:30:00"));
    });
    it("sends one start notice for two players and rechecks changes before execution", async () => {
      await processUpdate(text("/fort 16:14"));
      await processUpdate(text("/fort 16:32", 2));
      const sends = () =>
        calls.filter(
          (c) =>
            c.method === "sendMessage" &&
            String(c.body.text).startsWith("🎮 Можно начинать"),
        );
      await tick("before");
      expect(sends()).toHaveLength(0);
      vi.mocked(Date.now).mockReturnValue(at("16:15:00") * 1000);
      await tick("due");
      await tick("duplicate");
      expect(sends()).toHaveLength(1);
      await processUpdate(text("/fort 18"));
      await processUpdate(text("/fort 18", 2));
      vi.mocked(Date.now).mockReturnValue(at("18:00:00") * 1000);
      await tick("later");
      expect(sends()).toHaveLength(1);
    });
    it("does not ping one player or an already ready roster", async () => {
      await processUpdate(text("/fort"));
      await tick("single");
      await processUpdate(text("/fort через час", 2));
      await click("gready", 1);
      await click("gready", 2);
      vi.mocked(Date.now).mockReturnValue(at("16:10:00") * 1000);
      await tick("all-ready");
      expect(
        calls.filter(
          (c) =>
            c.method === "sendMessage" &&
            String(c.body.text).startsWith("🎮 Можно начинать"),
        ),
      ).toHaveLength(0);
    });
    it("archives only at midnight, unpins only its own card, and never counts evening end as expiry", async () => {
      await processUpdate(text("/fort"));
      const session = await current();
      vi.mocked(Date.now).mockReturnValue(at("23:59:00") * 1000);
      await tick("late");
      expect((await current()).message_id).toBe(session.message_id);
      vi.mocked(Date.now).mockReturnValue(
        (eveningEnd(session.created_at) + 1) * 1000,
      );
      await tick("midnight");
      expect(await current()).toBeUndefined();
      const closed = await invocation(chat, () =>
        db.load_session(session.message_id, chat),
      );
      expect(closed).toMatchObject({
        is_closed: true,
        is_expired: false,
        gathering: { close_reason: "evening_end" },
      });
      expect(
        calls.find((c) => c.method === "unpinChatMessage")?.body.message_id,
      ).toBe(session.message_id);
    });
    it("/rm deletes the card and obsoletes queued work, with graceful deletion denial", async () => {
      await processUpdate(text("/fort 18"));
      const first = await current();
      await processUpdate(text("/rm"));
      expect(
        calls.some(
          (c) =>
            c.method === "deleteMessage" &&
            c.body.message_id === first.message_id,
        ),
      ).toBe(true);
      expect(await current()).toBeUndefined();
      vi.mocked(Date.now).mockReturnValue(at("16:01:00") * 1000);
      await processUpdate(text("/fort 18"));
      reject = "deleteMessage";
      await processUpdate(text("/rm"));
      expect(await current()).toBeUndefined();
      expect(
        calls.some(
          (c) =>
            c.method === "sendMessage" &&
            String(c.body.text).includes("не разрешил удалить"),
        ),
      ).toBe(true);
    });
    it("replays a committed status after failed editing without duplicating or losing FIFO", async () => {
      await processUpdate(text("/fort 18"));
      mocks.intent.mockResolvedValueOnce({ action: "ready" });
      failEdit = true;
      const update = text("зашёл");
      expect(await processUpdate(update)).toBe("failed");
      expect((await current()).ready_players?.has(1)).toBe(true);
      expect(await drainChat(chat, createBot())).toBe("complete");
      expect(mocks.intent).toHaveBeenCalledTimes(1);
      expect((await current()).ready_players?.has(1)).toBe(true);
    });
    it("rejoins an explicit return without inventing a ready status or time", async () => {
      await processUpdate(text("/fort 18"));
      await click("pass");
      mocks.intent.mockResolvedValueOnce({ action: "join", rejoin: true });
      await processUpdate(text("всё-таки буду"));
      const session = await current();
      expect(session.go_players.has(1)).toBe(true);
      expect(session.availability?.has(1)).toBe(false);
      expect(session.ready_players?.has(1)).toBe(false);
    });
    it("rejects a stale own-time reply after a newer command", async () => {
      await processUpdate(text("/fort 18"));
      await click("gtime");
      const oldPrompt = messageId;
      await processUpdate(text("/fort 20"));
      await processUpdate(text("19:00", 1, oldPrompt));
      expect((await current()).availability?.get(1)).toBe(at("20:00:00"));
      expect(mocks.intent).not.toHaveBeenCalled();
    });
    it("replays confirmation after committed SQL and failed editing", async () => {
      await processUpdate(text("/fort 18"));
      mocks.intent.mockResolvedValueOnce({
        action: "set_time",
        at: at("19:00:00"),
        confirm: true,
      });
      await processUpdate(text("наверное в семь"));
      const oldPrompt = messageId;
      failEdit = true;
      expect(
        await click(`gconfirm:${(await current()).message_id}`, 1, oldPrompt),
      ).toBe("failed");
      expect(await drainChat(chat, createBot())).toBe("complete");
      expect((await current()).availability?.get(1)).toBe(at("19:00:00"));
    });
    it("does not repeat a delivered notice after failed persistence", async () => {
      await processUpdate(text("/fort"));
      await processUpdate(text("/fort 18", 2));
      const save = db.save_session;
      let interrupted = false;
      vi.spyOn(db, "save_session").mockImplementation(async (session) => {
        if (session.gathering?.notified_at && !interrupted) {
          interrupted = true;
          throw new Error("interrupted persistence");
        }
        return save(session);
      });
      expect(await tick("notice-retry")).toBe("failed");
      expect(await drainChat(chat, createBot())).toBe("complete");
      expect(
        calls.filter(
          (c) =>
            c.method === "sendMessage" &&
            String(c.body.text).startsWith("🎮 Можно начинать"),
        ),
      ).toHaveLength(1);
      expect((await current()).gathering?.notified_at).toBe(at("16:00:00"));
    });
    it("blocks ambiguous notice sends rather than sending again", async () => {
      await processUpdate(text("/fort"));
      await processUpdate(text("/fort 18", 2));
      failNotice = true;
      expect(await tick("notice-ambiguous")).toBe("ambiguous");
      expect(await drainChat(chat, createBot())).toBe("ambiguous");
      expect(
        calls.filter(
          (c) =>
            c.method === "sendMessage" &&
            String(c.body.text).startsWith("🎮 Можно начинать"),
        ),
      ).toHaveLength(1);
    });
    it("finishes midnight archiving after the closed row committed but the edit failed", async () => {
      await processUpdate(text("/fort"));
      const session = await current();
      vi.mocked(Date.now).mockReturnValue(
        (eveningEnd(session.created_at) + 1) * 1000,
      );
      failEdit = true;
      expect(await tick("close-retry")).toBe("failed");
      expect(await current()).toBeUndefined();
      expect(await drainChat(chat, createBot())).toBe("complete");
      expect(
        calls.filter(
          (c) =>
            c.method === "editMessageText" &&
            String(c.body.text).includes("Вечер завершён"),
        ),
      ).toHaveLength(2);
    });
    it("continues gathering when pinning is forbidden and rejects tomorrow without creating a card", async () => {
      await processUpdate(text("/fort завтра в 18"));
      expect(await current()).toBeUndefined();
      reject = "pinChatMessage";
      expect(await processUpdate(text("/fort"))).toBe("complete");
      expect((await current()).go_players.has(1)).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.method === "sendMessage" &&
            String(c.body.text).includes("закрепить карточку не удалось"),
        ),
      ).toBe(true);
    });
    it("rejects full reserve and preserves readiness without manufacturing completion", async () => {
      await processUpdate(text("/fort 18"));
      const session = await current();
      await invocation(chat, async () => {
        for (let id = 2; id <= 8; id++)
          expect(
            await changePlayer(
              session,
              id,
              `user${id}`,
              { action: "set_time", at: at("19:00:00") },
              at("16:00:00"),
            ),
          ).toBeNull();
        expect(
          await changePlayer(
            session,
            9,
            "nine",
            { action: "ready" },
            at("16:00:00"),
          ),
        ).toBe("Резерв заполнен.");
      });
      const loaded = await current();
      expect(loaded.is_complete).toBe(true);
      expect(buildGatherText(loaded, at("16:00:00"))).toContain(
        "Состав набран",
      );
      expect(buildGatherText(loaded, at("16:00:00"))).not.toContain(
        "Все готовы играть",
      );
    });
  },
);
