from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from bot import status
from bot.status import (
    ALERT_MIN_INTERVAL_SEC,
    BROADCAST_CONCURRENCY,
    ServerStatus,
    _should_emit_alert,
    broadcast_alert,
)


@pytest.fixture(autouse=True)
def _clear_alert_state():
    status._last_alert_sent.clear()
    yield
    status._last_alert_sent.clear()


# ---------- dedup ----------


def test_should_emit_first_alert_of_a_type():
    assert _should_emit_alert("down", now_ts := time.time()) is True
    _ = now_ts  # pin variable


def test_should_suppress_repeat_same_type_within_window():
    now = time.time()
    status._last_alert_sent["down"] = now - 10
    assert _should_emit_alert("down", now) is False


def test_should_emit_after_window_elapsed():
    now = time.time()
    status._last_alert_sent["down"] = now - (ALERT_MIN_INTERVAL_SEC + 1)
    assert _should_emit_alert("down", now) is True


def test_different_change_types_are_independent():
    """down → restored sequence must alert both — dedup is per change type."""
    now = time.time()
    status._last_alert_sent["down"] = now - 1
    assert _should_emit_alert("restored", now) is True
    assert _should_emit_alert("down", now) is False


# ---------- broadcast ----------


async def test_broadcast_alert_sends_to_every_chat():
    bot = MagicMock()
    bot.send_message = AsyncMock()
    await broadcast_alert(bot, [1, 2, 3], "hello")
    assert bot.send_message.await_count == 3
    bot.send_message.assert_any_await(1, "hello")
    bot.send_message.assert_any_await(2, "hello")
    bot.send_message.assert_any_await(3, "hello")


async def test_broadcast_alert_empty_chats_noop():
    bot = MagicMock()
    bot.send_message = AsyncMock()
    await broadcast_alert(bot, [], "hello")
    bot.send_message.assert_not_awaited()


async def test_broadcast_alert_continues_when_one_chat_fails():
    bot = MagicMock()

    async def send(chat_id, text):
        if chat_id == 2:
            raise RuntimeError("blocked by user")

    bot.send_message = AsyncMock(side_effect=send)
    # Should NOT raise — failures per chat are swallowed.
    await broadcast_alert(bot, [1, 2, 3], "hello")
    assert bot.send_message.await_count == 3


async def test_broadcast_alert_caps_concurrency():
    """With many chats, in-flight send_message calls must not exceed BROADCAST_CONCURRENCY."""
    bot = MagicMock()
    in_flight = 0
    peak = 0
    gate = asyncio.Event()

    async def send(chat_id, text):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        # Hold each send open until the test releases it, so concurrency is observable.
        await gate.wait()
        in_flight -= 1

    bot.send_message = AsyncMock(side_effect=send)
    chat_ids = list(range(BROADCAST_CONCURRENCY * 3))

    broadcast_task = asyncio.create_task(broadcast_alert(bot, chat_ids, "x"))
    # Yield to let the semaphore admit the first batch.
    for _ in range(5):
        await asyncio.sleep(0)
    assert peak <= BROADCAST_CONCURRENCY
    gate.set()
    await broadcast_task
    assert peak <= BROADCAST_CONCURRENCY
    assert bot.send_message.await_count == len(chat_ids)


# ---------- integration: ServerStatus + detect_change still works ----------


def test_server_status_dataclass_smoke():
    s = ServerStatus(indicator="major", description="Login: partial outage")
    assert s.indicator == "major"
    assert s.incidents == []
