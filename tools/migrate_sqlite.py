#!/usr/bin/env python3
"""Inspect, import, and verify the legacy SQLite database."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import psycopg

TABLES = (
    "sessions",
    "responses",
    "chat_features",
    "afk_mutes",
    "roast_state",
    "epic_links",
    "squad_snapshots",
)
PKS = {
    "sessions": ("message_id",),
    "responses": ("message_id", "user_id"),
    "chat_features": ("chat_id", "feature"),
    "afk_mutes": ("chat_id", "user_id"),
    "roast_state": ("chat_id",),
    "epic_links": ("chat_id", "user_id"),
    "squad_snapshots": ("epic_account_id", "fetched_at"),
}
JSON_COLUMNS = {"sessions": {"time_slots", "tag_line"}, "roast_state": {"history_json", "roast_msgs_json"}}
TIMESTAMPS = {
    "sessions": {"created_at", "completed_at"},
    "responses": {"responded_at", "joined_at"},
    "afk_mutes": {"muted_until"},
    "roast_state": {"last_roast"},
    "epic_links": {"linked_at"},
    "squad_snapshots": {"fetched_at"},
}
DEFAULTS = {
    "sessions": {"is_expired": 0, "is_closed": 0, "time_slots": [], "tag_line": {}, "llm_header": None},
    "responses": {"time_slot": None, "is_bot": 0, "joined_at": None},
    "chat_features": {"value": None},
    "squad_snapshots": {
        "overall_matches": None,
        "overall_wins": None,
        "overall_kills": None,
        "overall_deaths_est": None,
        "overall_kd": None,
    },
}


def source(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def tables(connection: sqlite3.Connection) -> set[str]:
    return {row[0] for row in connection.execute("select name from sqlite_master where type='table'")}


def normalize(table: str, row: dict, report: dict[str, int]) -> dict:
    had_is_closed = "is_closed" in row
    for column, default in DEFAULTS.get(table, {}).items():
        row.setdefault(column, default)
    if table == "sessions" and not had_is_closed:
        row["is_closed"] = bool(row.get("is_complete") or row.get("is_expired"))
    if table == "responses" and row.get("joined_at") is None and row.get("response") == "go":
        row["joined_at"] = row["responded_at"]
    for column in JSON_COLUMNS.get(table, set()):
        fallback = {} if column == "tag_line" else []
        value = row.get(column)
        if value in (None, ""):
            row[column] = fallback
        elif isinstance(value, str):
            try:
                row[column] = json.loads(value)
            except TypeError, ValueError:
                row[column] = fallback
                report[f"{table}.{column}"] = report.get(f"{table}.{column}", 0) + 1
        if column == "tag_line" and not isinstance(row[column], dict):
            row[column] = {}
            report[f"{table}.{column}"] = report.get(f"{table}.{column}", 0) + 1
        elif column != "tag_line" and not isinstance(row[column], list):
            row[column] = []
            report[f"{table}.{column}"] = report.get(f"{table}.{column}", 0) + 1
    for column in TIMESTAMPS.get(table, set()):
        if row.get(column) is not None and not isinstance(row[column], datetime):
            row[column] = datetime.fromtimestamp(float(row[column]), UTC)
    for column in ("is_complete", "is_expired", "is_closed", "is_bot", "enabled"):
        if column in row:
            row[column] = bool(row[column])
    return row


def read_rows(connection: sqlite3.Connection, table: str, report: dict[str, int]) -> list[dict]:
    if table not in tables(connection):
        return []
    return [normalize(table, dict(row), report) for row in connection.execute(f"select * from {table}")]


def canonical(value):
    if isinstance(value, datetime):
        return value.timestamp()
    return value


def digest(rows: list[dict], pks: tuple[str, ...]) -> str:
    ordered = sorted(rows, key=lambda row: tuple(row[key] for key in pks))
    payload = [{key: canonical(value) for key, value in sorted(row.items())} for row in ordered]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def inspect_command(args) -> None:
    report: dict[str, int] = {}
    with source(args.sqlite) as src:
        result = {table: len(read_rows(src, table, report)) for table in TABLES}
    print(json.dumps({"rows": result, "json_normalized": report}, indent=2, sort_keys=True))


def target_rows(connection, table: str) -> list[dict]:
    with connection.cursor(row_factory=psycopg.rows.dict_row) as cursor:
        cursor.execute(f"select * from fortnite_bot.{table}")
        return [dict(row) for row in cursor.fetchall()]


def verify(src, target) -> dict:
    report: dict[str, int] = {}
    result = {}
    for table in TABLES:
        expected = read_rows(src, table, report)
        actual = target_rows(target, table)
        expected_keys = sorted(tuple(row[key] for key in PKS[table]) for row in expected)
        actual_keys = sorted(tuple(row[key] for key in PKS[table]) for row in actual)
        result[table] = {"source": len(expected), "target": len(actual), "hash": digest(actual, PKS[table])}
        hashes_match = digest(expected, PKS[table]) == digest(actual, PKS[table])
        if len(expected) != len(actual) or expected_keys != actual_keys or not hashes_match:
            raise RuntimeError(f"verification mismatch: {table}")
    with target.cursor() as cursor:
        cursor.execute("set constraints all immediate")
        cursor.execute(
            """select count(*) filter(where not is_closed),count(*) filter(where is_closed),
                      count(*) filter(where is_complete) from fortnite_bot.sessions"""
        )
        active, closed, completed = cursor.fetchone()
        result["session_aggregates"] = {"active": active, "closed": closed, "completed": completed}
        cursor.execute(
            """select count(*) from fortnite_bot.responses r left join fortnite_bot.sessions s using(message_id)
               where s.message_id is null"""
        )
        if cursor.fetchone()[0]:
            raise RuntimeError("foreign-key verification failed")
    result["json_normalized"] = report
    return result


def import_command(args) -> None:
    report: dict[str, int] = {}
    with source(args.sqlite) as src, psycopg.connect(args.database_url, sslmode=args.sslmode) as target:
        with target.transaction():
            for table in TABLES:
                if target.execute(f"select exists(select 1 from fortnite_bot.{table} limit 1)").fetchone()[0]:
                    raise RuntimeError(f"target is not empty: {table}")
            for table in TABLES:
                rows = read_rows(src, table, report)
                if not rows:
                    continue
                columns = list(rows[0])
                placeholders = ",".join(["%s"] * len(columns))
                sql = f"insert into fortnite_bot.{table} ({','.join(columns)}) values ({placeholders})"
                values = [
                    [
                        psycopg.types.json.Jsonb(row[column])
                        if column in JSON_COLUMNS.get(table, set())
                        else row[column]
                        for column in columns
                    ]
                    for row in rows
                ]
                with target.cursor() as cursor:
                    cursor.executemany(sql, values)
            result = verify(src, target)
        print(json.dumps(result, indent=2, sort_keys=True))


def verify_command(args) -> None:
    with source(args.sqlite) as src, psycopg.connect(args.database_url, sslmode=args.sslmode) as target:
        print(json.dumps(verify(src, target), indent=2, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(required=True)
    for name, function in (("inspect", inspect_command), ("import", import_command), ("verify", verify_command)):
        command = sub.add_parser(name)
        command.add_argument("sqlite", type=Path)
        if name != "inspect":
            command.add_argument("--database-url", required=True)
            command.add_argument("--sslmode", default="require", choices=("require", "disable"))
        command.set_defaults(function=function)
    args = parser.parse_args()
    args.function(args)


if __name__ == "__main__":
    main()
