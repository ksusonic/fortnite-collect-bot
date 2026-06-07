from __future__ import annotations

import asyncio
import html
import logging
import os
import time
from datetime import datetime

from aiogram import Bot, F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject
from aiogram.types import (
    CallbackQuery,
    Message,
    ReactionTypeEmoji,
)
from aiogram.utils.chat_action import ChatActionSender

from bot import fortnite
from bot.db import (
    Session,
    get_chat_epic_links,
    get_chat_participants,
    get_chat_stats,
    get_chats_with_epic_links,
    get_epic_link,
    get_feature_value,
    get_last_weekly_drop,
    get_snapshot_before,
    is_feature_enabled,
    load_session,
    mark_complete,
    mark_expired,
    resolve_user_by_username,
    save_epic_link,
    save_response,
    save_session,
    sessions,
    set_feature,
    set_last_weekly_drop,
)
from bot.fortnite import (
    EpicNameNotFound,
    FortniteError,
    FortniteUnavailable,
    StatsEmpty,
    StatsPrivate,
)
from bot.messages import (
    MSK,
    PLAY_DEADLINE_HOUR,
    SESSION_TIMEOUT,
    SQUAD_SIZE,
    build_cancelled_text,
    build_expired_text,
    build_gather_text,
    build_keyboard,
    build_my_fn_stats_text,
    build_stats_text,
    build_team_fn_stats_text,
    generate_time_slots,
    my_fn_caption,
    random_style,
)
from bot.roast import (
    ROAST_PROBABILITY,
    TELEGRAM_MAX_MESSAGE_LEN,
    generate_fort_header,
    generate_roast,
    generate_team_stats_roast,
    get_roast_lock,
    is_roast_message,
    remember_bot_message,
    remember_message,
    remember_roast_message,
    should_roast,
)

logger = logging.getLogger(__name__)

FORT_REPLACE_COOLDOWN = 30  # per-user-per-chat cooldown between successful /fort attempts

# Strong refs to fire-and-forget background tasks so they aren't garbage-collected mid-flight.
_bg_tasks: set[asyncio.Task] = set()

ADMIN_USER_ID = int(os.getenv("ADMIN_USER_ID", "0")) or None

TEAMSTATS_CONCURRENCY = 5

_TEAM_ANALYSIS_HEADER = "\n────────────────────\n\U0001f916 <b>Анализ Grok</b>\n"
_TEAM_ANALYSIS_OPEN = "<i>"
_TEAM_ANALYSIS_CLOSE = "</i>"


def _append_team_analysis(html_text: str, roast: str) -> str:
    """Append the LLM analysis block to /teamstats output, truncating to fit
    Telegram's 4096-char message limit."""
    wrapper_len = len(_TEAM_ANALYSIS_HEADER) + len(_TEAM_ANALYSIS_OPEN) + len(_TEAM_ANALYSIS_CLOSE)
    budget = TELEGRAM_MAX_MESSAGE_LEN - len(html_text) - wrapper_len
    if budget <= 1:
        # Not enough room even for a minimal analysis block — skip.
        return html_text
    escaped = html.escape(roast)
    if len(escaped) > budget:
        # Trim the *original* roast text and re-escape so we never cut mid-entity.
        # Reserve 1 char for the ellipsis we add.
        cut = max(0, len(roast) - (len(escaped) - budget + 1))
        roast_trimmed = roast[:cut].rstrip() + "…"
        escaped = html.escape(roast_trimmed)
        if len(escaped) > budget:
            # Pathological case (many '<'/'&' in the trimmed text) — bail out.
            return html_text
    return f"{html_text}{_TEAM_ANALYSIS_HEADER}{_TEAM_ANALYSIS_OPEN}{escaped}{_TEAM_ANALYSIS_CLOSE}"


def _is_bot_admin(user_id: int) -> bool:
    return ADMIN_USER_ID is not None and user_id == ADMIN_USER_ID


def _epic_error_text(exc: FortniteError) -> str:
    if isinstance(exc, EpicNameNotFound):
        return "Не нашёл такой Epic-аккаунт. Проверь ник."
    if isinstance(exc, StatsPrivate):
        return "Статистика этого аккаунта закрыта. Включи Public Game Stats в настройках Fortnite."
    if isinstance(exc, StatsEmpty):
        return "У тебя 0 матчей. Сыграй пару каток и приходи."
    if isinstance(exc, FortniteUnavailable):
        return "Fortnite API сейчас недоступен. Попробуй позже."
    return "Не получилось получить статистику Fortnite."


# Last successful /fort timestamp per (chat_id, user_id). In-memory only —
# a bot restart resets the cooldown, which is acceptable for spam protection.
_fort_attempt_times: dict[tuple[int, int], float] = {}


def _prune_fort_attempts(now: float) -> None:
    """Drop entries older than the cooldown window to keep the dict bounded."""
    stale = [key for key, ts in _fort_attempt_times.items() if now - ts >= FORT_REPLACE_COOLDOWN]
    for key in stale:
        _fort_attempt_times.pop(key, None)


def _parse_target_hour(raw: str) -> int | None:
    """Parse a `/fort` time argument (e.g. "18", "18:00", "18ч") into an hour 0..PLAY_DEADLINE_HOUR.

    Returns None if the argument is malformed or out of the playable range.
    """
    token = raw.strip().split()[0] if raw.strip() else ""
    hour_part = token.split(":")[0]
    digits = "".join(c for c in hour_part if c.isdigit())
    if not digits:
        return None
    hour = int(digits)
    if hour < 0 or hour > PLAY_DEADLINE_HOUR:
        return None
    return hour


router = Router()


def _display_name(user) -> str:
    if user.username:
        return f"@{user.username}"
    return user.first_name or str(user.id)


async def _apply_fort_llm_header(bot: Bot, session: Session) -> None:
    """Generate a Grok gather header (≤10s) and edit the /fort message in place.

    Fire-and-forget from cmd_fort: the message is already shown with a hardcoded
    style, so any failure here is a silent no-op (graceful degradation). The
    session is the live in-memory object, so build_gather_text reflects any
    button presses that landed while we waited.
    """
    header = await generate_fort_header(session.chat_id)
    if not header:
        return
    if session.is_complete or session.is_expired:
        # Squad filled or session was replaced/cancelled while we waited — don't
        # overwrite the closed screen with a gather header.
        return
    session.llm_header = header
    await save_session(session)
    try:
        await bot.edit_message_text(
            text=build_gather_text(session),
            chat_id=session.chat_id,
            message_id=session.message_id,
            reply_markup=build_keyboard(len(session.go_players), time_slots=session.time_slots or None),
        )
    except TelegramBadRequest:
        pass


@router.message(Command("fort"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_fort(message: Message, command: CommandObject) -> None:
    user = message.from_user
    if user is None:
        return

    target_hour: int | None = None
    if command.args:
        target_hour = _parse_target_hour(command.args)
        if target_hour is None:
            await message.reply(
                "Не понял время. Укажи час сбора числом: <code>/fort 18</code> "
                f"(допустимо до {PLAY_DEADLINE_HOUR}:00 МСК)."
            )
            return
        if target_hour <= datetime.now(MSK).hour:
            await message.reply("Это время уже прошло. Для сбора прямо сейчас напиши <code>/fort</code> без числа.")
            return

    now = time.time()
    _prune_fort_attempts(now)
    cooldown_key = (message.chat.id, user.id)
    last_attempt = _fort_attempt_times.get(cooldown_key)
    if last_attempt is not None and now - last_attempt < FORT_REPLACE_COOLDOWN:
        try:
            await message.react([ReactionTypeEmoji(emoji="\U0001f44e")])
        except TelegramBadRequest:
            pass
        try:
            await message.delete()
        except TelegramBadRequest:
            pass
        return
    _fort_attempt_times[cooldown_key] = now

    active_session = next(
        (s for s in sessions.values() if s.chat_id == message.chat.id and not s.is_complete),
        None,
    )
    if active_session is not None:
        active_session.is_complete = True
        active_session.is_expired = True
        await mark_expired(active_session.message_id)
        try:
            await message.bot.edit_message_text(
                text=build_cancelled_text(active_session),
                chat_id=active_session.chat_id,
                message_id=active_session.message_id,
            )
        except TelegramBadRequest:
            pass
        sessions.pop(active_session.message_id, None)

    name = _display_name(user)
    slots = generate_time_slots(start_hour=target_hour)
    participants = await get_chat_participants(message.chat.id)
    # Exclude the initiator from the tag list
    tagged_users = {uid: n for uid, n in participants if uid != user.id}
    session = Session(
        chat_id=message.chat.id,
        message_id=0,
        initiator_id=user.id,
        initiator_name=name,
        style=random_style(),
        time_slots=slots,
        tagged_users=tagged_users,
    )

    text = build_gather_text(session)
    keyboard = build_keyboard(len(session.go_players), time_slots=slots)
    sent = await message.answer(text, reply_markup=keyboard)

    session.message_id = sent.message_id
    sessions[sent.message_id] = session

    await save_session(session)

    task = asyncio.create_task(_apply_fort_llm_header(message.bot, session))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)

    try:
        await message.delete()
    except TelegramBadRequest:
        pass


@router.message(Command("fort"))
async def cmd_fort_private(message: Message) -> None:
    await message.answer("Эта команда работает только в группах.")


@router.message(Command("stats"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_stats(message: Message) -> None:
    stats = await get_chat_stats(message.chat.id)
    await message.answer(build_stats_text(stats))


@router.message(Command("stats"))
async def cmd_stats_private(message: Message) -> None:
    await message.answer("Эта команда работает только в группах.")


@router.message(Command("roast"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_roast(message: Message, command: CommandObject) -> None:
    parts = (command.args or "").strip().lower().split()
    action = parts[0] if parts else ""
    if action == "off":
        await set_feature(message.chat.id, "roast", False)
        await message.answer("Режим язвительных ответов выключен.")
        return
    if action == "on":
        prob: float | None = None
        if len(parts) >= 2:
            try:
                prob = float(parts[1])
            except ValueError:
                await message.answer("Вероятность должна быть числом от 0 до 1, например: /roast on 0.15")
                return
            if not 0.0 < prob <= 1.0:
                await message.answer("Вероятность должна быть в диапазоне (0, 1], например: /roast on 0.15")
                return
        await set_feature(message.chat.id, "roast", True, value=prob)
        shown = f"{prob:.2f}" if prob is not None else f"{ROAST_PROBABILITY:.2f} (по умолчанию)"
        await message.answer(f"Режим язвительных ответов включён. Вероятность: {shown}")
        return
    await message.answer("Использование: /roast on [вероятность 0-1] или /roast off")


@router.message(Command("linkepicfor"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_linkepicfor(message: Message, command: CommandObject) -> None:
    user = message.from_user
    if user is None:
        return
    if ADMIN_USER_ID is None:
        await message.answer("Админ-линковка не настроена.")
        return
    if not _is_bot_admin(user.id):
        await message.answer("Команда только для админа бота.")
        return
    if not fortnite.is_configured():
        await message.answer("Fortnite-статистика не настроена.")
        return
    parts = (command.args or "").split(maxsplit=1)
    if len(parts) < 2:
        await message.answer("Формат: /linkepicfor @username EpicName")
        return
    handle, epic_name = parts[0], parts[1].strip()
    if not handle.startswith("@") or len(handle) < 2 or not epic_name or len(epic_name) > 32:
        await message.answer("Формат: /linkepicfor @username EpicName")
        return
    resolved = await resolve_user_by_username(message.chat.id, handle)
    if resolved is None:
        await message.answer(
            f"Не нашёл {html.escape(handle)} среди тех, кто отвечал на /fort в этом чате. "
            "Попроси его сначала ткнуть кнопку в /fort."
        )
        return
    target_user_id, target_user_name = resolved
    try:
        async with ChatActionSender.typing(bot=message.bot, chat_id=message.chat.id):
            stats = await fortnite.fetch_stats(name=epic_name)
    except StatsEmpty as exc:
        await save_epic_link(
            message.chat.id,
            target_user_id,
            target_user_name,
            exc.epic_name,
            exc.epic_account_id,
        )
        target_link = f'<a href="tg://user?id={target_user_id}">{html.escape(target_user_name)}</a>'
        await message.answer(
            f"✅ {target_link} → Epic <b>{html.escape(exc.epic_name)}</b> (залинковал админ, у игрока ещё 0 матчей)"
        )
        return
    except FortniteError as exc:
        await message.answer(_epic_error_text(exc))
        return
    await save_epic_link(
        message.chat.id,
        target_user_id,
        target_user_name,
        stats.epic_name,
        stats.epic_account_id,
    )
    target_link = f'<a href="tg://user?id={target_user_id}">{html.escape(target_user_name)}</a>'
    await message.answer(f"✅ {target_link} → Epic <b>{html.escape(stats.epic_name)}</b> (залинковал админ)")


@router.message(Command("linkepicfor"))
async def cmd_linkepicfor_private(message: Message) -> None:
    await message.answer("Эта команда работает только в группах.")


@router.message(Command("myfnstats"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_myfnstats(message: Message) -> None:
    user = message.from_user
    if user is None:
        return
    if not fortnite.is_configured():
        await message.answer("Fortnite-статистика не настроена.")
        return
    link = await get_epic_link(message.chat.id, user.id)
    if link is None:
        await message.answer("Тебя ещё не залинковали. Попроси админа: /linkepicfor @твой_ник EpicName")
        return
    try:
        async with ChatActionSender.typing(bot=message.bot, chat_id=message.chat.id):
            stats = await fortnite.fetch_stats(account_id=link.epic_account_id, with_image=True)
    except FortniteError as exc:
        await message.answer(_epic_error_text(exc))
        return
    if stats.image_url:
        try:
            await message.answer_photo(photo=stats.image_url, caption=my_fn_caption(link, stats))
            return
        except TelegramBadRequest:
            logger.warning(
                "myfnstats: answer_photo failed for url=%s, falling back to text",
                stats.image_url,
                exc_info=True,
            )
    await message.answer(build_my_fn_stats_text(link, stats))


@router.message(Command("myfnstats"))
async def cmd_myfnstats_private(message: Message) -> None:
    await message.answer("Эта команда работает только в группах.")


async def _compute_team_deltas(
    successes: list[tuple],
) -> tuple[dict[str, tuple[int, int, int, float]], dict[str, tuple[int, int, int, float]]]:
    """For each player with squad stats, look up the closest snapshot older
    than 24h / 7d and compute (d_matches, d_wins, d_kills, period_kd).

    Players whose current matches < snapshot matches are dropped (season
    reset). 2 SQLite reads per player; with N≤team-size and PK lookups it's
    cheap — kept sequential intentionally."""
    now = time.time()
    cutoff_24h = now - 24 * 3600
    cutoff_7d = now - 7 * 24 * 3600
    deltas_24h: dict[str, tuple[int, int, int, float]] = {}
    deltas_7d: dict[str, tuple[int, int, int, float]] = {}
    for _, s in successes:
        if s.squad is None or s.squad.matches == 0:
            continue
        aid = s.epic_account_id
        curr_kd = s.squad.kd
        curr_deaths = int(round(s.squad.kills / curr_kd)) if curr_kd > 0 else 0
        for cutoff, target in ((cutoff_24h, deltas_24h), (cutoff_7d, deltas_7d)):
            prev = await get_snapshot_before(aid, cutoff)
            if prev is None:
                continue
            dm = s.squad.matches - prev.matches
            dw = s.squad.wins - prev.wins
            dk = s.squad.kills - prev.kills
            if dm < 0:  # season reset — stats counter rolled back
                continue
            d_deaths = curr_deaths - prev.deaths_est
            period_kd = dk / d_deaths if d_deaths > 0 else 0.0
            target[aid] = (dm, dw, dk, period_kd)
    return deltas_24h, deltas_7d


async def _run_teamstats(bot: Bot, chat_id: int, *, silent_on_empty: bool = False) -> None:
    """Core /teamstats logic, shared by the slash command and the weekly drop.

    With silent_on_empty=True, returns without sending when there's nothing
    interesting to say (no config, no links, or every player failed). The
    weekly auto-drop uses this so Friday 21:00 doesn't spam a chat where
    /teamstats can't produce real data."""
    if not fortnite.is_configured():
        if silent_on_empty:
            return
        await bot.send_message(chat_id, "Fortnite-статистика не настроена.")
        return
    links = await get_chat_epic_links(chat_id)
    if not links:
        if silent_on_empty:
            return
        await bot.send_message(chat_id, "Никто не залинкован. Админ может это сделать через /linkepicfor.")
        return

    sem = asyncio.Semaphore(TEAMSTATS_CONCURRENCY)

    async def one(link):
        async with sem:
            try:
                return link, await fortnite.fetch_stats(account_id=link.epic_account_id, with_image=False)
            except FortniteError as exc:
                return link, exc

    async with ChatActionSender.typing(bot=bot, chat_id=chat_id):
        results = await asyncio.gather(*(one(link) for link in links))

        successes = [(link, r) for link, r in results if not isinstance(r, FortniteError)]
        failures = [(link, r) for link, r in results if isinstance(r, FortniteError)]

        if silent_on_empty and not successes:
            return

        deltas_24h, deltas_7d = await _compute_team_deltas(successes)
        html_text, facts = build_team_fn_stats_text(
            successes,
            failures,
            deltas_24h=deltas_24h,
            deltas_7d=deltas_7d,
        )

        if successes and facts and os.getenv("XAI_API_KEY"):
            roast = await generate_team_stats_roast(facts)
            if roast:
                html_text = _append_team_analysis(html_text, roast)

    await bot.send_message(chat_id, html_text)


@router.message(Command("teamstats"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_teamstats(message: Message) -> None:
    await _run_teamstats(message.bot, message.chat.id)


@router.message(Command("teamstats"))
async def cmd_teamstats_private(message: Message) -> None:
    await message.answer("Эта команда работает только в группах.")


@router.message(Command("rm"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_rm(message: Message) -> None:
    active_session = next(
        (s for s in sessions.values() if s.chat_id == message.chat.id and not s.is_complete),
        None,
    )
    if active_session is not None:
        active_session.is_complete = True
        active_session.is_expired = True
        await mark_expired(active_session.message_id)
        try:
            await message.bot.delete_message(
                chat_id=active_session.chat_id,
                message_id=active_session.message_id,
            )
        except TelegramBadRequest:
            pass
        sessions.pop(active_session.message_id, None)

    try:
        await message.delete()
    except TelegramBadRequest:
        pass


_WELCOME_TEMPLATE = (
    "\U0001f44b Привет, {mention}.\n\n"
    "Я бот для сбора скуада в Fortnite. Команды:\n"
    "\U0001f3ae /fort — собрать отряд из 4 человек\n"
    "\U0001f5d1 /rm — отменить активный сбор\n"
    "\U0001f4ca /stats — статистика чата\n\n"
    "Также слежу за статусом серверов Epic и предупрежу, если они недоступны."
)


@router.message(F.new_chat_members)
async def greet_new_members(message: Message) -> None:
    if not message.new_chat_members:
        return
    for member in message.new_chat_members:
        if member.is_bot and member.id != message.bot.id:
            continue
        if member.id == message.bot.id:
            mention = "всем"
        else:
            name = _display_name(member)
            mention = f'<a href="tg://user?id={member.id}">{html.escape(name)}</a>'
        try:
            await message.answer(_WELCOME_TEMPLATE.format(mention=mention))
        except TelegramBadRequest:
            pass


async def _is_bot_mentioned(message: Message) -> bool:
    if not message.entities:
        return False
    me = await message.bot.get_me()
    text = message.text or ""
    needle = f"@{me.username.lower()}" if me.username else None
    for entity in message.entities:
        if entity.type == "mention" and needle:
            fragment = text[entity.offset : entity.offset + entity.length].lower()
            if fragment == needle:
                return True
        elif entity.type == "text_mention" and entity.user and entity.user.id == me.id:
            return True
    return False


@router.message(F.chat.type.in_({"group", "supergroup"}) & F.text & ~F.text.startswith("/"))
async def maybe_roast(message: Message) -> None:
    if not message.from_user or message.from_user.is_bot:
        return
    chat_id = message.chat.id
    user_name = message.from_user.full_name or message.from_user.first_name or "Аноним"
    text = message.text or ""
    reply_to = message.reply_to_message
    reply_to_id = reply_to.message_id if reply_to is not None else None
    remember_message(chat_id, user_name, text, message_id=message.message_id, reply_to_id=reply_to_id)
    if not await is_feature_enabled(chat_id, "roast"):
        logger.debug("roast skip: feature disabled for chat %s", chat_id)
        return
    forced_by_reply = (
        reply_to is not None
        and reply_to.from_user is not None
        and reply_to.from_user.id == message.bot.id
        and is_roast_message(chat_id, reply_to.message_id)
    )
    forced_by_mention = await _is_bot_mentioned(message)
    forced = forced_by_reply or forced_by_mention
    async with get_roast_lock(chat_id):
        custom_prob = await get_feature_value(chat_id, "roast")
        if not forced and not should_roast(chat_id, probability=custom_prob):
            return
        logger.info("roast attempt: chat=%s user=%s forced=%s", chat_id, user_name, forced)
        async with ChatActionSender.typing(bot=message.bot, chat_id=chat_id):
            reply = await generate_roast(
                chat_id,
                user_name,
                text,
                target_message_id=message.message_id,
                reply_to_id=reply_to_id,
            )
        if reply:
            payload = html.escape(reply)
            if len(payload) > TELEGRAM_MAX_MESSAGE_LEN:
                payload = payload[: TELEGRAM_MAX_MESSAGE_LEN - 1] + "…"
            sent = await message.reply(payload)
            remember_roast_message(chat_id, sent.message_id)
            remember_bot_message(chat_id, reply, sent.message_id)
            logger.info("roast sent: chat=%s forced=%s", chat_id, forced)


@router.callback_query(F.data.in_({"go", "pass"}) | F.data.startswith("slot:"))
async def on_callback(callback: CallbackQuery) -> None:
    if callback.message is None or callback.from_user is None:
        await callback.answer()
        return

    message_id = callback.message.message_id

    session = sessions.get(message_id)
    if session is None:
        session = await load_session(message_id)
        if session is not None:
            sessions[message_id] = session

    if session is None:
        await callback.answer("Сбор устарел")
        return

    if session.is_expired:
        await callback.answer("Сбор завершён.")
        return

    user_id = callback.from_user.id
    name = _display_name(callback.from_user)
    raw = callback.data
    time_slot: str | None = None

    if raw.startswith("slot:"):
        action = "go"
        time_slot = raw[5:]  # "slot:18:00" -> "18:00"
        if time_slot not in session.time_slots:
            await callback.answer("Слот недоступен.")
            return
        current_slot = session.player_slots.get(user_id)
        if current_slot == time_slot:
            await callback.answer("Ты уже записан на это время!")
            return
    else:
        action = raw

    if action == "go" and not time_slot and user_id in session.go_players:
        await callback.answer("Ты уже в деле!")
        return
    if action == "pass" and user_id in session.pass_players:
        await callback.answer("Ты уже в списке пасующих.")
        return

    # Перемещение между списками
    session.go_players.pop(user_id, None)
    session.pass_players.pop(user_id, None)
    session.player_slots.pop(user_id, None)

    if action == "go":
        session.go_players[user_id] = name
        if time_slot:
            session.player_slots[user_id] = time_slot
    else:
        session.pass_players[user_id] = name

    await save_response(
        message_id,
        user_id,
        name,
        action,
        time_slot=time_slot,
        is_bot=callback.from_user.is_bot,
    )

    if not session.is_complete and len(session.go_players) >= SQUAD_SIZE:
        session.is_complete = True
        await mark_complete(message_id)

    text = build_gather_text(session)
    keyboard = build_keyboard(len(session.go_players), time_slots=session.time_slots or None)

    try:
        await callback.message.edit_text(text, reply_markup=keyboard)
    except TelegramBadRequest:
        pass

    await callback.answer()


async def sweep_expired_sessions(bot: Bot, now: float | None = None, past_deadline: bool | None = None) -> list[int]:
    """Single sweep: expire stale sessions. Returns the message_ids that were expired."""
    if now is None:
        now = time.time()
    if past_deadline is None:
        past_deadline = datetime.now(MSK).hour >= PLAY_DEADLINE_HOUR
    expired = [
        s for s in sessions.values() if not s.is_complete and (now - s.created_at > SESSION_TIMEOUT or past_deadline)
    ]
    expired_ids: list[int] = []
    for session in expired:
        session.is_complete = True
        session.is_expired = True
        await mark_expired(session.message_id)
        try:
            await bot.edit_message_text(
                text=build_expired_text(session),
                chat_id=session.chat_id,
                message_id=session.message_id,
            )
        except TelegramBadRequest:
            pass
        sessions.pop(session.message_id, None)
        expired_ids.append(session.message_id)
    return expired_ids


async def expire_sessions(bot: Bot) -> None:
    """Background task: expire sessions older than SESSION_TIMEOUT."""
    while True:
        await asyncio.sleep(60)
        await sweep_expired_sessions(bot)


# Weekly /teamstats auto-drop: Friday 21:00 MSK in every chat that has at least
# one linked Epic account. Dedup via chat_features (feature='weekly_drop',
# value=unix ts of last drop). 6-day cutoff guarantees one drop per Friday.
WEEKLY_DROP_INTERVAL_SEC = 300  # 5 min — the 21:00–21:59 MSK window catches ≥11 ticks
WEEKLY_DROP_DEDUP_WINDOW_SEC = 6 * 24 * 3600


async def _maybe_drop_weekly_stats(bot: Bot) -> None:
    now = datetime.now(MSK)
    if now.weekday() != 4 or now.hour != 21:  # Friday=4
        return
    chat_ids = await get_chats_with_epic_links()
    cutoff_ts = time.time() - WEEKLY_DROP_DEDUP_WINDOW_SEC
    for chat_id in chat_ids:
        last = await get_last_weekly_drop(chat_id)
        if last is not None and last > cutoff_ts:
            continue
        try:
            await _run_teamstats(bot, chat_id, silent_on_empty=True)
            await set_last_weekly_drop(chat_id, time.time())
        except Exception:
            logger.warning("weekly drop to chat %s failed", chat_id, exc_info=True)


async def weekly_stats_drop_loop(bot: Bot) -> None:
    while True:
        try:
            await _maybe_drop_weekly_stats(bot)
        except Exception:
            logger.warning("weekly stats drop failed", exc_info=True)
        await asyncio.sleep(WEEKLY_DROP_INTERVAL_SEC)
