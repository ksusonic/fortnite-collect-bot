from __future__ import annotations

import asyncio
import html
import logging
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

from bot.db import (
    Session,
    get_chat_participants,
    get_chat_stats,
    get_feature_value,
    is_feature_enabled,
    load_session,
    mark_complete,
    mark_expired,
    save_response,
    save_session,
    sessions,
    set_feature,
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
    build_stats_text,
    generate_time_slots,
    random_style,
)
from bot.roast import (
    ROAST_PROBABILITY,
    generate_roast,
    is_roast_message,
    remember_bot_message,
    remember_message,
    remember_roast_message,
    should_roast,
)

logger = logging.getLogger(__name__)

router = Router()


def _display_name(user) -> str:
    if user.username:
        return f"@{user.username}"
    return user.first_name or str(user.id)


@router.message(Command("fort"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_fort(message: Message) -> None:
    user = message.from_user
    if user is None:
        return

    has_active = any(s for s in sessions.values() if s.chat_id == message.chat.id and not s.is_complete)
    if has_active:
        try:
            await message.react([ReactionTypeEmoji(emoji="\U0001f44e")])
        except TelegramBadRequest:
            pass
        return

    name = _display_name(user)
    slots = generate_time_slots()
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

    try:
        await message.delete()
    except TelegramBadRequest:
        pass


@router.message(Command("fort"))
async def cmd_fort_private(message: Message) -> None:
    await message.answer("Эта команда работает только в группах.")


@router.message(Command("refort"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_refort(message: Message) -> None:
    user = message.from_user
    if user is None:
        return

    # Отменяем активный сбор, если есть
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

    # Создаём новый сбор
    name = _display_name(user)
    slots = generate_time_slots()
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

    try:
        await message.delete()
    except TelegramBadRequest:
        pass


@router.message(Command("refort"))
async def cmd_refort_private(message: Message) -> None:
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
    "\U0001f504 /refort — пересоздать текущий сбор\n"
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
        sent = await message.reply(html.escape(reply))
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


async def expire_sessions(bot: Bot) -> None:
    """Background task: expire sessions older than SESSION_TIMEOUT."""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        now_msk = datetime.now(MSK)
        past_deadline = now_msk.hour >= PLAY_DEADLINE_HOUR
        expired = [
            s
            for s in sessions.values()
            if not s.is_complete and (now - s.created_at > SESSION_TIMEOUT or past_deadline)
        ]
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
