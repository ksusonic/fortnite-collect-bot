from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

import aiosqlite

DB_PATH = os.getenv("DB_PATH", "bot.db")

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
    style: int = 0
    created_at: float = field(default_factory=time.time)
    completed_at: float | None = None
    time_slots: list[str] = field(default_factory=list)
    player_slots: dict[int, str] = field(default_factory=dict)  # user_id -> slot
    tagged_users: dict[int, str] = field(default_factory=dict)  # user_id -> name


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                message_id INTEGER PRIMARY KEY,
                chat_id INTEGER NOT NULL,
                initiator_id INTEGER NOT NULL,
                initiator_name TEXT NOT NULL,
                is_complete INTEGER NOT NULL DEFAULT 0,
                is_expired INTEGER NOT NULL DEFAULT 0,
                style INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                completed_at REAL
            )"""
        )
        # Migration: add columns if upgrading from older schema
        try:
            await db.execute("ALTER TABLE sessions ADD COLUMN is_expired INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        try:
            await db.execute("ALTER TABLE sessions ADD COLUMN completed_at REAL")
        except Exception:
            pass
        try:
            await db.execute("ALTER TABLE sessions ADD COLUMN time_slots TEXT")
        except Exception:
            pass
        try:
            await db.execute("ALTER TABLE sessions ADD COLUMN tag_line TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        await db.execute(
            """CREATE TABLE IF NOT EXISTS responses (
                message_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                response TEXT NOT NULL CHECK(response IN ('go', 'pass')),
                responded_at REAL NOT NULL,
                PRIMARY KEY (message_id, user_id),
                FOREIGN KEY (message_id) REFERENCES sessions(message_id)
            )"""
        )
        try:
            await db.execute("ALTER TABLE responses ADD COLUMN time_slot TEXT")
        except Exception:
            pass
        await db.commit()


async def save_session(session: Session) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO sessions
               (message_id, chat_id, initiator_id, initiator_name, is_complete, is_expired, style, created_at, completed_at, time_slots, tag_line)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                session.message_id,
                session.chat_id,
                session.initiator_id,
                session.initiator_name,
                int(session.is_complete),
                int(session.is_expired),
                session.style,
                session.created_at,
                session.completed_at,
                json.dumps(session.time_slots) if session.time_slots else None,
                json.dumps({str(k): v for k, v in session.tagged_users.items()}) if session.tagged_users else None,
            ),
        )
        await db.commit()


async def save_response(
    message_id: int, user_id: int, user_name: str, response: str, time_slot: str | None = None
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO responses
               (message_id, user_id, user_name, response, responded_at, time_slot)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (message_id, user_id, user_name, response, time.time(), time_slot),
        )
        await db.commit()


async def load_session(message_id: int) -> Session | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM sessions WHERE message_id = ?", (message_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None

        raw_slots = row["time_slots"] if "time_slots" in row.keys() else None
        time_slots = json.loads(raw_slots) if raw_slots else []
        raw_tag = row["tag_line"] if "tag_line" in row.keys() else None
        try:
            tagged_users = {int(k): v for k, v in json.loads(raw_tag).items()} if raw_tag else {}
        except (ValueError, AttributeError):
            tagged_users = {}

        session = Session(
            chat_id=row["chat_id"],
            message_id=row["message_id"],
            initiator_id=row["initiator_id"],
            initiator_name=row["initiator_name"],
            is_complete=bool(row["is_complete"]),
            is_expired=bool(row["is_expired"]),
            style=row["style"],
            created_at=row["created_at"],
            completed_at=row["completed_at"],
            time_slots=time_slots,
            tagged_users=tagged_users,
        )

        cursor = await db.execute(
            "SELECT user_id, user_name, response, time_slot FROM responses WHERE message_id = ?",
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
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE sessions SET is_complete = 1, completed_at = ? WHERE message_id = ?",
            (time.time(), message_id),
        )
        await db.commit()


async def mark_expired(message_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE sessions SET is_complete = 1, is_expired = 1, completed_at = ? WHERE message_id = ?",
            (time.time(), message_id),
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


async def get_chat_stats(chat_id: int) -> ChatStats:
    stats = ChatStats()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Session counts
        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = ?", (chat_id,)
        )
        stats.total_sessions = (await cur.fetchone())["cnt"]

        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = ? AND is_complete = 1 AND is_expired = 0",
            (chat_id,),
        )
        stats.completed_sessions = (await cur.fetchone())["cnt"]

        cur = await db.execute(
            "SELECT COUNT(*) as cnt FROM sessions WHERE chat_id = ? AND is_expired = 1",
            (chat_id,),
        )
        stats.expired_sessions = (await cur.fetchone())["cnt"]

        stats.active_sessions = stats.total_sessions - stats.completed_sessions - stats.expired_sessions

        # Top players (most "go" responses in this chat)
        cur = await db.execute(
            """SELECT r.user_name, COUNT(*) as cnt
               FROM responses r
               JOIN sessions s ON r.message_id = s.message_id
               WHERE s.chat_id = ? AND r.response = 'go'
               GROUP BY r.user_id
               ORDER BY cnt DESC
               LIMIT 10""",
            (chat_id,),
        )
        stats.top_players = [(row["user_name"], row["cnt"]) for row in await cur.fetchall()]

        # Top initiators
        cur = await db.execute(
            """SELECT initiator_name, COUNT(*) as cnt
               FROM sessions
               WHERE chat_id = ?
               GROUP BY initiator_id
               ORDER BY cnt DESC
               LIMIT 5""",
            (chat_id,),
        )
        stats.top_initiators = [(row["initiator_name"], row["cnt"]) for row in await cur.fetchall()]

        # Top passers
        cur = await db.execute(
            """SELECT r.user_name, COUNT(*) as cnt
               FROM responses r
               JOIN sessions s ON r.message_id = s.message_id
               WHERE s.chat_id = ? AND r.response = 'pass'
               GROUP BY r.user_id
               ORDER BY cnt DESC
               LIMIT 5""",
            (chat_id,),
        )
        stats.top_passers = [(row["user_name"], row["cnt"]) for row in await cur.fetchall()]

        # Average and fastest fill time (only completed, non-expired sessions with completed_at)
        cur = await db.execute(
            """SELECT AVG(completed_at - created_at) as avg_t, MIN(completed_at - created_at) as min_t
               FROM sessions
               WHERE chat_id = ? AND is_complete = 1 AND is_expired = 0 AND completed_at IS NOT NULL""",
            (chat_id,),
        )
        row = await cur.fetchone()
        if row and row["avg_t"] is not None:
            stats.avg_fill_seconds = row["avg_t"]
            stats.fastest_fill_seconds = row["min_t"]

    return stats


async def get_chat_participants(chat_id: int) -> list[tuple[int, str]]:
    """Return distinct users who previously responded 'go' in this chat, most recent first."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """SELECT r.user_id, r.user_name
               FROM responses r
               JOIN sessions s ON r.message_id = s.message_id
               WHERE s.chat_id = ? AND r.response = 'go'
               GROUP BY r.user_id
               ORDER BY MAX(r.responded_at) DESC
               LIMIT 20""",
            (chat_id,),
        )
        return [(row["user_id"], row["user_name"]) for row in await cursor.fetchall()]


async def load_active_sessions() -> list[Session]:
    result: list[Session] = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT message_id FROM sessions WHERE is_complete = 0"
        )
        rows = await cursor.fetchall()

    for row in rows:
        session = await load_session(row["message_id"])
        if session is not None:
            result.append(session)
    return result
