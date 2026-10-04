CREATE TABLE fortnite_bot.approved_chats (
    chat_id bigint PRIMARY KEY CHECK (chat_id < 0),
    approved_by bigint NOT NULL CHECK (approved_by > 0),
    approved_at timestamptz NOT NULL DEFAULT now()
);
-- No backfill: every existing or recovered chat requires explicit owner /init.
ALTER TABLE fortnite_bot.approved_chats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fortnite_bot.approved_chats FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON fortnite_bot.approved_chats FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON fortnite_bot.approved_chats FROM authenticated;
    END IF;
END $$;
