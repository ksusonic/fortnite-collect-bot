import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { invocation, migrate, raw } from "../src/bot/storage";
import * as db from "../src/bot/db";
import { enqueueDailySnapshots } from "../src/bot/snapshots";
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("global Epic links", () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(target.hostname) ||
      target.pathname !== "/fortnite_test"
    )
      throw new Error(
        "tests require disposable localhost fortnite_test database",
      );
    process.env.DATABASE_URL = url;
    process.env.DATABASE_LOCAL_TEST = "1";
    await migrate();
  });
  it("shares relinks across participant chats and excludes bots and unrelated users", async () => {
    await invocation(null, async () => {
      await raw("BEGIN");
      try {
        await raw(
          "TRUNCATE sessions,responses,epic_links,approved_chats,work_items CASCADE",
        );
        await raw(
          "INSERT INTO sessions(chat_id,message_id,initiator_id,initiator_name,created_at) VALUES (-10,1,7,'User',now()),(-20,1,7,'User',now()),(-30,1,7,'User',now())",
        );
        await raw(
          "INSERT INTO responses(chat_id,message_id,user_id,user_name,response,responded_at,is_bot) VALUES (-10,1,7,'User','go',now(),false),(-10,1,7+1,'Bot','go',now(),true),(-20,1,7,'User','pass',now(),false),(-30,1,9,'Unapproved','go',now(),false)",
        );
        await raw(
          "INSERT INTO approved_chats(chat_id,approved_by) VALUES (-10,1),(-20,1)",
        );
        await db.save_epic_link(7, "User", "Old", "old");
        await db.save_epic_link(7, "User", "New", "new");
        await db.save_epic_link(8, "Bot", "Bot", "bot");
        await db.save_epic_link(9, "Other", "Other", "other");
        expect((await db.get_epic_link(7))?.epic_account_id).toBe("new");
        for (const chat of [-10, -20])
          expect(
            (await db.get_chat_epic_links(chat)).map((l) => l.epic_account_id),
          ).toEqual(["new"]);
        expect(await db.get_chat_epic_links(-40)).toEqual([]);
        expect((await db.get_chats_with_epic_links()).sort()).toEqual([
          -10, -20,
        ]);
        vi.stubEnv("FORTNITE_API_KEY", "test-key");
        await enqueueDailySnapshots(Date.now() / 1000);
        expect(
          (
            await raw(
              "SELECT payload->>'account_id' AS account FROM work_items WHERE kind='snapshot'",
            )
          ).rows,
        ).toEqual([{ account: "new" }]);
      } finally {
        await raw("ROLLBACK");
        vi.unstubAllEnvs();
      }
    });
  });
  it("migrates duplicate users deterministically and keeps the private RLS table", async () => {
    const sql = await readFile(
      new URL(
        "../supabase/migrations/20261004172914_global_epic_links.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await invocation(null, async () => {
      await raw("BEGIN");
      try {
        await raw("TRUNCATE epic_links");
        await raw(
          "ALTER TABLE epic_links DROP CONSTRAINT epic_links_pkey; ALTER TABLE epic_links ADD COLUMN chat_id bigint NOT NULL DEFAULT -10; ALTER TABLE epic_links ADD PRIMARY KEY(chat_id,user_id)",
        );
        await raw(
          "INSERT INTO epic_links(chat_id,user_id,user_name,epic_name,epic_account_id,linked_at) VALUES (-10,7,'Old','Old','old','2026-10-01'),(-20,7,'New','New','new','2026-10-02'),(-30,8,'Tie','Tie','tie-old','2026-10-02'),(-10,8,'Tie','Tie','tie-new','2026-10-02')",
        );
        await raw(sql);
        expect(
          (
            await raw(
              "SELECT user_id,epic_account_id FROM epic_links ORDER BY user_id",
            )
          ).rows,
        ).toEqual([
          { user_id: 7, epic_account_id: "new" },
          { user_id: 8, epic_account_id: "tie-new" },
        ]);
        expect(
          (
            await raw(
              "SELECT column_name FROM information_schema.columns WHERE table_schema='fortnite_bot' AND table_name='epic_links' AND column_name='chat_id'",
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await raw(
              "SELECT relrowsecurity FROM pg_class WHERE oid='fortnite_bot.epic_links'::regclass",
            )
          ).rows[0].relrowsecurity,
        ).toBe(true);
        await expect(
          raw(
            "INSERT INTO epic_links VALUES (7,'Duplicate','Duplicate','duplicate',now())",
          ),
        ).rejects.toThrow();
      } finally {
        await raw("ROLLBACK");
        vi.unstubAllEnvs();
      }
    });
  });
});
