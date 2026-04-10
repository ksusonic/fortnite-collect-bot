from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError

from bot.db import get_active_chat_ids, get_last_seen_version, set_last_seen_version

logger = logging.getLogger(__name__)

CHANGELOG_PATH = Path(__file__).parent.parent / "CHANGELOG.md"


@dataclass
class Release:
    version: str
    changes: list[str] = field(default_factory=list)


def parse_latest_release() -> Release | None:
    try:
        text = CHANGELOG_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None

    version_match = re.search(r"^## (.+)$", text, re.MULTILINE)
    if not version_match:
        return None

    version = version_match.group(1).strip()
    rest = text[version_match.end():]
    next_heading = re.search(r"^## ", rest, re.MULTILINE)
    block = rest[:next_heading.start()] if next_heading else rest

    changes = [m.group(1) for m in re.finditer(r"^- (.+)$", block, re.MULTILINE)]
    if not changes:
        return None

    return Release(version=version, changes=changes)


def build_news_text(release: Release) -> str:
    lines = [f"\U0001f389 <b>Йоу! Обновление v{release.version}</b>\n"]
    for change in release.changes:
        lines.append(change)
    lines.append("\nЗалетай — /fort \U0001f3ae")
    return "\n".join(lines)


async def broadcast_news(bot: Bot) -> None:
    release = parse_latest_release()
    if release is None:
        return

    chat_ids = await get_active_chat_ids()
    for chat_id in chat_ids:
        last = await get_last_seen_version(chat_id)
        if last == release.version:
            continue

        text = build_news_text(release)
        try:
            await bot.send_message(chat_id, text)
        except (TelegramForbiddenError, TelegramBadRequest) as e:
            logger.warning("Failed to send news to chat %s: %s", chat_id, e)
            continue

        await set_last_seen_version(chat_id, release.version)
