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

  it("adopts legacy history without replaying DDL or changing stored data", async () => {
    const before = await invocation(null, async () => {
      await raw(
        "INSERT INTO service_state(key,value) VALUES ('migration-test', '{\"preserved\":true}') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      );
      const constraint = await raw(
        "SELECT oid FROM pg_constraint WHERE conrelid='fortnite_bot.sessions'::regclass AND contype='p'",
      );
      const history = await raw(
        "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version",
      );
      await raw(
        "DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20261004123945', '20261004123946')",
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
            "SELECT oid FROM pg_constraint WHERE conrelid='fortnite_bot.sessions'::regclass AND contype='p'",
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
