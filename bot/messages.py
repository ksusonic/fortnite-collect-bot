from __future__ import annotations

import html
from typing import TYPE_CHECKING

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

if TYPE_CHECKING:
    from bot.db import Session

SQUAD_SIZE = 4


def _user_link(user_id: int, name: str) -> str:
    return f'<a href="tg://user?id={user_id}">{html.escape(name)}</a>'


def build_gather_text(session: Session) -> str:
    go_count = len(session.go_players)

    if session.is_complete:
        players = "\n".join(
            f"  {i}. {_user_link(uid, name)}"
            for i, (uid, name) in enumerate(session.go_players.items(), 1)
        )
        return (
            "\U0001f3ae\U0001f525 КОРОБОЧКА СОБРАНА! \U0001f525\U0001f3ae\n\n"
            "\U0001f3c6 Скуад готов к бою!\n\n"
            f"\U0001f44a Состав:\n{players}\n\n"
            "Всем удачи! Летим! \U0001f680"
        )

    go_list = "\n".join(
        f"  {i}. {_user_link(uid, name)}"
        for i, (uid, name) in enumerate(session.go_players.items(), 1)
    ) or "  (пока пусто)"

    pass_list = "\n".join(
        f"  {i}. {_user_link(uid, name)}"
        for i, (uid, name) in enumerate(session.pass_players.items(), 1)
    ) or "  (пока пусто)"

    initiator = _user_link(session.initiator_id, session.initiator_name)

    return (
        "\U0001f3ae СБОР КОРОБОЧКИ! \U0001f3ae\n\n"
        f"\U0001f3d7 Собираем скуад на Fortnite!\nИнициатор: {initiator}\n\n"
        f"\u2705 Го! ({go_count}/{SQUAD_SIZE}):\n{go_list}\n\n"
        f"\u274c Пас:\n{pass_list}\n\n"
        "Жмите кнопки ниже! \U0001f447"
    )


def build_keyboard(go_count: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=f"\u2705 Го! ({go_count}/{SQUAD_SIZE})",
                    callback_data="go",
                ),
                InlineKeyboardButton(
                    text="\u274c Пас",
                    callback_data="pass",
                ),
            ]
        ]
    )
