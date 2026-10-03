from __future__ import annotations

import os

import pytest

from bot import db as db_module
from bot.storage import _chat, invocation


@pytest.fixture
async def tmp_db(monkeypatch):
    """A disposable Postgres database; never point TEST_DATABASE_URL at production."""
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.fail("TEST_DATABASE_URL must point to disposable Postgres")
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("DATABASE_LOCAL_TEST", "1")
    db_module.sessions.clear()
    await db_module.init_db()
    async with invocation() as conn:
        await conn.execute(
            "TRUNCATE sessions, responses, chat_features, afk_mutes, chat_fort_titles, "
            "roast_state, epic_links, squad_snapshots, news_sent, fortnite_news_seen, "
            "fort_cooldowns, service_state, work_items, work_steps, import_manifest CASCADE"
        )
    token = _chat.set(-100)
    yield url
    _chat.reset(token)
    db_module.sessions.clear()
