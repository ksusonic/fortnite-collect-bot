from __future__ import annotations

import json
import time

import aiosqlite
import pytest

from bot import db as db_module
from bot.db import (
    Session,
    load_active_sessions,
    load_session,
    mark_complete,
    mark_expired,
    save_response,
    save_session,
)


@pytest.fixture
def make_session():
    counter = {"n": 1000}

    def _make(**overrides) -> Session:
        counter["n"] += 1
        defaults = dict(
            chat_id=-100,
            message_id=counter["n"],
            initiator_id=1,
            initiator_name="@host",
            style=0,
            time_slots=["now", "19:00", "20:00"],
            tagged_users={2: "@alice", 3: "@bob"},
        )
        defaults.update(overrides)
        return Session(**defaults)

    return _make


async def test_session_roundtrip_with_tagged_users(tmp_db, make_session):
    s = make_session()
    await save_session(s)

    loaded = await load_session(s.message_id)
    assert loaded is not None
    assert loaded.message_id == s.message_id
    assert loaded.initiator_name == s.initiator_name
    assert loaded.time_slots == s.time_slots
    assert loaded.tagged_users == s.tagged_users


async def test_load_session_handles_malformed_tag_line(tmp_db, make_session):
    """Regression for #32: load_session must tolerate corrupted tag_line JSON."""
    s = make_session(tagged_users={})
    await save_session(s)
    # Inject malformed JSON into tag_line directly.
    async with aiosqlite.connect(tmp_db) as db:
        await db.execute(
            "UPDATE sessions SET tag_line = ? WHERE message_id = ?",
            ("not a json", s.message_id),
        )
        await db.commit()

    loaded = await load_session(s.message_id)
    assert loaded is not None
    assert loaded.tagged_users == {}


async def test_load_session_handles_non_dict_tag_line(tmp_db, make_session):
    s = make_session(tagged_users={})
    await save_session(s)
    async with aiosqlite.connect(tmp_db) as db:
        # JSON that parses but doesn't have .items() → AttributeError path.
        await db.execute(
            "UPDATE sessions SET tag_line = ? WHERE message_id = ?",
            (json.dumps([1, 2, 3]), s.message_id),
        )
        await db.commit()

    loaded = await load_session(s.message_id)
    assert loaded is not None
    assert loaded.tagged_users == {}


async def test_load_active_sessions_skips_completed_and_expired(tmp_db, make_session):
    active = make_session()
    completed = make_session()
    completed.is_complete = True
    expired = make_session()
    expired.is_complete = True
    expired.is_expired = True

    for s in (active, completed, expired):
        await save_session(s)

    await mark_complete(completed.message_id)
    await mark_expired(expired.message_id)

    loaded = await load_active_sessions()
    ids = {s.message_id for s in loaded}
    assert active.message_id in ids
    assert completed.message_id not in ids
    assert expired.message_id not in ids


async def test_load_active_sessions_restores_responses(tmp_db, make_session):
    s = make_session()
    await save_session(s)
    await save_response(s.message_id, 10, "@p1", "go", time_slot="19:00")
    await save_response(s.message_id, 11, "@p2", "pass")

    loaded = (await load_active_sessions())[0]
    assert loaded.go_players == {10: "@p1"}
    assert loaded.player_slots == {10: "19:00"}
    assert loaded.pass_players == {11: "@p2"}


async def test_roast_state_roundtrip(tmp_db):
    await db_module.save_roast_state(
        chat_id=42,
        history_payload=[
            {"role": "user", "name": "alice", "text": "hi", "ts": 1.0, "message_id": 1, "reply_to_id": None},
            {"role": "assistant", "name": "<bot>", "text": "yo", "ts": 2.0, "message_id": 2, "reply_to_id": None},
        ],
        roast_msg_ids=[2, 5, 7],
        last_roast=time.time(),
    )
    rows = await db_module.load_all_roast_state()
    assert len(rows) == 1
    chat_id, history, msgs, last = rows[0]
    assert chat_id == 42
    assert len(history) == 2
    assert msgs == [2, 5, 7]
    assert last is not None
