-- Apply with Supabase tools after production routes pass verification.
-- Vault must contain fortnite_bot_url and fortnite_bot_cron_secret.
-- pg_cron uses UTC: 15..20 UTC = 18..23 MSK; 18 UTC Friday = 21 MSK.
SELECT cron.schedule('fortnite-expiry', '* * * * *', $job$
    INSERT INTO fortnite_bot.job_http_requests(job, request_id)
    SELECT 'expiry', net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_url') || '/api/jobs/expiry',
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
SELECT cron.schedule('fortnite-weekly', '*/5 18 * * 5', $job$
    INSERT INTO fortnite_bot.job_http_requests(job, request_id)
    SELECT 'weekly', net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_url') || '/api/jobs/weekly',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
            'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_cron_secret')),
        body := '{}'::jsonb, timeout_milliseconds := 250000
    );
$job$);
SELECT cron.schedule('fortnite-cleanup', '0 1 * * *', $job$
    INSERT INTO fortnite_bot.job_http_requests(job, request_id)
    SELECT 'cleanup', net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_url') || '/api/jobs/cleanup',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
            'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='fortnite_bot_cron_secret')),
        body := '{}'::jsonb, timeout_milliseconds := 250000
    );
$job$);
