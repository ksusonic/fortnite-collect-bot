"""Explicit maintenance commands; no webhook mutation on startup."""

import argparse
import asyncio
import json
import os


async def maintain(args):
    from bot.commands import setup_bot_commands
    from bot.importer import import_backup
    from bot.runtime import bot_client, dispatcher
    from bot.storage import migrate

    if args.command == "migrate":
        await migrate()
    elif args.command == "import":
        print(json.dumps(await import_backup(args.path), indent=2))
    else:
        async with bot_client() as bot:
            if args.command == "register-webhook":
                import aiohttp

                url = args.url.rstrip("/")
                async with aiohttp.ClientSession() as http:
                    async with http.get(url + "/health") as response:
                        if response.status != 200 or not (await response.json()).get("ok"):
                            raise RuntimeError("production health check failed")
                await setup_bot_commands(bot)
                await bot.set_webhook(
                    url + "/api/telegram/webhook",
                    secret_token=os.environ["TELEGRAM_WEBHOOK_SECRET"],
                    max_connections=1,
                    allowed_updates=dispatcher.resolve_used_update_types(),
                    drop_pending_updates=False,
                )
            print((await bot.get_webhook_info()).model_dump_json(indent=2))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate")
    sub.add_parser("import").add_argument("path")
    sub.add_parser("register-webhook").add_argument("url")
    sub.add_parser("webhook-info")
    sub.add_parser("serve")
    args = parser.parse_args()
    if args.command == "serve":
        import uvicorn

        uvicorn.run("app:app", host="127.0.0.1", port=8000)
    else:
        asyncio.run(maintain(args))
