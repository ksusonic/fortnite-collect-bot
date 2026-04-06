from __future__ import annotations

import html
import random
from dataclasses import dataclass
from typing import TYPE_CHECKING

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

if TYPE_CHECKING:
    from bot.db import Session

SQUAD_SIZE = 4


@dataclass(frozen=True)
class Style:
    header: str  # {name} — ссылка на инициатора
    cta: str  # призыв к действию
    done_header: str
    done_footer: str


_STYLES: list[Style] = [
    Style(
        "\U0001f3ae СБОР КОРОБОЧКИ! \U0001f3ae\n\n\U0001f3d7 {name} собирает скуад на Fortnite!",
        "Жмите кнопки ниже! \U0001f447",
        "\U0001f3ae\U0001f525 КОРОБОЧКА СОБРАНА! \U0001f525\U0001f3ae",
        "Всем удачи! Летим! \U0001f680",
    ),
    Style(
        "\U0001f6e9 АВТОБУС ОТПРАВЛЯЕТСЯ! \U0001f6e9\n\n{name} за рулём — запрыгивайте!",
        "Осталось пару мест, пока не улетел! \u2708\ufe0f",
        "\U0001f6e9\U0001f4a8 ВСЕ НА БОРТУ! \U0001f4a8\U0001f6e9",
        "Автобус взлетает! Всем хорошего лута! \U0001f4b0",
    ),
    Style(
        "\u2694\ufe0f ТРЕВОГА! СБОР ОТРЯДА! \u2694\ufe0f\n\nКомандир {name} объявляет построение!",
        "Кто с нами? Записывайтесь! \U0001f4dd",
        "\u2694\ufe0f\U0001f6e1 ОТРЯД СФОРМИРОВАН! \U0001f6e1\u2694\ufe0f",
        "В бой! Победа будет за нами! \U0001f451",
    ),
    Style(
        "\U0001f525 КТО ГОТОВ НАГИБАТЬ? \U0001f525\n\n{name} бросает вызов — нужна банда!",
        "Налетайте, места ограничены! \U0001f3af",
        "\U0001f525\U0001f4aa БАНДА В СБОРЕ! \U0001f4aa\U0001f525",
        "Сейчас будет жарко! Го нагибать! \U0001f4a5",
    ),
    Style(
        "\U0001f30a ШТОРМ ПРИБЛИЖАЕТСЯ! \U0001f30a\n\n{name} ищет бойцов, чтобы пережить зону!",
        "Нужны бойцы! Кто идёт? \u26a1",
        "\U0001f30a\u26a1 СКУАД ГОТОВ К ШТОРМУ! \u26a1\U0001f30a",
        "Шторм нам не страшен! Вперёд! \U0001f3c3\u200d\u2642\ufe0f",
    ),
    Style(
        "\U0001f3d7 СТРОИМ КОРОБОЧКУ! \U0001f3d7\n\n{name} уже поставил первую стену — нужны строители!",
        "Подключайтесь! \U0001f9f1",
        "\U0001f3d7\U0001f3c6 КОРОБОЧКА ПОСТРОЕНА! \U0001f3c6\U0001f3d7",
        "Стены стоят, скуад готов! Погнали! \U0001f680",
    ),
    Style(
        "\U0001f4e2 ВНИМАНИЕ! НАБОР В СКУАД! \U0001f4e2\n\n{name} открывает набор — не проспите!",
        "Свободных мест всё меньше! \U0001f631",
        "\U0001f4e2\U0001f389 СКУАД УКОМПЛЕКТОВАН! \U0001f389\U0001f4e2",
        "Полный состав! Летим на вику! \U0001f60e",
    ),
    Style(
        "\U0001f3ae ФОРТНАЙТ ЗОВЁТ! \U0001f3ae\n\n{name} трубит в рог — пора в бой!",
        "Откликнитесь, воины! \U0001f93a",
        "\U0001f3ae\U0001f525 ВОИНЫ СОБРАЛИСЬ! \U0001f525\U0001f3ae",
        "Четвёрка смерти готова! Удачи! \U0001f340",
    ),
    Style(
        "\U0001f3b0 {name} КРУТИТ РУЛЕТКУ СКУАДА! \U0001f3b0\n\nКому сегодня повезёт попасть в команду?",
        "Испытай удачу — жми кнопку! \U0001f340",
        "\U0001f3b0\U0001f389 ДЖЕКПОТ! СКУАД СОБРАН! \U0001f389\U0001f3b0",
        "Выпал полный состав! Крутим катки! \U0001f4ab",
    ),
    Style(
        "\U0001f355 {name} ЗАКАЗЫВАЕТ ПИЦЦУ НА ЧЕТВЕРЫХ! \U0001f355\n\nНо вместо пиццы — катка в Fortnite!",
        "Кто голоден до побед? \U0001f924",
        "\U0001f355\U0001f525 ЗАКАЗ ГОТОВ! \U0001f525\U0001f355",
        "Пицца доставлена, приятного нагиба! \U0001f37d\ufe0f",
    ),
    Style(
        "\U0001f6f8 {name} ВЫЗЫВАЕТ ПОДКРЕПЛЕНИЕ! \U0001f6f8\n\nИнопланетное вторжение — нужен скуад!",
        "Земля в опасности! Кто на защиту? \U0001f30d",
        "\U0001f6f8\U0001f4a5 ПОДКРЕПЛЕНИЕ ПРИБЫЛО! \U0001f4a5\U0001f6f8",
        "Пришельцы не пройдут! Атакуем! \U0001f47e",
    ),
    Style(
        "\U0001f3ac КАСТИНГ НА ГЛАВНЫЕ РОЛИ! \U0001f3ac\n\nРежиссёр {name} ищет звёзд для блокбастера!",
        "Покажите на что способны! \U0001f31f",
        "\U0001f3ac\u2b50 КАСТ УТВЕРЖДЁН! \u2b50\U0001f3ac",
        "Камера! Мотор! Погнали! \U0001f3ac",
    ),
]


def random_style() -> int:
    return random.randrange(len(_STYLES))


def _user_link(user_id: int, name: str) -> str:
    return f'<a href="tg://user?id={user_id}">{html.escape(name)}</a>'


def _player_list(players: dict[int, str]) -> str:
    if not players:
        return "  (пока пусто)"
    return "\n".join(
        f"  {i}. {_user_link(uid, name)}"
        for i, (uid, name) in enumerate(players.items(), 1)
    )


def build_gather_text(session: Session) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)

    if session.is_complete:
        return (
            f"{style.done_header}\n\n"
            f"\U0001f3c6 Скуад готов к бою!\n\n"
            f"\U0001f44a Состав:\n{_player_list(session.go_players)}\n\n"
            f"{style.done_footer}"
        )

    header = style.header.format(name=initiator)

    return (
        f"{header}\n\n"
        f"\u2705 Го! ({go_count}/{SQUAD_SIZE}):\n{_player_list(session.go_players)}\n\n"
        f"\u274c Пас:\n{_player_list(session.pass_players)}\n\n"
        f"{style.cta}"
    )


SESSION_TIMEOUT = 60 * 60  # 1 hour


def build_expired_text(session: Session) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)
    header = style.header.format(name=initiator)

    return (
        f"{header}\n\n"
        f"\u2705 Го! ({go_count}/{SQUAD_SIZE}):\n{_player_list(session.go_players)}\n\n"
        f"\u274c Пас:\n{_player_list(session.pass_players)}\n\n"
        f"\u23f0 Время вышло — сбор отменён."
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
