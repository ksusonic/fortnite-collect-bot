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
    IF NOT EXISTS (SELECT 1 FROM fortnite_bot.migrations WHERE version = '003_mini_app_cache.sql') THEN
        EXECUTE $legacy_sql$
-- Private server-only, versioned results. No Data API grants or RLS policies.
CREATE TABLE statistics_cache (
    cache_key text PRIMARY KEY,
    version integer NOT NULL,
    result jsonb NOT NULL,
    fetched_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    retry_after timestamptz
);
CREATE INDEX statistics_cache_expiry ON statistics_cache(expires_at);
ALTER TABLE statistics_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON statistics_cache FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON statistics_cache FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON statistics_cache FROM authenticated;
    END IF;
END $$;
$legacy_sql$;
        INSERT INTO fortnite_bot.migrations(version) VALUES ('003_mini_app_cache.sql');
    END IF;
END
$legacy_migration$;
