import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { invocation, migrate, raw } from "../src/bot/storage";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("Supabase migration compatibility", () => {
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

  it("creates bot tables only in the private schema with RLS", async () => {
    await invocation(null, async () => {
      const tables = await raw<{ tablename: string; rowsecurity: boolean }>(
        "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='fortnite_bot'",
      );
      expect(tables.rows.length).toBeGreaterThan(10);
      expect(tables.rows.every((table) => table.rowsecurity)).toBe(true);
      const publicTables = await raw(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1)",
        [tables.rows.map((table) => table.tablename)],
      );
      expect(publicTables.rows).toEqual([]);
    });
  });

  it("removes retired tables and preserves roast preferences while updating cleanup", async () => {
    const sql = await readFile(
      new URL(
        "../supabase/migrations/20261004154824_remove_legacy_storage.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await invocation(null, async () => {
      await raw("BEGIN");
      try {
        await raw(
          "CREATE TABLE import_manifest(id integer); CREATE TABLE news_sent(id integer); CREATE TABLE fortnite_news_seen(id integer)",
        );
        await raw(
          "CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text, command text)",
        );
        await raw(
          "INSERT INTO cron.job VALUES ('fortnite-cleanup','SELECT 1 FROM fortnite_bot.import_manifest')",
        );
        await raw(
          "INSERT INTO chat_features(chat_id,feature,enabled) VALUES (-99901,'roast',true),(-99902,'roast',false)",
        );
        await raw(
          'INSERT INTO roast_profiles(chat_id,preferences) VALUES (-99902,\'{"length":"brief"}\')',
        );
        await raw(sql);
        expect(
          (
            await raw(
              "SELECT chat_id,preferences FROM roast_profiles WHERE chat_id IN (-99901,-99902) ORDER BY chat_id",
            )
          ).rows,
        ).toEqual([
          { chat_id: -99902, preferences: { length: "brief" } },
          { chat_id: -99901, preferences: { proactive: true } },
        ]);
        expect(
          (
            await raw(
              "SELECT to_regclass('fortnite_bot.import_manifest') AS marker,to_regclass('fortnite_bot.news_sent') AS news,to_regclass('fortnite_bot.fortnite_news_seen') AS seen",
            )
          ).rows[0],
        ).toEqual({ marker: null, news: null, seen: null });
        expect(
          (
            await raw(
              "SELECT command FROM cron.job WHERE jobname='fortnite-cleanup'",
            )
          ).rows[0].command,
        ).toContain("interval '30 days'");
        expect(
          (await raw("SELECT 1 FROM chat_features WHERE feature='roast'")).rows,
        ).toEqual([]);
      } finally {
        await raw("ROLLBACK");
      }
    });
  });

  it("adopts legacy history without replaying DDL or changing stored data", async () => {
    const before = await invocation(null, async () => {
      await raw(
        "INSERT INTO service_state(key,value) VALUES ('migration-test', '{\"preserved\":true}') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      );
      const constraint = await raw(
        "SELECT oid FROM pg_constraint WHERE conrelid IN ('fortnite_bot.sessions'::regclass, 'fortnite_bot.statistics_cache'::regclass) AND contype='p' ORDER BY oid",
      );
      const history = await raw(
        "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version",
      );
      await raw(
        "DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20261004123945', '20261004123946', '20261004125048')",
      );
      return { constraints: constraint.rows, history: history.rows };
    });
    await migrate();
    await migrate();
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT value FROM service_state WHERE key='migration-test'",
          )
        ).rows,
      ).toEqual([{ value: { preserved: true } }]);
      expect(
        (
          await raw(
            "SELECT oid FROM pg_constraint WHERE conrelid IN ('fortnite_bot.sessions'::regclass, 'fortnite_bot.statistics_cache'::regclass) AND contype='p' ORDER BY oid",
          )
        ).rows,
      ).toEqual(before.constraints);
      expect(
        (
          await raw(
            "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version",
          )
        ).rows,
      ).toEqual(before.history);
      await raw("DELETE FROM service_state WHERE key='migration-test'");
    });
  });
});
