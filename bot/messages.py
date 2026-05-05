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
PLAY_DEADLINE_HOUR = 23


@dataclass(frozen=True)
class Style:
    header: str  # {name} — ссылка на инициатора
    cta: str  # призыв к действию
    done_header: str
    done_footer: str


_STYLES: list[Style] = [
    Style(
        "\U0001f355 {name} заказал пиццу и зовёт в катку.",
        "Кто присоединяется?",
        "✅ Пицца в пути, скуад в сборе.",
        "Приятной игры.",
    ),
    Style(
        "\U0001f4bb {name} закрыл ноут и сел за PC.",
        "Кто свободен на вечер?",
        "✅ Все собрались.",
        "Поехали.",
    ),
    Style(
        "☕ {name} заварил чай и открыл Fortnite.",
        "Место ещё есть.",
        "✅ Все четверо в сборе.",
        "Хорошей катки.",
    ),
    Style(
        "\U0001fa82 {name} готовится к прыжку.",
        "Берём кого с собой?",
        "✅ Автобус укомплектован.",
        "Увидимся на острове.",
    ),
    Style(
        "\U0001f4c5 {name} нашёл свободный вечер.",
        "Берём кого-то ещё?",
        "✅ Скуад собран.",
        "Поехали.",
    ),
    Style(
        "\U0001f4e6 {name} видит лут — нужна команда.",
        "Кто в деле?",
        "✅ Скуад собран.",
        "К высадке.",
    ),
    Style(
        "\U0001f3c6 {name} объявил сбор на Victory Royale.",
        "Кто готов?",
        "✅ Отряд укомплектован.",
        "Ни пуха.",
    ),
    Style(
        "\U0001f3a7 {name} надел наушники.",
        "Кто сегодня играет?",
        "✅ Все в сборе.",
        "Удачной катки.",
    ),
    Style(
        "\U0001f319 {name} открывает вечернюю катку.",
        "Отметьтесь, если свободны.",
        "✅ Все на местах.",
        "Хорошей игры.",
    ),
    Style(
        "\U0001f3ae {name} заебался работать — го катка.",
        "Кто в деле?",
        "✅ Наконец-то все собрались.",
        "Поехали.",
    ),
    Style(
        "\U0001f9e0 {name} понял: без катки никуда.",
        "Возражения не принимаются.",
        "✅ Гипотеза подтверждена — скуад собран.",
        "Переходим к практике.",
    ),
    Style(
        "\U0001f4a2 {name} предлагает забить на дела.",
        "Кто со мной, ёпта?",
        "✅ Скуад собран.",
        "Погнали нагибать.",
    ),
    Style(
        "\U0001f37b {name} берёт пиво и зовёт ебашить.",
        "Присоединяйтесь, блядь.",
        "✅ Все в сборе, заебись.",
        "Погнали.",
    ),
    Style(
        "\U0001f624 {name} пришёл с работы и охуел.",
        "Кто катнёт, чтобы отпустило?",
        "✅ Спасены — все собрались.",
        "Поехали.",
    ),
    Style(
        "\U0001f393 {name} утверждает: Fortnite важнее сна.",
        "Оппоненты приветствуются.",
        "✅ Научный совет в сборе.",
        "Приступаем к защите.",
    ),
    Style(
        "\U0001f919 {name} зовёт катнуть по-пацански.",
        "Кто не ссыт — отмечайтесь.",
        "✅ Команда в сборе, пацаны.",
        "Погнали.",
    ),
    Style(
        "\U0001f3af {name} хочет кого-нибудь нахлобучить.",
        "Нужны трое — отмечайтесь.",
        "✅ Скуад собран, ща всех нахлобучим.",
        "Поехали.",
    ),
    Style(
        "\U0001f31a {name} зовёт катнуть до полуночи.",
        "Есть желающие?",
        "✅ Все четверо в сборе.",
        "До рассвета.",
    ),
    Style(
        "\U0001f37f {name} принёс снеки и зовёт играть.",
        "Кто составит компанию?",
        "✅ Скуад собран — снеки на столе.",
        "Поехали.",
    ),
]


def random_style() -> int:
    return random.randrange(len(_STYLES))


NOW_SLOT = "now"


def generate_time_slots(count: int = 3) -> list[str]:
    now = datetime.now(MSK)
    next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    deadline = now.replace(hour=PLAY_DEADLINE_HOUR, minute=0, second=0, microsecond=0)
    slots = [NOW_SLOT]
    for i in range(count):
        slot_time = next_hour + timedelta(hours=i)
        if slot_time > deadline:
            break
        slots.append(slot_time.strftime("%H:%M"))
    return slots


def _user_link(user_id: int, name: str) -> str:
    return f'<a href="tg://user?id={user_id}">{html.escape(name)}</a>'


def build_tag_line(tagged_users: dict[int, str]) -> str:
    if not tagged_users:
        return ""
    tags = " ".join(_user_link(uid, name) for uid, name in tagged_users.items())
    return f"\U0001f4e3 {tags}"


def _player_list(players: dict[int, str]) -> str:
    if not players:
        return "  (пока пусто)"
    return "\n".join(f"  {i}. {_user_link(uid, name)}" for i, (uid, name) in enumerate(players.items(), 1))


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
        label = "Сейчас" if slot == NOW_SLOT else slot
        if not players:
            lines.append(f"\U0001f554 {label}: (пусто)")
            continue
        lines.append(f"\U0001f554 {label}:")
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
        return (
            f"{style.done_header}\n\n"
            f"\U0001f44a Состав ({go_count}):\n{player_text}\n\n"
            f"❌ Пас:\n{_player_list(session.pass_players)}\n\n"
            f"{style.done_footer}"
        )

    header = style.header.format(name=initiator)

    responded = set(session.go_players) | set(session.pass_players)
    pending_tags = {uid: name for uid, name in session.tagged_users.items() if uid not in responded}
    tag_part = f"\n\n{build_tag_line(pending_tags)}" if pending_tags else ""
    return (
        f"{header}\n\n"
        f"✅ Го ({go_count}/{SQUAD_SIZE}):\n{player_text}\n\n"
        f"❌ Пас:\n{_player_list(session.pass_players)}\n\n"
        f"{style.cta}"
        f"{tag_part}"
    )


SESSION_TIMEOUT = 60 * 60  # 1 hour


@dataclass(frozen=True)
class StatsStyle:
    title: str
    sessions_header: str
    speed_header: str
    record_comment: str
    top_players_header: str
    top_initiators_header: str
    top_passers_header: str
    streaks_header: str
    best_hours_header: str


_STATS_STYLES: list[StatsStyle] = [
    StatsStyle(
        title="\U0001f4ca <b>Статистика сборов</b>",
        sessions_header="\U0001f3ae <b>Сводка</b>",
        speed_header="⏱ <b>Время до сбора</b>",
        record_comment="рекорд чата",
        top_players_header="\U0001f3c6 <b>Самые активные</b>",
        top_initiators_header="\U0001f4e2 <b>Кто чаще зовёт</b>",
        top_passers_header="\U0001f634 <b>Чаще пасуют</b>",
        streaks_header="\U0001f525 <b>Серии участия</b>",
        best_hours_header="\U0001f552 <b>Лучшее время</b>",
    ),
    StatsStyle(
        title="\U0001f4cb <b>Сводка по чату</b>",
        sessions_header="\U0001f3ae <b>Сессии</b>",
        speed_header="⚡ <b>Скорость сбора</b>",
        record_comment="минимальное время",
        top_players_header="⭐ <b>Лидеры по участию</b>",
        top_initiators_header="\U0001f4e1 <b>Чаще зовут</b>",
        top_passers_header="\U0001f6cb <b>Чаще пасуют</b>",
        streaks_header="\U0001f4aa <b>Серии подряд</b>",
        best_hours_header="\U0001f3af <b>Пиковые часы</b>",
    ),
    StatsStyle(
        title="\U0001f4c8 <b>Отчёт по сборам</b>",
        sessions_header="\U0001f5c2 <b>Итого</b>",
        speed_header="\U0001f680 <b>Скорость сбора</b>",
        record_comment="лучший результат",
        top_players_header="\U0001f451 <b>Топ участников</b>",
        top_initiators_header="\U0001f514 <b>Топ инициаторов</b>",
        top_passers_header="\U0001f40c <b>Топ пасующих</b>",
        streaks_header="\U0001f525 <b>Серии подряд</b>",
        best_hours_header="⏰ <b>Популярное время</b>",
    ),
]


def build_expired_text(session: Session) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)
    header = style.header.format(name=initiator)
    has_slots = bool(session.time_slots)
    player_text = _player_list_by_slots(session) if has_slots else _player_list(session.go_players)

    return (
        f"{header}\n\n"
        f"✅ Го ({go_count}/{SQUAD_SIZE}):\n{player_text}\n\n"
        f"❌ Пас:\n{_player_list(session.pass_players)}\n\n"
        f"⏰ Время вышло — сбор отменён."
    )


def build_cancelled_text(session: Session) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)
    header = style.header.format(name=initiator)
    has_slots = bool(session.time_slots)
    player_text = _player_list_by_slots(session) if has_slots else _player_list(session.go_players)

    return (
        f"{header}\n\n"
        f"✅ Го ({go_count}/{SQUAD_SIZE}):\n{player_text}\n\n"
        f"❌ Пас:\n{_player_list(session.pass_players)}\n\n"
        f"\U0001f504 Сбор отменён — запущен новый."
    )


def _bar(value: int, max_value: int, width: int = 8) -> str:
    if max_value == 0:
        return ""
    filled = round(value / max_value * width)
    return "█" * filled + "░" * (width - filled)


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


_STATS_DIVIDER = "─────────────────────"


def _section(lines: list[str], header: str, body: list[str]) -> None:
    if not body:
        return
    lines.append(_STATS_DIVIDER)
    lines.append(header)
    lines.extend(body)


def build_stats_text(stats: ChatStats) -> str:
    if stats.total_sessions == 0:
        return (
            f"\U0001f4ca <b>Статистика</b>\n{_STATS_DIVIDER}\n"
            "Пока ничего не собрано.\n"
            "Запустите /fort, чтобы появились данные."
        )

    style = random.choice(_STATS_STYLES)
    lines: list[str] = [style.title]

    # Overview — компактная сводка в одну-две строки
    summary_parts = [
        f"\U0001f3ae Всего: <b>{stats.total_sessions}</b>",
        f"✅ <b>{stats.completed_sessions}</b>",
        f"⏰ <b>{stats.expired_sessions}</b>",
    ]
    if stats.active_sessions > 0:
        summary_parts.append(f"\U0001f7e1 <b>{stats.active_sessions}</b>")
    rate = stats.completed_sessions / stats.total_sessions * 100
    overview_body = [
        "  ·  ".join(summary_parts),
        f"\U0001f4c8 Процент сборки: <b>{rate:.0f}%</b>",
    ]
    _section(lines, style.sessions_header, overview_body)

    # Timing
    if stats.avg_fill_seconds is not None:
        timing_body = [
            f"   Среднее: <b>{_format_duration(stats.avg_fill_seconds)}</b>",
            f"   Рекорд:  <b>{_format_duration(stats.fastest_fill_seconds)}</b> — {style.record_comment}",
        ]
        _section(lines, style.speed_header, timing_body)

    # Top players
    if stats.top_players:
        max_cnt = stats.top_players[0][1]
        medals = ["\U0001f947", "\U0001f948", "\U0001f949"]
        body = []
        for i, (name, cnt) in enumerate(stats.top_players[:5]):
            medal = medals[i] if i < len(medals) else f"   {i + 1}."
            bar = _bar(cnt, max_cnt)
            body.append(f"{medal} {html.escape(name)}  {bar} <b>{cnt}</b>")
        _section(lines, style.top_players_header, body)

    # Top initiators
    if stats.top_initiators:
        max_cnt = stats.top_initiators[0][1]
        body = []
        for i, (name, cnt) in enumerate(stats.top_initiators[:3]):
            bar = _bar(cnt, max_cnt, 6)
            body.append(f"   {i + 1}. {html.escape(name)}  {bar} <b>{cnt}</b>")
        _section(lines, style.top_initiators_header, body)

    # Top passers
    if stats.top_passers:
        max_cnt = stats.top_passers[0][1]
        body = []
        for i, (name, cnt) in enumerate(stats.top_passers[:3]):
            bar = _bar(cnt, max_cnt, 6)
            body.append(f"   {i + 1}. {html.escape(name)}  {bar} <b>{cnt}</b>")
        _section(lines, style.top_passers_header, body)

    # Streaks
    if stats.top_streaks:
        streak_medals = ["\U0001f947", "\U0001f948", "\U0001f949"]
        body = []
        for i, (name, cnt) in enumerate(stats.top_streaks[:3]):
            medal = streak_medals[i] if i < len(streak_medals) else f"   {i + 1}."
            fires = "\U0001f525" * min(cnt, 5)
            body.append(f"{medal} {html.escape(name)}  <b>{cnt}</b> {fires}")
        _section(lines, style.streaks_header, body)

    # Best hours
    if stats.best_hours:
        body = []
        for hour, cnt, avg_fill in stats.best_hours:
            avg_text = _format_duration(avg_fill) if avg_fill else "—"
            body.append(f"   {hour:02d}:00 — <b>{cnt}</b> сборов, среднее <b>{avg_text}</b>")
        _section(lines, style.best_hours_header, body)

    return "\n".join(lines)


def build_keyboard(go_count: int, time_slots: list[str] | None = None) -> InlineKeyboardMarkup:
    if time_slots:
        slot_buttons = [
            InlineKeyboardButton(
                text="⚡ Сейчас" if slot == NOW_SLOT else f"\U0001f554 {slot}",
                callback_data=f"slot:{slot}",
            )
            for slot in time_slots
        ]
        return InlineKeyboardMarkup(
            inline_keyboard=[
                slot_buttons,
                [InlineKeyboardButton(text="❌ Пас", callback_data="pass")],
            ]
        )
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=f"✅ Го ({go_count}/{SQUAD_SIZE})",
                    callback_data="go",
                ),
                InlineKeyboardButton(
                    text="❌ Пас",
                    callback_data="pass",
                ),
            ]
        ]
    )
