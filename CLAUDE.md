# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Telegram bot for gathering a 4-player Fortnite squad via inline buttons in group chats. Command `/fort` starts a gathering session, users press "Go" or "Pass", the message updates in real-time, and announces when the squad is full.

Stack: Python 3.14, aiogram 3.x, aiosqlite, uv.

## Commands

```bash
# Install dependencies
uv sync

# Run the bot locally (needs .env with BOT_TOKEN)
uv run python -m bot

# Run with Docker
docker compose up -d

# Check syntax/imports
uv run python -c "from bot.handlers import router"
```

## Architecture

All bot code lives in `bot/`:

- `__main__.py` — entry point: creates Bot/Dispatcher, initializes DB, restores active sessions from SQLite into in-memory cache, starts background tasks, runs polling
- `handlers.py` — aiogram Router with `/fort` command handler and callback query handler for "go"/"pass" buttons; also contains `expire_sessions()` background coroutine
- `db.py` — SQLite persistence via aiosqlite; defines `Session` dataclass and module-level `sessions: dict[int, Session]` cache (keyed by message_id); all DB functions open a new connection per call
- `messages.py` — text/keyboard builders; contains `_STYLES` list (12 randomized gathering themes) and constants (`SQUAD_SIZE=4`, `SESSION_TIMEOUT=3600`)
- `status.py` — Fortnite server status monitoring via Epic Games status API; sends alerts to active chats on status changes

## Key design decisions

- **Dual storage**: in-memory `sessions` dict for fast access + SQLite for persistence across restarts. Cache is authoritative during runtime; SQLite is synced on every mutation.
- **Session keyed by message_id**: each `/fort` creates one session tied to the bot's reply message_id. Only one active (incomplete) session per chat allowed.
- **Style index**: random style chosen at session creation, stored in DB `style` column, used consistently for all updates of that message.
- **HTML parse mode**: set globally via `DefaultBotProperties`. User names rendered as `<a href="tg://user?id=...">` deep links with `html.escape()`.
- **DB_PATH env var**: defaults to `bot.db` locally; set to `/app/data/bot.db` in Docker via docker-compose environment to use the persistent volume.

## Environment variables

- `BOT_TOKEN` (required) — Telegram bot token
- `DB_PATH` (optional) — SQLite database file path, defaults to `bot.db`
