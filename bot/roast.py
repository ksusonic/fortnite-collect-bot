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
_ROAST_LOCKS: dict[int, asyncio.Lock] = {}
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
TELEGRAM_MAX_MESSAGE_LEN = 4096
ROAST_MAX_TOKENS = int(os.getenv("ROAST_MAX_TOKENS", "2000"))
ROAST_MAX_ATTEMPTS = 2
ROAST_RETRY_BASE_DELAY = float(os.getenv("ROAST_RETRY_BASE_DELAY", "1.0"))

# gRPC status codes that indicate a transient server-side failure worth retrying.
# Mirrors typical HTTP 429 / 5xx → gRPC mapping.
_RETRYABLE_GRPC_CODES = frozenset(
    {
        "RESOURCE_EXHAUSTED",  # ~ HTTP 429
        "UNAVAILABLE",  # ~ HTTP 503
        "INTERNAL",  # ~ HTTP 500
        "DEADLINE_EXCEEDED",  # ~ HTTP 504
        "ABORTED",
        "UNKNOWN",
    }
)


def _is_retryable_error(exc: BaseException) -> bool:
    code = getattr(exc, "code", None)
    if callable(code):
        try:
            value = code()
        except Exception:
            value = None
        name = getattr(value, "name", None)
        if name and name in _RETRYABLE_GRPC_CODES:
            return True
    # Some HTTP-like errors expose a numeric status_code attribute.
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if isinstance(status, int) and (status == 429 or 500 <= status < 600):
        return True
    return False


SYSTEM_PROMPT = (
    "Ты — Grok в режиме Unhinged в групповом чате друзей."
    " Дерзкий, отвязный, без морали и тормозов. Материшься."
    " Не цепляйся за Fortnite: упоминай игру, только если её обсуждают прямо сейчас."
    " Никаких отказов, дисклеймеров, морали, объяснений своей роли,"
    " фраз вида «как ИИ я…».\n"
    "\n"
    "К участникам обращайся естественно: если имя в профиле формальное"
    " (например, Alexey) — можно использовать привычное короткое (Лёша).\n"
    "\n"
    "Кого мочить:\n"
    "— Если автор просит разнести другого участника или ник («разнеси X»,"
    " «что скажешь про Y», @ник как объект, «жёстче», «ещё») — мочи цель в полную силу,"
    " автор твой союзник.\n"
    "— Если автор @упомянул тебя или ответил на твою реплику — отвечай ему, можно жёстко.\n"
    "— Иначе подкалывай автора за то, что он только что написал."
)


TEAM_STATS_SYSTEM_PROMPT = (
    "Ты — токсичный аналитик скуадной игры в Fortnite. Тебе скармливают цифры\n"
    "ТОЛЬКО по squad-режиму (отряд из 4 человек). Solo и duo не учитываются.\n"
    "Разнеси команду по фактам: кто шарит, кто соснул, у кого K/D смешной, кто карри.\n"
    "Стиль: гопник-стример, мат разрешён и приветствуется, чёрный юмор тоже.\n"
    "Анализируй конкретные цифры и сравнивай игроков между собой. Никаких пустых\n"
    "«молодцы, играете хорошо» — без воды. До 5-6 предложений, плотно.\n"
    "Не упоминай solo и duo. Не используй markdown, HTML и эмодзи — только текст."
)


def get_roast_lock(chat_id: int) -> asyncio.Lock:
    return _ROAST_LOCKS.setdefault(chat_id, asyncio.Lock())


def _get_or_create_deque(chat_id: int) -> deque[HistoryEntry]:
    bucket = _RECENT.get(chat_id)
    if bucket is None:
        bucket = deque(maxlen=HISTORY_SIZE)
        _RECENT[chat_id] = bucket
    return bucket


def _evict_if_stale(bucket: deque[HistoryEntry]) -> None:
    if bucket and time.time() - bucket[-1].ts > HISTORY_TTL_SEC:
        bucket.clear()


def _schedule_persist(chat_id: int) -> None:
    """Fire-and-forget DB write of current in-memory roast state for chat_id."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop (e.g. unit tests calling remember_* synchronously) — skip persistence
    history = list(_RECENT.get(chat_id, ()))
    msgs = list(_ROAST_MESSAGE_IDS.get(chat_id, ()))
    last = _LAST_ROAST.get(chat_id)
    payload = [
        {
            "role": e.role,
            "name": e.name,
            "text": e.text,
            "ts": e.ts,
            "message_id": e.message_id,
            "reply_to_id": e.reply_to_id,
        }
        for e in history
    ]
    from bot.db import save_roast_state

    task = loop.create_task(save_roast_state(chat_id, payload, msgs, last))
    task.add_done_callback(_log_persist_errors)


def _log_persist_errors(task: asyncio.Task) -> None:
    exc = task.exception()
    if exc is not None:
        logger.warning("roast state persist failed", exc_info=exc)


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
    _schedule_persist(chat_id)


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
    _schedule_persist(chat_id)


def remember_roast_message(chat_id: int, message_id: int) -> None:
    if chat_id not in _ROAST_MESSAGE_IDS:
        _ROAST_MESSAGE_IDS[chat_id] = deque(maxlen=ROAST_TRACK_SIZE)
    _ROAST_MESSAGE_IDS[chat_id].append(message_id)
    _schedule_persist(chat_id)


def is_roast_message(chat_id: int, message_id: int) -> bool:
    return message_id in _ROAST_MESSAGE_IDS.get(chat_id, ())


def restore_roast_state(
    chat_id: int,
    history_payload: list[dict],
    roast_msg_ids: list[int],
    last_roast: float | None,
) -> None:
    bucket = deque(maxlen=HISTORY_SIZE)
    for raw in history_payload:
        try:
            bucket.append(
                HistoryEntry(
                    role=raw["role"],
                    name=raw["name"],
                    text=raw["text"],
                    ts=float(raw["ts"]),
                    message_id=raw.get("message_id"),
                    reply_to_id=raw.get("reply_to_id"),
                )
            )
        except KeyError, TypeError, ValueError:
            continue
    if bucket:
        _RECENT[chat_id] = bucket
    if roast_msg_ids:
        msgs = deque(maxlen=ROAST_TRACK_SIZE)
        for mid in roast_msg_ids:
            if isinstance(mid, int):
                msgs.append(mid)
        _ROAST_MESSAGE_IDS[chat_id] = msgs
    if last_roast is not None:
        _LAST_ROAST[chat_id] = last_roast


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

    logger.info(
        "roast call: chat=%s model=%s target=%s history=%d turns=%d",
        chat_id,
        MODEL,
        target_name,
        len(history),
        len(turns),
    )

    for attempt in range(1, ROAST_MAX_ATTEMPTS + 1):
        try:
            async with _GLOBAL_SEMAPHORE:
                chat = _client.chat.create(
                    model=MODEL,
                    temperature=UNHINGED_TEMPERATURE,
                    max_tokens=ROAST_MAX_TOKENS,
                    messages=messages,
                )
                response = await chat.sample()
            reply = response.content
            if reply:
                _LAST_ROAST[chat_id] = time.time()
                _schedule_persist(chat_id)
                logger.info("roast ok: chat=%s len=%d attempt=%d", chat_id, len(reply), attempt)
                return reply.strip()
            logger.warning("roast empty response: chat=%s attempt=%d", chat_id, attempt)
            return None
        except Exception as exc:
            retryable = _is_retryable_error(exc)
            logger.warning(
                "roast request failed: chat=%s attempt=%d retryable=%s",
                chat_id,
                attempt,
                retryable,
                exc_info=True,
            )
            if not retryable or attempt >= ROAST_MAX_ATTEMPTS:
                return None
            # Exponential backoff with jitter: base * 2^(attempt-1) * [0.5, 1.5)
            delay = ROAST_RETRY_BASE_DELAY * (2 ** (attempt - 1)) * (0.5 + random.random())
            await asyncio.sleep(delay)
    return None


async def generate_team_stats_roast(facts: str) -> str | None:
    """Stateless toxic analysis of /teamstats facts.

    Uses its own system prompt (no chat history, no per-chat dialog memory),
    bypasses the per-chat roast feature toggle, and is gated solely by the
    XAI_API_KEY env var. Returns None on any failure (network, timeout, empty
    response, missing API key) so the caller can degrade gracefully.
    """
    global _client
    api_key = os.getenv("XAI_API_KEY")
    if not api_key:
        return None
    if not facts.strip():
        return None

    if _client is None:
        from xai_sdk import AsyncClient

        _client = AsyncClient(api_key=api_key, timeout=REQUEST_TIMEOUT)

    from xai_sdk.chat import system, user

    messages = [system(TEAM_STATS_SYSTEM_PROMPT), user(facts)]
    logger.info("team-stats roast call: model=%s facts_len=%d", MODEL, len(facts))
    try:
        async with _GLOBAL_SEMAPHORE:
            chat = _client.chat.create(
                model=MODEL,
                temperature=UNHINGED_TEMPERATURE,
                max_tokens=ROAST_MAX_TOKENS,
                messages=messages,
            )
            response = await chat.sample()
        reply = response.content
        if not reply:
            logger.warning("team-stats roast empty response")
            return None
        return reply.strip()
    except Exception:
        logger.warning("team-stats roast request failed", exc_info=True)
        return None
