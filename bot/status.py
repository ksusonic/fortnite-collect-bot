from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import aiohttp

from bot.db import get_active_chat_ids

logger = logging.getLogger(__name__)

POLL_INTERVAL = 180  # 3 minutes
ALERT_START_HOUR = 18
ALERT_END_HOUR = 0

STATUS_API = "https://status.epicgames.com/api/v2/status.json"
INCIDENTS_API = "https://status.epicgames.com/api/v2/incidents/unresolved.json"

MSK = timezone(timedelta(hours=3))

_last_status: ServerStatus | None = None


@dataclass
class ServerStatus:
    indicator: str  # "none" | "minor" | "major" | "critical"
    description: str  # "All Systems Operational"
    incidents: list[str] = field(default_factory=list)  # active incident names


async def fetch_status(session: aiohttp.ClientSession) -> ServerStatus | None:
    try:
        async with session.get(STATUS_API, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            data = await resp.json()
            status = data["status"]

        incidents: list[str] = []
        async with session.get(INCIDENTS_API, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            data = await resp.json()
            for inc in data.get("incidents", []):
                incidents.append(inc["name"])

        return ServerStatus(
            indicator=status["indicator"],
            description=status["description"],
            incidents=incidents,
        )
    except Exception:
        logger.warning("Failed to fetch Epic Games status", exc_info=True)
        return None


def detect_change(old: ServerStatus | None, new: ServerStatus) -> str | None:
    if old is None:
        # First poll in the window — only alert if servers are down
        if new.indicator in ("major", "critical"):
            return "down"
        if new.indicator == "minor":
            return "degraded"
        return None

    if old.indicator == new.indicator:
        return None

    if new.indicator == "none":
        return "restored"
    if new.indicator in ("major", "critical"):
        return "down"
    if new.indicator == "minor":
        return "degraded"
    return None


def build_alert(change_type: str, status: ServerStatus) -> str:
    if change_type in ("down", "degraded"):
        lines = ["<b>⚠️ Проблемы с серверами Fortnite!</b>", ""]
        for name in status.incidents:
            lines.append(f"🔴 {name}")
        if not status.incidents:
            lines.append(f"🔴 {status.description}")
        lines.append("")
        lines.append("Серверы могут быть недоступны 🛠")
        return "\n".join(lines)

    # restored
    return (
        "<b>✅ Серверы Fortnite снова работают!</b>\n\n"
        "Погнали катать! /fort"
    )


async def check_status_loop(bot: object) -> None:
    global _last_status

    from aiogram import Bot
    assert isinstance(bot, Bot)

    await asyncio.sleep(10)  # let the bot start up

    async with aiohttp.ClientSession() as http:
        while True:
            try:
                now = datetime.now(MSK)
                hour = now.hour

                if ALERT_START_HOUR <= hour or hour < ALERT_END_HOUR:
                    status = await fetch_status(http)
                    if status is not None:
                        change = detect_change(_last_status, status)
                        if change is not None:
                            text = build_alert(change, status)
                            chat_ids = await get_active_chat_ids()
                            for chat_id in chat_ids:
                                try:
                                    await bot.send_message(chat_id, text)
                                except Exception:
                                    logger.warning("Failed to send status alert to %s", chat_id)
                        _last_status = status
                else:
                    _last_status = None
            except Exception:
                logger.error("Error in status check loop", exc_info=True)

            await asyncio.sleep(POLL_INTERVAL)
