import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import * as db from "../src/bot/db";
import { invocation, migrate, raw } from "../src/bot/storage";
import {
  drainChat,
  enqueue,
  executeItem,
  recoverPending,
} from "../src/bot/runtime";
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../src/bot/snapshots", () => ({ executeSnapshot: mocks.execute }));
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Postgres snapshot recovery lane", () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      target.pathname !== "/fortnite_test"
    )
      throw new Error("disposable localhost fortnite_test required");
    process.env.DATABASE_URL = url;
    process.env.DATABASE_LOCAL_TEST = "1";
    await migrate();
  });
  beforeEach(async () => {
    mocks.execute.mockReset();
    await invocation(null, async () => {
      await raw(
        "TRUNCATE approved_chats,roast_profiles,sessions,responses,work_items,work_steps,roast_state,chat_features,epic_links,squad_snapshots,service_state CASCADE",
      );
    });
    await invocation(null, () =>
      raw(
        "INSERT INTO approved_chats(chat_id,approved_by) VALUES (-10,1),(-11,1),(-12,1),(-13,1),(-20,1),(-100,1),(-200,1) ON CONFLICT DO NOTHING",
      ),
    );
    await invocation(null, async () => {
      await raw(
        "INSERT INTO sessions(chat_id,message_id,initiator_id,initiator_name,created_at) VALUES (-10,99999,1,'User',now()) ON CONFLICT DO NOTHING",
      );
      await raw(
        "INSERT INTO responses(chat_id,message_id,user_id,user_name,response,responded_at) SELECT -10,99999,n,'User','go',now() FROM generate_series(1000,1022) n ON CONFLICT DO NOTHING",
      );
      await raw(`INSERT INTO epic_links(user_id,user_name,epic_name,epic_account_id,linked_at)
      SELECT 1000+n,'user','Epic',CASE WHEN n=21 THEN 'broken' WHEN n=22 THEN 'healthy' ELSE n::text END,now() FROM generate_series(0,22) n`);
    });
  });
  it("snapshot failures cannot block chat updates or later accounts, and complete items stay complete", async () => {
    const bot = {
      isInited: () => true,
      handleUpdate: vi.fn(async () => {}),
    } as unknown as Bot;
    mocks.execute.mockImplementation(
      async (payload: { account_id: string }) => {
        if (payload.account_id === "broken") throw new Error("provider outage");
      },
    );
    await invocation(null, async () => {
      await enqueue("snapshot:broken", "snapshot", null, {
        account_id: "broken",
      });
      await enqueue("snapshot:healthy", "snapshot", null, {
        account_id: "healthy",
      });
      await enqueue("update:1", "update", -10, { update_id: 1 });
      await recoverPending(bot);
      expect(
        (await raw("SELECT id,status FROM work_items ORDER BY id")).rows,
      ).toEqual([
        { id: "snapshot:broken", status: "failed" },
        { id: "snapshot:healthy", status: "complete" },
        { id: "update:1", status: "complete" },
      ]);
      await recoverPending(bot);
      expect(
        mocks.execute.mock.calls.filter(
          ([payload]) => payload.account_id === "healthy",
        ),
      ).toHaveLength(1);
    });
    expect(bot.handleUpdate).toHaveBeenCalledOnce();
  });
  it("rotates a batch of failed accounts so later pending accounts get a turn", async () => {
    const bot = {} as Bot;
    mocks.execute.mockRejectedValue(new Error("provider outage"));
    await invocation(null, async () => {
      for (let i = 0; i < 21; i++)
        await enqueue(`snapshot:${i}`, "snapshot", null, {
          account_id: String(i),
        });
      await raw(
        "UPDATE work_items SET created_at=now()-interval '1 day',updated_at=now()-interval '1 day'",
      );
      await recoverPending(bot);
      expect(mocks.execute).toHaveBeenCalledTimes(20);
      const untouched = (
        await raw("SELECT id FROM work_items WHERE attempts=0")
      ).rows[0].id;
      await recoverPending(bot);
      expect(
        (await raw("SELECT attempts FROM work_items WHERE id=$1", [untouched]))
          .rows[0].attempts,
      ).toBe(1);
    });
  });
  it("retires unstarted stale weekly work under the chat lock", async () => {
    const bot = {
      isInited: () => true,
      handleUpdate: vi.fn(async () => {}),
    } as unknown as Bot;
    await invocation(null, async () => {
      await enqueue("weekly:old", "weekly", -10, {
        now: Date.now() / 1000 - 8 * 86400,
      });
      await enqueue("update:after", "update", -10, { update_id: 1 });
    });
    expect(await drainChat(-10, bot)).toBe("complete");
    expect(bot.handleUpdate).toHaveBeenCalledOnce();
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT status,attempts FROM work_items WHERE id='weekly:old'",
          )
        ).rows[0],
      ).toEqual({ status: "complete", attempts: 0 });
    });
  });
  it("replays started stale weekly reads instead of retiring the work", async () => {
    const bot = {
      isInited: () => true,
      api: { sendMessage: vi.fn(async () => {}) },
    } as unknown as Bot;
    await invocation(null, async () => {
      await enqueue("weekly:started", "weekly", -10, {
        now: Date.now() / 1000 - 8 * 86400,
      });
      // Real hydration/read checkpoints are produced by the first failed
      // execution, then recovered with the original ordering and SQL signatures.
    });
    const save = vi
      .spyOn(db, "save_roast_state")
      .mockRejectedValueOnce(new Error("temporary database outage"));
    expect(
      await invocation(-10, async () =>
        executeItem(
          {
            id: "weekly:started",
            kind: "weekly",
            chat_id: -10,
            status: "pending",
            payload: { now: Date.now() / 1000 - 8 * 86400 },
          },
          bot,
        ),
      ),
    ).toBe("failed");
    save.mockRestore();
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT count(*)::int AS count FROM work_steps WHERE work_id='weekly:started'",
          )
        ).rows[0].count,
      ).toBeGreaterThan(0);
    });
    expect(await drainChat(-10, bot)).toBe("complete");
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT status,attempts FROM work_items WHERE id='weekly:started'",
          )
        ).rows[0],
      ).toEqual({ status: "complete", attempts: 2 });
    });
  });
});
