SET LOCAL search_path = fortnite_bot;
ALTER TABLE sessions ADD COLUMN gathering jsonb NOT NULL DEFAULT '{"prompts":{},"revisions":{}}';
ALTER TABLE responses ADD COLUMN available_at timestamptz;
ALTER TABLE responses ADD COLUMN ready_at timestamptz;
UPDATE responses r SET available_at = CASE
  WHEN r.time_slot = 'now' THEN r.responded_at
  WHEN r.time_slot ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    THEN ((s.created_at AT TIME ZONE 'Europe/Moscow')::date + r.time_slot::time) AT TIME ZONE 'Europe/Moscow'
  ELSE NULL END
FROM sessions s WHERE r.chat_id=s.chat_id AND r.message_id=s.message_id AND r.response='go';
