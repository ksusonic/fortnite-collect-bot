from __future__ import annotations

import asyncio
import html
import logging
import random
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from aiogram import BaseMiddleware, Bot, F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject
from aiogram.types import (
    CallbackQuery,
    Message,
    ReactionTypeCustomEmoji,
    ReactionTypeEmoji,
    TelegramObject,
)

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
    remember_message,
    remember_roast_message,
    should_roast,
)

logger = logging.getLogger(__name__)

router = Router()

REACTION_EMOJI_PACK = "myfavoritetwitchemoji"
_custom_emoji_ids: list[str] = []


class CommandReactionMiddleware(BaseMiddleware):
    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        if isinstance(event, Message) and event.text and event.text.startswith("/"):
            if not _custom_emoji_ids:
                try:
                    bot: Bot = data["bot"]
                    sticker_set = await bot.get_sticker_set(REACTION_EMOJI_PACK)
                    _custom_emoji_ids.extend(s.custom_emoji_id for s in sticker_set.stickers if s.custom_emoji_id)
                except Exception:
                    logger.debug("Failed to load emoji pack %s", REACTION_EMOJI_PACK)
            if _custom_emoji_ids:
                try:
                    emoji_id = random.choice(_custom_emoji_ids)
                    await event.react([ReactionTypeCustomEmoji(custom_emoji_id=emoji_id)])
                except TelegramBadRequest:
                    pass
        return await handler(event, data)


router.message.middleware(CommandReactionMiddleware())


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
        await message.answer("Ладно, хватит. Завязываю.")
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
        await message.answer(f"Режим отборной брани включён. Вероятность: {shown}")
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


_PIZDA_REPLIES = [
    "Болтать — не строить. Погнали лучше в Фортнайт",
    "А королевку брал хоть раз? Или только языком?",
    "Тебе бы так на поле рубиться, как тут болтаешь",
    "Каждый раз одно и то же. Иди на свадьбах пой",
    "Кто тебя в коробочку возьмёт с таким характером?",
    "Тебе бы в фортике так языком работать — все бы боялись",
    "Молчание — золото. Но ты явно не из богатых",
    "Сократ говорил: «Заговори, чтобы я тебя увидел». Лучше бы ты молчал",
]


_PIDORA_REPLIES = [
    "Зеркало забыл дома?",
    "Ответ засчитан. Интеллект — нет",
    "Это всё, на что тебя хватает?",
    "Сам придумал или подсказали?",
]


_WELCOME_TEMPLATE = (
    "\U0001f91d Вечер в хату, {mention}!\n\n"
    "Я — бот для сбора скуада в Fortnite. Мои команды:\n"
    "\U0001f3ae /fort — собрать отряд из 4 человек\n"
    "\U0001f504 /refort — пересоздать текущий сбор\n"
    "\U0001f5d1 /rm — отменить активный сбор\n"
    "\U0001f4ca /stats — статистика чата\n\n"
    "Ещё слежу за статусом серверов Epic и сообщу, когда всё упадёт \U0001f4a5"
)


@router.message(F.new_chat_members)
async def greet_new_members(message: Message) -> None:
    if not message.new_chat_members:
        return
    for member in message.new_chat_members:
        if member.is_bot and member.id != message.bot.id:
            continue
        if member.id == message.bot.id:
            mention = "ребзя"
        else:
            name = _display_name(member)
            mention = f'<a href="tg://user?id={member.id}">{html.escape(name)}</a>'
        try:
            await message.answer(_WELCOME_TEMPLATE.format(mention=mention))
        except TelegramBadRequest:
            pass


@router.message(F.text.lower().in_({"да", "нет"}))
async def reply_to_da_net(message: Message) -> None:
    await asyncio.sleep(2)
    replies = _PIZDA_REPLIES if message.text.lower() == "да" else _PIDORA_REPLIES
    await message.answer(random.choice(replies))


@router.message(F.chat.type.in_({"group", "supergroup"}) & F.text & ~F.text.startswith("/"))
async def maybe_roast(message: Message) -> None:
    if not message.from_user or message.from_user.is_bot:
        return
    chat_id = message.chat.id
    user_name = message.from_user.full_name or message.from_user.first_name or "Аноним"
    text = message.text or ""
    remember_message(chat_id, user_name, text)
    if not await is_feature_enabled(chat_id, "roast"):
        logger.debug("roast skip: feature disabled for chat %s", chat_id)
        return
    reply_to = message.reply_to_message
    forced = (
        reply_to is not None
        and reply_to.from_user is not None
        and reply_to.from_user.id == message.bot.id
        and is_roast_message(chat_id, reply_to.message_id)
    )
    custom_prob = await get_feature_value(chat_id, "roast")
    if not forced and not should_roast(chat_id, probability=custom_prob):
        return
    logger.info("roast attempt: chat=%s user=%s forced=%s", chat_id, user_name, forced)
    reply = await generate_roast(chat_id, user_name, text)
    if reply:
        sent = await message.reply(html.escape(reply))
        remember_roast_message(chat_id, sent.message_id)
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
        try:
            sticker_set = await callback.bot.get_sticker_set("FortniteStick")
            if sticker_set.stickers:
                sticker = random.choice(sticker_set.stickers)
                await callback.message.answer_sticker(sticker.file_id)
        except TelegramBadRequest:
            pass

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
