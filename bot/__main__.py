import asyncio
import os

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from dotenv import load_dotenv

from bot.db import init_db, load_active_sessions, sessions
from bot.handlers import expire_sessions, router
from bot.status import check_status_loop


async def main() -> None:
    load_dotenv()

    if not os.getenv("OPENAI_API_KEY"):
        print("roast disabled: OPENAI_API_KEY not set")

    token = os.getenv("BOT_TOKEN")
    if not token:
        raise SystemExit("BOT_TOKEN is not set in .env")

    bot = Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher()
    dp.include_router(router)

    await init_db()
    for session in await load_active_sessions():
        sessions[session.message_id] = session

    asyncio.create_task(expire_sessions(bot))
    asyncio.create_task(check_status_loop(bot))
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
