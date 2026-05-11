from __future__ import annotations

from pathlib import Path

import pytest

from bot import db as db_module


@pytest.fixture
async def tmp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point bot.db at a fresh SQLite file and clear the in-memory session cache."""
    db_file = tmp_path / "test.db"
    monkeypatch.setattr(db_module, "DB_PATH", str(db_file))
    db_module.sessions.clear()
    await db_module.init_db()
    yield db_file
    db_module.sessions.clear()
