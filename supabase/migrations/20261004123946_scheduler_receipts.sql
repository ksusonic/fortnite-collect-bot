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
    IF NOT EXISTS (SELECT 1 FROM fortnite_bot.migrations WHERE version = '002_scheduler_receipts.sql') THEN
        EXECUTE $legacy_sql$
CREATE TABLE IF NOT EXISTS job_http_requests (
    request_id bigint PRIMARY KEY, job text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    status_code integer, timed_out boolean, error text
);
CREATE INDEX IF NOT EXISTS job_http_pending ON job_http_requests(requested_at) WHERE completed_at IS NULL;
ALTER TABLE job_http_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON job_http_requests FROM PUBLIC;
$legacy_sql$;
        INSERT INTO fortnite_bot.migrations(version) VALUES ('002_scheduler_receipts.sql');
    END IF;
END
$legacy_migration$;
