# AGENTS.md

## Project

TypeScript / Next.js App Router / grammY Telegram bot for Fortnite gatherings. Production
is Node.js 24 on Vercel plus Supabase Postgres, via Telegram webhooks. Keep bot logic
independent of React so the future Mini App can share services. Use pnpm directly from
registry.npmjs.org without proxies.
Do not use Docker or restore polling/SSH deployment. Preserve unrelated local files.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm --registry=https://registry.npmjs.org dlx supabase@2.119.0 db push --db-url "postgresql://localhost/fortnite_test?sslmode=disable"
pnpm bot register-webhook https://production-domain
pnpm bot webhook-info
pnpm bot configure-commands
pnpm lint
pnpm format:check
pnpm typecheck
TEST_DATABASE_URL=postgresql://localhost/fortnite_test pnpm test
pnpm build
```

Apply migrations with Supabase CLI before running database tests.
Tests require disposable Postgres and clear bot tables. Never use production URLs for tests.
All `.env` variants are ignored; Never commit credentials.
Use Supabase tools for production database changes/scheduling/verification.

## Bot commands (group chats only)

All chats require explicit owner approval via hidden `/init`; only the numeric
`ADMIN_USER_ID` can approve a group. Existing chats are not auto-approved.
Enforce approval for handlers, callbacks, proactive sends, queued work and snapshots.
Do not advertise `/init` in command menus; preserve approvals durably in private Postgres.

- `/fort [time]` — create or update the evening Fortnite gathering with availability, readiness, FIFO squad and reserve. Some cards include a Vice City easter egg. Checkpoint the choice and keep it on the card.
- `/rm` cancels the Fortnite gathering. `/afk` controls mentions in new gatherings. Warcraft stays retired and old Warcraft buttons are cleared on use.
- Maintenance schedules Fortnite start notices and closes cards at Moscow midnight. Legacy gathering/expiry work and incompatible interrupted updates retain their checkpoints and are retired without Telegram sends. Ambiguous outcomes remain blocked for review.
- Historical gathering data and game discrimination remain for statistics; never delete history or relabel Warcraft as Fortnite.
- `/stats` — one compact emoji-led report: Fortnite gatherings created in the last 7 days, fill times/top participants, counts of 2+ human signups and full four-player squads, and rolling Fortnite results from private lifetime snapshots. Show actual sample periods; daily samples give daily precision. Partial history is shown separately without weekly ranking/MVP. Never label four-player squad completion as gathering success or infer actual play from signups. Never treat missing history or API errors as zero activity. Optional Grok commentary is at most two sentences. `/teamstats` is retired and not handled.
- `/linkepicfor @user <EpicName>` — admin-only (`ADMIN_USER_ID`); link `@user` to a public Epic Games account (requires `FORTNITE_API_KEY`). `@user` must have responded at least once to `/fort` in this chat (resolved via `responses` table). The Epic account must have Public Game Stats enabled.
- The same `/stats` report is published every Friday at 21:00 MSK in approved chats with linked Epic accounts, retaining the existing durable weekly queue/deduplication. Seasonal snapshots remain separate from `lifetime_snapshots`; never backfill unknown lifetime counters from season totals.

## Runtime invariants

- Postgres in private `fortnite_bot` schema is authoritative; invocation-local maps
  are hydrated under a per-chat database advisory lock, including Telegram edits.
- Use SSL and the session pooler on port 5432. Transaction pooler 6543 cannot carry
  session advisory locks. Connections and HTTP clients close at invocation exit.
- Sessions/responses use composite chat_id/message_id keys. One open session per game per chat
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

## Storage

- `supabase/migrations/*.sql` are versioned; no schema changes or webhook registration at startup.
- Never expose bot tables through the Data API. Keep schema privileges private and RLS enabled.

## Deployment and verification

- Production Vercel project: fortnite-collect-bot in Daniil’s projects.
- Next.js `src/app/**/route.ts` entrypoints; Node.js 24, fra1, 300-second function duration.
- Routes are thin, Node runtime only; credentials and storage stay server-side.
- Preserve existing webhook/job URLs. Mini App authentication is future work, not a public DB API.
- Production requires BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, CRON_SECRET, PUBLIC_BASE_URL,
  ADMIN_USER_ID, and DATABASE_URL or integration-provided POSTGRES_URL_NON_POOLING. Optional Fortnite settings and the app-scoped Grok connector are documented in README. Deploy production from main only; previews are disabled.
- Register stable production webhook explicitly only after verification, with secret_token,
  max_connections=1, router-used update types and drop_pending_updates=false.
- Supabase Cron/pg_net call authenticated job routes; URL/secret live in Vault.
  See ops/schedules.sql. Verify actual HTTP outcomes, not only cron SQL success.
- CI runs ESLint, Prettier, TypeScript, Next.js build and Postgres-backed Vitest tests. Check group membership and pin/delete
  permissions, command menus and privacy mode separately from automated unit tests.
- Keep source checks, CI, deployed behavior, Telegram webhook status and actual scheduled
  outcomes separate when reporting completion.
- Vercel Web Analytics needs dashboard activation and actual event verification after deploy.
- Future Mini App work is recorded in `docs/MINI_APP.md`; implement it only when requested.

Roast preferences use natural-language addressed requests, private roast_profiles and the read-only Vercel roast-policy flag. Runtime initialization and maintenance synchronize and verify command menus once per release/hash under a shared advisory lock; failures stay retryable without blocking updates. Imports/builds never contact Telegram. /init is hidden.
