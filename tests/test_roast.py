from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from bot import roast


@pytest.fixture(autouse=True)
def _reset_roast_state(monkeypatch):
    roast._RECENT.clear()
    roast._LAST_ROAST.clear()
    roast._ROAST_MESSAGE_IDS.clear()
    # Prevent fire-and-forget DB writes from leaking into the real bot.db during unit tests.
    monkeypatch.setattr(roast, "_schedule_persist", lambda _chat_id: None)
    yield
    roast._RECENT.clear()
    roast._LAST_ROAST.clear()
    roast._ROAST_MESSAGE_IDS.clear()


def _grpc_error(code_name: str) -> Exception:
    exc = RuntimeError(f"grpc error {code_name}")
    exc.code = lambda: SimpleNamespace(name=code_name)
    return exc


# ---------- _is_retryable_error ----------


def test_is_retryable_grpc_unavailable():
    assert roast._is_retryable_error(_grpc_error("UNAVAILABLE")) is True


def test_is_retryable_grpc_resource_exhausted():
    assert roast._is_retryable_error(_grpc_error("RESOURCE_EXHAUSTED")) is True


def test_is_retryable_grpc_invalid_argument_false():
    assert roast._is_retryable_error(_grpc_error("INVALID_ARGUMENT")) is False


def test_is_retryable_http_429():
    exc = RuntimeError("rate limit")
    exc.status_code = 429
    assert roast._is_retryable_error(exc) is True


def test_is_retryable_http_503():
    exc = RuntimeError("svc unavail")
    exc.status_code = 503
    assert roast._is_retryable_error(exc) is True


def test_is_retryable_http_400_false():
    exc = RuntimeError("bad req")
    exc.status_code = 400
    assert roast._is_retryable_error(exc) is False


# ---------- generate_roast retry behavior ----------


async def test_generate_roast_retries_on_transient_then_succeeds(monkeypatch):
    monkeypatch.setenv("XAI_API_KEY", "test")
    # Avoid sleeping in tests.
    monkeypatch.setattr(roast.asyncio, "sleep", AsyncMock())

    calls = {"n": 0}

    async def fake_sample():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _grpc_error("UNAVAILABLE")
        return SimpleNamespace(content="zing")

    fake_chat = SimpleNamespace(sample=fake_sample)
    fake_client = SimpleNamespace(chat=SimpleNamespace(create=MagicMock(return_value=fake_chat)))
    monkeypatch.setattr(roast, "_client", fake_client)

    reply = await roast.generate_roast(chat_id=1, target_name="A", target_text="hi")

    assert reply == "zing"
    assert calls["n"] == 2


async def test_generate_roast_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setenv("XAI_API_KEY", "test")
    monkeypatch.setattr(roast.asyncio, "sleep", AsyncMock())

    calls = {"n": 0}

    async def fake_sample():
        calls["n"] += 1
        raise _grpc_error("UNAVAILABLE")

    fake_chat = SimpleNamespace(sample=fake_sample)
    fake_client = SimpleNamespace(chat=SimpleNamespace(create=MagicMock(return_value=fake_chat)))
    monkeypatch.setattr(roast, "_client", fake_client)

    reply = await roast.generate_roast(chat_id=1, target_name="A", target_text="hi")

    assert reply is None
    assert calls["n"] == roast.ROAST_MAX_ATTEMPTS


async def test_generate_roast_does_not_retry_non_retryable(monkeypatch):
    monkeypatch.setenv("XAI_API_KEY", "test")
    monkeypatch.setattr(roast.asyncio, "sleep", AsyncMock())

    calls = {"n": 0}

    async def fake_sample():
        calls["n"] += 1
        raise _grpc_error("INVALID_ARGUMENT")

    fake_chat = SimpleNamespace(sample=fake_sample)
    fake_client = SimpleNamespace(chat=SimpleNamespace(create=MagicMock(return_value=fake_chat)))
    monkeypatch.setattr(roast, "_client", fake_client)

    reply = await roast.generate_roast(chat_id=1, target_name="A", target_text="hi")

    assert reply is None
    assert calls["n"] == 1


# ---------- restore_roast_state ----------


def test_restore_roast_state_repopulates_in_memory():
    roast.restore_roast_state(
        chat_id=10,
        history_payload=[
            {"role": "user", "name": "a", "text": "hi", "ts": 1.0, "message_id": 5, "reply_to_id": None},
            {"role": "assistant", "name": "<bot>", "text": "yo", "ts": 2.0, "message_id": 6, "reply_to_id": None},
        ],
        roast_msg_ids=[6, 11],
        last_roast=100.0,
    )
    assert 10 in roast._RECENT
    assert len(roast._RECENT[10]) == 2
    # Reply to old roast message must still be detected after restore.
    assert roast.is_roast_message(10, 6) is True
    assert roast.is_roast_message(10, 11) is True
    assert roast.is_roast_message(10, 99) is False
    assert roast._LAST_ROAST[10] == 100.0


def test_restore_roast_state_skips_malformed_entries():
    roast.restore_roast_state(
        chat_id=11,
        history_payload=[
            {"role": "user", "name": "a", "text": "hi", "ts": 1.0},
            {"completely": "broken"},
        ],
        roast_msg_ids=[1, "bad", 2],
        last_roast=None,
    )
    assert len(roast._RECENT[11]) == 1
    assert list(roast._ROAST_MESSAGE_IDS[11]) == [1, 2]
