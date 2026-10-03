"""Read-only SQLite recovery with transactional content and key verification."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime
from pathlib import Path

from psycopg import sql
from psycopg.types.json import Jsonb

from bot.storage import invocation, lock_key, timestamp

TABLES = (
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
)
DATES = {
    "created_at",
    "completed_at",
    "responded_at",
    "joined_at",
    "last_roast",
    "linked_at",
    "fetched_at",
    "muted_until",
    "seen_at",
}
JSON_DEFAULTS = {"time_slots": [], "tag_line": {}, "history_json": [], "roast_msgs_json": []}
BOOLS = {"is_complete", "is_expired", "is_closed", "is_bot", "enabled"}


def canonical(rows):
    def convert(value):
        if isinstance(value, datetime):
            return value.timestamp()
        if isinstance(value, Jsonb):
            return value.obj
        return value

    normalized = [{k: convert(v) for k, v in row.items()} for row in rows]
    # Hashes cover every value, including the composite primary keys.
    records = sorted(json.dumps(row, sort_keys=True, ensure_ascii=False) for row in normalized)
    return hashlib.sha256("\n".join(records).encode()).hexdigest()


def read_backup(path):
    path = Path(path).resolve()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    source = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    source.row_factory = sqlite3.Row
    try:
        names = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        unknown = names - set(TABLES) - {"sqlite_sequence"}
        if unknown:
            raise ValueError(f"unrecognized backup tables: {sorted(unknown)}")
        rows = {
            table: [dict(r) for r in source.execute(f'SELECT * FROM "{table}"')] if table in names else []
            for table in TABLES
        }
    finally:
        source.close()
    return digest, rows


async def import_backup(path, *, verify_hook=None):
    digest, source = read_backup(path)
    report = {}
    async with invocation() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(%s)", (lock_key("import"),))
            for table in TABLES:
                if await (
                    await conn.execute(sql.SQL("SELECT 1 FROM {} LIMIT 1").format(sql.Identifier(table)))
                ).fetchone():
                    raise ValueError(f"target table {table} is not empty")
            if await (await conn.execute("SELECT 1 FROM import_manifest LIMIT 1")).fetchone():
                raise ValueError("target was already imported")
            sessions = {r["message_id"]: r for r in source["sessions"]}
            # Legacy terminal sessions closed on completion or expiry. Multiple
            # historical open gatherings retain only the newest per chat.
            latest = {}
            for row in source["sessions"]:
                row.setdefault("is_closed", bool(row.get("is_complete") or row.get("is_expired")))
                if row.get("is_expired"):
                    row["is_closed"] = True
                if not row["is_closed"]:
                    current = latest.get(row["chat_id"])
                    if current is None or (row["created_at"], row["message_id"]) > (
                        current["created_at"],
                        current["message_id"],
                    ):
                        latest[row["chat_id"]] = row
            for row in source["sessions"]:
                if not row["is_closed"] and latest[row["chat_id"]] is not row:
                    row["is_closed"] = True
            for row in source["responses"]:
                parent = sessions.get(row["message_id"])
                if parent is None:
                    raise ValueError("orphan response in backup")
                row["chat_id"] = parent["chat_id"]
                row.setdefault("joined_at", row["responded_at"] if row["response"] == "go" else None)
            for table in TABLES:
                columns = await (
                    await conn.execute(
                        "SELECT column_name,data_type,column_default,is_nullable FROM information_schema.columns "
                        "WHERE table_schema='fortnite_bot' AND table_name=%s ORDER BY ordinal_position",
                        (table,),
                    )
                ).fetchall()
                expected = []
                for raw in source[table]:
                    row = {}
                    for column in columns:
                        key = column["column_name"]
                        value = raw.get(key)
                        if key in JSON_DEFAULTS:
                            try:
                                value = json.loads(value) if isinstance(value, str) and value else value
                            except ValueError:
                                value = None
                            default = JSON_DEFAULTS[key]
                            if not isinstance(value, type(default)):
                                value = default
                            value = Jsonb(value)
                        elif key in BOOLS:
                            value = bool(value)
                        elif key in DATES:
                            value = timestamp(value)
                        elif value is None and column["column_default"] == "0":
                            value = 0
                        row[key] = value
                    columns_sql = sql.SQL(",").join(map(sql.Identifier, row))
                    placeholders = sql.SQL(",").join(sql.Placeholder() for _ in row)
                    await conn.execute(
                        sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
                            sql.Identifier(table), columns_sql, placeholders
                        ),
                        list(row.values()),
                    )
                    expected.append(row)
                actual = await (
                    await conn.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))
                ).fetchall()
                expected_hash = canonical(expected)
                if len(actual) != len(expected) or canonical(actual) != expected_hash:
                    raise ValueError(f"import verification failed for {table}")
                report[table] = {"rows": len(actual), "sha256": expected_hash}
            await conn.execute("SET CONSTRAINTS ALL IMMEDIATE")
            if verify_hook:
                await verify_hook(conn)
            await conn.execute(
                "INSERT INTO import_manifest(source_sha256,report) VALUES (%s,%s)", (digest, Jsonb(report))
            )
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest:
        raise ValueError("backup changed during import")
    return {"source_sha256": digest, "tables": report}
