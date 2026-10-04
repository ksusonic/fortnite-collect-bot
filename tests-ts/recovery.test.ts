import * as undici from "undici";
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot, BotError } from "grammy";
import * as db from "../src/bot/db";
import {
  advisoryLock,
  databaseConfig,
  invocation,
  lockKey,
  migrate,
  raw,
  withWork,
} from "../src/bot/storage";
import {
  AmbiguousOutcome,
  Work,
  valueCheckpoint,
  externalCheckpoint,
} from "../src/bot/work";
import { createBot, drainChat, enqueue, executeItem } from "../src/bot/runtime";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("Postgres recovery and storage", () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(target.hostname) ||
      !target.pathname.endsWith("/fortnite_test")
    )
      throw new Error(
        "tests require disposable localhost fortnite_test database",
      );
    process.env.DATABASE_URL = url;
    process.env.DATABASE_LOCAL_TEST = "1";
    await migrate();
  });
  beforeEach(async () => {
    await invocation(null, async () => {
      await raw(
        "TRUNCATE sessions,responses,chat_features,afk_mutes,roast_state,chat_fort_titles,epic_links,squad_snapshots,fort_cooldowns,work_steps,work_items,service_state,import_manifest CASCADE",
      );
    });
  });
  it("leaves queued work untouched when another invocation owns the chat", async () => {
    await invocation(null, () =>
      enqueue("update:overlap", "update", -99, { update_id: 99 }),
    );
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = invocation(-99, () =>
      advisoryLock("chat:-99", async () => {
        acquired();
        await hold;
      }),
    );
    await locked;
    const bot = { init: vi.fn() } as unknown as Bot;
    try {
      expect(await drainChat(-99, bot)).toBe("busy");
      expect(bot.init).not.toHaveBeenCalled();
      await invocation(null, async () => {
        expect(
          (
            await raw("SELECT status,attempts FROM work_items WHERE id=$1", [
              "update:overlap",
            ])
          ).rows[0],
        ).toMatchObject({ status: "pending", attempts: 0 });
      });
    } finally {
      release();
      await owner;
    }
    await invocation(-99, async () => {
      expect(
        await advisoryLock("chat:-99", async () => "available", false),
      ).toBe("available");
    });
  });
  it("uses Python-compatible advisory lock keys", () => {
    expect(lockKey("chat:-100")).toBe("-2749151833718385421");
  });
  it("preserves composite IDs, FIFO readiness changes and reserve promotion after reload", async () => {
    await invocation(-10, async () => {
      await db.save_session(
        db.newSession({
          chat_id: -10,
          message_id: 1,
          initiator_id: 1,
          initiator_name: "a",
        }),
      );
      await db.save_session(
        db.newSession({
          chat_id: -11,
          message_id: 1,
          initiator_id: 2,
          initiator_name: "b",
        }),
      );
      for (const uid of [90, 3, 70, 4, 50])
        await db.save_response(1, uid, String(uid), "go", {
          time_slot: "19:00",
        });
      await db.save_response(1, 90, "90", "go", { time_slot: "20:00" });
      const before = await db.load_session(1);
      expect([...before!.go_players.keys()]).toEqual([90, 3, 70, 4, 50]);
      expect(before!.player_slots.get(90)).toBe("20:00");
      await db.save_response(1, 3, "3", "pass");
      await db.save_response(1, 3, "3", "go", { time_slot: "21:00" });
      expect([...(await db.load_session(1))!.go_players.keys()]).toEqual([
        90, 70, 4, 50, 3,
      ]);
      expect((await db.load_session(1, -11))!.go_players.size).toBe(0);
    });
  });
  it("enforces one open session while filled sessions remain editable", async () => {
    await invocation(-10, async () => {
      await db.save_session(
        db.newSession({
          chat_id: -10,
          message_id: 1,
          initiator_id: 1,
          initiator_name: "a",
          is_complete: true,
        }),
      );
      await expect(
        db.save_session(
          db.newSession({
            chat_id: -10,
            message_id: 2,
            initiator_id: 1,
            initiator_name: "a",
          }),
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await db.mark_closed(1);
      await db.save_session(
        db.newSession({
          chat_id: -10,
          message_id: 2,
          initiator_id: 1,
          initiator_name: "a",
        }),
      );
      expect(
        (await db.load_active_sessions()).map((s) => s.message_id),
      ).toEqual([2]);
    });
  });
  it("replays original reads and values after a committed mutation", async () => {
    await invocation(-10, async () => {
      await enqueue("retry", "update", -10, {});
      const replay = () =>
        withWork(new Work("retry"), async () => {
          const time = await valueCheckpoint("time", () => 123);
          const prior = await db.is_feature_enabled(-10, "roast");
          await db.set_feature(-10, "roast", true);
          return { time, prior };
        });
      expect(await replay()).toEqual({ time: 123, prior: false });
      expect(await replay()).toEqual({ time: 123, prior: false });
      expect(
        (await raw("SELECT enabled FROM chat_features")).rows[0].enabled,
      ).toBe(true);
    });
  });
  it("replays generation and appended memory writes without changing older checkpoint order", async () => {
    await invocation(-10, async () => {
      await enqueue("memory-retry", "update", -10, {});
      const generate = vi.fn().mockResolvedValue("reply");
      const store = vi.fn().mockResolvedValue(true);
      // An old invocation completed generation before this version was deployed.
      await withWork(new Work("memory-retry"), () =>
        externalCheckpoint("roast", generate),
      );
      const replay = () =>
        withWork(new Work("memory-retry"), async () => {
          const result = await externalCheckpoint("roast", generate);
          const saved = await externalCheckpoint("roast-memory-add", store);
          return { result, saved };
        });
      expect(await replay()).toEqual({ result: "reply", saved: true });
      expect(await replay()).toEqual({ result: "reply", saved: true });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(store).toHaveBeenCalledTimes(1);
    });
  });
  it("rolls SQL mutation back if checkpoint cannot commit", async () => {
    await invocation(-10, async () => {
      // Missing work parent violates the checkpoint FK after the SQL write.
      await expect(
        withWork(new Work("missing"), () => db.set_feature(-10, "roast", true)),
      ).rejects.toMatchObject({ code: "23503" });
      expect((await raw("SELECT * FROM chat_features")).rows).toEqual([]);
    });
  });
  it("does not resend completed or uncertain Telegram sends", async () => {
    await invocation(-10, async () => {
      await enqueue("send", "update", -10, {});
      let sends = 0;
      const send = async () => {
        sends++;
        return { ok: true, result: { message_id: 7 } };
      };
      expect(
        await new Work("send").telegram("sendMessage", { text: "hi" }, send),
      ).toEqual({ ok: true, result: { message_id: 7 } });
      await new Work("send").telegram("sendMessage", { text: "hi" }, send);
      expect(sends).toBe(1);
      await enqueue("uncertain", "update", -10, {});
      await expect(
        new Work("uncertain").telegram("sendMessage", {}, async () => {
          sends++;
          throw new Error("lost response");
        }),
      ).rejects.toBeInstanceOf(AmbiguousOutcome);
      await expect(
        new Work("uncertain").telegram("sendMessage", {}, send),
      ).rejects.toBeInstanceOf(AmbiguousOutcome);
      expect(sends).toBe(2);
      expect(
        (await raw("SELECT status FROM work_items WHERE id='uncertain'"))
          .rows[0].status,
      ).toBe("ambiguous");
    });
  });
  it("journals real grammY calls with HTML defaults and native bounded transport", async () => {
    const originalToken = process.env.BOT_TOKEN;
    process.env.BOT_TOKEN = "123:fake-test-token";
    const fetcher = vi
      .spyOn(undici, "fetch")
      .mockImplementation(async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          text: "<b>hello</b>",
          parse_mode: "HTML",
        });
        return new undici.Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 9,
              date: 1,
              chat: { id: -10, type: "group" },
              text: "hello",
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      });
    try {
      await invocation(-10, async () => {
        await enqueue("grammy", "update", -10, {});
        const bot = createBot();
        expect(
          (
            await withWork(new Work("grammy"), () =>
              bot.api.sendMessage(-10, "<b>hello</b>"),
            )
          ).message_id,
        ).toBe(9);
        expect(
          (
            await withWork(new Work("grammy"), () =>
              bot.api.sendMessage(-10, "<b>hello</b>"),
            )
          ).message_id,
        ).toBe(9);
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
    } finally {
      fetcher.mockRestore();
      if (originalToken === undefined) delete process.env.BOT_TOKEN;
      else process.env.BOT_TOKEN = originalToken;
    }
  });
  it("retries a definite 429 and preserves definitive Telegram rejections", async () => {
    await invocation(-10, async () => {
      await enqueue("rate", "update", -10, {});
      await new Work("rate").telegram("sendMessage", {}, async () => ({
        ok: false,
        error_code: 429,
        description: "slow",
      }));
      await new Work("rate").telegram("sendMessage", {}, async () => ({
        ok: true,
        result: true,
      }));
      await enqueue("reject", "update", -10, {});
      const response = { ok: false, error_code: 403, description: "forbidden" };
      await new Work("reject").telegram(
        "sendMessage",
        {},
        async () => response,
      );
      expect(
        await new Work("reject").telegram("sendMessage", {}, async () => {
          throw new Error("must not retry");
        }),
      ).toEqual(response);
    });
  });
  it("replays the original callback state after a committed response and failed edit", async () => {
    const originalToken = process.env.BOT_TOKEN;
    process.env.BOT_TOKEN = "123:fake-test-token";
    let editAttempts = 0;
    const fetcher = vi
      .spyOn(undici, "fetch")
      .mockImplementation(async (input) => {
        const method = String(input).split("/").at(-1);
        if (method === "editMessageText" && ++editAttempts === 1)
          throw new Error("edit connection interrupted");
        return new undici.Response(
          JSON.stringify({
            ok: true,
            result:
              method === "getMe"
                ? {
                    id: 123,
                    is_bot: true,
                    first_name: "Fort",
                    username: "fort_test_bot",
                  }
                : true,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      });
    try {
      await invocation(-10, async () => {
        await db.save_session(
          db.newSession({
            chat_id: -10,
            message_id: 20,
            initiator_id: 1,
            initiator_name: "one",
            time_slots: ["now"],
          }),
        );
        for (const id of [1, 2, 3])
          await db.save_response(20, id, `user${id}`, "go");
        const item = {
          id: "callback-retry",
          kind: "update",
          chat_id: -10,
          status: "pending",
          payload: {
            update_id: 1,
            callback_query: {
              id: "callback",
              chat_instance: "chat",
              data: "go",
              from: { id: 4, is_bot: false, first_name: "four" },
              message: {
                message_id: 20,
                date: 1,
                chat: { id: -10, type: "group" },
              },
            },
          },
        };
        await enqueue(item.id, item.kind, item.chat_id, item.payload);
        const bot = createBot();
        await bot.init();
        expect(await executeItem(item, bot)).toBe("failed");
        const committed = (await db.load_session(20))!;
        expect(committed.is_complete).toBe(true);
        expect([...committed.go_players.keys()]).toEqual([1, 2, 3, 4]);
        expect(await executeItem(item, bot)).toBe("complete");
        const recovered = (await db.load_session(20))!;
        expect(recovered.completed_at).toBe(committed.completed_at);
        expect([...recovered.go_players.keys()]).toEqual([1, 2, 3, 4]);
        expect(editAttempts).toBe(2);
        expect(
          fetcher.mock.calls.filter(([input]) =>
            String(input).endsWith("answerCallbackQuery"),
          ),
        ).toHaveLength(1);
      });
    } finally {
      fetcher.mockRestore();
      if (originalToken === undefined) delete process.env.BOT_TOKEN;
      else process.env.BOT_TOKEN = originalToken;
    }
  });
  it("propagates grammY-wrapped ambiguity and blocks later chat work", async () => {
    await invocation(-10, async () => {
      await enqueue("first", "update", -10, { update_id: 1 });
      await enqueue("later", "update", -10, { update_id: 2 });
      const bot = {
        handleUpdate: async () => {
          await raw(
            "UPDATE work_items SET status='ambiguous' WHERE id='first'",
          );
          throw new BotError(new AmbiguousOutcome("first"), {} as never);
        },
      } as unknown as Bot;
      expect(
        await executeItem(
          {
            id: "first",
            kind: "update",
            chat_id: -10,
            status: "pending",
            payload: { update_id: 1 },
          },
          bot,
        ),
      ).toBe("ambiguous");
    });
    const bot = {
      isInited: () => true,
      handleUpdate: async () => {
        throw new Error("later must not execute");
      },
    } as unknown as Bot;
    expect(await drainChat(-10, bot)).toBe("ambiguous");
    await invocation(null, async () => {
      expect(
        (await raw("SELECT attempts FROM work_items WHERE id='later'")).rows[0]
          .attempts,
      ).toBe(0);
    });
  });
  it("releases session locks and isolates invocation state", async () => {
    await invocation(-10, async () => {
      db.getSessions().set(
        "test",
        db.newSession({
          chat_id: -10,
          message_id: 1,
          initiator_id: 1,
          initiator_name: "a",
        }),
      );
      await advisoryLock("test.lock", async () => {
        await invocation(-10, async () => {
          expect(db.getSessions().size).toBe(0);
          expect(
            await advisoryLock("test.lock", async () => true, false),
          ).toBeUndefined();
        });
      });
    });
    await invocation(null, async () => {
      expect(await advisoryLock("test.lock", async () => true, false)).toBe(
        true,
      );
    });
  });
  it("keeps AFK, titles and weekly baselines durably scoped to chat/account", async () => {
    await invocation(-10, async () => {
      await db.set_afk(-10, 1, 123456);
      expect(await db.get_afk_until(-10, 1)).toBe(123456);
      await db.clear_afk(-10, 1);
      expect(await db.get_afk_until(-10, 1)).toBeNull();
      await db.set_fort_title(-10, "FORT");
      expect(await db.get_fort_title(-10)).toBe("FORT");
      expect(await db.get_fort_title(-11)).toBeNull();
      await db.save_squad_snapshot(
        "epic",
        100,
        10,
        2,
        9,
        7,
        1.2,
        20,
        3,
        18,
        15,
        1.2,
      );
      expect(await db.get_snapshot_before("epic", 101, 99)).toMatchObject({
        overall_matches: 20,
      });
      expect(await db.get_snapshot_before("epic", 101, 100.5)).toBeNull();
    });
  });
});
describe("database configuration", () => {
  it("rejects transaction pooler", () => {
    const old = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://x:y@localhost:6543/db";
    expect(() => databaseConfig()).toThrow("session pooler");
    if (old) process.env.DATABASE_URL = old;
    else delete process.env.DATABASE_URL;
  });
});
