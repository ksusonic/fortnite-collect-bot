import logging

from aiogram import Bot
from aiogram.types import BotCommand, BotCommandScopeAllGroupChats, BotCommandScopeAllPrivateChats

logger = logging.getLogger(__name__)

GROUP_COMMANDS = [
    BotCommand(command="fort", description="собрать сквад на катку"),
    BotCommand(command="fortemoji", description="настроить emoji-заголовок FORT (для админов)"),
    BotCommand(command="afk", description="временно не звать в /fort: 1d, 2w или off"),
    BotCommand(command="rm", description="отменить активный сбор"),
    BotCommand(command="stats", description="статистика чата"),
    BotCommand(command="roast", description="вкл/выкл язвительные ответы: on [0..1] | off"),
    BotCommand(command="myfnstats", description="моя статистика Fortnite"),
    BotCommand(command="teamstats", description="командная статистика Fortnite"),
]


async def setup_bot_commands(bot: Bot) -> None:
    try:
        await bot.set_my_commands(GROUP_COMMANDS, scope=BotCommandScopeAllGroupChats())
        await bot.delete_my_commands(scope=BotCommandScopeAllPrivateChats())
        await bot.delete_my_commands()
    except Exception:
        logger.warning("set_my_commands failed", exc_info=True)
