from __future__ import annotations

from bot import db


async def test_private_schema_types_indexes_and_rls(tmp_db):
    async with db._connection() as connection:
        columns = await (
            await connection.execute(
                """select table_name,column_name,data_type from information_schema.columns
                   where table_schema='fortnite_bot'"""
            )
        ).fetchall()
        types = {(row["table_name"], row["column_name"]): row["data_type"] for row in columns}
        assert types[("sessions", "chat_id")] == "bigint"
        assert types[("sessions", "created_at")] == "timestamp with time zone"
        assert types[("sessions", "time_slots")] == "jsonb"
        assert types[("chat_features", "enabled")] == "boolean"
        assert types[("squad_snapshots", "kd")] == "double precision"

        rls = await (
            await connection.execute(
                """select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='fortnite_bot' and relkind='r'"""
            )
        ).fetchall()
        assert rls and all(row["relrowsecurity"] for row in rls)

        indexes = {
            row["indexname"]
            for row in await (
                await connection.execute("select indexname from pg_indexes where schemaname='fortnite_bot'")
            ).fetchall()
        }
        assert {"sessions_chat_created_idx", "responses_recent_idx", "snapshots_account_time_idx"} <= indexes


async def test_pool_closes_cleanly(tmp_db):
    await db.close_db()
    assert db._pool is None
