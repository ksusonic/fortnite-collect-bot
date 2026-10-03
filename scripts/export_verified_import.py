"""Export locally verified recovery data as an atomic Supabase-tool import.

Run with DATABASE_URL pointing at a disposable database after `bot import`.
The exported SQL refuses nonempty targets and verifies every normalized value
using bidirectional EXCEPT before committing, in addition to PK/FK constraints.
"""

import asyncio
from pathlib import Path

from psycopg import sql
from psycopg.types.json import Jsonb

from bot.importer import TABLES
from bot.storage import invocation


def literal(value):
    return sql.Literal(Jsonb(value) if isinstance(value, (dict, list)) else value).as_string()


async def export():
    statements = ["BEGIN; SET LOCAL search_path = fortnite_bot;"]
    async with invocation() as conn:
        for table in (*TABLES, "import_manifest"):
            rows = await (await conn.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))).fetchall()
            statements.append(
                f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM {table}) THEN "
                f"RAISE EXCEPTION 'target {table} is not empty'; END IF; END $$;"
            )
            staging = "expected_" + table
            statements.append(f"CREATE TEMP TABLE {staging} (LIKE {table}) ON COMMIT DROP;")
            for row in rows:
                columns = ",".join(sql.Identifier(key).as_string() for key in row)
                values = ",".join(literal(value) for value in row.values())
                statements.append(f"INSERT INTO {staging} ({columns}) VALUES ({values});")
            statements.append(f"INSERT INTO {table} SELECT * FROM {staging};")
            statements.append(
                f"DO $$ BEGIN IF (SELECT count(*) FROM {table}) <> {len(rows)} OR EXISTS ("
                f"(SELECT * FROM {table} EXCEPT SELECT * FROM {staging}) UNION ALL "
                f"(SELECT * FROM {staging} EXCEPT SELECT * FROM {table})) THEN "
                f"RAISE EXCEPTION 'verification failed for {table}'; END IF; END $$;"
            )
    statements.extend(["SET CONSTRAINTS ALL IMMEDIATE;", "COMMIT;"])
    target = Path(".codex/recovery/verified-import.sql")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(statements) + "\n")
    print(f"Verified import SQL written to {target}")


if __name__ == "__main__":
    asyncio.run(export())
