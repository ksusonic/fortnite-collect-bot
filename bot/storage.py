"""Invocation-scoped Postgres access and isolated runtime views.

Session advisory locks require the Supabase session pooler (5432), never the
transaction pooler. Autocommit keeps locks while checkpoints commit independently.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import MutableMapping
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from decimal import Decimal

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

_connection = ContextVar("connection", default=None)
_chat = ContextVar("chat", default=None)
_work = ContextVar("work", default=None)


class ContextMap(MutableMapping):
    """A mapping isolated per invocation, with a fallback for standalone tests."""

    def __init__(self, name):
        self.context = ContextVar(name, default=None)
        self.fallback = {}

    def _data(self):
        value = self.context.get()
        return self.fallback if value is None else value

    def __getitem__(self, key):
        return self._data()[key]

    def __setitem__(self, key, value):
        self._data()[key] = value

    def __delitem__(self, key):
        del self._data()[key]

    def __iter__(self):
        return iter(self._data())

    def __len__(self):
        return len(self._data())


def timestamp(value):
    return datetime.fromtimestamp(value, UTC) if value is not None else None


def chat_id(explicit=None):
    value = explicit if explicit is not None else _chat.get()
    if value is None:
        raise ValueError("chat_id is required outside an invocation")
    return value


def lock_key(name):
    return int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], "big", signed=True)


@asynccontextmanager
async def invocation(chat=None):
    url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL_NON_POOLING")
    if not url:
        raise RuntimeError("DATABASE_URL is not configured")
    if ":6543/" in url:
        raise ValueError("use the session pooler on port 5432 for advisory locks")
    # Local tests may opt out of TLS; deployed connections always require it.
    sslmode = "disable" if os.getenv("DATABASE_LOCAL_TEST") == "1" else "require"
    async with await psycopg.AsyncConnection.connect(
        url,
        autocommit=True,
        row_factory=dict_row,
        sslmode=sslmode,
        connect_timeout=10,
        options="-c search_path=fortnite_bot -c statement_timeout=20000",
    ) as conn:
        token = _connection.set(conn)
        chat_token = _chat.set(chat)
        try:
            yield conn
        finally:
            _chat.reset(chat_token)
            _connection.reset(token)


@asynccontextmanager
async def advisory_lock(name, *, wait=True):
    conn = _connection.get()
    if conn is None:
        raise RuntimeError("advisory locks require an invocation")
    key = lock_key(name)
    fn = "pg_advisory_lock" if wait else "pg_try_advisory_lock"
    row = await (await conn.execute(f"SELECT {fn}(%s) AS acquired", (key,))).fetchone()
    acquired = wait or row["acquired"]
    try:
        yield acquired
    finally:
        if acquired:
            await conn.execute("SELECT pg_advisory_unlock(%s)", (key,))


class Row(dict):
    def __getitem__(self, key):
        return list(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


def normalize(row):
    result = Row()
    for key, value in row.items():
        if isinstance(value, datetime):
            value = value.timestamp()
        if isinstance(value, Decimal):
            value = float(value)
        if key in {"time_slots", "tag_line", "history_json", "roast_msgs_json"}:
            import json

            value = json.dumps(value) if value is not None else None
        result[key] = value
    return result


class Result:
    def __init__(self, rows, rowcount):
        self.rows = [Row(r) for r in rows]
        self.rowcount = rowcount
        self.index = 0

    async def fetchone(self):
        if self.index >= len(self.rows):
            return None
        row = self.rows[self.index]
        self.index += 1
        return row

    async def fetchall(self):
        rows = self.rows[self.index :]
        self.index = len(self.rows)
        return rows

    def __aiter__(self):
        return self

    async def __anext__(self):
        row = await self.fetchone()
        if row is None:
            raise StopAsyncIteration
        return row


class Database:
    def __init__(self, conn):
        self.conn = conn

    async def execute(self, query, params=()):
        async def run():
            cursor = await self.conn.execute(query, params)
            rows = [normalize(r) for r in await cursor.fetchall()] if cursor.description else []
            return {"rows": rows, "rowcount": cursor.rowcount}

        work = _work.get()
        if work:
            data = await work.database_step(query, run)
        else:
            data = await run()
        return Result(data["rows"], data["rowcount"])

    async def commit(self):
        # Each statement and its recovery checkpoint already commit atomically.
        pass


@asynccontextmanager
async def database():
    conn = _connection.get()
    if conn is not None:
        yield Database(conn)
    else:
        async with invocation() as conn:
            yield Database(conn)


async def value_checkpoint(name, factory):
    work = _work.get()
    if work:
        return await work.value_step(name, factory)
    return factory()


async def migrate():
    from pathlib import Path

    async with invocation() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(%s)", (lock_key("migrations"),))
            await conn.execute("CREATE SCHEMA IF NOT EXISTS fortnite_bot")
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS fortnite_bot.migrations "
                "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            for path in sorted((Path(__file__).parents[1] / "migrations").glob("*.sql")):
                found = await (await conn.execute("SELECT 1 FROM migrations WHERE version=%s", (path.name,))).fetchone()
                if not found:
                    await conn.execute(path.read_text(), prepare=False)
                    await conn.execute("INSERT INTO migrations(version) VALUES (%s)", (path.name,))


__all__ = ["Jsonb", "advisory_lock", "chat_id", "database", "invocation", "migrate", "timestamp"]
