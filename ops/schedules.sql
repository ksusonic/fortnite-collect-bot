-- Apply with Supabase tools after production routes pass verification.
-- Vault must contain fortnite_bot_url and fortnite_bot_cron_secret.
-- Maintenance retains one-minute recovery latency; status runs 18..23 MSK.
-- Old job routes remain available, but their schedules are replaced atomically.
BEGIN;
DO $migration$
DECLARE old_job record;
BEGIN
    FOR old_job IN SELECT jobid FROM cron.job
        WHERE jobname IN ('fortnite-expiry', 'fortnite-weekly')
    LOOP
        PERFORM cron.unschedule(old_job.jobid);
    END LOOP;
END
$migration$;
SELECT cron.schedule('fortnite-maintenance', '* * * * *', $job$
    INSERT INTO fortnite_bot.job_http_requests(job, request_id)
    SELECT 'maintenance', net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_url') || '/api/jobs/maintenance',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
            'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_cron_secret')),
        body := '{}'::jsonb, timeout_milliseconds := 250000
    );
$job$);
SELECT cron.schedule('fortnite-status', '*/3 15-20 * * *', $job$
    INSERT INTO fortnite_bot.job_http_requests(job, request_id)
    SELECT 'status', net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_url') || '/api/jobs/status',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
            'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_cron_secret')),
        body := '{}'::jsonb, timeout_milliseconds := 250000
    );
$job$);
-- SQL retention avoids a daily serverless invocation.
SELECT cron.schedule('fortnite-cleanup', '0 1 * * *', $job$
    DELETE FROM fortnite_bot.squad_snapshots
    WHERE fetched_at < now() - interval '30 days';
    -- Preserve a day of stale fallback; remove old hash keys and failure markers.
    DELETE FROM fortnite_bot.statistics_cache
    WHERE expires_at < now() - interval '1 day'
      AND (retry_after IS NULL OR retry_after < now());
$job$);
COMMIT;
