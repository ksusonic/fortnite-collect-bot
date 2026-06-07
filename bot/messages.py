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

# Relative readiness offers in minutes; capped at +2h (product decision —
# people coordinate as "через полчаса", not by the clock).
SLOT_OFFERS_MIN = [30, 60, 120]


def generate_time_slots(start_hour: int | None = None) -> list[str]:
    """Return readiness tokens for a /fort keyboard.

    Plain `/fort` → ["now", "30", "60", "120"]: "now" plus minute-offset tokens
    whose absolute target still lands before `PLAY_DEADLINE_HOUR`. Each token is
    a *relative* offer; the absolute target is computed when a player presses it.
    `/fort <hour>` pins a single absolute "HH:00" slot (no "now").
    """
    now = datetime.now(MSK)
    if start_hour is not None:
        return [f"{start_hour:02d}:00"]
    deadline = now.replace(hour=PLAY_DEADLINE_HOUR, minute=0, second=0, microsecond=0)
    slots = [NOW_SLOT]
    for minutes in SLOT_OFFERS_MIN:
        if now + timedelta(minutes=minutes) <= deadline:
            slots.append(str(minutes))
    return slots


_DIVIDER = "─────────────────────"


def _user_link(user_id: int, name: str) -> str:
    return f'<a href="tg://user?id={user_id}">{html.escape(name)}</a>'


def _user_code(name: str) -> str:
    """Monospace username that does NOT trigger a Telegram mention/notification."""
    return f"<code>{html.escape(name)}</code>"


def build_tag_line(tagged_users: dict[int, str]) -> str:
    if not tagged_users:
        return ""
    tags = " ".join(_user_link(uid, name) for uid, name in tagged_users.items())
    return f"\U0001f4e3 {tags}"


def _player_list(players: dict[int, str]) -> str:
    if not players:
        return "   (пока пусто)"
    return "\n".join(f"   {i}. {_user_link(uid, name)}" for i, (uid, name) in enumerate(players.items(), 1))


def _eta_label(slot: str) -> str:
    """Human ETA for a stored player slot ("now" or an absolute "HH:MM" target)."""
    if slot == NOW_SLOT:
        return "сейчас"
    label = f"≈ {slot}"
    try:
        hh, mm = slot.split(":")
        now = datetime.now(MSK)
        target = now.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
        delta_min = round((target - now).total_seconds() / 60)
        if delta_min > 0:
            label += f" (через ~{delta_min}м)"
    except ValueError, AttributeError:
        pass
    return label


def _player_eta_list(session: Session) -> str:
    """Flat numbered list of go-players, each annotated with their ETA."""
    if not session.go_players:
        return "   (пока пусто)"

    def sort_key(item: tuple[int, str]) -> tuple[int, str]:
        slot = session.player_slots.get(item[0]) or NOW_SLOT
        return (0, "") if slot == NOW_SLOT else (1, slot)

    lines: list[str] = []
    for idx, (uid, name) in enumerate(sorted(session.go_players.items(), key=sort_key), 1):
        slot = session.player_slots.get(uid)
        eta = f" — {_eta_label(slot)}" if slot else ""
        lines.append(f"   {idx}. {_user_link(uid, name)}{eta}")
    return "\n".join(lines)


def build_gather_text(session: Session) -> str:
    style = _STYLES[session.style % len(_STYLES)]
    go_count = len(session.go_players)
    initiator = _user_link(session.initiator_id, session.initiator_name)
    has_slots = bool(session.time_slots)
    player_text = _player_eta_list(session) if has_slots else _player_list(session.go_players)

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

    template = session.llm_header or style.header
    header = template.replace("{name}", initiator)
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


SESSION_TIMEOUT = 60 * 60  # 1 hour — drop a set nobody (or just one) joined
SESSION_TIMEOUT_TRACTION = 3 * 60 * 60  # 3 hours — a set with 2+ "go" survives longer


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
    template = session.llm_header or style.header
    header = template.replace("{name}", initiator)
    has_slots = bool(session.time_slots)
    player_text = _player_eta_list(session) if has_slots else _player_list(session.go_players)

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
    if len(session.go_players) >= 2:
        footer = f"⏰ Окно закрылось. В деле было {len(session.go_players)} — добивайте в игре \U0001f3ae"
    else:
        footer = "⏰ Время вышло — сбор отменён."
    return _build_closed_text(session, footer)


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


def my_fn_caption(link: EpicLink, stats: PlayerStats) -> str:
    """Short HTML caption (<=1024 chars) for the /myfnstats stats image."""
    user_link = _user_link(link.user_id, link.user_name)
    fetched_dt = datetime.fromtimestamp(stats.fetched_at, MSK)
    return (
        f"\U0001f3af {user_link} · Epic <b>{html.escape(stats.epic_name)}</b>\n"
        f"\U0001f5d3 обновлено {fetched_dt.strftime('%d.%m %H:%M')} MSK"
    )


def build_my_fn_stats_text(link: EpicLink, stats: PlayerStats) -> str:
    user_link = _user_link(link.user_id, link.user_name)
    fetched_dt = datetime.fromtimestamp(stats.fetched_at, MSK)
    lines: list[str] = [
        f"\U0001f3ae <b>Fortnite stats</b> — {user_link}",
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
    lines.append(f"\U0001f553 Обновлено: {fetched_dt.strftime('%d.%m %H:%M')} MSK")
    return "\n".join(lines)


def _squad_totals(stats: PlayerStats) -> tuple[int, int, int, float]:
    """Player totals in squad mode only. This bot is for 4-player squads."""
    mode = stats.squad
    if mode is None:
        return 0, 0, 0, 0.0
    return mode.matches, mode.wins, mode.kills, mode.kd


def _team_aggregate(successes: list[tuple[EpicLink, PlayerStats]]) -> tuple[int, int, int, float, float]:
    """Team-wide totals in squad mode. Solo and duo are excluded."""
    total_matches = total_wins = total_kills = total_deaths_est = 0
    for _, s in successes:
        m, w, k, kd = _squad_totals(s)
        total_matches += m
        total_wins += w
        total_kills += k
        if kd > 0:
            total_deaths_est += int(round(k / kd))
    team_kd = total_kills / total_deaths_est if total_deaths_est > 0 else 0.0
    team_win_rate = total_wins / total_matches if total_matches > 0 else 0.0
    return total_matches, total_wins, total_kills, team_kd, team_win_rate


def _display_short(link: EpicLink, epic_name: str) -> str:
    """Choose what to show in the Player column: prefer telegram name, then Epic."""
    name = link.user_name or epic_name
    return _short(name)


_TEAM_DIVIDER = "─" * 20

_MEDAL_GOLD = "\U0001f947"  # 🥇
_MEDAL_SILVER = "\U0001f948"  # 🥈
_MEDAL_BRONZE = "\U0001f949"  # 🥉
_TEAM_MEDALS = (_MEDAL_GOLD, _MEDAL_SILVER, _MEDAL_BRONZE)


def _plural_players(n: int) -> str:
    """Russian plural for 'игрок' based on the trailing digits."""
    mod100 = n % 100
    if 11 <= mod100 <= 14:
        return "игроков"
    mod10 = n % 10
    if mod10 == 1:
        return "игрок"
    if 2 <= mod10 <= 4:
        return "игрока"
    return "игроков"


def _leaders_pre_table(successes: list[tuple[EpicLink, PlayerStats]], limit: int = 5) -> str:
    """Render leaders table as <pre>, with medal column for top-3 inside the block.

    Emojis inside <pre> render as ~2 cells wide visually but len()==1 in Python.
    We compensate by using a fixed-width medal column where each cell is either:
      - "<emoji> " (len=2, visual ~3) for medalled rows, or
      - "   " (len=3, visual=3) for non-medalled rows and the header.
    """

    def team_play_key(item: tuple[EpicLink, PlayerStats]) -> tuple[int, int]:
        m, w, k, _ = _squad_totals(item[1])
        return (-w, -k)

    ranked = sorted(successes, key=team_play_key)[:limit]
    headers = ["Игрок", "M", "W", "K", "K/D"]
    rows_payload: list[tuple[str, list[str]]] = []
    for i, (link, s) in enumerate(ranked):
        m, w, k, kd = _squad_totals(s)
        medal_cell = f"{_TEAM_MEDALS[i]} " if i < len(_TEAM_MEDALS) else "   "
        cells = [
            _display_short(link, s.epic_name),
            str(m),
            str(w),
            str(k),
            f"{kd:.2f}",
        ]
        rows_payload.append((medal_cell, cells))

    cols = len(headers)
    widths = [len(h) for h in headers]
    for _, cells in rows_payload:
        for i in range(cols):
            cell = cells[i] if i < len(cells) else ""
            if len(cell) > widths[i]:
                widths[i] = len(cell)

    aligns = ["l", "r", "r", "r", "r"]
    medal_width_plain = 3  # three spaces in the header / non-medal rows

    def fmt(medal: str, cells: list[str]) -> str:
        parts: list[str] = [medal]
        for i in range(cols):
            cell = cells[i] if i < len(cells) else ""
            parts.append(cell.rjust(widths[i]) if aligns[i] == "r" else cell.ljust(widths[i]))
        return "  ".join(parts).rstrip()

    sep_parts = ["─" * medal_width_plain] + ["─" * w for w in widths]
    sep = "  ".join(sep_parts)
    body = [fmt(" " * medal_width_plain, headers), sep]
    for medal_cell, cells in rows_payload:
        body.append(fmt(medal_cell, cells))
    return "<pre>" + html.escape("\n".join(body)) + "</pre>"


def _mvp(successes: list[tuple[EpicLink, PlayerStats]]) -> tuple[EpicLink, PlayerStats] | None:
    """MVP by team-play (duo+squad) wins, tie-broken by team-play kills."""
    if not successes:
        return None

    def key(item: tuple[EpicLink, PlayerStats]) -> tuple[int, int]:
        _, w, k, _ = _squad_totals(item[1])
        return (-w, -k)

    return sorted(successes, key=key)[0]


def _format_delta_block(
    title: str,
    successes: list[tuple[EpicLink, PlayerStats]],
    deltas: dict[str, tuple[int, int, int, float]],
) -> list[str]:
    """One Grok-facts block for a given window. Players without a baseline
    snapshot are skipped (already filtered out by caller); zero-new-matches
    rows are kept so Grok can call out the no-show."""
    rows: list[str] = []
    for link, s in successes:
        delta = deltas.get(s.epic_account_id)
        if delta is None:
            continue
        dm, dw, dk, period_kd = delta
        name = link.user_name or s.epic_name
        if dm == 0:
            rows.append(f"- {name}: 0 новых матчей")
        else:
            rows.append(f"- {name}: +{dm}M, +{dw}W, +{dk}K, K/D за период {period_kd:.2f}")
    if not rows:
        return []
    return [title, *rows]


def _build_team_facts(
    successes: list[tuple[EpicLink, PlayerStats]],
    aggregates: tuple[int, int, int, float, float],
    mvp: tuple[EpicLink, PlayerStats] | None,
    leaders: list[tuple[EpicLink, PlayerStats]],
    weekly_missing: list[tuple[EpicLink, str]] | None = None,
    deltas_24h: dict[str, tuple[int, int, int, float]] | None = None,
) -> str:
    """Plain-text fact dump for LLM consumption (no HTML, no emojis).

    All numbers are for the LAST 7 DAYS only (the squad fields already carry the
    weekly statline). `deltas_24h` is keyed by epic_account_id; value is
    (d_matches, d_wins, d_kills, period_kd) — recent dynamics inside the week.
    `weekly_missing` lists players without a weekly baseline so the LLM is told
    not to judge them.
    """
    total_matches, total_wins, total_kills, team_kd, team_win_rate = aggregates
    lines: list[str] = ["Статистика ТОЛЬКО за последние 7 дней (свежая форма, не за сезон).", ""]
    lines.append(f"Игроков: {len(successes)}")
    lines.append(
        f"За неделю (squad): {total_matches} матчей, {total_wins} побед "
        f"({team_win_rate * 100:.1f}%), {total_kills} киллов, K/D {team_kd:.2f}"
    )
    if mvp is not None:
        link, s = mvp
        name = link.user_name or s.epic_name
        m, w, k, kd = _squad_totals(s)
        lines.append(f"MVP недели: {name} — {m}M, {w}W, {k}K, K/D {kd:.2f}")
    if leaders:
        lines.append("Топ недели:")
        for i, (link, s) in enumerate(leaders, 1):
            name = link.user_name or s.epic_name
            m, w, k, kd = _squad_totals(s)
            lines.append(f"{i}. {name} {m}M {w}W {k}K K/D {kd:.2f}")
    if deltas_24h:
        lines.extend(_format_delta_block("Динамика за 24ч (squad):", successes, deltas_24h))
    if weekly_missing:
        names = ", ".join(link.user_name or "?" for link, _ in weekly_missing)
        lines.append(f"Без недельных данных (НЕ оценивай и не упоминай как слабых): {names}")
    return "\n".join(lines)


def build_team_fn_stats_text(
    successes: list[tuple[EpicLink, PlayerStats]],
    failures: list[tuple[EpicLink, FortniteError]],
    *,
    weekly_missing: list[tuple[EpicLink, str]] | None = None,
    deltas_24h: dict[str, tuple[int, int, int, float]] | None = None,
) -> tuple[str, str]:
    """Return (html_text, plain_facts) for /teamstats.

    All numbers are for the LAST 7 DAYS only: the caller passes successes whose
    `squad` field already holds each player's weekly statline (see
    `_build_weekly_view`). The HTML text is the formatted Telegram message;
    `plain_facts` is a compact plain-text fact sheet for feeding into an LLM
    (no HTML, no emojis). `plain_facts` is empty when there are no entries.

    `weekly_missing` lists (link, reason) for players without a weekly baseline
    snapshot; they are shown in a separate section and excluded from the ranking.
    `deltas_24h` is an optional dict keyed by epic_account_id, passed through to
    `_build_team_facts` for the intra-week recency block; it never affects HTML.
    """
    from bot.fortnite import EpicNameNotFound, FortniteUnavailable, StatsEmpty, StatsPrivate

    facts = ""
    n = len(successes)
    lines: list[str] = [
        f"\U0001f3c6 <b>Fortnite Squad</b> — {n} {_plural_players(n)} · за неделю",
    ]

    if not successes:
        lines.append("")
        lines.append("Не удалось получить ни одну статистику.")
    else:
        aggregates = _team_aggregate(successes)
        total_matches, total_wins, total_kills, team_kd, team_win_rate = aggregates
        mvp = _mvp(successes)
        leaders_ranked = sorted(successes, key=lambda x: (-x[1].overall.wins, -x[1].overall.kills))[:5]

        # MVP block — judged by squad performance over the last 7 days.
        if mvp is not None:
            link, s = mvp
            mvp_m, mvp_w, mvp_k, mvp_kd = _squad_totals(s)
            user_label = _user_code(link.user_name or s.epic_name)
            lines.append("")
            lines.append(f"\U0001f947 <b>MVP недели</b>: {user_label}")
            lines.append(f"   \U0001f3af {mvp_w}W · \U0001f4a5 {mvp_k}K · ⚔️ {mvp_kd:.2f} K/D · \U0001f3ae {mvp_m}M")

        # Summary
        lines.append("")
        lines.append(_TEAM_DIVIDER)
        lines.append("\U0001f4ca <b>Сводка за неделю</b>")
        lines.append(f"• \U0001f3ae {total_matches} матчей  ·  \U0001f3c6 {total_wins}W ({team_win_rate * 100:.1f}%)")
        lines.append(f"• \U0001f4a5 {total_kills} киллов  ·  ⚔️ K/D {team_kd:.2f}")

        # Leaders table
        lines.append(_TEAM_DIVIDER)
        lines.append("\U0001f3c5 <b>Лидеры недели</b>")
        lines.append(_leaders_pre_table(successes, limit=5))

        # Players without a weekly baseline (new accounts / no week-old snapshot)
        # or who didn't play this week — shown with a marker, not judged.
        if weekly_missing:
            body = [f"   {_user_code(link.user_name or '?')} — {reason}" for link, reason in weekly_missing]
            _section(lines, "\U0001f4a4 <b>Вне недельного зачёта</b>", body)

        # Per-mode lines are intentionally dropped: this bot focuses on squad
        # only, and the MVP + leaders table already convey the squad picture.

        facts = _build_team_facts(
            successes,
            aggregates,
            mvp,
            leaders_ranked,
            weekly_missing=weekly_missing,
            deltas_24h=deltas_24h,
        )

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
            names = ", ".join(_user_code(link.user_name) for link in private)
            body.append(f"   \U0001f512 Приватный профиль: {names}")
        if empty:
            names = ", ".join(_user_code(link.user_name) for link in empty)
            body.append(f"   \U0001f4ad Без матчей: {names}")
        if not_found:
            names = ", ".join(_user_code(link.user_name) for link in not_found)
            body.append(f"   \U0001f47b Не найден: {names}")
        if unavailable:
            names = ", ".join(_user_code(link.user_name) for link in unavailable)
            body.append(f"   \U0001f6ab API недоступен: {names}")
        _section(lines, "⚠️ <b>Без данных</b>", body)

    return "\n".join(lines), facts


def _slot_button_label(token: str) -> str:
    if token == NOW_SLOT:
        return "⚡ Сейчас"
    if token.isdigit():
        minutes = int(token)
        return f"\U0001f550 +{minutes // 60}ч" if minutes % 60 == 0 else f"\U0001f550 +{minutes}м"
    # Legacy absolute "HH:MM" token (/fort <hour> pin, or a pre-deploy session).
    return f"\U0001f550 {token}"


def build_keyboard(go_count: int, time_slots: list[str] | None = None) -> InlineKeyboardMarkup:
    if time_slots:
        slot_buttons = [
            InlineKeyboardButton(
                text=_slot_button_label(slot),
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
