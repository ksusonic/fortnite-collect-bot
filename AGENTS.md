# AGENTS.md

## Project

Python 3.14 / aiogram 3.x Telegram bot for Fortnite gatherings. Production is FastAPI
on Vercel plus Supabase Postgres, via Telegram webhooks. Use `uv` for every Python command.
Do not use Docker or restore polling/SSH deployment. Preserve unrelated local files.

## Commands

```bash
uv sync --frozen
uv run python -m bot serve
uv run python -m bot migrate
uv run python -m bot import /path/to/read-only-backup.db
uv run python -m bot register-webhook https://production-domain
uv run python -m bot webhook-info
uv run ruff check --fix
uv run ruff format
TEST_DATABASE_URL=postgresql://localhost/fortnite_test uv run pytest -q
uv run pre-commit install
```

Tests require disposable Postgres and clear bot tables. Never use production URLs for tests.
All `.env` variants are ignored; `config.example` contains placeholders only.
Use Supabase tools for production database changes/imports/scheduling/verification.

## Bot commands (group chats only)

- `/fort` — start a gathering session with **relative readiness** buttons (`⚡ Сейчас`, `🕐 +30м`, `🕐 +1ч`, `🕐 +2ч`; capped at +2 h, trimmed so the absolute target stays before 23:00 MSK). Each `go` press resolves its offer into an absolute `HH:MM` target at press time. The first four players form the squad; the next four enter a FIFO reserve and are promoted automatically when a confirmed player presses Pass. Optional `/fort <hour>` pins one absolute slot. A live session remains editable after filling and is closed when replaced, expired, or cancelled.
- `/afk <Nd|Nw>` — suppress the caller's proactive `📣` mention in new `/fort` sessions for a per-chat duration such as `1d` or `2w`; `/afk off` clears it early. Normal Go/Pass rendering is unchanged.
- `/rm` — cancel and delete current active session
- `/fortemoji` — chat-admin setup: reply to four WideABC custom emoji spelling FORT to save the title for future gatherings; `/fortemoji off` restores the plain title. Requires Premium on the bot owner's account. Each session stores its title so edits and restarts preserve it.
- `/stats` — chat statistics (top players, fill times, streaks, peak hours)
- `/roast on [0..1] | off` — toggle xAI Grok "Unhinged" replies; optional probability override (default `ROAST_PROBABILITY`)
- `/linkepicfor @user <EpicName>` — admin-only (`ADMIN_USER_ID`); link `@user` to a public Epic Games account (requires `FORTNITE_API_KEY`). `@user` must have responded at least once to `/fort` in this chat (resolved via `responses` table). The Epic account must have Public Game Stats enabled.
- `/myfnstats` — sends a provider-rendered PNG card with caller's current-season BR stats (overall + per-input split); falls back to a text block if the image URL is absent or rejected by Telegram.
- `/teamstats` — **last-7-days** squad aggregates for everyone in this chat who has linked an Epic account; MVP-of-the-week block, weekly summary, and a leaders `<pre>` table (top-5 by weekly wins) with medal column. Weekly numbers are derived from `squad_snapshots` deltas, not the season totals (provider has no weekly window). Players without a ~7-day-old baseline snapshot, or who didn't play this week, are listed in a "Вне недельного зачёта" section with a reason and excluded from the ranking/analysis. If nobody has weekly data yet, the command replies that snapshots are still accumulating. Appends an optional LLM analysis block from Grok if `XAI_API_KEY` is set. The bot also publishes `/teamstats` automatically every Friday at 21:00 MSK in chats with at least one linked Epic account (deduped via `chat_features.weekly_drop` with a 6-day window).


## Runtime invariants

- Postgres in private `fortnite_bot` schema is authoritative; invocation-local maps
  are hydrated under a per-chat database advisory lock, including Telegram edits.
- Use SSL and the session pooler on port 5432. Transaction pooler 6543 cannot carry
  session advisory locks. Connections and HTTP clients close at invocation exit.
- Sessions/responses use composite chat_id/message_id keys. One open session per chat
  is enforced by a partial unique index. joined_at preserves FIFO across retries/restarts.
- Completed Telegram/update/job actions are checkpointed. Reads replay their original
  result; SQL writes commit atomically with their checkpoint. All branch inputs that
  vary with time/randomness must use value_checkpoint; external results use external_checkpoint.
- Never add detached tasks or endless loops. Work must be bounded and awaited.
- Uncertain sends become ambiguous for manual review; never blindly resend. Keep the
  causal chat queue blocked until the outcome is reconciled. Changing handler checkpoint
  order requires draining or deliberately migrating incomplete work before rollout.
- Store roast history, message IDs, cooldowns, status changes and job outcomes durably.
- Keep HTML escaping of names and LLM replies, stored gathering styles/custom titles,
  Go/Pass rendering, relative offers and reserve promotion behavior.

## Storage and recovery

- `migrations/*.sql` are versioned; no schema changes or webhook registration at startup.
- `importer.py` opens SQLite read-only, refuses nonempty targets, imports transactionally
  and verifies counts, all normalized contents/keys and foreign keys. Preserve original backup.
- Legacy terminal sessions close; joined_at backfills from responded_at. Missing AFK/titles
  remain empty. Old news tables remain archives. Cleanup waits for verified import_manifest.
- Never expose bot tables through the Data API. Keep schema privileges private and RLS enabled.
- Preserve pre-launch export. Weekly stats need fresh baseline snapshots after recovery.

## Deployment and verification

- Production Vercel project: fortnite-collect-bot in Daniil’s projects.
- `app.py` FastAPI entrypoint; Python 3.14, fra1, 300-second function duration.
- Production requires BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, CRON_SECRET, PUBLIC_BASE_URL,
  and DATABASE_URL or integration-provided POSTGRES_URL_NON_POOLING. Optional xAI/Fortnite/admin
  settings are documented in README. Previews need separate bot/database/API credentials.
- Register stable production webhook explicitly only after verification, with secret_token,
  max_connections=1, router-used update types and drop_pending_updates=false.
- Supabase Cron/pg_net call authenticated job routes; URL/secret live in Vault.
  See ops/schedules.sql. Verify actual HTTP outcomes, not only cron SQL success.
- CI runs Ruff check/format and Postgres-backed tests. Check group membership, pin/delete
  permissions, command menus and privacy mode separately from automated unit tests.
- Keep source checks, CI, deployed behavior, Telegram webhook status and actual scheduled
  outcomes separate when reporting completion.
