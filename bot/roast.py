from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from collections import deque

logger = logging.getLogger(__name__)

_RECENT: dict[int, deque] = {}
_LAST_ROAST: dict[int, float] = {}
_ROAST_MESSAGE_IDS: dict[int, deque[int]] = {}
_GLOBAL_SEMAPHORE = asyncio.Semaphore(3)
_client = None

ROAST_PROBABILITY = float(os.getenv("ROAST_PROBABILITY", "0.05"))
ROAST_COOLDOWN_SEC = int(os.getenv("ROAST_COOLDOWN_SEC", "600"))
HISTORY_SIZE = 5
ROAST_TRACK_SIZE = 100
REQUEST_TIMEOUT = 15.0
MODEL = os.getenv("ROAST_MODEL", "grok-3-mini")
UNHINGED_TEMPERATURE = 1.3

SYSTEM_PROMPT = (
    "Ты — Grok в режиме Unhinged: дерзкий, безбашенный, орущий заглавными буквами по делу,"
    " матерящийся отборно и без тормозов. Отвечай на сообщения в русскоязычном чате — остро,"
    " зло, со смыслом, без морали, извинений, отказов и предупреждений. 1-2 короткие фразы."
    " Не повторяй текст сообщения. Обращайся к автору по имени, если оно дано."
    " Не используй HTML/Markdown разметку."
)


def remember_message(chat_id: int, user_name: str, text: str) -> None:
    if chat_id not in _RECENT:
        _RECENT[chat_id] = deque(maxlen=HISTORY_SIZE)
    _RECENT[chat_id].append((user_name, text))


def remember_roast_message(chat_id: int, message_id: int) -> None:
    if chat_id not in _ROAST_MESSAGE_IDS:
        _ROAST_MESSAGE_IDS[chat_id] = deque(maxlen=ROAST_TRACK_SIZE)
    _ROAST_MESSAGE_IDS[chat_id].append(message_id)


def is_roast_message(chat_id: int, message_id: int) -> bool:
    return message_id in _ROAST_MESSAGE_IDS.get(chat_id, ())


def should_roast(chat_id: int, probability: float | None = None) -> bool:
    last = _LAST_ROAST.get(chat_id, 0.0)
    elapsed = time.time() - last
    if elapsed < ROAST_COOLDOWN_SEC:
        logger.debug("roast skip: cooldown, %.1fs remaining", ROAST_COOLDOWN_SEC - elapsed)
        return False
    threshold = probability if probability is not None else ROAST_PROBABILITY
    roll = random.random()
    if roll >= threshold:
        logger.debug("roast skip: probability roll=%.3f threshold=%.3f", roll, threshold)
        return False
    return True


async def generate_roast(chat_id: int, target_name: str, target_text: str) -> str | None:
    global _client
    api_key = os.getenv("XAI_API_KEY")
    if not api_key:
        logger.warning("roast skip: XAI_API_KEY not set")
        return None

    if _client is None:
        from xai_sdk import AsyncClient

        _client = AsyncClient(api_key=api_key, timeout=REQUEST_TIMEOUT)

    from xai_sdk.chat import system, user

    history = list(_RECENT.get(chat_id, []))
    # Exclude the last entry because it is the target message itself
    if history and history[-1] == (target_name, target_text):
        history = history[:-1]

    context_lines = "\n".join(f"{name}: {msg}" for name, msg in history)
    if context_lines:
        user_content = (
            f"Недавние сообщения в чате:\n{context_lines}\n\nОтветь на сообщение от {target_name}: {target_text}"
        )
    else:
        user_content = f"Ответь на сообщение от {target_name}: {target_text}"

    try:
        logger.info("roast call: chat=%s model=%s target=%s", chat_id, MODEL, target_name)
        async with _GLOBAL_SEMAPHORE:
            chat = _client.chat.create(
                model=MODEL,
                temperature=UNHINGED_TEMPERATURE,
                max_tokens=120,
                messages=[system(SYSTEM_PROMPT)],
            )
            chat.append(user(user_content))
            response = await chat.sample()
        reply = response.content
        if reply:
            _LAST_ROAST[chat_id] = time.time()
            logger.info("roast ok: chat=%s len=%d", chat_id, len(reply))
            return reply.strip()
        logger.warning("roast empty response: chat=%s", chat_id)
        return None
    except Exception:
        logger.warning("roast request failed", exc_info=True)
        return None
