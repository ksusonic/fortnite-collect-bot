from contextlib import asynccontextmanager
from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from bot import handlers, jobs, runtime
from bot.messages import MSK
from bot.storage import advisory_lock, invocation


async def test_duplicate_job_ticks_do_not_repeat_cleanup(tmp_db, monkeypatch):
    async with invocation() as conn:
        await conn.execute("INSERT INTO import_manifest(source_sha256,report) VALUES ('verified','{}')")
    cleanup = AsyncMock(return_value=0)
    monkeypatch.setattr(jobs.db, "cleanup_old_snapshots", cleanup)
    monkeypatch.setattr(jobs, "recover_pending", AsyncMock())
    monkeypatch.setattr(jobs.time, "time", lambda: 1700000000)

    @asynccontextmanager
    async def client():
        yield object()

    monkeypatch.setattr(jobs, "bot_client", client)
    assert await jobs.run_job("cleanup") == {"ok": True}
    assert (await jobs.run_job("cleanup"))["skipped"] == "duplicate"
    cleanup.assert_awaited_once()


async def test_overlapping_jobs_skip(tmp_db):
    async with invocation():
        async with advisory_lock("job:expiry"):
            assert (await jobs.run_job("expiry"))["skipped"] == "overlap"


async def test_recovery_ignores_job_orchestration_items(tmp_db, monkeypatch):
    async with invocation() as conn:
        await runtime.enqueue(conn, "job:expiry:123", "job", None, {})
    drain = AsyncMock()
    monkeypatch.setattr(runtime, "drain_chat", drain)
    await runtime.recover_pending(object())
    drain.assert_not_awaited()


async def test_cleanup_waits_for_verified_import(tmp_db, monkeypatch):
    cleanup = AsyncMock()
    monkeypatch.setattr(jobs.db, "cleanup_old_snapshots", cleanup)
    assert (await jobs.run_job("cleanup"))["skipped"] == "import not verified"
    cleanup.assert_not_awaited()


@pytest.mark.parametrize("has_results", [False, True])
async def test_weekly_drop_runs_once_across_friday_ticks(tmp_db, monkeypatch, has_results):
    current = [datetime(2026, 10, 2, 21, 0, tzinfo=MSK)]

    class Clock:
        @staticmethod
        def now(tz):
            return current[0].astimezone(tz)

    @asynccontextmanager
    async def client():
        yield object()

    monkeypatch.setattr(jobs, "datetime", Clock)
    monkeypatch.setattr(jobs.time, "time", lambda: current[0].timestamp())
    monkeypatch.setattr(jobs, "bot_client", client)
    render = AsyncMock(return_value=has_results)
    monkeypatch.setattr(handlers, "_run_teamstats", render)
    await jobs.db.save_epic_link(-100, 10, "Player", "Epic", "account")

    assert await jobs.run_job("weekly") == {"ok": True}
    assert (await jobs.run_job("weekly"))["skipped"] == "duplicate"
    current[0] = current[0].replace(minute=5)
    assert await jobs.run_job("weekly") == {"ok": True}
    render.assert_awaited_once_with(render.call_args.args[0], -100, silent_on_empty=True)
    assert await jobs.db.get_last_weekly_drop(-100) == datetime(2026, 10, 2, 21, 0, tzinfo=MSK).timestamp()


@pytest.mark.parametrize("day,hour", [(2, 20), (2, 22), (3, 21)])
async def test_weekly_drop_stays_quiet_outside_friday_window(tmp_db, monkeypatch, day, hour):
    current = datetime(2026, 10, day, hour, tzinfo=MSK)

    class Clock:
        @staticmethod
        def now(tz):
            return current.astimezone(tz)

    @asynccontextmanager
    async def client():
        yield object()

    monkeypatch.setattr(jobs, "datetime", Clock)
    monkeypatch.setattr(jobs.time, "time", lambda: current.timestamp())
    monkeypatch.setattr(jobs, "bot_client", client)
    render = AsyncMock()
    monkeypatch.setattr(handlers, "_run_teamstats", render)
    await jobs.db.save_epic_link(-100, 10, "Player", "Epic", "account")
    assert await jobs.run_job("weekly") == {"ok": True}
    render.assert_not_awaited()
    assert await jobs.db.get_last_weekly_drop(-100) is None
