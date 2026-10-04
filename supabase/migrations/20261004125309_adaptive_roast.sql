CREATE TABLE fortnite_bot.roast_profiles (
    chat_id bigint PRIMARY KEY,
    preferences jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(preferences) = 'object'),
    pending_question text,
    last_evaluated_at timestamptz,
    changed_by bigint,
    changed_message_id bigint,
    changed_at timestamptz
);
INSERT INTO fortnite_bot.roast_profiles(chat_id, preferences, last_evaluated_at)
SELECT f.chat_id, jsonb_build_object('proactive', f.enabled), r.last_roast
FROM fortnite_bot.chat_features f
LEFT JOIN fortnite_bot.roast_state r ON r.chat_id = f.chat_id
WHERE f.feature = 'roast';
ALTER TABLE fortnite_bot.roast_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fortnite_bot.roast_profiles FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON fortnite_bot.roast_profiles FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON fortnite_bot.roast_profiles FROM authenticated;
    END IF;
END $$;
