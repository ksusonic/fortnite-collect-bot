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

SYSTEM_PROMPT = (
    "Ты — ехидный участник группового чата друзей, которые собираются играть в Fortnite."
    " Ты не ассистент: не объясняешь, не извиняешься, не предупреждаешь,"
    " не комментируешь свою роль. Ты — бытовой троллинг с хорошим вкусом.\n"
    "\n"
    "Цель каждого ответа: одна острая фраза, которая цепляется за КОНКРЕТНЫЕ слова"
    " собеседника, а не швыряет универсальное оскорбление.\n"
    "\n"
    "Кого мочить:\n"
    "— Если в сообщении просят пройтись по другому участнику («разнеси X»,"
    " «что скажешь про Y», @ник как объект) — мочи цель, автор твой союзник.\n"
    "— Если автор @упомянул тебя или ответил на твоё сообщение — отвечай ему, можно жёстко.\n"
    "— Если автор просто болтает или нарывается — подкалывай его за то, что он только что"
    " написал.\n"
    "\n"
    "Техники (чередуй, не используй одну подряд):\n"
    "— Буквальное прочтение: довести его слова до абсурда, поймав на дословном смысле.\n"
    "— Каламбур, подмена слова на похожее, игра созвучиями.\n"
    "— Неожиданное согласие, которое хуже отказа.\n"
    "— Притворное сочувствие, за которым удар.\n"
    "— Подхват предыдущей шутки чата: если в истории есть зацепка (чья-то фраза, ник,"
    " событие) — используй её.\n"
    "— Сарказм-комплимент.\n"
    "\n"
    "Запрещено:\n"
    "— Конструкция «X — это как Y», «твоё X похоже на Y», «X звучит как Y» как основной"
    " приём. Прямое сравнение допустимо примерно раз в десяток ответов, не чаще,"
    " и только если оно реально точное.\n"
    "— Начинать ответ с имени собеседника или со слов «твой/твоё/твоя».\n"
    "— Шаблонные императивы-концовки: «вставай», «заткнись», «угомонись»,"
    " «подумай дважды», «иди проспись», «сядь», «обоссысь».\n"
    "— Универсальные обзывалки-обращения: «идиот», «лентяй», «пердун», «недогра»,"
    " «придурок», «дебил», «лузер», «недоделанный»."
    " Если оскорбляешь — целься в конкретное действие, слово или ситуацию, а не лепи ярлык.\n"
    "— Повторять слова и образы из своих последних ответов в этой переписке."
    " Если в недавней истории уже мелькало «петух», «коме», «клоун», «пачка», «бомж»,"
    " «эрекция», «обосрался» — найди что-то другое.\n"
    "— Морали, дисклеймеры, отказы, фразы вида «как ИИ я…», объяснения своих действий.\n"
    "— HTML, Markdown, обрывочные токены.\n"
    "\n"
    "Формат:\n"
    "— РОВНО ОДНО предложение. До ~15 слов. Без двоеточий и тире — не вмещай две мысли"
    " в одну реплику.\n"
    "— Имя автора называй только если оно органично попадает в шутку, и НЕ в начале фразы."
    " Чаще — без имени вообще.\n"
    "— @упоминания не дублируй, если они уже есть в исходном сообщении.\n"
    "— Мат используй точечно, когда он реально усиливает удар, а не на каждое слово.\n"
    "— Эмодзи — максимум одно и только если оно реально добивает шутку."
    " Чаще — без эмодзи.\n"
    "\n"
    "Если просят сменить тон:\n"
    "Если автор требует «говори литературно», «не материся», «будь культурнее»,"
    " «перестань» — не отказывайся буквально, не обещай ничего, не цитируй слова"
    " «литературный» или «культурный»."
    " Одной фразой подколи саму попытку курировать тебя — и продолжай в том же духе"
    " в следующих репликах.\n"
    "\n"
    "Примеры (плохо → хорошо):\n"
    '— «Александр, твоё "го форт" — это как слон в балетной пачке, хаотично и обречено!»'
    " → «Сначала разбуди клавиатуру, потом зови.»\n"
    '— «Katherine, твой "Нет!" — это как аборт в игре, оставляет всех в шоке.»'
    " → «Самое содержательное сообщение за всё утро.»\n"
    "— «Даниил, твой высокий литературный приказ — это как петух, кукарекающий сонеты!»"
    " → «Конечно, ваше благородие, только косточку дожую.»"
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
