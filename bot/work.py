"""Durable invocation replay, including a Telegram action journal.

Database reads are replayed from checkpoints so a resumed handler follows the
same decisions as its first attempt. Writes commit with their checkpoint. Sends
are marked before HTTP: a crash or uncertain send is quarantined for inspection.
"""

from __future__ import annotations

from collections import defaultdict

from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from psycopg.types.json import Jsonb
from pydantic import TypeAdapter

from bot.storage import _connection, _work


class AmbiguousOutcome(BaseException):
    """Must escape handlers that intentionally catch ordinary API failures."""


class Work:
    def __init__(self, work_id):
        self.id = work_id
        self.counters = defaultdict(int)
        self.conn = _connection.get()

    def next_step(self, category):
        index = self.counters[category]
        self.counters[category] += 1
        return f"{category}:{index}"

    async def previous(self, step, signature):
        row = await (
            await self.conn.execute("SELECT * FROM work_steps WHERE work_id=%s AND step=%s", (self.id, step))
        ).fetchone()
        if row and row["signature"] != signature:
            raise RuntimeError("recovery checkpoint differs from deployed handler; manual review required")
        return row

    async def save(self, step, signature, status, result=None):
        await self.conn.execute(
            "INSERT INTO work_steps(work_id, step, signature, status, result) VALUES (%s,%s,%s,%s,%s) "
            "ON CONFLICT(work_id,step) DO UPDATE SET status=excluded.status,result=excluded.result",
            (self.id, step, signature, status, Jsonb(result)),
        )

    async def database_step(self, query, factory):
        step = self.next_step("db")
        previous = await self.previous(step, query)
        if previous:
            return previous["result"]
        async with self.conn.transaction():
            result = await factory()
            await self.save(step, query, "complete", result)
        return result

    async def value_step(self, name, factory):
        step = self.next_step("value")
        previous = await self.previous(step, name)
        if previous:
            return previous["result"]
        result = factory()
        await self.save(step, name, "complete", result)
        return result

    async def external_step(self, name, factory):
        step = self.next_step("external")
        previous = await self.previous(step, name)
        if previous:
            return previous["result"]
        token = _work.set(None)
        try:
            result = await factory()
        finally:
            _work.reset(token)
        await self.save(step, name, "complete", result)
        return result

    async def telegram(self, make_request, bot, method):
        name = method.__api_method__
        step = self.next_step("telegram")
        previous = await self.previous(step, name)
        adapter = TypeAdapter(method.__returning__)
        if previous and previous["status"] == "complete":
            return adapter.validate_python(previous["result"], context={"bot": bot})
        if previous and previous["status"] == "rejected":
            cls = {"TelegramForbiddenError": TelegramForbiddenError}.get(previous["result"]["type"], TelegramBadRequest)
            raise cls(method=method, message=previous["result"]["message"])
        # Edits/deletes/pins are safe to retry; sends/forwards/copies have no
        # Telegram idempotency key and an unknown outcome must not be resent.
        unsafe = name.startswith(("send", "forward", "copy")) and name != "sendChatAction"
        if previous and unsafe:
            await self.ambiguous(step)
        request = bot.session.prepare_value(method.model_dump(exclude_none=True), bot=bot, files={})
        await self.save(step, name, "started", {"request": request})
        try:
            result = await make_request(bot, method)
        except (TelegramBadRequest, TelegramForbiddenError) as exc:
            await self.save(step, name, "rejected", {"type": type(exc).__name__, "message": exc.message})
            raise
        except TelegramRetryAfter:
            await self.conn.execute("DELETE FROM work_steps WHERE work_id=%s AND step=%s", (self.id, step))
            raise
        except BaseException:
            if unsafe:
                await self.ambiguous(step)
            raise
        await self.save(step, name, "complete", adapter.dump_python(result, mode="json"))
        return result

    async def ambiguous(self, step):
        await self.conn.execute(
            "UPDATE work_items SET status='ambiguous', error=%s, updated_at=now() WHERE id=%s",
            (f"uncertain Telegram outcome at {step}; inspect work_steps before recovery", self.id),
        )
        raise AmbiguousOutcome(self.id)


async def telegram_middleware(make_request, bot, method):
    work = _work.get()
    if work:
        return await work.telegram(make_request, bot, method)
    return await make_request(bot, method)


async def external_checkpoint(name, factory):
    work = _work.get()
    return await work.external_step(name, factory) if work else await factory()
