from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

from bot.storage import ContextMap, Jsonb, database, migrate, timestamp
from bot.storage import chat_id as current_chat_id

sessions = ContextMap("sessions")


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
    fort_title: str | None = None


async def init_db() -> None:
    await migrate()


async def get_fort_title(chat_id: int) -> str | None:
    async with database() as db:
        cursor = await db.execute("SELECT title FROM chat_fort_titles WHERE chat_id = %s", (chat_id,))
        row = await cursor.fetchone()
        return row[0] if row else None


async def set_fort_title(chat_id: int, title: str | None) -> None:
    async with database() as db:
        if title is None:
            await db.execute("DELETE FROM chat_fort_titles WHERE chat_id = %s", (chat_id,))
        else:
            await db.execute(
                """INSERT INTO chat_fort_titles (chat_id, title) VALUES (%s, %s) ON CONFLICT (chat_id) DO UPDATE SET
                title = excluded.title""",
                (chat_id, title),
            )
        await db.commit()


async def save_session(session: Session) -> None:
    async with database() as db:
        await db.execute(
            """INSERT INTO sessions (message_id, chat_id, initiator_id, initiator_name, is_complete, is_expired,
            is_closed, style, created_at, completed_at, time_slots, tag_line, llm_header,
            fort_title) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT
            (chat_id, message_id) DO UPDATE SET initiator_id = excluded.initiator_id, initiator_name
            = excluded.initiator_name, is_complete = excluded.is_complete, is_expired =
            excluded.is_expired, is_closed = excluded.is_closed, style = excluded.style, created_at
            = excluded.created_at, completed_at = excluded.completed_at, time_slots =
            excluded.time_slots, tag_line = excluded.tag_line, llm_header = excluded.llm_header,
            fort_title = excluded.fort_title""",
            (
                session.message_id,
                session.chat_id,
                session.initiator_id,
                session.initiator_name,
                session.is_complete,
                session.is_expired,
                session.is_closed,
                session.style,
                timestamp(session.created_at),
                timestamp(session.completed_at),
                Jsonb(session.time_slots),
                Jsonb({str(k): v for k, v in session.tagged_users.items()}),
                session.llm_header,
                session.fort_title,
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
    chat_id: int | None = None,
) -> None:
    chat_id = current_chat_id(chat_id)
    async with database() as db:
        now = time.time()
        await db.execute(
            """INSERT INTO responses
               (chat_id, message_id, user_id, user_name, response, responded_at, time_slot, is_bot, joined_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT(chat_id, message_id, user_id) DO UPDATE SET
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
                chat_id,
                message_id,
                user_id,
                user_name,
                response,
                timestamp(now),
                time_slot,
                is_bot,
                timestamp(now) if response == "go" else None,
            ),
        )
        if became_complete:
            await db.execute(
                """UPDATE sessions SET is_complete = true, completed_at = COALESCE(completed_at, %s) WHERE chat_id = %s
                AND message_id = %s""",
                (timestamp(now), chat_id, message_id),
            )
        await db.commit()


async def load_session(message_id: int, chat_id: int | None = None) -> Session | None:
    chat_id = current_chat_id(chat_id)
    async with database() as db:
        cursor = await db.execute(
            "SELECT * FROM sessions WHERE chat_id = %s AND message_id = %s", (chat_id, message_id)
        )
        row = await cursor.fetchone()
        if row is None:
            return None

        raw_slots = row["time_slots"] if "time_slots" in row.keys() else None
        time_slots = json.loads(raw_slots) if raw_slots else []
        raw_tag = row["tag_line"] if "tag_line" in row.keys() else None
        try:
            tagged_users = {int(k): v for k, v in json.loads(raw_tag).items()} if raw_tag else {}
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
            created_at=row["created_at"],
            completed_at=row["completed_at"],
            time_slots=time_slots,
            tagged_users=tagged_users,
            llm_header=llm_header,
            fort_title=row["fort_title"] if "fort_title" in row.keys() else None,
        )

        cursor = await db.execute(
            """SELECT user_id, user_name, response, time_slot FROM responses
               WHERE chat_id = %s AND message_id = %s
               ORDER BY CASE WHEN joined_at IS NULL THEN 1 ELSE 0 END, joined_at, responded_at""",
            (chat_id, message_id),
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


async def mark_complete(message_id: int, chat_id: int | None = None) -> None:
    chat_id = current_chat_id(chat_id)
    async with database() as db:
        await db.execute(
            """UPDATE sessions SET is_complete = true, completed_at = COALESCE(completed_at, %s) WHERE chat_id = %s
            AND message_id = %s""",
            (timestamp(time.time()), chat_id, message_id),
        )
        await db.commit()


async def mark_expired(message_id: int, chat_id: int | None = None) -> None:
    chat_id = current_chat_id(chat_id)
    async with database() as db:
        await db.execute(
            "UPDATE sessions SET is_closed = true, is_expired = true WHERE chat_id = %s AND message_id = %s",
            (chat_id, message_id),
        )
        await db.commit()


async def mark_closed(message_id: int, chat_id: int | None = None) -> None:
    """Close a live session without turning a previously filled squad into a failure."""
    chat_id = current_chat_id(chat_id)
    async with database() as db:
        await db.execute(
            "UPDATE sessions SET is_closed = true WHERE chat_id = %s AND message_id = %s", (chat_id, message_id)
        )
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
    async with database() as db:
        # Session counts
        cur = await db.execute("SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = %s", (chat_id,))
        stats.total_sessions = (await cur.fetchone())["cnt"]

        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = %s AND is_complete = true AND is_expired = false",
            (chat_id,),
        )
        stats.completed_sessions = (await cur.fetchone())["cnt"]

        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = %s AND is_closed = true AND is_expired = true",
            (chat_id,),
        )
        stats.expired_sessions = (await cur.fetchone())["cnt"]

        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = %s AND is_closed = false",
            (chat_id,),
        )
        stats.active_sessions = (await cur.fetchone())["cnt"]

        # Top players (most "go" responses in this chat)
        cur = await db.execute(
            """SELECT (array_agg(r.user_name ORDER BY r.responded_at DESC))[1] AS user_name, COUNT(*) as cnt
               FROM responses r
               JOIN sessions s ON r.chat_id = s.chat_id AND r.message_id = s.message_id
               WHERE s.chat_id = %s AND r.response = 'go'
               GROUP BY r.user_id
               ORDER BY cnt DESC
               LIMIT 10""",
            (chat_id,),
        )
        stats.top_players = [(row["user_name"], row["cnt"]) for row in await cur.fetchall()]

        # Top initiators
        cur = await db.execute(
            """SELECT (array_agg(initiator_name ORDER BY created_at DESC))[1] AS initiator_name, COUNT(*) as cnt
               FROM sessions
               WHERE chat_id = %s
               GROUP BY initiator_id
               ORDER BY cnt DESC
               LIMIT 5""",
            (chat_id,),
        )
        stats.top_initiators = [(row["initiator_name"], row["cnt"]) for row in await cur.fetchall()]

        # Top passers
        cur = await db.execute(
            """SELECT (array_agg(r.user_name ORDER BY r.responded_at DESC))[1] AS user_name, COUNT(*) as cnt
               FROM responses r
               JOIN sessions s ON r.chat_id = s.chat_id AND r.message_id = s.message_id
               WHERE s.chat_id = %s AND r.response = 'pass'
               GROUP BY r.user_id
               ORDER BY cnt DESC
               LIMIT 5""",
            (chat_id,),
        )
        stats.top_passers = [(row["user_name"], row["cnt"]) for row in await cur.fetchall()]

        # Average and fastest fill time (only completed, non-expired sessions with completed_at)
        cur = await db.execute(
            """SELECT AVG(EXTRACT(EPOCH FROM completed_at - created_at)) as avg_t,
                      MIN(EXTRACT(EPOCH FROM completed_at - created_at)) as min_t
               FROM sessions
               WHERE chat_id = %s AND is_complete = true AND is_expired = false AND completed_at IS NOT NULL""",
            (chat_id,),
        )
        row = await cur.fetchone()
        if row and row["avg_t"] is not None:
            stats.avg_fill_seconds = row["avg_t"]
            stats.fastest_fill_seconds = row["min_t"]

        # Streaks
        cur = await db.execute(
            """SELECT message_id FROM sessions
               WHERE chat_id = %s AND is_complete = true AND is_expired = false
               ORDER BY created_at DESC""",
            (chat_id,),
        )
        completed_ids = [row["message_id"] for row in await cur.fetchall()]

        if completed_ids:
            placeholders = ",".join("%s" * len(completed_ids))
            cur = await db.execute(
                f"""SELECT message_id, user_id, user_name FROM responses
                    WHERE chat_id = %s AND message_id IN ({placeholders}) AND response = 'go'""",
                [chat_id, *completed_ids],
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
            """SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Europe/Moscow')::integer AS hour,
                      COUNT(*) AS cnt,
                      AVG(EXTRACT(EPOCH FROM completed_at - created_at)) AS avg_fill
               FROM sessions
               WHERE chat_id = %s AND is_complete = true AND is_expired = false AND completed_at IS NOT NULL
               GROUP BY hour
               ORDER BY cnt DESC, avg_fill ASC
               LIMIT 2""",
            (chat_id,),
        )
        stats.best_hours = [(row["hour"], row["cnt"], row["avg_fill"]) for row in await cur.fetchall()]

    return stats


async def get_chat_participants(chat_id: int) -> list[tuple[int, str]]:
    """Return mentionable previous 'go' responders in this chat, most recent first."""
    async with database() as db:
        cursor = await db.execute(
            """SELECT user_id, user_name FROM (
                   SELECT DISTINCT ON (r.user_id) r.user_id, r.user_name, r.responded_at
                   FROM responses r WHERE r.chat_id = %s AND r.response = 'go' AND NOT r.is_bot
                   AND NOT EXISTS (SELECT 1 FROM afk_mutes a WHERE a.chat_id = r.chat_id
                       AND a.user_id = r.user_id AND a.muted_until > %s)
                   ORDER BY r.user_id, r.responded_at DESC
               ) recent ORDER BY responded_at DESC LIMIT 20""",
            (chat_id, timestamp(time.time())),
        )
        return [(row["user_id"], row["user_name"]) for row in await cursor.fetchall()]


async def set_afk(chat_id: int, user_id: int, muted_until: float) -> None:
    async with database() as db:
        await db.execute(
            """INSERT INTO afk_mutes (chat_id, user_id, muted_until) VALUES (%s, %s, %s) ON CONFLICT (chat_id,
            user_id) DO UPDATE SET muted_until = excluded.muted_until""",
            (chat_id, user_id, timestamp(muted_until)),
        )
        await db.commit()


async def clear_afk(chat_id: int, user_id: int) -> None:
    async with database() as db:
        await db.execute("DELETE FROM afk_mutes WHERE chat_id = %s AND user_id = %s", (chat_id, user_id))
        await db.commit()


async def get_afk_until(chat_id: int, user_id: int) -> float | None:
    async with database() as db:
        cursor = await db.execute(
            "SELECT muted_until FROM afk_mutes WHERE chat_id = %s AND user_id = %s",
            (chat_id, user_id),
        )
        row = await cursor.fetchone()
        return row[0] if row else None


async def get_active_chat_ids(days: int = 14) -> list[int]:
    cutoff = time.time() - days * 86400
    async with database() as db:
        cursor = await db.execute("SELECT DISTINCT chat_id FROM sessions WHERE created_at > %s", (timestamp(cutoff),))
        return [row[0] for row in await cursor.fetchall()]


async def is_feature_enabled(chat_id: int, feature: str) -> bool:
    async with database() as db:
        cursor = await db.execute(
            "SELECT enabled FROM chat_features WHERE chat_id = %s AND feature = %s",
            (chat_id, feature),
        )
        row = await cursor.fetchone()
        return bool(row and row[0])


async def set_feature(chat_id: int, feature: str, enabled: bool, value: float | None = None) -> None:
    async with database() as db:
        await db.execute(
            """INSERT INTO chat_features (chat_id, feature, enabled, value) VALUES (%s, %s, %s, %s) ON CONFLICT
            (chat_id, feature) DO UPDATE SET enabled = excluded.enabled, value = excluded.value""",
            (chat_id, feature, enabled, value),
        )
        await db.commit()


async def get_feature_value(chat_id: int, feature: str) -> float | None:
    async with database() as db:
        cursor = await db.execute(
            "SELECT value FROM chat_features WHERE chat_id = %s AND feature = %s",
            (chat_id, feature),
        )
        row = await cursor.fetchone()
        return row[0] if row and row[0] is not None else None


async def save_roast_state(
    chat_id: int,
    history_payload: list[dict] | None,
    roast_msg_ids: list[int] | None,
    last_roast: float | None,
) -> None:
    async with database() as db:
        await db.execute(
            """INSERT INTO roast_state (chat_id, history_json, roast_msgs_json, last_roast) VALUES (%s, %s, %s, %s)
            ON CONFLICT (chat_id) DO UPDATE SET history_json = excluded.history_json,
            roast_msgs_json = excluded.roast_msgs_json, last_roast = excluded.last_roast""",
            (
                chat_id,
                Jsonb(history_payload or []),
                Jsonb(roast_msg_ids or []),
                timestamp(last_roast),
            ),
        )
        await db.commit()


async def load_all_roast_state(chat_id: int | None = None) -> list[tuple[int, list[dict], list[int], float | None]]:
    result: list[tuple[int, list[dict], list[int], float | None]] = []
    async with database() as db:
        query = "SELECT chat_id, history_json, roast_msgs_json, last_roast FROM roast_state"
        cursor = await db.execute(
            query + " WHERE chat_id=%s" if chat_id is not None else query, (chat_id,) if chat_id is not None else ()
        )
        rows = await cursor.fetchall()
    for row in rows:
        try:
            history = json.loads(row["history_json"]) if row["history_json"] else []
        except ValueError, TypeError:
            history = []
        try:
            msgs = json.loads(row["roast_msgs_json"]) if row["roast_msgs_json"] else []
        except ValueError, TypeError:
            msgs = []
        result.append((row["chat_id"], history, msgs, row["last_roast"]))
    return result


async def load_active_sessions(chat_id: int | None = None) -> list[Session]:
    result: list[Session] = []
    async with database() as db:
        query = "SELECT chat_id, message_id FROM sessions WHERE is_closed = false"
        cursor = await db.execute(
            query + " AND chat_id=%s" if chat_id is not None else query, (chat_id,) if chat_id is not None else ()
        )
        rows = await cursor.fetchall()

    for row in rows:
        session = await load_session(row["message_id"], row["chat_id"])
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
    async with database() as db:
        await db.execute(
            """INSERT INTO epic_links (chat_id, user_id, user_name, epic_name, epic_account_id, linked_at) VALUES
            (%s, %s, %s, %s, %s, %s) ON CONFLICT (chat_id, user_id) DO UPDATE SET user_name =
            excluded.user_name, epic_name = excluded.epic_name, epic_account_id =
            excluded.epic_account_id, linked_at = excluded.linked_at""",
            (chat_id, user_id, user_name, epic_name, epic_account_id, timestamp(time.time())),
        )
        await db.commit()


async def get_epic_link(chat_id: int, user_id: int) -> EpicLink | None:
    async with database() as db:
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
            linked_at=row["linked_at"],
        )


async def get_chat_epic_links(chat_id: int) -> list[EpicLink]:
    async with database() as db:
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
            linked_at=row["linked_at"],
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
    async with database() as db:
        await db.execute(
            """INSERT INTO squad_snapshots (epic_account_id, fetched_at, matches, wins, kills, deaths_est, kd,
            overall_matches, overall_wins, overall_kills, overall_deaths_est, overall_kd) VALUES
            (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (epic_account_id,
            fetched_at) DO UPDATE SET matches = excluded.matches, wins = excluded.wins, kills =
            excluded.kills, deaths_est = excluded.deaths_est, kd = excluded.kd, overall_matches =
            excluded.overall_matches, overall_wins = excluded.overall_wins, overall_kills =
            excluded.overall_kills, overall_deaths_est = excluded.overall_deaths_est, overall_kd =
            excluded.overall_kd""",
            (
                epic_account_id,
                timestamp(fetched_at),
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
    async with database() as db:
        sql = (
            "SELECT epic_account_id, fetched_at, matches, wins, kills, deaths_est, kd, "
            "overall_matches, overall_wins, overall_kills, overall_deaths_est, overall_kd "
            "FROM squad_snapshots WHERE epic_account_id = %s AND fetched_at <= %s"
        )
        params: list = [epic_account_id, timestamp(cutoff_ts)]
        if floor_ts is not None:
            sql += " AND fetched_at >= %s"
            params.append(timestamp(floor_ts))
        sql += " ORDER BY fetched_at DESC LIMIT 1"
        cursor = await db.execute(sql, params)
        row = await cursor.fetchone()
        if row is None:
            return None
        return SquadSnapshot(
            epic_account_id=row["epic_account_id"],
            fetched_at=row["fetched_at"],
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
    async with database() as db:
        cursor = await db.execute(
            "DELETE FROM squad_snapshots WHERE fetched_at < %s",
            (timestamp(cutoff),),
        )
        await db.commit()
        return cursor.rowcount


async def get_chats_with_epic_links() -> list[int]:
    async with database() as db:
        cursor = await db.execute("SELECT DISTINCT chat_id FROM epic_links")
        return [row[0] for row in await cursor.fetchall()]


async def get_last_weekly_drop(chat_id: int) -> float | None:
    return await get_feature_value(chat_id, "weekly_drop")


async def set_last_weekly_drop(chat_id: int, ts: float) -> None:
    await set_feature(chat_id, "weekly_drop", enabled=True, value=ts)


async def resolve_user_by_username(chat_id: int, username_with_at: str) -> tuple[int, str] | None:
    async with database() as db:
        cursor = await db.execute(
            """SELECT r.user_id, r.user_name
               FROM responses r JOIN sessions s ON r.chat_id = s.chat_id AND r.message_id = s.message_id
               WHERE s.chat_id = %s AND LOWER(r.user_name) = LOWER(%s) AND r.is_bot = false
               ORDER BY r.responded_at DESC LIMIT 1""",
            (chat_id, username_with_at),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return row["user_id"], row["user_name"]
