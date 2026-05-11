import asyncio
import logging
import os
import time

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from dotenv import load_dotenv

from bot.db import init_db, load_active_sessions, load_all_roast_state, sessions
from bot.handlers import expire_sessions, router
from bot.roast import restore_roast_state
from bot.status import check_status_loop

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL_SEC = 30


async def heartbeat_loop(path: str) -> None:
    while True:
        try:
            with open(path, "w") as f:
                f.write(str(int(time.time())))
        except OSError:
            logger.warning("heartbeat write failed: %s", path, exc_info=True)
        await asyncio.sleep(HEARTBEAT_INTERVAL_SEC)


async def main() -> None:
    load_dotenv()

    log_level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    from bot.db import DB_PATH
    from bot.roast import MODEL, ROAST_COOLDOWN_SEC, ROAST_PROBABILITY

    token = os.getenv("BOT_TOKEN")
    admin_user_id = int(os.getenv("ADMIN_USER_ID", "0")) or None
    logger.info(
        "startup config: log_level=%s db_path=%s bot_token=%s xai_api_key=%s "
        "fortnite_api_key=%s admin_user_id=%s "
        "roast_probability=%.3f roast_cooldown=%ss roast_model=%s",
        log_level,
        DB_PATH,
        "set" if token else "missing",
        "set" if os.getenv("XAI_API_KEY") else "missing",
        "set" if os.getenv("FORTNITE_API_KEY") else "missing",
        admin_user_id if admin_user_id is not None else "missing",
        ROAST_PROBABILITY,
        ROAST_COOLDOWN_SEC,
        MODEL,
    )

    if not os.getenv("XAI_API_KEY"):
        logger.warning("roast disabled: XAI_API_KEY not set")
    if not os.getenv("FORTNITE_API_KEY"):
        logger.warning("fortnite stats disabled: FORTNITE_API_KEY not set")
    if admin_user_id is None:
        logger.warning("admin link command disabled: ADMIN_USER_ID not set")

    if not token:
        raise SystemExit("BOT_TOKEN is not set in .env")

    bot = Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher()
    dp.include_router(router)

    await init_db()
    for session in await load_active_sessions():
        sessions[session.message_id] = session
    for chat_id, history, msg_ids, last_roast in await load_all_roast_state():
        restore_roast_state(chat_id, history, msg_ids, last_roast)

    expire_task = asyncio.create_task(expire_sessions(bot))
    status_task = asyncio.create_task(check_status_loop(bot))
    heartbeat_path = os.getenv("HEARTBEAT_FILE")
    heartbeat_task = asyncio.create_task(heartbeat_loop(heartbeat_path)) if heartbeat_path else None
    background_tasks = [t for t in (expire_task, status_task, heartbeat_task) if t is not None]
    try:
        await dp.start_polling(bot)
    finally:
        for task in background_tasks:
            task.cancel()
        await asyncio.gather(*background_tasks, return_exceptions=True)
        await bot.session.close()
        from bot import fortnite

        await fortnite.close()


if __name__ == "__main__":
    asyncio.run(main())
