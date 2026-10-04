-- Apply before deploying the runtime that no longer reads import markers.
-- Preserve preferences before removing the retired roast feature rows.
INSERT INTO fortnite_bot.roast_profiles(chat_id,preferences,last_evaluated_at)
SELECT f.chat_id,jsonb_build_object('proactive',f.enabled),r.last_roast
FROM fortnite_bot.chat_features f
LEFT JOIN fortnite_bot.roast_state r ON r.chat_id=f.chat_id
WHERE f.feature='roast'
ON CONFLICT(chat_id) DO NOTHING;
DELETE FROM fortnite_bot.chat_features WHERE feature='roast';

-- Update an existing cleanup schedule before removing its import marker table.
DO $$ BEGIN
    IF to_regclass('cron.job') IS NOT NULL AND EXISTS (SELECT 1 FROM cron.job WHERE jobname='fortnite-cleanup') THEN
        PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='fortnite-cleanup'), command := $cleanup$
            DELETE FROM fortnite_bot.squad_snapshots
            WHERE fetched_at < now() - interval '30 days';
        $cleanup$);
    END IF;
END $$;
DROP TABLE IF EXISTS fortnite_bot.import_manifest;
DROP TABLE IF EXISTS fortnite_bot.news_sent;
DROP TABLE IF EXISTS fortnite_bot.fortnite_news_seen;
