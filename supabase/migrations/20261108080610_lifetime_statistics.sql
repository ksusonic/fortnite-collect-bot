CREATE TABLE fortnite_bot.lifetime_snapshots (
    epic_account_id text NOT NULL,
    fetched_at timestamptz NOT NULL,
    matches integer NOT NULL CHECK (matches >= 0),
    wins integer NOT NULL CHECK (wins >= 0 AND wins <= matches),
    kills integer NOT NULL CHECK (kills >= 0),
    deaths_est integer NOT NULL CHECK (deaths_est >= 0),
    kd double precision NOT NULL CHECK (kd >= 0),
    PRIMARY KEY (epic_account_id, fetched_at)
);
CREATE INDEX lifetime_snapshots_fetched ON fortnite_bot.lifetime_snapshots(fetched_at);
ALTER TABLE fortnite_bot.lifetime_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fortnite_bot.lifetime_snapshots FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON fortnite_bot.lifetime_snapshots FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON fortnite_bot.lifetime_snapshots FROM authenticated;
    END IF;
END $$;

-- Extend the existing SQL-only cleanup without changing its URL or schedule.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
        EXECUTE $cron$
          SELECT cron.alter_job(jobid, command := command ||
            E'\nDELETE FROM fortnite_bot.lifetime_snapshots WHERE fetched_at < now() - interval ''30 days'';')
          FROM cron.job WHERE jobname='fortnite-cleanup'
        $cron$;
    END IF;
END $$;
