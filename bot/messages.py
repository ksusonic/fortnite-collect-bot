from __future__ import annotations

import html
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

if TYPE_CHECKING:
    from bot.db import ChatStats, Session

MSK = timezone(timedelta(hours=3))

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


def generate_time_slots(count: int = 3) -> list[str]:
    now = datetime.now(MSK)
    next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return [(next_hour + timedelta(hours=i)).strftime("%H:%M") for i in range(count)]


def _user_link(user_id: int, name: str) -> str:
    return f'<a href="tg://user?id={user_id}">{html.escape(name)}</a>'


def _player_list(players: dict[int, str]) -> str:
    if not players:
        return "  (пока пусто)"
    return "\n".join(
        f"  {i}. {_user_link(uid, name)}"
        for i, (uid, name) in enumerate(players.items(), 1)
    )


def _player_list_by_slots(session: Session) -> str:
    if not session.go_players:
        return "  (пока пусто)"
    slots_grouped: dict[str, list[tuple[int, str]]] = {s: [] for s in session.time_slots}
    for uid, name in session.go_players.items():
        slot = session.player_slots.get(uid)
        if slot and slot in slots_grouped:
            slots_grouped[slot].append((uid, name))
    lines: list[str] = []
    idx = 1
    for slot, players in slots_grouped.items():
        if not players:
            lines.append(f"\U0001f554 {slot}: (пусто)")
            continue
        lines.append(f"\U0001f554 {slot}:")
        for uid, name in players:
            lines.append(f"  {idx}. {_user_link(uid, name)}")
            idx += 1
    return "\n".join(lines)


def build_gather_text(session: Session) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)
    has_slots = bool(session.time_slots)
    player_text = _player_list_by_slots(session) if has_slots else _player_list(session.go_players)

    if session.is_complete:
        header = (
            f"{style.done_header}\n\n"
            f"\U0001f3c6 Скуад готов к бою!\n\n"
        )
        return (
            f"{header}"
            f"\U0001f44a Состав ({go_count}):\n{player_text}\n\n"
            f"\u274c Пас:\n{_player_list(session.pass_players)}\n\n"
            f"{style.done_footer}"
        )

    header = style.header.format(name=initiator)

    return (
        f"{header}\n\n"
        f"\u2705 Го! ({go_count}/{SQUAD_SIZE}):\n{player_text}\n\n"
        f"\u274c Пас:\n{_player_list(session.pass_players)}\n\n"
        f"{style.cta}"
    )


SESSION_TIMEOUT = 60 * 60  # 1 hour


def build_expired_text(session: Session) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)
    header = style.header.format(name=initiator)
    has_slots = bool(session.time_slots)
    player_text = _player_list_by_slots(session) if has_slots else _player_list(session.go_players)

    return (
        f"{header}\n\n"
        f"\u2705 Го! ({go_count}/{SQUAD_SIZE}):\n{player_text}\n\n"
        f"\u274c Пас:\n{_player_list(session.pass_players)}\n\n"
        f"\u23f0 Время вышло — сбор отменён."
    )


def _bar(value: int, max_value: int, width: int = 8) -> str:
    if max_value == 0:
        return ""
    filled = round(value / max_value * width)
    return "\u2588" * filled + "\u2591" * (width - filled)


def _format_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = int(seconds // 60)
    secs = int(seconds % 60)
    if minutes < 60:
        return f"{minutes}m {secs}s"
    hours = int(minutes // 60)
    mins = minutes % 60
    return f"{hours}h {mins}m"


def build_stats_text(stats: ChatStats) -> str:
    if stats.total_sessions == 0:
        return "\U0001f4ca <b>Статистика</b>\n\nПока нет данных — начните с /fort!"

    lines: list[str] = []
    lines.append("\U0001f4ca <b>СТАТИСТИКА СБОРОВ</b> \U0001f4ca")
    lines.append("")

    # Overview
    lines.append("\U0001f3ae <b>Сборы:</b>")
    lines.append(f"  Всего: <b>{stats.total_sessions}</b>")
    lines.append(f"  \u2705 Собрано: <b>{stats.completed_sessions}</b>")
    lines.append(f"  \u23f0 Истекло: <b>{stats.expired_sessions}</b>")
    if stats.active_sessions > 0:
        lines.append(f"  \U0001f7e1 Активных: <b>{stats.active_sessions}</b>")

    if stats.total_sessions > 0:
        rate = stats.completed_sessions / stats.total_sessions * 100
        lines.append(f"  Процент сборки: <b>{rate:.0f}%</b>")

    # Timing
    if stats.avg_fill_seconds is not None:
        lines.append("")
        lines.append("\u23f1 <b>Скорость сбора:</b>")
        lines.append(f"  Среднее: <b>{_format_duration(stats.avg_fill_seconds)}</b>")
        lines.append(f"  Рекорд: <b>{_format_duration(stats.fastest_fill_seconds)}</b> \U0001f525")

    # Top players
    if stats.top_players:
        lines.append("")
        lines.append("\U0001f3c6 <b>Топ игроков (по участию):</b>")
        max_cnt = stats.top_players[0][1]
        medals = ["\U0001f947", "\U0001f948", "\U0001f949"]
        for i, (name, cnt) in enumerate(stats.top_players[:5]):
            medal = medals[i] if i < len(medals) else f"  {i + 1}."
            bar = _bar(cnt, max_cnt)
            lines.append(f"{medal} {html.escape(name)}  {bar} <b>{cnt}</b>")

    # Top initiators
    if stats.top_initiators:
        lines.append("")
        lines.append("\U0001f4e2 <b>Топ зачинщиков:</b>")
        max_cnt = stats.top_initiators[0][1]
        for i, (name, cnt) in enumerate(stats.top_initiators[:3]):
            bar = _bar(cnt, max_cnt, 6)
            lines.append(f"  {i + 1}. {html.escape(name)}  {bar} <b>{cnt}</b>")

    # Top passers
    if stats.top_passers:
        lines.append("")
        lines.append("\U0001f634 <b>Топ пасующих:</b>")
        max_cnt = stats.top_passers[0][1]
        for i, (name, cnt) in enumerate(stats.top_passers[:3]):
            bar = _bar(cnt, max_cnt, 6)
            lines.append(f"  {i + 1}. {html.escape(name)}  {bar} <b>{cnt}</b>")

    return "\n".join(lines)


def build_keyboard(go_count: int, time_slots: list[str] | None = None) -> InlineKeyboardMarkup:
    if time_slots:
        slot_buttons = [
            InlineKeyboardButton(
                text=f"\U0001f554 {slot}",
                callback_data=f"slot:{slot}",
            )
            for slot in time_slots
        ]
        return InlineKeyboardMarkup(
            inline_keyboard=[
                slot_buttons,
                [InlineKeyboardButton(text="\u274c Пас", callback_data="pass")],
            ]
        )
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
