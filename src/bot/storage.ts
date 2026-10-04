import { SUPABASE_ROOT_CA } from "./supabase-ca";
import { rootCertificates } from "node:tls";
import { withHttpClient } from "./transport";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client, types, type QueryResultRow } from "pg";
import type { Session } from "./db";

export interface RoastEntry {
  role: "user" | "assistant";
  name: string;
  text: string;
  ts: number;
  message_id?: number;
  reply_to_id?: number;
}
export interface RoastState {
  history: RoastEntry[];
  message_ids: number[];
  last_roast: number | null;
}
export interface Checkpointer {
  databaseStep<T>(signature: string, factory: () => Promise<T>): Promise<T>;
  valueStep<T>(name: string, factory: () => T): Promise<T>;
  externalStep<T>(name: string, factory: () => Promise<T>): Promise<T>;
}
interface Invocation {
  client: Client;
  chat: number | null;
  work?: Checkpointer;
  sessions: Map<string, Session>;
  roast: Map<number, RoastState>;
  signal?: AbortSignal;
}
const context = new AsyncLocalStorage<Invocation>();
export function maybeCurrent() {
  return context.getStore();
}
export function current() {
  const state = context.getStore();
  if (!state) throw new Error("database access requires an invocation");
  return state;
}
export function connection() {
  return current().client;
}
export function getSessions() {
  return current().sessions;
}
export function getRoastState(chat: number): RoastState {
  const states = current().roast;
  if (!states.has(chat))
    states.set(chat, { history: [], message_ids: [], last_roast: null });
  return states.get(chat)!;
}
export function chatId(explicit?: number) {
  const chat = explicit ?? current().chat;
  if (chat === null)
    throw new Error("chat_id is required outside a chat invocation");
  return chat;
}
export function lockKey(name: string) {
  return createHash("sha256")
    .update(name)
    .digest()
    .readBigInt64BE(0)
    .toString();
}
export function databaseConfig() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const parsed = new URL(url);
  if (parsed.port === "6543")
    throw new Error("use the session pooler on port 5432 for advisory locks");
  const local = process.env.DATABASE_LOCAL_TEST === "1";
  if (local && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("DATABASE_LOCAL_TEST is restricted to localhost");
  }
  // Explicit TLS configuration cannot be weakened by connection-string sslmode.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    parsed.searchParams.delete(key);
  const parseNumber = (value: string) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("invalid database number");
    return number;
  };
  return {
    connectionString: parsed.toString(),
    ssl: local
      ? false
      : {
          rejectUnauthorized: true,
          ...(parsed.hostname.endsWith(".pooler.supabase.com")
            ? { ca: [...rootCertificates, SUPABASE_ROOT_CA] }
            : {}),
        },
    connectionTimeoutMillis: 10000,
    query_timeout: 20000,
    options: "-c search_path=fortnite_bot -c statement_timeout=20000",
    types: {
      getTypeParser(oid: number, format?: "text" | "binary") {
        if (format !== "binary" && [20, 1700].includes(oid))
          return (value: string) => {
            const number = parseNumber(value);
            if (oid === 20 && !Number.isSafeInteger(number))
              throw new Error("database bigint exceeds safe integer range");
            return number;
          };
        return types.getTypeParser(oid, format);
      },
    },
  };
}
export async function invocation<T>(
  chat: number | null,
  factory: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const client = new Client(databaseConfig());
  try {
    await client.connect();
    return await withHttpClient(
      () =>
        context.run(
          { client, chat, sessions: new Map(), roast: new Map(), signal },
          factory,
        ),
      signal,
    );
  } finally {
    await client.end();
  }
}
export function withWork<T>(
  work: Checkpointer,
  factory: () => Promise<T>,
): Promise<T> {
  return context.run(
    { ...current(), work, sessions: new Map(), roast: new Map() },
    factory,
  );
}
export function withoutWork<T>(factory: () => Promise<T>): Promise<T> {
  return context.run({ ...current(), work: undefined }, factory);
}
export async function raw<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
) {
  current().signal?.throwIfAborted();
  return connection().query<R>(sql, params);
}
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.getTime() / 1000;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, normalize(v)]),
    );
  return value;
}
export async function query<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  const factory = async () =>
    (await raw(sql, params)).rows.map((row) => normalize(row) as R);
  return current().work
    ? current().work!.databaseStep(sql, factory)
    : factory();
}
export async function transaction<T>(factory: () => Promise<T>): Promise<T> {
  await raw("BEGIN");
  try {
    const value = await factory();
    await raw("COMMIT");
    return value;
  } catch (error) {
    await connection().query("ROLLBACK");
    throw error;
  }
}
export async function advisoryLock<T>(
  name: string,
  factory: () => Promise<T>,
  wait = true,
): Promise<T | undefined> {
  const key = lockKey(name);
  const row = (
    await raw(
      `SELECT ${wait ? "pg_advisory_lock" : "pg_try_advisory_lock"}($1) AS acquired`,
      [key],
    )
  ).rows[0];
  if (!wait && !row.acquired) return undefined;
  try {
    return await factory();
  } finally {
    await connection().query("SELECT pg_advisory_unlock($1)", [key]);
  }
}
export function timestamp(seconds: number | null | undefined) {
  if (seconds == null) return null;
  const whole = Math.floor(seconds);
  const micros = Math.round((seconds - whole) * 1_000_000);
  return new Date((whole + (micros === 1_000_000 ? 1 : 0)) * 1000)
    .toISOString()
    .replace(".000Z", "." + String(micros % 1_000_000).padStart(6, "0") + "Z");
}
export async function migrate() {
  await invocation(null, () =>
    transaction(async () => {
      await raw("SELECT pg_advisory_xact_lock($1)", [lockKey("migrations")]);
      await raw("CREATE SCHEMA IF NOT EXISTS supabase_migrations");
      await raw(
        "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY)",
      );
      await raw(
        "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text",
      );
      await raw(
        "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]",
      );
      const directory = path.join(process.cwd(), "supabase", "migrations");
      for (const file of (await readdir(directory))
        .filter((file) => /^\d+_.+\.sql$/.test(file))
        .sort()) {
        const [version, ...parts] = file.replace(/\.sql$/, "").split("_");
        if (
          (
            await raw(
              "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1",
              [version],
            )
          ).rowCount
        )
          continue;
        const sql = await readFile(path.join(directory, file), "utf8");
        await raw(sql);
        await raw(
          "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES ($1, $2, $3)",
          [version, parts.join("_"), [sql]],
        );
      }
    }),
  );
}
