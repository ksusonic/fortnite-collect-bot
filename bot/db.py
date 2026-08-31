from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

SCHEMA_VERSION = "20260901000000"
DATABASE_URL = os.getenv("DATABASE_URL")
_pool: AsyncConnectionPool | None = None

sessions: dict[int, Session] = {}


@dataclass
class Session:
    chat_id: int
    message_id: int
    initiator_id: int
    initiator_name: str
    go_players: dict[int, str] = field(default_factory=dict)
    pass_players: dict[int, str] = field(default_factory=dict)
    is_complete: bool = False
    is_expired: bool = False
    is_closed: bool = False
    style: int = 0
    created_at: float = field(default_factory=time.time)
    completed_at: float | None = None
    time_slots: list[str] = field(default_factory=list)
    player_slots: dict[int, str] = field(default_factory=dict)  # user_id -> slot
    tagged_users: dict[int, str] = field(default_factory=dict)  # user_id -> name
    llm_header: str | None = None  # Grok-generated gather header; falls back to style.header


async def init_db() -> None:
    global _pool
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required")
    pool_min = int(os.getenv("DATABASE_POOL_MIN", "1"))
    pool_max = int(os.getenv("DATABASE_POOL_MAX", "4"))
    timeout = int(os.getenv("DATABASE_CONNECT_TIMEOUT", "10"))
    if pool_min < 1 or pool_max < pool_min:
        raise RuntimeError("invalid database pool size")
    _pool = AsyncConnectionPool(
        DATABASE_URL,
        min_size=pool_min,
        max_size=pool_max,
        timeout=timeout,
        open=False,
        kwargs={
            "connect_timeout": timeout,
            "row_factory": dict_row,
            "sslmode": os.getenv("DATABASE_SSLMODE", "require"),
            "options": "-c search_path=fortnite_bot,public -c application_name=fortnite-collect-bot",
        },
    )
    try:
        await _pool.open(wait=True, timeout=timeout)
        async with _pool.connection() as connection:
            row = await (
                await connection.execute("SELECT version FROM fortnite_bot.schema_version WHERE singleton")
            ).fetchone()
            if not row or row["version"] != SCHEMA_VERSION:
                raise RuntimeError(f"database migration {SCHEMA_VERSION} is not applied")
    except Exception:
        await close_db()
        raise


async def close_db() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def _connection():
    if _pool is None:
        raise RuntimeError("database pool is not initialized")
    async with _pool.connection() as connection:
        yield connection


def _datetime(value: float | None) -> datetime | None:
    return datetime.fromtimestamp(value, UTC) if value is not None else None


def _timestamp(value: datetime | None) -> float | None:
    return value.timestamp() if value is not None else None


async def save_session(session: Session) -> None:
    async with _connection() as db:
        await db.execute(
            """INSERT INTO sessions
               (message_id, chat_id, initiator_id, initiator_name, is_complete, is_expired, is_closed,
                style, created_at, completed_at, time_slots, tag_line, llm_header)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT(message_id) DO UPDATE SET chat_id=excluded.chat_id,initiator_id=excluded.initiator_id,
               initiator_name=excluded.initiator_name,is_complete=excluded.is_complete,is_expired=excluded.is_expired,
               is_closed=excluded.is_closed,style=excluded.style,created_at=excluded.created_at,
               completed_at=excluded.completed_at,time_slots=excluded.time_slots,tag_line=excluded.tag_line,
               llm_header=excluded.llm_header""",
            (
                session.message_id,
                session.chat_id,
                session.initiator_id,
                session.initiator_name,
                session.is_complete,
                session.is_expired,
                session.is_closed,
                session.style,
                _datetime(session.created_at),
                _datetime(session.completed_at),
                Jsonb(session.time_slots),
                Jsonb({str(k): v for k, v in session.tagged_users.items()}),
                session.llm_header,
            ),
        )
        await db.commit()


async def save_response(
    message_id: int,
    user_id: int,
    user_name: str,
    response: str,
    time_slot: str | None = None,
    is_bot: bool = False,
    became_complete: bool = False,
) -> None:
    async with _connection() as db:
        now = datetime.now(UTC)
        await db.execute(
            """INSERT INTO responses
               (message_id, user_id, user_name, response, responded_at, time_slot, is_bot, joined_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT(message_id, user_id) DO UPDATE SET
                   user_name = excluded.user_name,
                   response = excluded.response,
                   responded_at = excluded.responded_at,
                   time_slot = excluded.time_slot,
                   is_bot = excluded.is_bot,
                   joined_at = CASE
                       WHEN excluded.response = 'pass' THEN NULL
                       WHEN responses.response = 'go' THEN responses.joined_at
                       ELSE excluded.joined_at
                   END""",
            (
                message_id,
                user_id,
                user_name,
                response,
                now,
                time_slot,
                is_bot,
                now if response == "go" else None,
            ),
        )
        if became_complete:
            await db.execute(
                """UPDATE sessions SET is_complete = true,
                   completed_at = COALESCE(completed_at, %s) WHERE message_id = %s""",
                (now, message_id),
            )
        await db.commit()


async def load_session(message_id: int) -> Session | None:
    async with _connection() as db:
        cursor = await db.execute("SELECT * FROM sessions WHERE message_id = %s", (message_id,))
        row = await cursor.fetchone()
        if row is None:
            return None

        raw_slots = row["time_slots"] if "time_slots" in row.keys() else None
        time_slots = raw_slots if isinstance(raw_slots, list) else []
        raw_tag = row["tag_line"] if "tag_line" in row.keys() else None
        try:
            tagged_users = {int(k): v for k, v in raw_tag.items()} if isinstance(raw_tag, dict) else {}
        except ValueError, AttributeError:
            tagged_users = {}

        llm_header = row["llm_header"] if "llm_header" in row.keys() else None

        session = Session(
            chat_id=row["chat_id"],
            message_id=row["message_id"],
            initiator_id=row["initiator_id"],
            initiator_name=row["initiator_name"],
            is_complete=bool(row["is_complete"]),
            is_expired=bool(row["is_expired"]),
            is_closed=bool(row["is_closed"]) if "is_closed" in row.keys() else bool(row["is_complete"]),
            style=row["style"],
            created_at=_timestamp(row["created_at"]),
            completed_at=_timestamp(row["completed_at"]),
            time_slots=time_slots,
            tagged_users=tagged_users,
            llm_header=llm_header,
        )

        cursor = await db.execute(
            """SELECT user_id, user_name, response, time_slot FROM responses
               WHERE message_id = %s
               ORDER BY CASE WHEN joined_at IS NULL THEN 1 ELSE 0 END, joined_at, responded_at""",
            (message_id,),
        )
        async for resp_row in cursor:
            if resp_row["response"] == "go":
                session.go_players[resp_row["user_id"]] = resp_row["user_name"]
                slot = resp_row["time_slot"]
                if slot:
                    session.player_slots[resp_row["user_id"]] = slot
            else:
                session.pass_players[resp_row["user_id"]] = resp_row["user_name"]

        return session


async def mark_complete(message_id: int) -> None:
    async with _connection() as db:
        await db.execute(
            "UPDATE sessions SET is_complete = true, completed_at = COALESCE(completed_at, %s) WHERE message_id = %s",
            (datetime.now(UTC), message_id),
        )
        await db.commit()


async def mark_expired(message_id: int) -> None:
    async with _connection() as db:
        await db.execute(
            "UPDATE sessions SET is_closed = true, is_expired = true WHERE message_id = %s",
            (message_id,),
        )
        await db.commit()


async def mark_closed(message_id: int) -> None:
    """Close a live session without turning a previously filled squad into a failure."""
    async with _connection() as db:
        await db.execute("UPDATE sessions SET is_closed = true WHERE message_id = %s", (message_id,))
        await db.commit()


@dataclass
class ChatStats:
    total_sessions: int = 0
    completed_sessions: int = 0
    expired_sessions: int = 0
    active_sessions: int = 0
    top_players: list[tuple[str, int]] = field(default_factory=list)  # (name, go_count)
    top_initiators: list[tuple[str, int]] = field(default_factory=list)  # (name, session_count)
    top_passers: list[tuple[str, int]] = field(default_factory=list)  # (name, pass_count)
    avg_fill_seconds: float | None = None
    fastest_fill_seconds: float | None = None
    top_streaks: list[tuple[str, int]] = field(default_factory=list)  # (name, streak)
    best_hours: list[tuple[int, int, float | None]] = field(default_factory=list)  # (hour, count, avg_fill_sec)


async def get_chat_stats(chat_id: int) -> ChatStats:
    stats = ChatStats()
    async with _connection() as db:
        # Session counts
        cur = await db.execute("SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = %s", (chat_id,))
        stats.total_sessions = (await cur.fetchone())["cnt"]

        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = %s AND is_complete AND NOT is_expired",
            (chat_id,),
        )
        stats.completed_sessions = (await cur.fetchone())["cnt"]

        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = %s AND is_closed AND is_expired",
            (chat_id,),
        )
        stats.expired_sessions = (await cur.fetchone())["cnt"]

        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = %s AND NOT is_closed",
            (chat_id,),
        )
        stats.active_sessions = (await cur.fetchone())["cnt"]

        # Top players (most "go" responses in this chat)
        cur = await db.execute(
            """SELECT user_name,cnt FROM (
               SELECT DISTINCT ON (r.user_id) r.user_id,r.user_name,r.responded_at,
                      count(*) OVER (PARTITION BY r.user_id) cnt
               FROM responses r
               JOIN sessions s ON r.message_id = s.message_id
               WHERE s.chat_id = %s AND r.response = 'go'
               ORDER BY r.user_id,r.responded_at DESC
               ) latest ORDER BY cnt DESC,user_id
               LIMIT 10""",
            (chat_id,),
        )
        stats.top_players = [(row["user_name"], row["cnt"]) for row in await cur.fetchall()]

        # Top initiators
        cur = await db.execute(
            """SELECT initiator_name,cnt FROM (
               SELECT DISTINCT ON (initiator_id) initiator_id,initiator_name,created_at,
                      count(*) OVER (PARTITION BY initiator_id) cnt FROM sessions
               WHERE chat_id = %s
               ORDER BY initiator_id,created_at DESC
               ) latest ORDER BY cnt DESC,initiator_id
               LIMIT 5""",
            (chat_id,),
        )
        stats.top_initiators = [(row["initiator_name"], row["cnt"]) for row in await cur.fetchall()]

        # Top passers
        cur = await db.execute(
            """SELECT user_name,cnt FROM (
               SELECT DISTINCT ON (r.user_id) r.user_id,r.user_name,r.responded_at,
                      count(*) OVER (PARTITION BY r.user_id) cnt
               FROM responses r
               JOIN sessions s ON r.message_id = s.message_id
               WHERE s.chat_id = %s AND r.response = 'pass'
               ORDER BY r.user_id,r.responded_at DESC
               ) latest ORDER BY cnt DESC,user_id
               LIMIT 5""",
            (chat_id,),
        )
        stats.top_passers = [(row["user_name"], row["cnt"]) for row in await cur.fetchall()]

        # Average and fastest fill time (only completed, non-expired sessions with completed_at)
        cur = await db.execute(
            """SELECT extract(epoch from AVG(completed_at - created_at)) as avg_t,
                      extract(epoch from MIN(completed_at - created_at)) as min_t
               FROM sessions
               WHERE chat_id = %s AND is_complete AND NOT is_expired AND completed_at IS NOT NULL""",
            (chat_id,),
        )
        row = await cur.fetchone()
        if row and row["avg_t"] is not None:
            stats.avg_fill_seconds = row["avg_t"]
            stats.fastest_fill_seconds = row["min_t"]

        # Streaks
        cur = await db.execute(
            """SELECT message_id FROM sessions
               WHERE chat_id = %s AND is_complete AND NOT is_expired
               ORDER BY created_at DESC""",
            (chat_id,),
        )
        completed_ids = [row["message_id"] for row in await cur.fetchall()]

        if completed_ids:
            cur = await db.execute(
                """SELECT message_id, user_id, user_name FROM responses
                    WHERE message_id = ANY(%s) AND response = 'go'""",
                (completed_ids,),
            )
            go_by_session: dict[int, set[int]] = {mid: set() for mid in completed_ids}
            user_names: dict[int, str] = {}
            for row in await cur.fetchall():
                go_by_session[row["message_id"]].add(row["user_id"])
                user_names[row["user_id"]] = row["user_name"]

            active = dict.fromkeys(go_by_session[completed_ids[0]], 1)
            for mid in completed_ids[1:]:
                go_users = go_by_session[mid]
                active = {uid: cnt + 1 for uid, cnt in active.items() if uid in go_users}
                if not active:
                    break

            stats.top_streaks = sorted(
                [(user_names[uid], cnt) for uid, cnt in active.items()],
                key=lambda x: -x[1],
            )[:3]

        # Best hours
        cur = await db.execute(
            """SELECT extract(hour from created_at AT TIME ZONE 'Europe/Moscow')::integer AS hour,
                      COUNT(*) AS cnt,
                      extract(epoch from AVG(completed_at - created_at)) AS avg_fill
               FROM sessions
               WHERE chat_id = %s AND is_complete AND NOT is_expired AND completed_at IS NOT NULL
               GROUP BY 1
               ORDER BY cnt DESC, avg_fill ASC
               LIMIT 2""",
            (chat_id,),
        )
        stats.best_hours = [(row["hour"], row["cnt"], row["avg_fill"]) for row in await cur.fetchall()]

    return stats


async def get_chat_participants(chat_id: int) -> list[tuple[int, str]]:
    """Return mentionable previous 'go' responders in this chat, most recent first."""
    async with _connection() as db:
        cursor = await db.execute(
            """SELECT user_id,user_name FROM (
               SELECT DISTINCT ON (r.user_id) r.user_id,r.user_name,r.responded_at
               FROM responses r
               JOIN sessions s ON r.message_id = s.message_id
               WHERE s.chat_id = %s AND r.response = 'go' AND NOT r.is_bot
                 AND NOT EXISTS (
                     SELECT 1 FROM afk_mutes a
                     WHERE a.chat_id = s.chat_id
                       AND a.user_id = r.user_id
                       AND a.muted_until > %s
                 )
               ORDER BY r.user_id,r.responded_at DESC
               ) recent ORDER BY responded_at DESC
               LIMIT 20""",
            (chat_id, datetime.now(UTC)),
        )
        return [(row["user_id"], row["user_name"]) for row in await cursor.fetchall()]


async def set_afk(chat_id: int, user_id: int, muted_until: float) -> None:
    async with _connection() as db:
        await db.execute(
            """INSERT INTO afk_mutes (chat_id,user_id,muted_until) VALUES (%s,%s,%s)
               ON CONFLICT(chat_id,user_id) DO UPDATE SET muted_until=excluded.muted_until""",
            (chat_id, user_id, _datetime(muted_until)),
        )
        await db.commit()


async def clear_afk(chat_id: int, user_id: int) -> None:
    async with _connection() as db:
        await db.execute("DELETE FROM afk_mutes WHERE chat_id = %s AND user_id = %s", (chat_id, user_id))
        await db.commit()


async def get_afk_until(chat_id: int, user_id: int) -> float | None:
    async with _connection() as db:
        cursor = await db.execute(
            "SELECT muted_until FROM afk_mutes WHERE chat_id = %s AND user_id = %s",
            (chat_id, user_id),
        )
        row = await cursor.fetchone()
        return _timestamp(row["muted_until"]) if row else None


async def get_active_chat_ids(days: int = 14) -> list[int]:
    cutoff = time.time() - days * 86400
    async with _connection() as db:
        cursor = await db.execute("SELECT DISTINCT chat_id FROM sessions WHERE created_at > %s", (_datetime(cutoff),))
        return [row["chat_id"] for row in await cursor.fetchall()]


async def is_feature_enabled(chat_id: int, feature: str) -> bool:
    async with _connection() as db:
        cursor = await db.execute(
            "SELECT enabled FROM chat_features WHERE chat_id = %s AND feature = %s",
            (chat_id, feature),
        )
        row = await cursor.fetchone()
        return bool(row and row["enabled"])


async def set_feature(chat_id: int, feature: str, enabled: bool, value: float | None = None) -> None:
    async with _connection() as db:
        await db.execute(
            """INSERT INTO chat_features(chat_id,feature,enabled,value) VALUES(%s,%s,%s,%s)
               ON CONFLICT(chat_id,feature) DO UPDATE SET enabled=excluded.enabled,value=excluded.value""",
            (chat_id, feature, enabled, value),
        )
        await db.commit()


async def get_feature_value(chat_id: int, feature: str) -> float | None:
    async with _connection() as db:
        cursor = await db.execute(
            "SELECT value FROM chat_features WHERE chat_id = %s AND feature = %s",
            (chat_id, feature),
        )
        row = await cursor.fetchone()
        return row["value"] if row and row["value"] is not None else None


async def save_roast_state(
    chat_id: int,
    history_payload: list[dict] | None,
    roast_msg_ids: list[int] | None,
    last_roast: float | None,
) -> None:
    async with _connection() as db:
        await db.execute(
            """INSERT INTO roast_state(chat_id,history_json,roast_msgs_json,last_roast) VALUES(%s,%s,%s,%s)
               ON CONFLICT(chat_id) DO UPDATE SET history_json=excluded.history_json,
               roast_msgs_json=excluded.roast_msgs_json,last_roast=excluded.last_roast""",
            (
                chat_id,
                Jsonb(history_payload or []),
                Jsonb(roast_msg_ids or []),
                _datetime(last_roast),
            ),
        )
        await db.commit()


async def load_all_roast_state() -> list[tuple[int, list[dict], list[int], float | None]]:
    result: list[tuple[int, list[dict], list[int], float | None]] = []
    async with _connection() as db:
        cursor = await db.execute("SELECT chat_id, history_json, roast_msgs_json, last_roast FROM roast_state")
        rows = await cursor.fetchall()
    for row in rows:
        try:
            history = row["history_json"] if isinstance(row["history_json"], list) else []
        except ValueError, TypeError:
            history = []
        try:
            msgs = row["roast_msgs_json"] if isinstance(row["roast_msgs_json"], list) else []
        except ValueError, TypeError:
            msgs = []
        result.append((row["chat_id"], history, msgs, _timestamp(row["last_roast"])))
    return result


async def load_active_sessions() -> list[Session]:
    result: list[Session] = []
    async with _connection() as db:
        cursor = await db.execute("SELECT message_id FROM sessions WHERE NOT is_closed")
        rows = await cursor.fetchall()

    for row in rows:
        session = await load_session(row["message_id"])
        if session is not None:
            result.append(session)
    return result


@dataclass
class EpicLink:
    chat_id: int
    user_id: int
    user_name: str
    epic_name: str
    epic_account_id: str
    linked_at: float


async def save_epic_link(
    chat_id: int,
    user_id: int,
    user_name: str,
    epic_name: str,
    epic_account_id: str,
) -> None:
    async with _connection() as db:
        await db.execute(
            """INSERT INTO epic_links
               (chat_id, user_id, user_name, epic_name, epic_account_id, linked_at)
               VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT(chat_id,user_id) DO UPDATE SET
               user_name=excluded.user_name,epic_name=excluded.epic_name,
               epic_account_id=excluded.epic_account_id,linked_at=excluded.linked_at""",
            (chat_id, user_id, user_name, epic_name, epic_account_id, datetime.now(UTC)),
        )
        await db.commit()


async def get_epic_link(chat_id: int, user_id: int) -> EpicLink | None:
    async with _connection() as db:
        cursor = await db.execute(
            "SELECT * FROM epic_links WHERE chat_id = %s AND user_id = %s",
            (chat_id, user_id),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return EpicLink(
            chat_id=row["chat_id"],
            user_id=row["user_id"],
            user_name=row["user_name"],
            epic_name=row["epic_name"],
            epic_account_id=row["epic_account_id"],
            linked_at=_timestamp(row["linked_at"]),
        )


async def get_chat_epic_links(chat_id: int) -> list[EpicLink]:
    async with _connection() as db:
        cursor = await db.execute(
            "SELECT * FROM epic_links WHERE chat_id = %s ORDER BY linked_at ASC",
            (chat_id,),
        )
        rows = await cursor.fetchall()
    return [
        EpicLink(
            chat_id=row["chat_id"],
            user_id=row["user_id"],
            user_name=row["user_name"],
            epic_name=row["epic_name"],
            epic_account_id=row["epic_account_id"],
            linked_at=_timestamp(row["linked_at"]),
        )
        for row in rows
    ]


@dataclass(frozen=True)
class SquadSnapshot:
    epic_account_id: str
    fetched_at: float
    matches: int
    wins: int
    kills: int
    deaths_est: int
    kd: float
    # Overall (all modes) — added when the weekly view moved off squad-only.
    # NULL for rows written before that migration.
    overall_matches: int | None = None
    overall_wins: int | None = None
    overall_kills: int | None = None
    overall_deaths_est: int | None = None
    overall_kd: float | None = None


async def save_squad_snapshot(
    epic_account_id: str,
    fetched_at: float,
    matches: int,
    wins: int,
    kills: int,
    deaths_est: int,
    kd: float,
    overall_matches: int | None = None,
    overall_wins: int | None = None,
    overall_kills: int | None = None,
    overall_deaths_est: int | None = None,
    overall_kd: float | None = None,
) -> None:
    async with _connection() as db:
        await db.execute(
            """INSERT INTO squad_snapshots
               (epic_account_id, fetched_at, matches, wins, kills, deaths_est, kd,
                overall_matches, overall_wins, overall_kills, overall_deaths_est, overall_kd)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT(epic_account_id,fetched_at) DO UPDATE SET matches=excluded.matches,
               wins=excluded.wins,kills=excluded.kills,deaths_est=excluded.deaths_est,kd=excluded.kd,
               overall_matches=excluded.overall_matches,overall_wins=excluded.overall_wins,
               overall_kills=excluded.overall_kills,overall_deaths_est=excluded.overall_deaths_est,
               overall_kd=excluded.overall_kd""",
            (
                epic_account_id,
                _datetime(fetched_at),
                matches,
                wins,
                kills,
                deaths_est,
                kd,
                overall_matches,
                overall_wins,
                overall_kills,
                overall_deaths_est,
                overall_kd,
            ),
        )
        await db.commit()


async def get_snapshot_before(
    epic_account_id: str, cutoff_ts: float, floor_ts: float | None = None
) -> SquadSnapshot | None:
    """Closest snapshot at or before cutoff_ts. If floor_ts is given, the
    snapshot must also be no older than floor_ts — so a sparse history can't
    silently stretch the "last 7 days" window into several weeks."""
    async with _connection() as db:
        sql = (
            "SELECT epic_account_id, fetched_at, matches, wins, kills, deaths_est, kd, "
            "overall_matches, overall_wins, overall_kills, overall_deaths_est, overall_kd "
            "FROM squad_snapshots WHERE epic_account_id = %s AND fetched_at <= %s"
        )
        params: list = [epic_account_id, _datetime(cutoff_ts)]
        if floor_ts is not None:
            sql += " AND fetched_at >= %s"
            params.append(_datetime(floor_ts))
        sql += " ORDER BY fetched_at DESC LIMIT 1"
        cursor = await db.execute(sql, params)
        row = await cursor.fetchone()
        if row is None:
            return None
        return SquadSnapshot(
            epic_account_id=row["epic_account_id"],
            fetched_at=_timestamp(row["fetched_at"]),
            matches=row["matches"],
            wins=row["wins"],
            kills=row["kills"],
            deaths_est=row["deaths_est"],
            kd=row["kd"],
            overall_matches=row["overall_matches"],
            overall_wins=row["overall_wins"],
            overall_kills=row["overall_kills"],
            overall_deaths_est=row["overall_deaths_est"],
            overall_kd=row["overall_kd"],
        )


async def cleanup_old_snapshots(older_than_days: int = 30) -> int:
    cutoff = time.time() - older_than_days * 86400
    async with _connection() as db:
        cursor = await db.execute(
            "DELETE FROM squad_snapshots WHERE fetched_at < %s",
            (_datetime(cutoff),),
        )
        await db.commit()
        return cursor.rowcount


async def get_chats_with_epic_links() -> list[int]:
    async with _connection() as db:
        cursor = await db.execute("SELECT DISTINCT chat_id FROM epic_links")
        return [row["chat_id"] for row in await cursor.fetchall()]


async def get_last_weekly_drop(chat_id: int) -> float | None:
    return await get_feature_value(chat_id, "weekly_drop")


async def set_last_weekly_drop(chat_id: int, ts: float) -> None:
    await set_feature(chat_id, "weekly_drop", enabled=True, value=ts)


async def resolve_user_by_username(chat_id: int, username_with_at: str) -> tuple[int, str] | None:
    async with _connection() as db:
        cursor = await db.execute(
            """SELECT r.user_id, r.user_name
               FROM responses r JOIN sessions s ON r.message_id = s.message_id
               WHERE s.chat_id = %s AND LOWER(r.user_name) = LOWER(%s) AND NOT r.is_bot
               ORDER BY r.responded_at DESC LIMIT 1""",
            (chat_id, username_with_at),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return row["user_id"], row["user_name"]
