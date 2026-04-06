from __future__ import annotations

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
    style: int = 0
    created_at: float = field(default_factory=time.time)


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                message_id INTEGER PRIMARY KEY,
                chat_id INTEGER NOT NULL,
                initiator_id INTEGER NOT NULL,
                initiator_name TEXT NOT NULL,
                is_complete INTEGER NOT NULL DEFAULT 0,
                style INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL
            )"""
        )
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
        await db.commit()


async def save_session(session: Session) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO sessions
               (message_id, chat_id, initiator_id, initiator_name, is_complete, style, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                session.message_id,
                session.chat_id,
                session.initiator_id,
                session.initiator_name,
                int(session.is_complete),
                session.style,
                session.created_at,
            ),
        )
        await db.commit()


async def save_response(
    message_id: int, user_id: int, user_name: str, response: str
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO responses
               (message_id, user_id, user_name, response, responded_at)
               VALUES (?, ?, ?, ?, ?)""",
            (message_id, user_id, user_name, response, time.time()),
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

        session = Session(
            chat_id=row["chat_id"],
            message_id=row["message_id"],
            initiator_id=row["initiator_id"],
            initiator_name=row["initiator_name"],
            is_complete=bool(row["is_complete"]),
            style=row["style"],
            created_at=row["created_at"],
        )

        cursor = await db.execute(
            "SELECT user_id, user_name, response FROM responses WHERE message_id = ?",
            (message_id,),
        )
        async for resp_row in cursor:
            if resp_row["response"] == "go":
                session.go_players[resp_row["user_id"]] = resp_row["user_name"]
            else:
                session.pass_players[resp_row["user_id"]] = resp_row["user_name"]

        return session


async def mark_complete(message_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE sessions SET is_complete = 1 WHERE message_id = ?",
            (message_id,),
        )
        await db.commit()


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
