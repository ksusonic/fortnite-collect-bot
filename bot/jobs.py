from __future__ import annotations

import time
from dataclasses import asdict
from datetime import datetime

import aiohttp
from psycopg.types.json import Jsonb

from bot import db, status
from bot.messages import MSK, PLAY_DEADLINE_HOUR
from bot.runtime import bot_client, enqueue, recover_pending
from bot.storage import advisory_lock, invocation


async def status_check(conn):
    row = await (await conn.execute("SELECT value FROM service_state WHERE key='epic_status'")).fetchone()
    state = row["value"] if row else {"status": None, "alerts": {}}
    hour = datetime.now(MSK).hour
    if hour < status.ALERT_START_HOUR:
        state["status"] = None
    else:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as http:
            current = await status.fetch_status(http)
        if current is None:
            raise RuntimeError("Epic status unavailable")
        previous = status.ServerStatus(**state["status"]) if state["status"] else None
        change = status.detect_change(previous, current)
        now = time.time()
        async with conn.transaction():
            if change and now - state["alerts"].get(change, 0) >= status.ALERT_MIN_INTERVAL_SEC:
                for chat in await db.get_active_chat_ids():
                    await enqueue(
                        conn, f"status:{now}:{chat}", "status", chat, {"text": status.build_alert(change, current)}
                    )
                state["alerts"][change] = now
            state["status"] = asdict(current)
            await conn.execute(
                "INSERT INTO service_state(key,value) VALUES ('epic_status',%s) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (Jsonb(state),),
            )
        return
    await conn.execute(
        "INSERT INTO service_state(key,value) VALUES ('epic_status',%s) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (Jsonb(state),),
    )


async def run_job(name):
    now = time.time()
    period = {"expiry": 60, "status": 180, "weekly": 300, "cleanup": 86400}[name]
    work_id = f"job:{name}:{int(now) // period}"
    async with invocation() as conn:
        registered = await (await conn.execute("SELECT to_regclass('net._http_response') AS table_name")).fetchone()
        if registered["table_name"]:
            await conn.execute(
                "UPDATE job_http_requests j SET completed_at=r.created,status_code=r.status_code,"
                "timed_out=r.timed_out,error=r.error_msg FROM net._http_response r "
                "WHERE j.request_id=r.id AND j.completed_at IS NULL"
            )
        async with advisory_lock(f"job:{name}", wait=False) as acquired:
            if not acquired:
                return {"ok": True, "skipped": "overlap"}
            await enqueue(conn, work_id, "job", None, {"name": name})
            row = await (await conn.execute("SELECT status FROM work_items WHERE id=%s", (work_id,))).fetchone()
            if row["status"] == "complete":
                return {"ok": True, "skipped": "duplicate"}
            await conn.execute("UPDATE work_items SET attempts=attempts+1,updated_at=now() WHERE id=%s", (work_id,))
            try:
                if name == "cleanup":
                    if not await (await conn.execute("SELECT 1 FROM import_manifest LIMIT 1")).fetchone():
                        return {"ok": True, "skipped": "import not verified"}
                    await db.cleanup_old_snapshots(30)
                elif name == "status":
                    await status_check(conn)
                elif name == "expiry":
                    # An item per session preserves its initial view while an
                    # unfinished edit resumes after the session was closed.
                    for session in await db.load_active_sessions():
                        await enqueue(
                            conn,
                            f"expiry:{session.chat_id}:{session.message_id}:{int(now) // 60}",
                            "expiry",
                            session.chat_id,
                            {"now": now, "past_deadline": datetime.now(MSK).hour >= PLAY_DEADLINE_HOUR},
                        )
                elif name == "weekly":
                    current = datetime.now(MSK)
                    if current.weekday() == 4 and current.hour == 21:
                        for chat in await db.get_chats_with_epic_links():
                            await enqueue(conn, f"weekly:{current.date()}:{chat}", "weekly", chat, {"now": now})
                async with bot_client() as bot:
                    await recover_pending(bot)
                await conn.execute(
                    "UPDATE work_items SET status='complete',error=NULL,updated_at=now() WHERE id=%s", (work_id,)
                )
            except BaseException as exc:
                await conn.execute(
                    "UPDATE work_items SET status='failed',error=%s,updated_at=now() WHERE id=%s",
                    (type(exc).__name__, work_id),
                )
                raise
    return {"ok": True}
