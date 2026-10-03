/** Explicit offline recovery; never invoke during startup or a Vercel request. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { invocation, lockKey, raw, timestamp, transaction } from "./storage";

const tables = [
  "sessions",
  "responses",
  "chat_features",
  "roast_state",
  "epic_links",
  "squad_snapshots",
  "afk_mutes",
  "chat_fort_titles",
  "news_sent",
  "fortnite_news_seen",
] as const;
const dates = new Set([
  "created_at",
  "completed_at",
  "responded_at",
  "joined_at",
  "last_roast",
  "linked_at",
  "fetched_at",
  "muted_until",
  "seen_at",
]);
const jsonDefaults: Record<string, unknown> = {
  time_slots: [],
  tag_line: {},
  history_json: [],
  roast_msgs_json: [],
};
type Row = Record<string, unknown>;
type Table = (typeof tables)[number];
export interface ImportReport {
  source_sha256: string;
  tables: Record<string, { rows: number; sha256: string }>;
}
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function contentHash(rows: Row[]) {
  return createHash("sha256")
    .update(
      rows
        .map((row) => JSON.stringify(canonical(row)))
        .sort()
        .join("\n"),
    )
    .digest("hex");
}
async function assertStandalone(path: string) {
  // A backup must be a standalone snapshot, not a live WAL-mode database.
  for (const suffix of ["-wal", "-journal"]) {
    const sidecar = await stat(path + suffix).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      },
    );
    if (sidecar)
      throw new Error(
        "backup has a journal; provide a standalone SQLite snapshot",
      );
  }
}
async function readBackup(path: string) {
  await assertStandalone(path);
  const sourceSha256 = await digest(path);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const names = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String(row.name));
    const unknown = names.filter(
      (name) => !tables.includes(name as Table) && name !== "sqlite_sequence",
    );
    if (unknown.length)
      throw new Error(
        `unrecognized backup tables: ${unknown.sort().join(", ")}`,
      );
    const source = Object.fromEntries(
      tables.map((table) => {
        if (!names.includes(table)) return [table, []];
        const statement = database.prepare(
          `SELECT * FROM ${identifier(table)}`,
        );
        statement.setReadBigInts(true);
        return [
          table,
          statement.all().map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => {
                if (typeof value === "bigint") {
                  const number = Number(value);
                  if (!Number.isSafeInteger(number))
                    throw new Error(
                      "backup integer exceeds safe integer range",
                    );
                  return [key, number];
                }
                return [key, value];
              }),
            ),
          ),
        ];
      }),
    ) as Record<Table, Row[]>;
    return { sourceSha256, source };
  } finally {
    database.close();
  }
}
function reconcile(source: Record<Table, Row[]>) {
  const latest = new Map<unknown, Row>();
  const parents = new Map<unknown, Row[]>();
  for (const row of source.sessions) {
    const matches = parents.get(row.message_id) ?? [];
    matches.push(row);
    parents.set(row.message_id, matches);
    row.is_closed ??= Boolean(row.is_complete || row.is_expired);
    if (row.is_expired) row.is_closed = true;
    if (!row.is_closed) {
      const prior = latest.get(row.chat_id);
      if (
        !prior ||
        Number(row.created_at) > Number(prior.created_at) ||
        (row.created_at === prior.created_at &&
          Number(row.message_id) > Number(prior.message_id))
      )
        latest.set(row.chat_id, row);
    }
  }
  for (const row of source.sessions)
    if (!row.is_closed && latest.get(row.chat_id) !== row) row.is_closed = true;
  for (const row of source.responses) {
    const matches = (parents.get(row.message_id) ?? []).filter(
      (parent) => row.chat_id == null || row.chat_id === parent.chat_id,
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? "ambiguous response parent in backup"
          : "orphan response in backup",
      );
    row.chat_id = matches[0].chat_id;
    if (!("joined_at" in row))
      row.joined_at = row.response === "go" ? row.responded_at : null;
  }
}
interface Column {
  column_name: string;
  data_type: string;
  column_default: string | null;
}
function normalize(raw: Row, columns: Column[]): Row {
  return Object.fromEntries(
    columns.map((column) => {
      const key = column.column_name;
      let value: unknown = raw[key] ?? null;
      if (key in jsonDefaults) {
        try {
          if (typeof value === "string") value = JSON.parse(value);
        } catch {
          value = null;
        }
        const fallback = jsonDefaults[key];
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) !== Array.isArray(fallback)
        )
          value = fallback;
      } else if (column.data_type === "boolean") value = Boolean(value);
      else if (dates.has(key) && value !== null) {
        if (typeof value !== "number" || !Number.isFinite(value))
          throw new Error(`invalid backup timestamp: ${key}`);
        value = Math.round(value * 1_000_000) / 1_000_000;
      } else if (value === null && column.column_default === "0") value = 0;
      return [key, value];
    }),
  );
}
export async function importBackup(
  path: string,
  options: { verifyHook?: () => Promise<void> } = {},
): Promise<ImportReport> {
  path = resolve(path);
  const { sourceSha256, source } = await readBackup(path);
  reconcile(source);
  const report: ImportReport = { source_sha256: sourceSha256, tables: {} };
  await invocation(null, () =>
    transaction(async () => {
      await raw("SELECT pg_advisory_xact_lock($1)", [lockKey("import")]);
      const targets = (
        await raw<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='fortnite_bot' AND tablename <> 'migrations'",
        )
      ).rows;
      // Refuse all existing runtime state, including queued work and cooldowns.
      await raw(
        `LOCK TABLE ${targets.map((row) => identifier(row.tablename)).join(",")} IN ACCESS EXCLUSIVE MODE`,
      );
      for (const { tablename } of targets)
        if (
          (await raw(`SELECT 1 FROM ${identifier(tablename)} LIMIT 1`)).rowCount
        )
          throw new Error(`target table ${tablename} is not empty`);
      const expected = new Map<Table, { rows: Row[]; columns: Column[] }>();
      for (const table of tables) {
        const columns = (
          await raw<Column & Row>(
            "SELECT column_name,data_type,column_default FROM information_schema.columns WHERE table_schema='fortnite_bot' AND table_name=$1 ORDER BY ordinal_position",
            [table],
          )
        ).rows;
        if (!columns.length)
          throw new Error(
            `target table ${table} is missing; run migrations first`,
          );
        const rows = source[table].map((row) => normalize(row, columns));
        expected.set(table, { rows, columns });
        for (const row of rows) {
          const values = columns.map((column) => {
            const value = row[column.column_name];
            return column.data_type === "jsonb"
              ? JSON.stringify(value)
              : dates.has(column.column_name)
                ? timestamp(value as number | null)
                : value;
          });
          await raw(
            `INSERT INTO ${identifier(table)} (${columns.map((column) => identifier(column.column_name)).join(",")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})`,
            values,
          );
        }
      }
      await options.verifyHook?.();
      for (const [table, { rows, columns }] of expected) {
        // Extract epoch in SQL to retain microseconds beyond pg's Date precision.
        const select = columns
          .map((column) =>
            dates.has(column.column_name)
              ? `EXTRACT(EPOCH FROM ${identifier(column.column_name)})::double precision AS ${identifier(column.column_name)}`
              : identifier(column.column_name),
          )
          .join(",");
        const actual = (await raw(`SELECT ${select} FROM ${identifier(table)}`))
          .rows;
        const sha256 = contentHash(rows);
        if (rows.length !== actual.length || contentHash(actual) !== sha256)
          throw new Error(`import verification failed for ${table}`);
        report.tables[table] = { rows: actual.length, sha256 };
      }
      await raw("SET CONSTRAINTS ALL IMMEDIATE");
      // Check before commit so a changed source never leaves a committed import.
      await assertStandalone(path);
      if ((await digest(path)) !== sourceSha256)
        throw new Error("backup changed during import");
      await raw(
        "INSERT INTO import_manifest(source_sha256,report) VALUES ($1,$2)",
        [sourceSha256, JSON.stringify(report.tables)],
      );
    }),
  );
  return report;
}
