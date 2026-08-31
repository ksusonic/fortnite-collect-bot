from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest

from bot import db as db_module


@pytest.fixture
async def tmp_db(monkeypatch: pytest.MonkeyPatch):
    """Reset and migrate the disposable PostgreSQL test database."""
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_DATABASE_URL is required for database tests")
    migrations = sorted(Path("supabase/migrations").glob("*.sql"))
    with psycopg.connect(database_url) as connection:
        for role in ("anon", "authenticated"):
            if not connection.execute("select 1 from pg_roles where rolname=%s", (role,)).fetchone():
                connection.execute(f"create role {role} nologin")
        connection.execute("drop schema if exists fortnite_bot cascade")
        for migration in migrations:
            connection.execute(migration.read_text())
    monkeypatch.setattr(db_module, "DATABASE_URL", database_url)
    db_module.sessions.clear()
    await db_module.init_db()
    yield database_url
    await db_module.close_db()
    db_module.sessions.clear()
