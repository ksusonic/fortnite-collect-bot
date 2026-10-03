from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
from aiogram import Bot
from aiogram.methods import SendMessage
from aiogram.types import Message
from httpx import ASGITransport, AsyncClient

import app as api
from bot import db, handlers, roast, runtime
from bot.storage import _work, advisory_lock, database, invocation
from bot.work import AmbiguousOutcome, Work

TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"


def update(update_id=1, chat=-100, text="/fort"):
    return {
        "update_id": update_id,
        "message": {
            "message_id": update_id,
            "date": 1700000000,
            "chat": {"id": chat, "type": "supergroup"},
            "from": {"id": 5, "is_bot": False, "first_name": "Host"},
            "text": text,
            "entities": [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}],
        },
    }


@pytest.fixture
def telegram(monkeypatch):
    calls = []
    fail = {"method": None, "once": False}

    async def request(bot, method):
        name = method.__api_method__
        calls.append(name)
        if name == fail["method"] and not fail["once"]:
            fail["once"] = True
            raise RuntimeError("injected failure")
        if name == "sendMessage":
            return Message.model_validate(
                {
                    "message_id": 900,
                    "date": 1700000000,
                    "chat": {"id": method.chat_id, "type": "supergroup"},
                    "text": method.text,
                },
                context={"bot": bot},
            )
        return True

    @asynccontextmanager
    async def client():
        bot = Bot(TOKEN)

        async def middleware(make_request, bot, method):
            from bot.work import telegram_middleware

            return await telegram_middleware(request, bot, method)

        bot.session.middleware(middleware)
        try:
            yield bot
        finally:
            await bot.session.close()

    monkeypatch.setattr(runtime, "bot_client", client)
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    return calls, fail, client


async def test_webhook_authentication_precedes_update_processing(monkeypatch):
    monkeypatch.setenv("TELEGRAM_WEBHOOK_SECRET", "secret")
    process = AsyncMock(return_value="complete")
    monkeypatch.setattr(api, "process_update", process)
    async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://test") as client:
        assert (await client.post("/api/telegram/webhook", json=update())).status_code == 401
        assert (
            await client.post(
                "/api/telegram/webhook", json=update(), headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"}
            )
        ).status_code == 401
        process.assert_not_awaited()
        assert (
            await client.post(
                "/api/telegram/webhook", json=update(), headers={"X-Telegram-Bot-Api-Secret-Token": "secret"}
            )
        ).status_code == 200


async def test_jobs_require_bearer_secret(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "job-secret")
    run = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(api, "run_job", run)
    async with AsyncClient(transport=ASGITransport(app=api.app), base_url="http://test") as client:
        assert (await client.post("/api/jobs/expiry")).status_code == 401
        assert (await client.post("/api/jobs/expiry", headers={"Authorization": "job-secret"})).status_code == 401
        assert (
            await client.post("/api/jobs/expiry", headers={"Authorization": "Bearer job-secret"})
        ).status_code == 200
        assert (
            await client.post("/api/jobs/unknown", headers={"Authorization": "Bearer job-secret"})
        ).status_code == 404


async def test_duplicate_updates_send_once(tmp_db, telegram):
    calls, _, _ = telegram
    assert await runtime.process_update(update()) == "complete"
    assert await runtime.process_update(update()) == "complete"
    assert calls.count("sendMessage") == 1
    assert (await db.load_session(900, -100)).initiator_id == 5


async def test_retry_after_send_and_database_write_does_not_repeat_them(tmp_db, telegram):
    calls, fail, _ = telegram
    fail["method"] = "pinChatMessage"
    assert await runtime.process_update(update()) == "failed"
    assert await runtime.process_update(update()) == "complete"
    assert calls.count("sendMessage") == 1
    assert calls.count("pinChatMessage") == 2
    assert len(await db.load_active_sessions(-100)) == 1


async def test_ambiguous_send_is_quarantined(tmp_db, telegram):
    calls, fail, _ = telegram
    fail["method"] = "sendMessage"
    assert await runtime.process_update(update()) == "ambiguous"
    assert await runtime.process_update(update()) == "ambiguous"
    assert calls.count("sendMessage") == 1
    async with invocation() as conn:
        row = await (await conn.execute("SELECT status,error FROM work_items WHERE id='update:1'")).fetchone()
        assert row["status"] == "ambiguous"
        assert "uncertain Telegram outcome" in row["error"]


async def test_started_send_after_process_crash_is_not_repeated(tmp_db):
    async with invocation() as conn:
        await runtime.enqueue(conn, "crash", "update", -100, update())
        first = Work("crash")
        await first.save("telegram:0", "sendMessage", "started")
        bot = Bot(TOKEN)
        send = AsyncMock()
        with pytest.raises(AmbiguousOutcome):
            await Work("crash").telegram(send, bot, SendMessage(chat_id=-100, text="hello"))
        send.assert_not_awaited()
        await bot.session.close()


async def test_database_write_and_read_replay(tmp_db):
    async with invocation() as conn:
        await runtime.enqueue(conn, "sql", "update", -100, {})
        for _ in range(2):
            token = _work.set(Work("sql"))
            try:
                async with database() as database_conn:
                    await database_conn.execute(
                        "INSERT INTO chat_features VALUES (-100,'counter',true,1) "
                        "ON CONFLICT(chat_id,feature) DO UPDATE SET value=chat_features.value+1"
                    )
                    row = await (
                        await database_conn.execute("SELECT value FROM chat_features WHERE feature='counter'")
                    ).fetchone()
                    assert row["value"] == 1
            finally:
                _work.reset(token)
        assert (await (await conn.execute("SELECT value FROM chat_features")).fetchone())["value"] == 1


async def test_concurrent_callbacks_serialize_and_promote_reserve(tmp_db, telegram):
    _, _, _ = telegram
    session = db.Session(chat_id=-100, message_id=900, initiator_id=5, initiator_name="Host")
    await db.save_session(session)

    def callback(uid, action):
        return {
            "update_id": 100 + uid,
            "callback_query": {
                "id": str(uid),
                "from": {"id": uid, "is_bot": False, "first_name": f"P{uid}"},
                "chat_instance": "chat",
                "data": action,
                "message": {"message_id": 900, "date": 1700000000, "chat": {"id": -100, "type": "supergroup"}},
            },
        }

    await asyncio.gather(*(runtime.process_update(callback(uid, "go")) for uid in range(1, 6)))
    loaded = await db.load_session(900, -100)
    roster = list(loaded.go_players)
    assert len(roster) == 5
    leaving = roster[0]
    payload = callback(leaving, "pass")
    payload["update_id"] = 999
    assert await runtime.process_update(payload) == "complete"
    loaded = await db.load_session(900, -100)
    assert list(loaded.go_players) == roster[1:]
    assert len(handlers.split_roster(loaded)[1]) == 0


async def test_cross_chat_message_ids_are_independent(tmp_db, telegram):
    await asyncio.gather(runtime.process_update(update(1, -100)), runtime.process_update(update(2, -200)))
    assert await db.load_session(900, -100) is not None
    assert await db.load_session(900, -200) is not None
    await db.save_response(900, 10, "Alice", "go", chat_id=-100)
    assert (await db.load_session(900, -200)).go_players == {}


async def test_chat_lock_prevents_overlapping_edits(tmp_db):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def hold():
        async with invocation():
            async with advisory_lock("chat:-100"):
                entered.set()
                await release.wait()

    task = asyncio.create_task(hold())
    await entered.wait()
    async with invocation():
        async with advisory_lock("chat:-100", wait=False) as acquired:
            assert not acquired
        async with advisory_lock("chat:-200", wait=False) as acquired:
            assert acquired
    release.set()
    await task


async def test_roast_history_persists_across_invocations(tmp_db, telegram):
    payload = update(text="hello")
    payload["message"]["entities"] = []
    assert await runtime.process_update(payload) == "complete"
    rows = await db.load_all_roast_state(-100)
    assert rows[0][1][0]["text"] == "hello"
    async with runtime.runtime_views():
        await runtime.hydrate(-100)
        assert roast._RECENT[-100][0].message_id == 1
