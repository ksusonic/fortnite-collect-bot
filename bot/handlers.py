from __future__ import annotations

import asyncio
import time

from aiogram import Bot, F, Router
from aiogram.enums import ChatType
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command
from aiogram.types import CallbackQuery, Message, ReactionTypeEmoji

from bot.db import (
    Session,
    load_session,
    mark_complete,
    save_response,
    save_session,
    sessions,
)
from bot.messages import (
    SQUAD_SIZE,
    SESSION_TIMEOUT,
    build_expired_text,
    build_gather_text,
    build_keyboard,
    random_style,
)

router = Router()


def _display_name(user) -> str:
    if user.first_name and user.last_name:
        return f"{user.first_name} {user.last_name}"
    return user.first_name or user.username or str(user.id)


@router.message(Command("fort"), F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))
async def cmd_fort(message: Message) -> None:
    user = message.from_user
    if user is None:
        return

    has_active = any(
        s for s in sessions.values()
        if s.chat_id == message.chat.id and not s.is_complete
    )
    if has_active:
        try:
            await message.react([ReactionTypeEmoji(emoji="\U0001f44e")])
        except TelegramBadRequest:
            pass
        return

    name = _display_name(user)
    session = Session(
        chat_id=message.chat.id,
        message_id=0,
        initiator_id=user.id,
        initiator_name=name,
        go_players={user.id: name},
        style=random_style(),
    )

    text = build_gather_text(session)
    keyboard = build_keyboard(len(session.go_players))
    sent = await message.answer(text, reply_markup=keyboard)

    session.message_id = sent.message_id
    sessions[sent.message_id] = session

    await save_session(session)
    await save_response(sent.message_id, user.id, name, "go")

    try:
        await message.delete()
    except TelegramBadRequest:
        pass


@router.message(Command("fort"))
async def cmd_fort_private(message: Message) -> None:
    await message.answer("Эта команда работает только в группах.")


@router.callback_query(F.data.in_({"go", "pass"}))
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

    if session.is_complete:
        await callback.answer("Коробочка уже собрана!")
        return

    user_id = callback.from_user.id
    name = _display_name(callback.from_user)
    action = callback.data

    if action == "go" and user_id in session.go_players:
        await callback.answer("Ты уже в деле!")
        return
    if action == "pass" and user_id in session.pass_players:
        await callback.answer("Ты уже в списке пасующих.")
        return

    # Перемещение между списками
    session.go_players.pop(user_id, None)
    session.pass_players.pop(user_id, None)

    if action == "go":
        session.go_players[user_id] = name
    else:
        session.pass_players[user_id] = name

    await save_response(message_id, user_id, name, action)

    if len(session.go_players) >= SQUAD_SIZE:
        session.is_complete = True
        await mark_complete(message_id)

    text = build_gather_text(session)
    keyboard = None if session.is_complete else build_keyboard(len(session.go_players))

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
        expired = [
            s for s in sessions.values()
            if not s.is_complete and now - s.created_at > SESSION_TIMEOUT
        ]
        for session in expired:
            session.is_complete = True
            await mark_complete(session.message_id)
            try:
                await bot.edit_message_text(
                    text=build_expired_text(session),
                    chat_id=session.chat_id,
                    message_id=session.message_id,
                )
            except TelegramBadRequest:
                pass
            sessions.pop(session.message_id, None)
