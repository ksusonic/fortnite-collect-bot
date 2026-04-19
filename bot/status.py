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

COMPONENTS_API = "https://status.epicgames.com/api/v2/components.json"
INCIDENTS_API = "https://status.epicgames.com/api/v2/incidents/unresolved.json"

FORTNITE_GROUP_NAME = "Fortnite"

# Worst component status → indicator
_STATUS_TO_INDICATOR = {
    "operational": "none",
    "under_maintenance": "minor",
    "degraded_performance": "minor",
    "partial_outage": "major",
    "major_outage": "critical",
}
_INDICATOR_SEVERITY = {"none": 0, "minor": 1, "major": 2, "critical": 3}

MSK = timezone(timedelta(hours=3))

_last_status: ServerStatus | None = None


@dataclass
class ServerStatus:
    indicator: str  # "none" | "minor" | "major" | "critical"
    description: str  # human-readable summary
    incidents: list[str] = field(default_factory=list)  # active incident names


def _find_fortnite_group(components: list[dict]) -> dict | None:
    for c in components:
        if c.get("group") and c.get("name") == FORTNITE_GROUP_NAME:
            return c
    return None


def _derive_indicator(statuses: list[str]) -> tuple[str, list[str]]:
    worst = "none"
    problems: list[str] = []
    for name, status in statuses:
        ind = _STATUS_TO_INDICATOR.get(status, "none")
        if _INDICATOR_SEVERITY[ind] > _INDICATOR_SEVERITY[worst]:
            worst = ind
        if status != "operational":
            problems.append(f"{name}: {status.replace('_', ' ')}")
    return worst, problems


async def fetch_status(session: aiohttp.ClientSession) -> ServerStatus | None:
    try:
        async with session.get(
            COMPONENTS_API, timeout=aiohttp.ClientTimeout(total=15)
        ) as resp:
            data = await resp.json()
            components = data.get("components", [])

        group = _find_fortnite_group(components)
        if group is None:
            logger.warning("Fortnite group not found in components API")
            return None

        child_ids = set(group.get("components", []))
        fortnite_components = [c for c in components if c["id"] in child_ids]
        statuses = [(c["name"], c["status"]) for c in fortnite_components]

        indicator, problems = _derive_indicator(statuses)
        description = (
            "All Fortnite Systems Operational"
            if indicator == "none"
            else "; ".join(problems)
        )

        incidents: list[str] = []
        async with session.get(
            INCIDENTS_API, timeout=aiohttp.ClientTimeout(total=15)
        ) as resp:
            data = await resp.json()
            group_id = group["id"]
            for inc in data.get("incidents", []):
                affected = inc.get("components", [])
                if any(
                    comp.get("group_id") == group_id or comp.get("id") in child_ids
                    for comp in affected
                ):
                    incidents.append(inc["name"])

        return ServerStatus(
            indicator=indicator,
            description=description,
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
    return "<b>✅ Серверы Fortnite снова работают!</b>\n\nПогнали катать! /fort"


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
                                    logger.warning(
                                        "Failed to send status alert to %s", chat_id
                                    )
                        _last_status = status
                else:
                    _last_status = None
            except Exception:
                logger.error("Error in status check loop", exc_info=True)

            await asyncio.sleep(POLL_INTERVAL)
