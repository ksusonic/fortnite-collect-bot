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

- `/fort` — start a gathering session with time-slot buttons (Now + next hours up to 23:00 MSK). Optional time argument `/fort <hour>` (e.g. `/fort 18`, also accepts `18:00`) starts the slots at that target hour (no "Now" slot) up to 23:00 MSK; rejected if the hour is malformed, past, or after `PLAY_DEADLINE_HOUR`. If an active session exists, repeated `/fort` within `FORT_REPLACE_COOLDOWN` (30 s) gets a 👎 reaction; after the cooldown it cancels the old session and creates a new one.
- `/rm` — cancel and delete current active session
- `/stats` — chat statistics (top players, fill times, streaks, peak hours)
- `/roast on [0..1] | off` — toggle xAI Grok "Unhinged" replies; optional probability override (default `ROAST_PROBABILITY`)
- `/linkepicfor @user <EpicName>` — admin-only (`ADMIN_USER_ID`); link `@user` to a public Epic Games account (requires `FORTNITE_API_KEY`). `@user` must have responded at least once to `/fort` in this chat (resolved via `responses` table). The Epic account must have Public Game Stats enabled.
- `/myfnstats` — sends a provider-rendered PNG card with caller's current-season BR stats (overall + per-input split); falls back to a text block if the image URL is absent or rejected by Telegram.
- `/teamstats` — current-season aggregates for everyone in this chat who has linked an Epic account; MVP block, sweepstake-style summary, one leaders `<pre>` table (top-5 by wins) with medal column, and a one-line leader per mode (squad/duo/solo). Appends an optional LLM analysis block from Grok if `XAI_API_KEY` is set. The bot also publishes `/teamstats` automatically every Friday at 21:00 MSK in chats with at least one linked Epic account (deduped via `chat_features.weekly_drop` with a 6-day window).

## Linting & CI

- **Pre-commit** (`.pre-commit-config.yaml`): runs `ruff-check --fix` and `ruff-format` on staged files. Install hooks with `uv run pre-commit install` after `uv sync`.
- **CI** (`.github/workflows/lint.yml`): runs `ruff check` and `ruff format --check` on every PR via `astral-sh/ruff-action@v3`. Both must pass to merge.
- **Ruff config** (`pyproject.toml`): line length 120, rules `E,F,W,I,B,UP`, double quotes.

## Architecture

All bot code lives in `bot/`:

- `__main__.py` — entry point: creates Bot/Dispatcher, initializes DB, restores active sessions from SQLite into in-memory cache, starts background tasks (`expire_sessions`, `check_status_loop`, `cleanup_snapshots_loop`, `weekly_stats_drop_loop`), runs polling
- `handlers.py` — aiogram Router with command handlers (`/fort`, `/rm`, `/stats`, `/roast`), callback query handler for slot/`go`/`pass` buttons, `maybe_roast` for non-command group messages, welcome message for new chat members; also contains `expire_sessions()` and `weekly_stats_drop_loop()` background coroutines. `_run_teamstats(bot, chat_id)` is the shared core of `/teamstats` reused by the weekly auto-drop.
- `db.py` — SQLite persistence via aiosqlite; defines `Session`/`ChatStats`/`EpicLink`/`SquadSnapshot` dataclasses and module-level `sessions: dict[int, Session]` cache (keyed by message_id); all DB functions open a new connection per call. Tables: `sessions`, `responses`, `chat_features`, `roast_state`, `epic_links`, `squad_snapshots`
- `messages.py` — text/keyboard builders; contains `_STYLES` list (19 randomized gathering themes), `_STATS_STYLES` (3 stats layouts), `generate_time_slots()`, constants (`SQUAD_SIZE=4`, `SESSION_TIMEOUT=3600`, `PLAY_DEADLINE_HOUR=23`); also `build_my_fn_stats_text`/`build_team_fn_stats_text` for Fortnite stat blocks
- `roast.py` — xAI Grok integration (Unhinged persona via system prompt + `temperature=1.3`); manages per-chat dialog history (default 30 messages, both user and assistant turns) with 12-hour idle TTL, cooldown, probability roll, recent roast message-id tracking (so replies to bot's roasts force a new roast). Also exposes `generate_team_stats_roast(facts: str) -> str | None` — a stateless toxic analyzer of `/teamstats` numbers with its own dedicated system prompt, bypassing the per-chat `roast` feature toggle (gated only by `XAI_API_KEY`); fails silently to `None` on any error.
- `status.py` — Fortnite server status monitoring via Epic Games status API; alerts active chats during 18:00–24:00 MSK on indicator changes (`down`/`degraded`/`restored`)
- `fortnite.py` — `fortnite-api` SDK wrapper. Lazy singleton `Client` under `asyncio.Lock`, current-season BR stats fetch (`fetch_stats(name=...)` / `fetch_stats(account_id=..., with_image=...)`) via `TimeWindow.SEASON`. When `with_image=True`, requests `StatsImageType.ALL` and surfaces the provider's PNG URL as `PlayerStats.image_url`. In-memory TTL cache keyed by `(account_id, with_image)` with per-key `asyncio.Lock` coalescing, `asyncio.wait_for` per request, exception mapping (`EpicNameNotFound`/`StatsPrivate`/`StatsEmpty`/`FortniteUnavailable`). `StatsEmpty` carries `epic_account_id` and `epic_name` so callers can still persist a link for a player with 0 matches this season. After every successful API call (no cache hit) writes a squad-only snapshot row into `squad_snapshots` so `/teamstats` can compute 24h/7d deltas. `close()` shuts down the underlying aiohttp session at app exit.

## Key design decisions

- **Dual storage**: in-memory `sessions` dict for fast access + SQLite for persistence across restarts. Cache is authoritative during runtime; SQLite is synced on every mutation.
- **Session keyed by message_id**: each `/fort` creates one session tied to the bot's reply message_id. Only one active (incomplete) session per chat allowed; a repeat `/fort` only replaces it once `FORT_REPLACE_COOLDOWN` seconds have passed since the original (otherwise it's rejected with a 👎 reaction).
- **Time slots**: `generate_time_slots()` returns `["now", "HH:00", ...]` up to `PLAY_DEADLINE_HOUR`. Slot buttons use callback data `slot:<slot>`. After `PLAY_DEADLINE_HOUR` the background expirer also closes any open session.
- **Tagged users**: at `/fort`, pulls last 20 distinct `go`-responders from `responses` (excluding bots and the initiator) into `session.tagged_users`. They render as a `📣 @user1 @user2…` line until each responds.
- **Per-chat feature toggles**: `chat_features` table stores `(chat_id, feature, enabled, value REAL)`. Currently used for `roast` with optional custom probability. Use `set_feature` / `is_feature_enabled` / `get_feature_value`.
- **Roast forcing**: even with cooldown/probability not met, a reply to a known bot-roast message OR a `@bot` mention forces a roast. Bot tracks its own roast message ids per chat in a deque (size 100).
- **Roast dialog memory**: `_RECENT[chat_id]` is a deque of `HistoryEntry(role, name, text, ts, message_id, reply_to_id)` capped at `ROAST_HISTORY_SIZE`. User messages and bot replies both go in (bot's roast captured after send). On any new entry, if the last record is older than `ROAST_HISTORY_TTL_SEC`, the deque is cleared first — so a chat that's been silent > 12 h starts a fresh context. `generate_roast` collapses adjacent user entries into one `user(...)` turn (lines `Имя: текст`) interleaved with `assistant(...)` turns; `reply_to_id` is resolved against the deque to inject `(в ответ на сообщение от X: «…»)` into the final user turn.
- **Style index**: random style chosen at session creation, stored in DB `style` column, used consistently for all updates of that message.
- **HTML parse mode**: set globally via `DefaultBotProperties`. User names rendered as `<a href="tg://user?id=...">` deep links with `html.escape()`. Roast text is also `html.escape()`-d before sending.
- **DB migrations**: `init_db()` issues idempotent `ALTER TABLE ADD COLUMN ...` statements wrapped in `try/except` — schema upgrades run in-place on every startup, no migration framework. New columns must be nullable or have a default.
- **DB_PATH env var**: defaults to `bot.db` locally; set to `/app/data/bot.db` in Docker via docker-compose to use the persistent `bot-data` volume.
- **Fortnite stats are current-season only**: provider (`fortnite-api.com`) is called with `TimeWindow.SEASON` everywhere — no `lifetime` toggle. `/myfnstats` requests `StatsImageType.ALL`, gets back a PNG URL from the provider, and sends it via `bot.answer_photo(photo=url, caption=...)` so Telegram downloads the image itself (no local download, no Pillow). If the URL is missing or rejected (`TelegramBadRequest`), the handler falls back to the text builder. `/teamstats` always uses `with_image=False`. Each player must enable Public Game Stats in their Fortnite settings or the API returns 403 (mapped to `StatsPrivate`); an account with 0 matches this season raises `StatsEmpty` (success-shaped exception that still carries `epic_account_id`/`epic_name` so `/linkepicfor` can link new players at the start of a season). Cache lives in memory only (`STATS_TTL_SEC`, default 600 s) — restart drops it. Cache key is `(account_id, with_image)` so the image-bearing and image-less variants are kept separately. No background prefetch; all fetches are on-demand. Per-key `asyncio.Lock` coalesces concurrent fetches during `/teamstats`.
- **Squad snapshots are lazy**: written inside `fetch_stats` after a successful API call (no background fetching, no cache-hit writes). `cleanup_snapshots_loop` trims rows older than 30 days once a day. Deltas (24h, 7d) are computed sequentially inside `_run_teamstats` (PK + index reads, cheap) and fed only into the Grok facts blob — the HTML message is unchanged. Players whose current `squad.matches < snapshot.matches` are silently dropped from the delta block (season reset).
- **Weekly /teamstats auto-drop**: `weekly_stats_drop_loop` fires every 5 min and triggers `_run_teamstats` for each chat with linked Epic accounts on Fridays 21:00–21:59 MSK. Dedup uses `chat_features` with `feature='weekly_drop'` and `value=last_drop_ts`; a 6-day cutoff guarantees at most one drop per Friday. No catch-up if the bot was down through the window. No toggle (YAGNI).

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BOT_TOKEN` | yes | — | Telegram bot token |
| `DB_PATH` | no | `bot.db` | SQLite file path |
| `XAI_API_KEY` | no | — | Required for `/roast`; without it, roast is silently disabled |
| `LOG_LEVEL` | no | `INFO` | Python logging level |
| `ROAST_PROBABILITY` | no | `0.05` | Default chance per non-command group message to trigger a roast |
| `ROAST_COOLDOWN_SEC` | no | `600` | Min seconds between roasts per chat |
| `ROAST_HISTORY_SIZE` | no | `30` | Max messages (user + bot) kept per chat for roast context |
| `ROAST_HISTORY_TTL_SEC` | no | `43200` | Idle seconds after which roast history is dropped on next message (default 12 h) |
| `ROAST_MODEL` | no | `grok-3-mini` | xAI model id |
| `ROAST_REQUEST_TIMEOUT` | no | `45` | xAI client RPC timeout in seconds |
| `FORTNITE_API_KEY` | no | — | Required for `/linkepicfor`, `/myfnstats`, `/teamstats`; without it those commands answer "not configured" |
| `FORTNITE_STATS_TTL_SEC` | no | `600` | In-memory TTL for cached Fortnite stats (per account_id) |
| `FORTNITE_REQUEST_TIMEOUT` | no | `15` | Per-request timeout for the Fortnite API client (seconds) |
| `ADMIN_USER_ID` | no | — | Telegram user_id of the single bot admin; required for `/linkepicfor`. Without it that command answers "not configured" |
