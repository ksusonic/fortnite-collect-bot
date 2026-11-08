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

- `/fort [time]` — one Fortnite gathering per chat until midnight MSK. Creation records the initiator as available now (not confirmed ready); `/fort через час`, `/fort 18`, `/fort в 19:30` set the author's availability. Repeating `/fort` returns the existing card; a time argument updates only the author. First four players form the squad; next four are FIFO reserve, promoted on Pass. Availability changes preserve FIFO; rejoining after Pass goes to the back. The early start is the earliest main-player availability rounded up to five minutes (immediate availability/readiness stays immediate); personal times stay exact. Reserve does not affect the start. `Готов играть` is explicit, never inferred from the clock. Natural-language updates use the app-scoped Grok connector before roast; clear self-status changes apply with a reaction, uncertain actions require author-bound durable confirmation. A passer rejoins only explicitly. Pin the active card quietly, unpin only that card at midnight, and send at most one start notice per evening when two or more main players are signed up. No 1/3-hour or 23:00 expiration.
- `/warcraft [time]` — independent Warcraft gathering; may coexist with `/fort`. Invite only `@dim_led`, `@ksusonic`, `@Sirius_Auror`, independently of Fortnite AFK. Persist the game and `rumble_es` emoji ID in gathering state; no Fortnite/Grok header. Use `/rm warcraft` or reply `/rm` to its card. Status updates must select a card/game when ambiguous.
- Replying `добавь @username` to a gathering card adds that known chat participant to that card only, without confirming readiness or assigning a time. Preserve existing participation and FIFO/reserve rules; never apply it to the requesting author.
- `/afk <Nd|Nw>` — suppress the caller's proactive `📣` mention in new `/fort` sessions for a per-chat duration such as `1d` or `2w`; `/afk off` clears it early. Any participant in an approved chat can target another user with `/afk @username <Nd|Nw|off>` (resolved from this chat's responses), or by replying to their message with `/afk <Nd|Nw|off>`; usernames also accept no `@` prefix or surrounding backticks; an explicit username takes precedence. Reject bot/channel reply targets. Normal Go/Pass rendering is unchanged.
- `/rm` — close the active session and delete its Telegram card; retain private history. On denied deletion, remove buttons/unpin and explain the missing permission.
- `/stats` — one compact emoji-led report: Fortnite gatherings created in the last 7 days, fill times/top participants, and rolling Fortnite results from private lifetime snapshots. Show actual sample periods; daily samples give daily precision. Partial history is shown separately without weekly ranking/MVP. Never treat missing history or API errors as zero activity. Optional Grok commentary is at most two sentences. `/teamstats` is retired and not handled.
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
