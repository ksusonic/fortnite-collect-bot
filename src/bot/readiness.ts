import { readdir } from "node:fs/promises";
import path from "node:path";
import { invocation, raw, connection } from "./storage";
import { schemaContract } from "./schema-contract";

export class DatabaseReadinessError extends Error {
  readonly code = "DATABASE_SCHEMA_NOT_READY";
}

/** Resolves the same names as runtime queries, without reading application rows. */
export async function checkSchema(requiredVersions: string[] = []) {
  await raw("BEGIN READ ONLY");
  try {
    await raw("SET LOCAL statement_timeout = '5000'");
    if (requiredVersions.length) {
      const pending = await raw<{ version: string }>(
        `SELECT version FROM unnest($1::text[]) AS required(version)
         WHERE NOT EXISTS (
           SELECT 1 FROM supabase_migrations.schema_migrations AS applied
           WHERE applied.version = required.version
         ) ORDER BY version`,
        [requiredVersions],
      );
      if (pending.rows.length)
        throw new DatabaseReadinessError(
          "database migrations are not applied: " +
            pending.rows.map(({ version }) => version).join(", "),
        );
    }
    const result = await raw<{ ready: boolean }>(
      `SELECT current_schema() = 'fortnite_bot' AND NOT EXISTS (
        SELECT 1 FROM unnest($1::text[]) AS required(name)
        LEFT JOIN pg_class c ON c.oid = to_regclass(required.name)
        LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid IS NULL OR n.nspname <> 'fortnite_bot'
          OR c.relkind <> 'r' OR NOT c.relrowsecurity
          OR EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)
            WHERE NOT has_table_privilege(c.oid, p.privilege))
      ) AS ready`,
      [Object.keys(schemaContract)],
    );
    if (!result.rows[0]?.ready)
      throw new DatabaseReadinessError(
        "database schema is not ready: check fortnite_bot tables, RLS, permissions and search_path",
      );
    // Parse every required column and check permissions without scanning data.
    await raw(
      "SELECT " +
        Object.entries(schemaContract)
          .map(
            ([table, columns]) =>
              `EXISTS (SELECT ${columns.split(" ").join(",")} FROM ${table} WHERE false)`,
          )
          .join(","),
    );
    await raw("COMMIT");
  } catch (error) {
    await connection().query("ROLLBACK");
    throw error;
  }
}

export function checkDatabase(requiredVersions: string[] = []) {
  return invocation(
    null,
    () => checkSchema(requiredVersions),
    AbortSignal.timeout(20_000),
  );
}

export async function checkProductionDatabase() {
  if (process.env.VERCEL_ENV !== "production") return;
  const files = await readdir(
    path.join(process.cwd(), "supabase", "migrations"),
  );
  const versions = files
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .map((file) => file.split("_")[0])
    .sort();
  if (!versions.length || new Set(versions).size !== versions.length)
    throw new DatabaseReadinessError("invalid release migration manifest");
  await checkDatabase(versions);
}
