-- Compatibility with the migrations already applied by pnpm bot migrate.
-- Supabase applies this file transactionally on both preview and production.
CREATE SCHEMA IF NOT EXISTS fortnite_bot;
SET LOCAL search_path = fortnite_bot;
CREATE TABLE IF NOT EXISTS fortnite_bot.migrations (
    version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fortnite_bot.migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA fortnite_bot FROM PUBLIC;
REVOKE ALL ON fortnite_bot.migrations FROM PUBLIC;
DO $legacy_migration$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM fortnite_bot.migrations WHERE version = '001_storage.sql') THEN
        EXECUTE $legacy_sql$
CREATE TABLE IF NOT EXISTS sessions (
    message_id bigint NOT NULL, chat_id bigint NOT NULL,
    initiator_id bigint NOT NULL, initiator_name text NOT NULL,
    is_complete boolean NOT NULL DEFAULT false, is_expired boolean NOT NULL DEFAULT false,
    is_closed boolean NOT NULL DEFAULT false, style integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL, completed_at timestamptz,
    time_slots jsonb NOT NULL DEFAULT '[]', tag_line jsonb NOT NULL DEFAULT '{}',
    llm_header text, fort_title text,
    PRIMARY KEY (chat_id, message_id)
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fort_title text;
CREATE TABLE IF NOT EXISTS responses (
    chat_id bigint NOT NULL, message_id bigint NOT NULL, user_id bigint NOT NULL,
    user_name text NOT NULL, response text NOT NULL CHECK (response IN ('go', 'pass')),
    responded_at timestamptz NOT NULL, joined_at timestamptz,
    time_slot text, is_bot boolean NOT NULL DEFAULT false,
    PRIMARY KEY (chat_id, message_id, user_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES sessions(chat_id, message_id)
);
-- Reconcile the empty schema prepared by the earlier SQLite migration.
ALTER TABLE responses ADD COLUMN IF NOT EXISTS chat_id bigint;
UPDATE responses r SET chat_id = s.chat_id FROM sessions s
WHERE r.message_id = s.message_id AND r.chat_id IS NULL;
ALTER TABLE responses ALTER COLUMN chat_id SET NOT NULL;
ALTER TABLE responses DROP CONSTRAINT IF EXISTS responses_message_id_fkey;
ALTER TABLE responses DROP CONSTRAINT IF EXISTS responses_chat_id_message_id_fkey;
ALTER TABLE responses DROP CONSTRAINT IF EXISTS responses_pkey;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_pkey;
ALTER TABLE sessions ADD PRIMARY KEY (chat_id, message_id);
ALTER TABLE responses ADD PRIMARY KEY (chat_id, message_id, user_id);
ALTER TABLE responses ADD FOREIGN KEY (chat_id, message_id) REFERENCES sessions(chat_id, message_id);
-- Historical duplicate open sessions are closed in creation order.
UPDATE sessions SET is_closed = true WHERE (chat_id, message_id) IN (
    SELECT chat_id, message_id FROM (
        SELECT chat_id, message_id, row_number() OVER (
            PARTITION BY chat_id ORDER BY created_at DESC, message_id DESC
        ) AS position FROM sessions WHERE NOT is_closed
    ) s WHERE position > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open ON sessions(chat_id) WHERE NOT is_closed;
CREATE INDEX IF NOT EXISTS sessions_chat_created ON sessions(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS responses_chat_user ON responses(chat_id, user_id, responded_at DESC);
CREATE TABLE IF NOT EXISTS chat_features (
    chat_id bigint NOT NULL, feature text NOT NULL, enabled boolean NOT NULL DEFAULT false,
    value double precision, PRIMARY KEY (chat_id, feature)
);
CREATE TABLE IF NOT EXISTS afk_mutes (
    chat_id bigint NOT NULL, user_id bigint NOT NULL, muted_until timestamptz NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_fort_titles (chat_id bigint PRIMARY KEY, title text NOT NULL);
CREATE TABLE IF NOT EXISTS roast_state (
    chat_id bigint PRIMARY KEY, history_json jsonb NOT NULL DEFAULT '[]',
    roast_msgs_json jsonb NOT NULL DEFAULT '[]', last_roast timestamptz
);
CREATE TABLE IF NOT EXISTS epic_links (
    chat_id bigint NOT NULL, user_id bigint NOT NULL, user_name text NOT NULL,
    epic_name text NOT NULL, epic_account_id text NOT NULL, linked_at timestamptz NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS squad_snapshots (
    epic_account_id text NOT NULL, fetched_at timestamptz NOT NULL,
    matches integer NOT NULL, wins integer NOT NULL, kills integer NOT NULL,
    deaths_est integer NOT NULL, kd double precision NOT NULL,
    overall_matches integer, overall_wins integer, overall_kills integer,
    overall_deaths_est integer, overall_kd double precision,
    PRIMARY KEY (epic_account_id, fetched_at)
);
CREATE INDEX IF NOT EXISTS snapshots_fetched ON squad_snapshots(fetched_at);
CREATE TABLE IF NOT EXISTS news_sent (chat_id bigint PRIMARY KEY, last_version text NOT NULL);
CREATE TABLE IF NOT EXISTS fortnite_news_seen (
    chat_id bigint NOT NULL, item_id text NOT NULL, seen_at timestamptz NOT NULL,
    PRIMARY KEY (chat_id, item_id)
);
CREATE TABLE IF NOT EXISTS fort_cooldowns (
    chat_id bigint NOT NULL, user_id bigint NOT NULL, attempted_at timestamptz NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS service_state (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS work_items (
    id text PRIMARY KEY, kind text NOT NULL, chat_id bigint, payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'ambiguous', 'failed')),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0, error text
);
CREATE INDEX IF NOT EXISTS work_pending ON work_items(created_at) WHERE status IN ('pending', 'failed');
CREATE TABLE IF NOT EXISTS work_steps (
    work_id text NOT NULL REFERENCES work_items(id), step text NOT NULL, signature text NOT NULL,
    status text NOT NULL CHECK (status IN ('started', 'complete', 'rejected')),
    result jsonb, PRIMARY KEY (work_id, step)
);
CREATE TABLE IF NOT EXISTS import_manifest (
    source_sha256 text PRIMARY KEY, imported_at timestamptz NOT NULL DEFAULT now(), report jsonb NOT NULL
);
DO $$ DECLARE t text; BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'fortnite_bot' LOOP
        EXECUTE format('ALTER TABLE fortnite_bot.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON fortnite_bot.%I FROM PUBLIC', t);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON SCHEMA fortnite_bot FROM anon, authenticated;
        REVOKE ALL ON ALL TABLES IN SCHEMA fortnite_bot FROM anon, authenticated;
    END IF;
END $$;
REVOKE ALL ON SCHEMA fortnite_bot FROM PUBLIC;
$legacy_sql$;
        INSERT INTO fortnite_bot.migrations(version) VALUES ('001_storage.sql');
    END IF;
END
$legacy_migration$;
