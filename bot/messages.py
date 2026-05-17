from __future__ import annotations

import html
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

if TYPE_CHECKING:
    from bot.db import ChatStats, EpicLink, Session
    from bot.fortnite import FortniteError, ModeStats, PlayerStats

MSK = timezone(timedelta(hours=3))

SQUAD_SIZE = 4
PLAY_DEADLINE_HOUR = 23


@dataclass(frozen=True)
class Style:
    header: str  # {name} — ссылка на инициатора
    done_header: str
    done_footer: str


_STYLES: list[Style] = [
    Style(
        "\U0001f355 {name} заказал пиццу и зовёт в катку.",
        "✅ Пицца в пути, скуад в сборе.",
        "Приятной игры.",
    ),
    Style(
        "\U0001f4bb {name} закрыл ноут и сел за PC.",
        "✅ Все собрались.",
        "Поехали.",
    ),
    Style(
        "☕ {name} заварил чай и открыл Fortnite.",
        "✅ Все четверо в сборе.",
        "Хорошей катки.",
    ),
    Style(
        "\U0001fa82 {name} готовится к прыжку.",
        "✅ Автобус укомплектован.",
        "Увидимся на острове.",
    ),
    Style(
        "\U0001f4c5 {name} нашёл свободный вечер.",
        "✅ Скуад собран.",
        "Поехали.",
    ),
    Style(
        "\U0001f4e6 {name} видит лут — нужна команда.",
        "✅ Скуад собран.",
        "К высадке.",
    ),
    Style(
        "\U0001f3c6 {name} объявил сбор на Victory Royale.",
        "✅ Отряд укомплектован.",
        "Ни пуха.",
    ),
    Style(
        "\U0001f3a7 {name} надел наушники.",
        "✅ Все в сборе.",
        "Удачной катки.",
    ),
    Style(
        "\U0001f319 {name} открывает вечернюю катку.",
        "✅ Все на местах.",
        "Хорошей игры.",
    ),
    Style(
        "\U0001f3ae {name} заебался работать — го катка.",
        "✅ Наконец-то все собрались.",
        "Поехали.",
    ),
    Style(
        "\U0001f9e0 {name} понял: без катки никуда.",
        "✅ Гипотеза подтверждена — скуад собран.",
        "Переходим к практике.",
    ),
    Style(
        "\U0001f4a2 {name} предлагает забить на дела.",
        "✅ Скуад собран.",
        "Погнали нагибать.",
    ),
    Style(
        "\U0001f37b {name} берёт пиво и зовёт ебашить.",
        "✅ Все в сборе, заебись.",
        "Погнали.",
    ),
    Style(
        "\U0001f624 {name} пришёл с работы и охуел.",
        "✅ Спасены — все собрались.",
        "Поехали.",
    ),
    Style(
        "\U0001f393 {name} утверждает: Fortnite важнее сна.",
        "✅ Научный совет в сборе.",
        "Приступаем к защите.",
    ),
    Style(
        "\U0001f919 {name} зовёт катнуть по-пацански.",
        "✅ Команда в сборе, пацаны.",
        "Погнали.",
    ),
    Style(
        "\U0001f3af {name} хочет кого-нибудь нахлобучить.",
        "✅ Скуад собран, ща всех нахлобучим.",
        "Поехали.",
    ),
    Style(
        "\U0001f31a {name} зовёт катнуть до полуночи.",
        "✅ Все четверо в сборе.",
        "До рассвета.",
    ),
    Style(
        "\U0001f37f {name} принёс снеки и зовёт играть.",
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


_DIVIDER = "─────────────────────"


def _user_link(user_id: int, name: str) -> str:
    return f'<a href="tg://user?id={user_id}">{html.escape(name)}</a>'


def build_tag_line(tagged_users: dict[int, str]) -> str:
    if not tagged_users:
        return ""
    tags = " ".join(_user_link(uid, name) for uid, name in tagged_users.items())
    return f"\U0001f4e3 {tags}"


def _player_list(players: dict[int, str]) -> str:
    if not players:
        return "   (пока пусто)"
    return "\n".join(f"   {i}. {_user_link(uid, name)}" for i, (uid, name) in enumerate(players.items(), 1))


def _player_list_by_slots(session: Session) -> str:
    if not session.go_players:
        return "   (пока пусто)"
    slots_grouped: dict[str, list[tuple[int, str]]] = {s: [] for s in session.time_slots}
    for uid, name in session.go_players.items():
        slot = session.player_slots.get(uid)
        if slot and slot in slots_grouped:
            slots_grouped[slot].append((uid, name))
    lines: list[str] = []
    idx = 1
    empty_labels: list[str] = []
    for slot, players in slots_grouped.items():
        label = "Сейчас" if slot == NOW_SLOT else slot
        if not players:
            empty_labels.append(label)
            continue
        lines.append(f"\U0001f554 {label}:")
        for uid, name in players:
            lines.append(f"   {idx}. {_user_link(uid, name)}")
            idx += 1
    if empty_labels:
        lines.append(f"\U0001f554 Свободно: {' · '.join(empty_labels)}")
    return "\n".join(lines)


def build_gather_text(session: Session) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)
    has_slots = bool(session.time_slots)
    player_text = _player_list_by_slots(session) if has_slots else _player_list(session.go_players)

    if session.is_complete:
        lines = [
            style.done_header,
            _DIVIDER,
            f"\U0001f44a <b>Состав</b> {go_count}",
            player_text,
            _DIVIDER,
            "❌ <b>Пас</b>",
            _player_list(session.pass_players),
            _DIVIDER,
            style.done_footer,
        ]
        return "\n".join(lines)

    header = style.header.format(name=initiator)
    responded = set(session.go_players) | set(session.pass_players)
    pending_tags = {uid: name for uid, name in session.tagged_users.items() if uid not in responded}

    lines = [
        header,
        _DIVIDER,
        f"✅ <b>Go</b> {go_count}/{SQUAD_SIZE}",
        player_text,
        _DIVIDER,
        "❌ <b>Пас</b>",
        _player_list(session.pass_players),
    ]
    if pending_tags:
        lines.append("")
        lines.append(build_tag_line(pending_tags))
    return "\n".join(lines)


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


def _build_closed_text(session: Session, footer: str) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)
    header = style.header.format(name=initiator)
    has_slots = bool(session.time_slots)
    player_text = _player_list_by_slots(session) if has_slots else _player_list(session.go_players)

    lines = [
        header,
        _DIVIDER,
        f"✅ <b>Go</b> {go_count}/{SQUAD_SIZE}",
        player_text,
        _DIVIDER,
        "❌ <b>Пас</b>",
        _player_list(session.pass_players),
        _DIVIDER,
        footer,
    ]
    return "\n".join(lines)


def build_expired_text(session: Session) -> str:
    return _build_closed_text(session, "⏰ Время вышло — сбор отменён.")


def build_cancelled_text(session: Session) -> str:
    return _build_closed_text(session, "\U0001f504 Сбор отменён — запущен новый.")


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


def _section(lines: list[str], header: str, body: list[str]) -> None:
    if not body:
        return
    lines.append(_DIVIDER)
    lines.append(header)
    lines.extend(body)


def build_stats_text(stats: ChatStats) -> str:
    if stats.total_sessions == 0:
        return (
            f"\U0001f4ca <b>Статистика</b>\n{_DIVIDER}\n"
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


def _format_hours(minutes: int) -> str:
    return f"{minutes // 60}ч {minutes % 60}м"


def _format_mode_block(title: str, mode: ModeStats) -> list[str]:
    return [
        title,
        f"   Матчи: <b>{mode.matches}</b>  ·  Победы: <b>{mode.wins}</b>  ·  K/D: <b>{mode.kd:.2f}</b>",
        f"   Win rate: <b>{mode.win_rate * 100:.1f}%</b>  ·  Киллы: <b>{mode.kills}</b>",
        f"   В игре: <b>{_format_hours(mode.minutes_played)}</b>",
    ]


def _short(name: str, n: int = 14) -> str:
    """Truncate a display name with an ellipsis if it exceeds n chars."""
    if len(name) <= n:
        return name
    return name[: n - 1] + "…"


def _table(headers: list[str], rows: list[list[str]], aligns: list[str]) -> str:
    """Render a monospace table wrapped in <pre>...</pre>.

    Plain text only — no inline HTML tags inside the <pre> block (Telegram
    breaks rendering otherwise). Cell contents are escaped before being
    wrapped, so callers may pass raw user text.
    """
    cols = len(headers)
    widths = [len(h) for h in headers]
    for row in rows:
        for i in range(cols):
            cell = row[i] if i < len(row) else ""
            if len(cell) > widths[i]:
                widths[i] = len(cell)

    def fmt(cells: list[str]) -> str:
        parts: list[str] = []
        for i in range(cols):
            cell = cells[i] if i < len(cells) else ""
            if i < len(aligns) and aligns[i] == "r":
                parts.append(cell.rjust(widths[i]))
            else:
                parts.append(cell.ljust(widths[i]))
        return "  ".join(parts).rstrip()

    sep = "  ".join("-" * w for w in widths)
    body_lines = [fmt(headers), sep] + [fmt(row) for row in rows]
    return "<pre>" + html.escape("\n".join(body_lines)) + "</pre>"


def my_fn_caption(link: EpicLink, stats: PlayerStats) -> str:
    """Short HTML caption (<=1024 chars) for the /myfnstats stats image."""
    user_link = _user_link(link.user_id, link.user_name)
    fetched_dt = datetime.fromtimestamp(stats.fetched_at, MSK)
    return (
        f"\U0001f3af {user_link} · Epic <b>{html.escape(stats.epic_name)}</b>\n"
        f"\U0001f5d3 сезон · обновлено {fetched_dt.strftime('%d.%m %H:%M')} MSK"
    )


def build_my_fn_stats_text(link: EpicLink, stats: PlayerStats) -> str:
    user_link = _user_link(link.user_id, link.user_name)
    fetched_dt = datetime.fromtimestamp(stats.fetched_at, MSK)
    lines: list[str] = [
        f"\U0001f3ae <b>Fortnite stats</b> · сезон — {user_link}",
        f"\U0001f3ad Epic: <b>{html.escape(stats.epic_name)}</b>",
    ]
    _section(lines, "\U0001f4ca <b>Overall</b>", _format_mode_block("Все режимы", stats.overall)[1:])
    mode_blocks = (
        ("\U0001f9cd <b>Solo</b>", stats.solo),
        ("\U0001f465 <b>Duo</b>", stats.duo),
        ("\U0001f46a <b>Squad</b>", stats.squad),
    )
    for title, mode in mode_blocks:
        if mode is None:
            continue
        body = _format_mode_block(title, mode)
        lines.append(_DIVIDER)
        lines.extend(body)
    lines.append(_DIVIDER)
    lines.append(f"\U0001f553 Обновлено: {fetched_dt.strftime('%d.%m %H:%M')} MSK · сезон")
    return "\n".join(lines)


def _team_aggregate(successes: list[tuple[EpicLink, PlayerStats]]) -> tuple[int, int, int, float, float]:
    total_matches = sum(s.overall.matches for _, s in successes)
    total_wins = sum(s.overall.wins for _, s in successes)
    total_kills = sum(s.overall.kills for _, s in successes)
    total_deaths_est = sum(int(round(s.overall.kills / s.overall.kd)) if s.overall.kd > 0 else 0 for _, s in successes)
    team_kd = total_kills / total_deaths_est if total_deaths_est > 0 else 0.0
    team_win_rate = total_wins / total_matches if total_matches > 0 else 0.0
    return total_matches, total_wins, total_kills, team_kd, team_win_rate


def _display_short(link: EpicLink, epic_name: str) -> str:
    """Choose what to show in the Player column: prefer telegram name, then Epic."""
    name = link.user_name or epic_name
    return _short(name)


def _leaders_table(successes: list[tuple[EpicLink, PlayerStats]], limit: int = 5) -> str:
    ranked = sorted(successes, key=lambda x: -x[1].overall.wins)[:limit]
    headers = ["Игрок", "M", "W", "K", "K/D"]
    rows: list[list[str]] = []
    for link, s in ranked:
        rows.append(
            [
                _display_short(link, s.epic_name),
                str(s.overall.matches),
                str(s.overall.wins),
                str(s.overall.kills),
                f"{s.overall.kd:.2f}",
            ]
        )
    return _table(headers, rows, aligns=["l", "r", "r", "r", "r"])


def _mode_top_by_wins(
    successes: list[tuple[EpicLink, PlayerStats]],
    mode_attr: str,
    limit: int = 3,
) -> list[tuple[EpicLink, str, ModeStats]]:
    rows: list[tuple[EpicLink, str, ModeStats]] = []
    for link, stats in successes:
        mode = getattr(stats, mode_attr)
        if mode is None:
            continue
        rows.append((link, stats.epic_name, mode))
    rows.sort(key=lambda x: -x[2].wins)
    return rows[:limit]


def _mode_table(top: list[tuple[EpicLink, str, ModeStats]]) -> str:
    headers = ["Игрок", "M", "W", "K", "K/D"]
    rows = [
        [
            _display_short(link, epic_name),
            str(mode.matches),
            str(mode.wins),
            str(mode.kills),
            f"{mode.kd:.2f}",
        ]
        for link, epic_name, mode in top
    ]
    return _table(headers, rows, aligns=["l", "r", "r", "r", "r"])


def build_team_fn_stats_text(
    successes: list[tuple[EpicLink, PlayerStats]],
    failures: list[tuple[EpicLink, FortniteError]],
) -> str:
    from bot.fortnite import EpicNameNotFound, FortniteUnavailable, StatsEmpty, StatsPrivate

    lines: list[str] = ["\U0001f3c6 <b>Командная Fortnite-статистика</b> · сезон"]

    if not successes:
        lines.append(_DIVIDER)
        lines.append("Не удалось получить ни одну статистику.")
    else:
        total_matches, total_wins, total_kills, team_kd, team_win_rate = _team_aggregate(successes)
        summary_body = [
            f"   Игроков: <b>{len(successes)}</b>",
            f"   Матчи: <b>{total_matches}</b>  ·  Победы: <b>{total_wins}</b>  ·  Киллы: <b>{total_kills}</b>",
            f"   Командный K/D: <b>{team_kd:.2f}</b>  ·  Win rate: <b>{team_win_rate * 100:.1f}%</b>",
        ]
        _section(lines, "\U0001f4ca <b>Сводка</b>", summary_body)

        # Single leaders table (top-5 by wins) replaces the three separate top lists.
        _section(lines, "\U0001f3c5 <b>Лидеры</b> <i>(по победам)</i>", [_leaders_table(successes, limit=5)])

        for header, mode_attr in (
            ("\U0001f9cd <b>Solo</b>", "solo"),
            ("\U0001f465 <b>Duo</b>", "duo"),
            ("\U0001f3af <b>Squad</b>", "squad"),
        ):
            top = _mode_top_by_wins(successes, mode_attr)
            if not top:
                continue
            _section(lines, header, [_mode_table(top)])

    if failures:
        not_found: list[EpicLink] = []
        private: list[EpicLink] = []
        empty: list[EpicLink] = []
        unavailable: list[EpicLink] = []
        for link, err in failures:
            if isinstance(err, EpicNameNotFound):
                not_found.append(link)
            elif isinstance(err, StatsPrivate):
                private.append(link)
            elif isinstance(err, StatsEmpty):
                empty.append(link)
            elif isinstance(err, FortniteUnavailable):
                unavailable.append(link)
            else:
                unavailable.append(link)

        body: list[str] = []
        if private:
            names = ", ".join(_user_link(link.user_id, link.user_name) for link in private)
            body.append(f"   \U0001f512 Приватный профиль: {names}")
        if empty:
            names = ", ".join(_user_link(link.user_id, link.user_name) for link in empty)
            body.append(f"   \U0001f4ad Без матчей в сезоне: {names}")
        if not_found:
            names = ", ".join(_user_link(link.user_id, link.user_name) for link in not_found)
            body.append(f"   \U0001f47b Не найден: {names}")
        if unavailable:
            names = ", ".join(_user_link(link.user_id, link.user_name) for link in unavailable)
            body.append(f"   \U0001f6ab API недоступен: {names}")
        _section(lines, "⚠️ <b>Без данных</b>", body)

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
                    text=f"✅ Go ({go_count}/{SQUAD_SIZE})",
                    callback_data="go",
                ),
                InlineKeyboardButton(
                    text="❌ Пас",
                    callback_data="pass",
                ),
            ]
        ]
    )
