import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { invocation, migrate, raw } from "../src/bot/storage";
import {
  checkDatabase,
  checkProductionDatabase,
  checkSchema,
} from "../src/bot/readiness";
import { schemaContract } from "../src/bot/schema-contract";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
afterEach(() => vi.unstubAllEnvs());

describe("production database gate", () => {
  it("does not contact a database during local or CI builds", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL_NON_POOLING", "");
    await expect(checkProductionDatabase()).resolves.toBeUndefined();
  });
  it("refuses production builds with no database configuration", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL_NON_POOLING", "");
    await expect(checkProductionDatabase()).rejects.toThrow(
      "DATABASE_URL is not configured",
    );
  });
});

suite("database readiness on disposable Postgres", () => {
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

  it("checks the fully migrated release without reading or modifying application rows", async () => {
    await invocation(null, () =>
      raw(
        "INSERT INTO service_state(key,value) VALUES ('readiness-test', '{\"preserved\":true}') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      ),
    );
    await expect(checkDatabase()).resolves.toBeUndefined();
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT value FROM service_state WHERE key='readiness-test'",
          )
        ).rows,
      ).toEqual([{ value: { preserved: true } }]);
      await raw("DELETE FROM service_state WHERE key='readiness-test'");
    });
  });

  it("rejects an unapplied migration even when the schema is compatible", async () => {
    await expect(checkDatabase(["29990101000000"])).rejects.toMatchObject({
      code: "DATABASE_SCHEMA_NOT_READY",
    });
    await expect(checkDatabase()).resolves.toBeUndefined();
  });

  it("checks every migration bundled in a production release", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(checkProductionDatabase()).resolves.toBeUndefined();
    const removed = await invocation(null, () =>
      raw(
        "DELETE FROM supabase_migrations.schema_migrations WHERE version='20261004125309' RETURNING version,name,statements",
      ),
    );
    try {
      await expect(checkDatabase()).resolves.toBeUndefined();
      await expect(checkProductionDatabase()).rejects.toMatchObject({
        code: "DATABASE_SCHEMA_NOT_READY",
      });
    } finally {
      const row = removed.rows[0];
      await invocation(null, () =>
        raw(
          "INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ($1,$2,$3)",
          [row.version, row.name, row.statements],
        ),
      );
    }
  });

  it("requires the contract to cover every migrated application table and column", async () => {
    await invocation(null, async () => {
      const actual = (
        await raw<{ table_name: string; column_name: string }>(
          "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='fortnite_bot' AND table_name<>'migrations' ORDER BY table_name,column_name",
        )
      ).rows;
      const expected = Object.entries(schemaContract)
        .flatMap(([table_name, columns]) =>
          columns
            .split(" ")
            .map((column_name) => ({ table_name, column_name })),
        )
        .sort(
          (a, b) =>
            a.table_name.localeCompare(b.table_name) ||
            a.column_name.localeCompare(b.column_name),
        );
      expect(actual).toEqual(expected);
    });
  });

  it.each(["approved_chats", "statistics_cache"])(
    "rejects missing %s even if other bot tables exist",
    async (table) => {
      await invocation(null, async () => {
        await raw(`ALTER TABLE ${table} RENAME TO readiness_hidden`);
        try {
          await expect(checkSchema()).rejects.toMatchObject({
            code: "DATABASE_SCHEMA_NOT_READY",
          });
          // Failure rolled back its read-only transaction, leaving the connection usable.
          expect((await raw("SELECT 1 AS ok")).rows[0].ok).toBe(1);
        } finally {
          await raw(`ALTER TABLE readiness_hidden RENAME TO ${table}`);
        }
      });
    },
  );

  it("rejects missing columns despite an existing table and migration journal", async () => {
    await invocation(null, async () => {
      await raw(
        "ALTER TABLE statistics_cache RENAME COLUMN retry_after TO readiness_hidden",
      );
      try {
        await expect(checkSchema()).rejects.toMatchObject({ code: "42703" });
      } finally {
        await raw(
          "ALTER TABLE statistics_cache RENAME COLUMN readiness_hidden TO retry_after",
        );
      }
    });
  });

  it("rejects an incorrect search path instead of trusting a TCP connection", async () => {
    await invocation(null, async () => {
      await raw("SET search_path = public");
      await expect(checkSchema()).rejects.toMatchObject({
        code: "DATABASE_SCHEMA_NOT_READY",
      });
    });
  });

  it("rejects disabled RLS", async () => {
    await invocation(null, async () => {
      await raw("ALTER TABLE approved_chats DISABLE ROW LEVEL SECURITY");
      try {
        await expect(checkSchema()).rejects.toMatchObject({
          code: "DATABASE_SCHEMA_NOT_READY",
        });
      } finally {
        await raw("ALTER TABLE approved_chats ENABLE ROW LEVEL SECURITY");
      }
    });
  });
});
