from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from collections import deque
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger(__name__)

Role = Literal["user", "assistant"]


@dataclass
class HistoryEntry:
    role: Role
    name: str
    text: str
    ts: float
    message_id: int | None = None
    reply_to_id: int | None = None


_RECENT: dict[int, deque[HistoryEntry]] = {}
_LAST_ROAST: dict[int, float] = {}
_ROAST_MESSAGE_IDS: dict[int, deque[int]] = {}
_GLOBAL_SEMAPHORE = asyncio.Semaphore(3)
_client = None

ROAST_PROBABILITY = float(os.getenv("ROAST_PROBABILITY", "0.05"))
ROAST_COOLDOWN_SEC = int(os.getenv("ROAST_COOLDOWN_SEC", "600"))
HISTORY_SIZE = int(os.getenv("ROAST_HISTORY_SIZE", "30"))
HISTORY_TTL_SEC = int(os.getenv("ROAST_HISTORY_TTL_SEC", "43200"))
ROAST_TRACK_SIZE = 100
REQUEST_TIMEOUT = float(os.getenv("ROAST_REQUEST_TIMEOUT", "45"))
MODEL = os.getenv("ROAST_MODEL", "grok-3-mini")
UNHINGED_TEMPERATURE = 1.3
BOT_HISTORY_NAME = "<bot>"

SYSTEM_PROMPT = (
    "Ты — Grok в режиме Unhinged в групповом чате друзей. Дерзкий, безбашенный, без морали"
    " и тормозов. Материшься отборно и грубо. Главное — смешно и больно одновременно.\n"
    "\n"
    "Целеуказание (важно):\n"
    "— Если в сообщении просят пройтись по конкретному человеку или нику ("
    "«разнеси X», «что скажешь про Y», упомянут @кто-то как объект) — мочи именно цель,"
    " автор твой союзник, его не трогай.\n"
    "— Если автор @упомянул тебя или ответил на твоё сообщение — отвечай ему, можно жёстко.\n"
    "— Если автор просто болтает или нарывается — подкалывай его в ответ, без жалости.\n"
    "\n"
    "Стиль:\n"
    "— 1–2 короткие острые фразы. Не пересказывай исходное сообщение.\n"
    "— Меняй приёмы: матерное оскорбление, неожиданная метафора, абсурд, отсылка к ранее"
    " сказанному в чате. Не повторяй одну и ту же конструкцию из своих предыдущих ответов.\n"
    "— Опирайся на контекст переписки: подхватывай шутки, ники, события чата.\n"
    "— Имя автора называй, когда естественно вписывается, не обязательно в начале.\n"
    "— @упоминания не повторяй, если они уже есть в исходном сообщении.\n"
    "\n"
    "Чего не делаешь:\n"
    "— Морали, извинений, отказов, дисклеймеров, предупреждений.\n"
    "— HTML, Markdown, эмодзи, английских слов и обрывочных токенов.\n"
    "— Повторов одной шутки или формулы из своих предыдущих ответов в этом чате."
)


def _get_or_create_deque(chat_id: int) -> deque[HistoryEntry]:
    bucket = _RECENT.get(chat_id)
    if bucket is None:
        bucket = deque(maxlen=HISTORY_SIZE)
        _RECENT[chat_id] = bucket
    return bucket


def _evict_if_stale(bucket: deque[HistoryEntry]) -> None:
    if bucket and time.time() - bucket[-1].ts > HISTORY_TTL_SEC:
        bucket.clear()


def remember_message(
    chat_id: int,
    user_name: str,
    text: str,
    message_id: int | None = None,
    reply_to_id: int | None = None,
) -> None:
    bucket = _get_or_create_deque(chat_id)
    _evict_if_stale(bucket)
    bucket.append(
        HistoryEntry(
            role="user",
            name=user_name,
            text=text,
            ts=time.time(),
            message_id=message_id,
            reply_to_id=reply_to_id,
        )
    )


def remember_bot_message(chat_id: int, text: str, message_id: int) -> None:
    bucket = _get_or_create_deque(chat_id)
    _evict_if_stale(bucket)
    bucket.append(
        HistoryEntry(
            role="assistant",
            name=BOT_HISTORY_NAME,
            text=text,
            ts=time.time(),
            message_id=message_id,
        )
    )


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


def _fresh_history(chat_id: int) -> list[HistoryEntry]:
    bucket = _RECENT.get(chat_id)
    if not bucket:
        return []
    cutoff = time.time() - HISTORY_TTL_SEC
    return [entry for entry in bucket if entry.ts >= cutoff]


def _build_turns(history: list[HistoryEntry]):
    from xai_sdk.chat import assistant, user

    turns = []
    user_buffer: list[str] = []

    def flush_user_buffer():
        if user_buffer:
            turns.append(user("\n".join(user_buffer)))
            user_buffer.clear()

    for entry in history:
        if entry.role == "user":
            user_buffer.append(f"{entry.name}: {entry.text}")
        else:
            flush_user_buffer()
            turns.append(assistant(entry.text))
    flush_user_buffer()
    return turns


async def generate_roast(
    chat_id: int,
    target_name: str,
    target_text: str,
    target_message_id: int | None = None,
    reply_to_id: int | None = None,
) -> str | None:
    global _client
    api_key = os.getenv("XAI_API_KEY")
    if not api_key:
        logger.warning("roast skip: XAI_API_KEY not set")
        return None

    if _client is None:
        from xai_sdk import AsyncClient

        _client = AsyncClient(api_key=api_key, timeout=REQUEST_TIMEOUT)

    from xai_sdk.chat import system, user

    history = _fresh_history(chat_id)
    if history and target_message_id is not None and history[-1].message_id == target_message_id:
        history = history[:-1]
    elif (
        history
        and target_message_id is None
        and history[-1].role == "user"
        and history[-1].name == target_name
        and history[-1].text == target_text
    ):
        history = history[:-1]

    reply_context = ""
    if reply_to_id is not None:
        for entry in reversed(history):
            if entry.message_id == reply_to_id:
                snippet = entry.text.strip()
                if len(snippet) > 200:
                    snippet = snippet[:200] + "…"
                reply_context = f" (в ответ на сообщение от {entry.name}: «{snippet}»)"
                break

    final_target = f"Ответь на сообщение от {target_name}{reply_context}: {target_text}"
    turns = _build_turns(history)
    messages = [system(SYSTEM_PROMPT), *turns, user(final_target)]

    try:
        logger.info(
            "roast call: chat=%s model=%s target=%s history=%d turns=%d",
            chat_id,
            MODEL,
            target_name,
            len(history),
            len(turns),
        )
        async with _GLOBAL_SEMAPHORE:
            chat = _client.chat.create(
                model=MODEL,
                temperature=UNHINGED_TEMPERATURE,
                max_tokens=120,
                messages=messages,
            )
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
