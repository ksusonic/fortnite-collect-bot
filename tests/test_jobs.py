from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

from bot import jobs, runtime
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
