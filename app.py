"""Vercel FastAPI entrypoint. Webhook registration is an explicit CLI action."""

import asyncio
import hmac
import logging
import os

from fastapi import FastAPI, HTTPException, Request
from pydantic import ValidationError

import bot.config  # noqa: F401
from bot.jobs import run_job
from bot.runtime import bot_client, dispatcher, process_update

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def authenticate(provided, variable):
    expected = os.getenv(variable)
    if not expected:
        raise HTTPException(503, "endpoint is not configured")
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(401, "unauthorized")


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/api/telegram/webhook")
async def webhook(request: Request):
    authenticate(request.headers.get("x-telegram-bot-api-secret-token"), "TELEGRAM_WEBHOOK_SECRET")
    try:
        payload = await request.json()
        async with asyncio.timeout(240):
            outcome = await process_update(payload)
    except ValidationError, ValueError:
        raise HTTPException(400, "invalid update") from None
    if outcome == "ambiguous":
        # Persisted for review; repeated delivery cannot resolve an uncertain send.
        return {"ok": True, "review_required": True}
    if outcome != "complete":
        raise HTTPException(503, "processing incomplete")
    return {"ok": True}


@app.post("/api/jobs/{name}")
async def job(name: str, request: Request):
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(401, "unauthorized")
    authenticate(header[7:], "CRON_SECRET")
    if name not in {"expiry", "status", "weekly", "cleanup"}:
        raise HTTPException(404, "unknown job")
    async with asyncio.timeout(240):
        return await run_job(name)


def admin_auth(request):
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(401, "unauthorized")
    authenticate(header[7:], "CRON_SECRET")


@app.post("/api/admin/register-webhook")
async def register_webhook(request: Request):
    admin_auth(request)
    from bot.commands import setup_bot_commands

    url = os.environ["PUBLIC_BASE_URL"].rstrip("/")
    if not url.startswith("https://"):
        raise HTTPException(503, "production URL must use HTTPS")
    async with bot_client() as bot:
        await setup_bot_commands(bot)
        await bot.set_webhook(
            url + "/api/telegram/webhook",
            secret_token=os.environ["TELEGRAM_WEBHOOK_SECRET"],
            max_connections=1,
            allowed_updates=dispatcher.resolve_used_update_types(),
            drop_pending_updates=False,
        )
        return (await bot.get_webhook_info()).model_dump(mode="json")


@app.get("/api/admin/inspect")
async def inspect_bot(request: Request):
    admin_auth(request)
    from bot.storage import invocation

    async with invocation() as conn:
        chats = await (await conn.execute("SELECT DISTINCT chat_id FROM sessions ORDER BY chat_id")).fetchall()
        counts = await (
            await conn.execute("SELECT status,count(*) AS count FROM work_items GROUP BY status")
        ).fetchall()
    async with bot_client() as bot:
        from aiogram.types import BotCommandScopeAllGroupChats

        me = await bot.get_me()
        memberships = []
        for row in chats:
            try:
                member = await bot.get_chat_member(row["chat_id"], bot.id)
                memberships.append(
                    {
                        "chat_id": row["chat_id"],
                        "status": member.status,
                        "can_pin_messages": getattr(member, "can_pin_messages", None),
                        "can_delete_messages": getattr(member, "can_delete_messages", None),
                    }
                )
            except Exception as exc:
                memberships.append({"chat_id": row["chat_id"], "error": type(exc).__name__})
        return {
            "bot": {
                "id": me.id,
                "username": me.username,
                "can_read_all_group_messages": me.can_read_all_group_messages,
            },
            "webhook": (await bot.get_webhook_info()).model_dump(mode="json"),
            "memberships": memberships,
            "work": counts,
            "commands": [
                command.model_dump() for command in await bot.get_my_commands(scope=BotCommandScopeAllGroupChats())
            ],
        }
