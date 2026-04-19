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
_GLOBAL_SEMAPHORE = asyncio.Semaphore(3)
_client = None

ROAST_PROBABILITY = 0.05
ROAST_COOLDOWN_SEC = 600
HISTORY_SIZE = 5
REQUEST_TIMEOUT = 15.0
MODEL = "gpt-4o-mini"

SYSTEM_PROMPT = (
    "Ты — бот в русскоязычной геймерской группе Fortnite. Твоя задача — отвечать на сообщения"
    " отборно, с матом, остроумно и со смыслом. Стиль: дерзкий, саркастичный, иногда с отсылкой"
    " к Fortnite/королевке/скуаду. 1-2 короткие фразы, без морали, без извинений, без отказов."
    " Не повторяй текст сообщения. Обращайся к автору по имени, если оно дано."
    " Не используй HTML/Markdown разметку."
)


def remember_message(chat_id: int, user_name: str, text: str) -> None:
    if chat_id not in _RECENT:
        _RECENT[chat_id] = deque(maxlen=HISTORY_SIZE)
    _RECENT[chat_id].append((user_name, text))


def should_roast(chat_id: int) -> bool:
    last = _LAST_ROAST.get(chat_id, 0.0)
    if time.time() - last < ROAST_COOLDOWN_SEC:
        return False
    return random.random() < ROAST_PROBABILITY


async def generate_roast(chat_id: int, target_name: str, target_text: str) -> str | None:
    global _client
    if not os.getenv("OPENAI_API_KEY"):
        return None

    if _client is None:
        from openai import AsyncOpenAI

        _client = AsyncOpenAI()

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
        async with _GLOBAL_SEMAPHORE:
            response = await _client.chat.completions.create(
                model=MODEL,
                timeout=REQUEST_TIMEOUT,
                max_tokens=120,
                temperature=1.0,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
            )
        reply = response.choices[0].message.content
        if reply:
            _LAST_ROAST[chat_id] = time.time()
            return reply.strip()
        return None
    except Exception:
        logger.warning("roast request failed", exc_info=True)
        return None
