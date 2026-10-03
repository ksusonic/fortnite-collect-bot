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
