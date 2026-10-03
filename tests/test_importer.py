import hashlib
import sqlite3

import pytest

from bot import db
from bot.importer import import_backup
from bot.storage import invocation


def legacy_backup(path):
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE sessions(message_id INTEGER PRIMARY KEY, chat_id INTEGER, initiator_id INTEGER, "
            "initiator_name TEXT, is_complete INTEGER, created_at REAL)"
        )
        conn.execute(
            "CREATE TABLE responses(message_id INTEGER,user_id INTEGER,user_name TEXT,response TEXT, "
            "responded_at REAL,PRIMARY KEY(message_id,user_id))"
        )
        conn.execute("INSERT INTO sessions VALUES (1,-100,5,'Host',1,100)")
        conn.execute("INSERT INTO responses VALUES (1,10,'Alice','go',110)")


async def test_legacy_import_backfills_closure_fifo_and_preserves_file(tmp_db, tmp_path):
    path = tmp_path / "legacy.db"
    legacy_backup(path)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    report = await import_backup(path)
    assert report["source_sha256"] == before == hashlib.sha256(path.read_bytes()).hexdigest()
    session = await db.load_session(1, -100)
    assert session.is_closed and session.fort_title is None
    assert list(session.go_players) == [10]
    async with invocation() as conn:
        row = await (await conn.execute("SELECT joined_at FROM responses")).fetchone()
        assert row["joined_at"].timestamp() == 110


async def test_import_verification_failure_rolls_back_every_table(tmp_db, tmp_path):
    path = tmp_path / "legacy.db"
    legacy_backup(path)

    async def fail(conn):
        raise ValueError("verification failed")

    with pytest.raises(ValueError, match="verification failed"):
        await import_backup(path, verify_hook=fail)
    async with invocation() as conn:
        assert not await (await conn.execute("SELECT 1 FROM sessions")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM responses")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM import_manifest")).fetchone()


async def test_import_refuses_nonempty_target(tmp_db, tmp_path):
    path = tmp_path / "legacy.db"
    legacy_backup(path)
    await db.save_session(db.Session(chat_id=-100, message_id=5, initiator_id=1, initiator_name="Host"))
    with pytest.raises(ValueError, match="not empty"):
        await import_backup(path)
    assert await db.load_session(5, -100) is not None


async def test_orphan_backup_rolls_back(tmp_db, tmp_path):
    path = tmp_path / "legacy.db"
    legacy_backup(path)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO responses VALUES (999,20,'Bob','go',111)")
    with pytest.raises(ValueError, match="orphan"):
        await import_backup(path)
    assert await db.load_session(1, -100) is None
