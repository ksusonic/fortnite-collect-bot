from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from bot import handlers
from bot.db import Session, save_session, sessions
from bot.handlers import (
    FORT_REPLACE_COOLDOWN,
    cmd_fort,
    on_callback,
    sweep_expired_sessions,
)
from bot.messages import PLAY_DEADLINE_HOUR, SESSION_TIMEOUT


def _make_user(user_id: int = 1, username: str | None = "host", first_name: str = "Host", is_bot: bool = False):
    return SimpleNamespace(id=user_id, username=username, first_name=first_name, is_bot=is_bot)


def _make_callback(data: str, message_id: int, user_id: int, chat_id: int = -100):
    message = MagicMock()
    message.message_id = message_id
    message.chat = SimpleNamespace(id=chat_id)
    message.edit_text = AsyncMock()
    callback = MagicMock()
    callback.data = data
    callback.message = message
    callback.from_user = _make_user(user_id=user_id, username=f"u{user_id}", first_name=f"User{user_id}")
    callback.answer = AsyncMock()
    return callback


def _make_session(message_id: int = 555, chat_id: int = -100, created_at: float | None = None) -> Session:
    return Session(
        chat_id=chat_id,
        message_id=message_id,
        initiator_id=1,
        initiator_name="@host",
        style=0,
        time_slots=["now", "19:00", "20:00"],
        tagged_users={},
        created_at=created_at if created_at is not None else time.time(),
    )


# ---------- callback handler: go ↔ pass and slot switching ----------


async def test_callback_slot_then_pass_switches_lists(tmp_db):
    session = _make_session()
    await save_session(session)
    sessions[session.message_id] = session

    # User 42 picks 19:00.
    cb1 = _make_callback("slot:19:00", session.message_id, user_id=42)
    await on_callback(cb1)
    assert 42 in session.go_players
    assert session.player_slots[42] == "19:00"
    assert 42 not in session.pass_players

    # User 42 changes mind → pass.
    cb2 = _make_callback("pass", session.message_id, user_id=42)
    await on_callback(cb2)
    assert 42 not in session.go_players
    assert 42 not in session.player_slots
    assert 42 in session.pass_players


async def test_callback_slot_to_other_slot(tmp_db):
    session = _make_session()
    await save_session(session)
    sessions[session.message_id] = session

    await on_callback(_make_callback("slot:19:00", session.message_id, user_id=7))
    assert session.player_slots[7] == "19:00"

    await on_callback(_make_callback("slot:20:00", session.message_id, user_id=7))
    assert session.player_slots[7] == "20:00"
    assert 7 in session.go_players
    assert 7 not in session.pass_players


async def test_callback_pass_back_to_slot(tmp_db):
    session = _make_session()
    await save_session(session)
    sessions[session.message_id] = session

    await on_callback(_make_callback("pass", session.message_id, user_id=9))
    assert 9 in session.pass_players

    await on_callback(_make_callback("slot:now", session.message_id, user_id=9))
    assert 9 not in session.pass_players
    assert session.player_slots[9] == "now"


async def test_callback_unknown_slot_rejected(tmp_db):
    session = _make_session()
    await save_session(session)
    sessions[session.message_id] = session

    cb = _make_callback("slot:99:00", session.message_id, user_id=5)
    await on_callback(cb)
    assert 5 not in session.go_players
    cb.answer.assert_awaited_with("Слот недоступен.")


async def test_callback_marks_complete_when_squad_full(tmp_db):
    session = _make_session()
    await save_session(session)
    sessions[session.message_id] = session

    for uid in (10, 11, 12, 13):
        await on_callback(_make_callback("slot:19:00", session.message_id, user_id=uid))

    assert session.is_complete is True
    assert len(session.go_players) == 4


# ---------- /fort anti-spam ----------


async def test_cmd_fort_replaces_when_no_active_session(tmp_db):
    """Smoke test: with no active session in cache, /fort creates one and persists it."""
    user = _make_user(user_id=1, username="host", first_name="Host")
    msg = MagicMock()
    msg.from_user = user
    msg.chat = SimpleNamespace(id=-100, type="group")
    msg.bot = MagicMock()
    msg.bot.edit_message_text = AsyncMock()
    msg.react = AsyncMock()
    msg.delete = AsyncMock()
    # answer returns the bot's reply Message with a message_id.
    sent = MagicMock()
    sent.message_id = 777
    msg.answer = AsyncMock(return_value=sent)

    await cmd_fort(msg)

    msg.react.assert_not_awaited()
    msg.answer.assert_awaited()
    assert 777 in sessions
    sessions.pop(777, None)


async def test_cmd_fort_within_cooldown_thumbs_down(tmp_db):
    """Repeat /fort within FORT_REPLACE_COOLDOWN must react 👎 and NOT replace the session."""
    session = _make_session(message_id=222, created_at=time.time() - (FORT_REPLACE_COOLDOWN - 5))
    await save_session(session)
    sessions[session.message_id] = session

    user = _make_user(user_id=2, username="spammer")
    msg = MagicMock()
    msg.from_user = user
    msg.chat = SimpleNamespace(id=session.chat_id, type="group")
    msg.bot = MagicMock()
    msg.react = AsyncMock()
    msg.delete = AsyncMock()
    msg.answer = AsyncMock()

    await cmd_fort(msg)

    msg.react.assert_awaited()
    msg.answer.assert_not_awaited()
    # Session untouched.
    assert sessions[222].is_expired is False
    assert sessions[222].is_complete is False


async def test_cmd_fort_after_cooldown_replaces_session(tmp_db):
    """After FORT_REPLACE_COOLDOWN seconds, a new /fort cancels the previous and creates a new one."""
    old = _make_session(message_id=333, created_at=time.time() - (FORT_REPLACE_COOLDOWN + 5))
    await save_session(old)
    sessions[old.message_id] = old

    user = _make_user(user_id=3, username="other")
    msg = MagicMock()
    msg.from_user = user
    msg.chat = SimpleNamespace(id=old.chat_id, type="group")
    msg.bot = MagicMock()
    msg.bot.edit_message_text = AsyncMock()
    msg.react = AsyncMock()
    msg.delete = AsyncMock()
    sent = MagicMock()
    sent.message_id = 444
    msg.answer = AsyncMock(return_value=sent)

    await cmd_fort(msg)

    msg.react.assert_not_awaited()
    msg.answer.assert_awaited()
    # New session present, old one popped.
    assert 444 in sessions
    assert 333 not in sessions
    sessions.pop(444, None)


# ---------- expiration: timeout and play deadline ----------


async def test_sweep_expires_session_past_timeout(tmp_db):
    stale = _make_session(message_id=900, created_at=time.time() - SESSION_TIMEOUT - 60)
    await save_session(stale)
    sessions[stale.message_id] = stale

    bot = MagicMock()
    bot.edit_message_text = AsyncMock()

    expired_ids = await sweep_expired_sessions(bot, past_deadline=False)
    assert 900 in expired_ids
    assert 900 not in sessions


async def test_sweep_does_not_expire_fresh_session(tmp_db):
    fresh = _make_session(message_id=901, created_at=time.time())
    await save_session(fresh)
    sessions[fresh.message_id] = fresh

    bot = MagicMock()
    bot.edit_message_text = AsyncMock()

    expired_ids = await sweep_expired_sessions(bot, past_deadline=False)
    assert expired_ids == []
    assert 901 in sessions


async def test_sweep_expires_all_when_past_play_deadline(tmp_db):
    """After PLAY_DEADLINE_HOUR=23 MSK every open session must be closed regardless of age."""
    fresh = _make_session(message_id=902, created_at=time.time())
    await save_session(fresh)
    sessions[fresh.message_id] = fresh

    bot = MagicMock()
    bot.edit_message_text = AsyncMock()

    expired_ids = await sweep_expired_sessions(bot, past_deadline=True)
    assert 902 in expired_ids
    assert 902 not in sessions


def test_play_deadline_hour_is_23():
    # Pin the constant — used by sweep_expired_sessions logic.
    assert PLAY_DEADLINE_HOUR == 23


def test_session_timeout_is_one_hour():
    assert SESSION_TIMEOUT == 3600


@pytest.fixture(autouse=True)
def _clear_sessions_cache():
    handlers.sessions.clear()
    yield
    handlers.sessions.clear()
