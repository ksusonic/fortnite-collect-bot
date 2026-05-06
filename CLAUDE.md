# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Telegram bot for gathering a 4-player Fortnite squad via inline buttons in group chats. Command `/fort` starts a gathering session, users press a time-slot button or "Pass", the message updates in real-time, and announces when the squad is full. The bot also monitors Epic Games server status and can roast group members via xAI Grok.

Stack: Python 3.14, aiogram 3.x, aiosqlite, xai-sdk, aiohttp, uv.

## Commands

```bash
# Install dependencies
uv sync

# Run the bot locally (needs .env with BOT_TOKEN; XAI_API_KEY optional for /roast)
uv run python -m bot

# Run with Docker
docker compose up -d

# Check syntax/imports
uv run python -c "from bot.handlers import router"

# Lint & format
uv run ruff check --fix
uv run ruff format

# Install pre-commit hooks (one-time)
uv run pre-commit install

# Run pre-commit on all files
uv run pre-commit run --all-files
```

## Bot commands (group chats only)

- `/fort` — start a gathering session with time-slot buttons (Now + next hours up to 23:00 MSK)
- `/refort` — cancel current active session and start a new one
- `/rm` — cancel and delete current active session
- `/stats` — chat statistics (top players, fill times, streaks, peak hours)
- `/roast on [0..1] | off` — toggle xAI Grok "Unhinged" replies; optional probability override (default `ROAST_PROBABILITY`)

## Linting & CI

- **Pre-commit** (`.pre-commit-config.yaml`): runs `ruff-check --fix` and `ruff-format` on staged files. Install hooks with `uv run pre-commit install` after `uv sync`.
- **CI** (`.github/workflows/lint.yml`): runs `ruff check` and `ruff format --check` on every PR via `astral-sh/ruff-action@v3`. Both must pass to merge.
- **Ruff config** (`pyproject.toml`): line length 120, rules `E,F,W,I,B,UP`, double quotes.

## Architecture

All bot code lives in `bot/`:

- `__main__.py` — entry point: creates Bot/Dispatcher, initializes DB, restores active sessions from SQLite into in-memory cache, starts background tasks (`expire_sessions`, `check_status_loop`), runs polling
- `handlers.py` — aiogram Router with command handlers (`/fort`, `/refort`, `/rm`, `/stats`, `/roast`), callback query handler for slot/`go`/`pass` buttons, `maybe_roast` for non-command group messages, welcome message for new chat members; also contains `expire_sessions()` background coroutine
- `db.py` — SQLite persistence via aiosqlite; defines `Session`/`ChatStats` dataclasses and module-level `sessions: dict[int, Session]` cache (keyed by message_id); all DB functions open a new connection per call. Tables: `sessions`, `responses`, `chat_features`
- `messages.py` — text/keyboard builders; contains `_STYLES` list (19 randomized gathering themes), `_STATS_STYLES` (3 stats layouts), `generate_time_slots()`, constants (`SQUAD_SIZE=4`, `SESSION_TIMEOUT=3600`, `PLAY_DEADLINE_HOUR=23`)
- `roast.py` — xAI Grok integration (Unhinged persona via system prompt + `temperature=1.3`); manages per-chat history (last 5 messages), cooldown, probability roll, recent roast message-id tracking (so replies to bot's roasts force a new roast)
- `status.py` — Fortnite server status monitoring via Epic Games status API; alerts active chats during 18:00–24:00 MSK on indicator changes (`down`/`degraded`/`restored`)

## Key design decisions

- **Dual storage**: in-memory `sessions` dict for fast access + SQLite for persistence across restarts. Cache is authoritative during runtime; SQLite is synced on every mutation.
- **Session keyed by message_id**: each `/fort` creates one session tied to the bot's reply message_id. Only one active (incomplete) session per chat allowed (use `/refort` to replace).
- **Time slots**: `generate_time_slots()` returns `["now", "HH:00", ...]` up to `PLAY_DEADLINE_HOUR`. Slot buttons use callback data `slot:<slot>`. After `PLAY_DEADLINE_HOUR` the background expirer also closes any open session.
- **Tagged users**: at `/fort`, pulls last 20 distinct `go`-responders from `responses` (excluding bots and the initiator) into `session.tagged_users`. They render as a `📣 @user1 @user2…` line until each responds.
- **Per-chat feature toggles**: `chat_features` table stores `(chat_id, feature, enabled, value REAL)`. Currently used for `roast` with optional custom probability. Use `set_feature` / `is_feature_enabled` / `get_feature_value`.
- **Roast forcing**: even with cooldown/probability not met, a reply to a known bot-roast message OR a `@bot` mention forces a roast. Bot tracks its own roast message ids per chat in a deque (size 100).
- **Style index**: random style chosen at session creation, stored in DB `style` column, used consistently for all updates of that message.
- **HTML parse mode**: set globally via `DefaultBotProperties`. User names rendered as `<a href="tg://user?id=...">` deep links with `html.escape()`. Roast text is also `html.escape()`-d before sending.
- **DB migrations**: `init_db()` issues idempotent `ALTER TABLE ADD COLUMN ...` statements wrapped in `try/except` — schema upgrades run in-place on every startup, no migration framework. New columns must be nullable or have a default.
- **DB_PATH env var**: defaults to `bot.db` locally; set to `/app/data/bot.db` in Docker via docker-compose to use the persistent `bot-data` volume.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BOT_TOKEN` | yes | — | Telegram bot token |
| `DB_PATH` | no | `bot.db` | SQLite file path |
| `XAI_API_KEY` | no | — | Required for `/roast`; without it, roast is silently disabled |
| `LOG_LEVEL` | no | `INFO` | Python logging level |
| `ROAST_PROBABILITY` | no | `0.05` | Default chance per non-command group message to trigger a roast |
| `ROAST_COOLDOWN_SEC` | no | `600` | Min seconds between roasts per chat |
| `ROAST_MODEL` | no | `grok-3-mini` | xAI model id |
