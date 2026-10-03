from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import Update
from psycopg.types.json import Jsonb

from bot import db, fortnite, handlers, roast
from bot.storage import ContextMap, _work, advisory_lock, database, invocation
from bot.work import AmbiguousOutcome, Work, telegram_middleware

logger = logging.getLogger(__name__)
dispatcher = Dispatcher()
dispatcher.include_router(handlers.router)


@asynccontextmanager
async def runtime_views():
    maps = [
        db.sessions,
        handlers._session_locks,
        handlers._fort_attempt_times,
        roast._RECENT,
        roast._LAST_ROAST,
        roast._ROAST_MESSAGE_IDS,
        roast._ROAST_LOCKS,
        fortnite._stats_cache,
        fortnite._stats_locks,
    ]
    tokens = [(mapping, mapping.context.set({})) for mapping in maps if isinstance(mapping, ContextMap)]
    try:
        yield
    finally:
        for mapping, token in reversed(tokens):
            mapping.context.reset(token)


@asynccontextmanager
async def bot_client():
    bot = Bot(os.environ["BOT_TOKEN"], default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    bot.session.middleware(telegram_middleware)
    try:
        yield bot
    finally:
        await bot.session.close()
        await fortnite.close()
        await roast.close()


async def hydrate(chat_id):
    if chat_id is None:
        return
    for session in await db.load_active_sessions(chat_id):
        db.sessions[(session.chat_id, session.message_id)] = session
    for cid, history, msgs, last in await db.load_all_roast_state(chat_id):
        roast.restore_roast_state(cid, history, msgs, last)
    async with database() as database_conn:
        rows = await (
            await database_conn.execute(
                "SELECT chat_id,user_id,attempted_at FROM fort_cooldowns WHERE chat_id=%s", (chat_id,)
            )
        ).fetchall()
        for row in rows:
            handlers._fort_attempt_times[(row["chat_id"], row["user_id"])] = row["attempted_at"]


def update_chat(update):
    message = update.message or update.edited_message or update.my_chat_member or update.chat_member
    if message:
        return message.chat.id
    if update.callback_query and update.callback_query.message:
        return update.callback_query.message.chat.id
    return None


async def enqueue(conn, work_id, kind, chat_id, payload):
    await conn.execute(
        "INSERT INTO work_items(id,kind,chat_id,payload) VALUES (%s,%s,%s,%s) ON CONFLICT(id) DO NOTHING",
        (work_id, kind, chat_id, Jsonb(payload)),
    )


async def execute_item(conn, item, bot):
    token = _work.set(Work(item["id"]))
    await conn.execute("UPDATE work_items SET attempts=attempts+1,updated_at=now() WHERE id=%s", (item["id"],))
    try:
        async with runtime_views():
            chat = item["chat_id"]
            payload = item["payload"]
            await hydrate(chat)
            if item["kind"] == "update":
                update = Update.model_validate(payload, context={"bot": bot})
                await dispatcher.feed_update(bot, update)
            elif item["kind"] == "expiry":
                await handlers.sweep_expired_sessions(bot, payload["now"], payload["past_deadline"])
            elif item["kind"] == "weekly":
                last = await db.get_last_weekly_drop(chat)
                if last is None or last <= payload["now"] - handlers.WEEKLY_DROP_DEDUP_WINDOW_SEC:
                    await handlers._run_teamstats(bot, chat, silent_on_empty=True)
                    await db.set_last_weekly_drop(chat, payload["now"])
            elif item["kind"] == "status":
                await bot.send_message(chat, payload["text"])
            else:
                raise ValueError("unknown work kind")
            if chat is not None:
                await roast.persist_roast_state(chat)
        await conn.execute(
            "UPDATE work_items SET status='complete',error=NULL,updated_at=now() WHERE id=%s", (item["id"],)
        )
        return "complete"
    except AmbiguousOutcome:
        return "ambiguous"
    except Exception as exc:
        logger.exception("work failed: %s", item["id"])
        await conn.execute(
            "UPDATE work_items SET status='failed',error=%s,updated_at=now() WHERE id=%s",
            (type(exc).__name__, item["id"]),
        )
        return "failed"
    finally:
        _work.reset(token)


async def drain_chat(chat, bot, *, limit=20):
    async with invocation(chat) as conn:
        async with advisory_lock(f"chat:{chat}"):
            # Preserve causal order across updates and scheduled edits. An
            # ambiguous earlier send quarantines its chat until reviewed.
            rows = await (
                await conn.execute(
                    "SELECT * FROM work_items WHERE chat_id IS NOT DISTINCT FROM %s "
                    "AND kind <> 'job' AND status <> 'complete' ORDER BY created_at,id LIMIT %s",
                    (chat, limit),
                )
            ).fetchall()
            for item in rows:
                if item["status"] == "ambiguous":
                    return "ambiguous"
                outcome = await execute_item(conn, item, bot)
                if outcome != "complete":
                    return outcome
    return "complete"


async def process_update(payload):
    update = Update.model_validate(payload)
    chat = update_chat(update)
    work_id = f"update:{update.update_id}"
    async with invocation() as conn:
        await enqueue(conn, work_id, "update", chat, payload)
        row = await (await conn.execute("SELECT status FROM work_items WHERE id=%s", (work_id,))).fetchone()
        if row["status"] == "complete":
            return "complete"
    async with bot_client() as bot:
        await drain_chat(chat, bot)
    async with invocation() as conn:
        row = await (await conn.execute("SELECT status FROM work_items WHERE id=%s", (work_id,))).fetchone()
        return row["status"]


async def recover_pending(bot):
    async with invocation() as conn:
        chats = await (
            await conn.execute(
                "SELECT chat_id FROM work_items WHERE kind <> 'job' AND status IN ('pending','failed') "
                "GROUP BY chat_id ORDER BY min(created_at) LIMIT 20"
            )
        ).fetchall()
    for row in chats:
        await drain_chat(row["chat_id"], bot)
