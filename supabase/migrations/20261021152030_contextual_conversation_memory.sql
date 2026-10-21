-- Existing work must retain its checkpoint order; only newly enqueued work uses v2.
ALTER TABLE fortnite_bot.work_items ADD COLUMN conversation_version integer NOT NULL DEFAULT 1;
-- New application code explicitly stamps v2; old deployment enqueuers retain v1.

CREATE TABLE fortnite_bot.conversation_messages (
  chat_id bigint NOT NULL REFERENCES fortnite_bot.approved_chats(chat_id) ON DELETE CASCADE,
  message_id bigint NOT NULL, user_id bigint NOT NULL, name text NOT NULL,
  text text NOT NULL, sent_at timestamptz NOT NULL, edited_at timestamptz,
  thread_id bigint NOT NULL DEFAULT 0, reply_to_id bigint, is_bot boolean NOT NULL DEFAULT false,
  forwarded boolean NOT NULL DEFAULT false,
  citation_refs text[] NOT NULL DEFAULT '{}',
  processed boolean NOT NULL DEFAULT false, forgotten boolean NOT NULL DEFAULT false,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('russian', text) || to_tsvector('simple', text)) STORED,
  PRIMARY KEY(chat_id,message_id)
);
CREATE INDEX conversation_messages_search ON fortnite_bot.conversation_messages USING gin(search_vector);
CREATE INDEX conversation_messages_recent ON fortnite_bot.conversation_messages(chat_id,thread_id,sent_at DESC,message_id DESC);
CREATE INDEX conversation_messages_pending ON fortnite_bot.conversation_messages(chat_id,sent_at,message_id) WHERE NOT processed AND NOT forgotten AND NOT is_bot;

CREATE TABLE fortnite_bot.conversation_memories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id bigint NOT NULL REFERENCES fortnite_bot.approved_chats(chat_id) ON DELETE CASCADE,
  source_message_id bigint NOT NULL, user_id bigint NOT NULL, name text NOT NULL,
  thread_id bigint NOT NULL DEFAULT 0, content text NOT NULL, quote text NOT NULL,
  source_at timestamptz NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  explicit boolean NOT NULL DEFAULT false,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('russian', content) || to_tsvector('simple', content)) STORED,
  UNIQUE(chat_id,source_message_id,content)
);
CREATE INDEX conversation_memories_search ON fortnite_bot.conversation_memories USING gin(search_vector);
CREATE INDEX conversation_memories_chat ON fortnite_bot.conversation_memories(chat_id,thread_id,user_id);

CREATE TABLE fortnite_bot.conversation_state (
  chat_id bigint NOT NULL REFERENCES fortnite_bot.approved_chats(chat_id) ON DELETE CASCADE,
  thread_id bigint NOT NULL DEFAULT 0, dialogue_user_id bigint, dialogue_until timestamptz,
  pending_user_id bigint, pending_question text, evaluated_at timestamptz, proactive_at timestamptz, reacted_at timestamptz,
  extracted_at timestamptz, PRIMARY KEY(chat_id,thread_id)
);
CREATE TABLE fortnite_bot.conversation_memory_epochs (
  chat_id bigint NOT NULL REFERENCES fortnite_bot.approved_chats(chat_id) ON DELETE CASCADE,
  user_id bigint NOT NULL, epoch integer NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE fortnite_bot.conversation_memory_deletions (
  chat_id bigint NOT NULL REFERENCES fortnite_bot.approved_chats(chat_id) ON DELETE CASCADE,
  user_id bigint NOT NULL, epoch integer NOT NULL, attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(), complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY(chat_id,user_id,epoch)
);
-- Seed only verifiable IDs from the bounded existing history. No Telegram backfill.
INSERT INTO fortnite_bot.conversation_messages(chat_id,message_id,user_id,name,text,sent_at,reply_to_id,is_bot,processed)
SELECT r.chat_id,(h->>'message_id')::bigint,0,COALESCE(h->>'name',''),h->>'text',
  to_timestamp((h->>'ts')::double precision),(h->>'reply_to_id')::bigint,h->>'role'='assistant',true
FROM fortnite_bot.roast_state r JOIN fortnite_bot.approved_chats a USING(chat_id),
  LATERAL jsonb_array_elements(r.history_json) h
WHERE h->>'message_id' ~ '^[0-9]+$' AND h->>'text' IS NOT NULL
  AND h->>'ts' ~ '^[0-9]+(\.[0-9]+)?$'
  AND to_timestamp((h->>'ts')::double precision)>now()-interval '30 days'
ON CONFLICT DO NOTHING;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_messages','conversation_memories','conversation_state','conversation_memory_epochs','conversation_memory_deletions'] LOOP
    EXECUTE format('ALTER TABLE fortnite_bot.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON fortnite_bot.%I FROM PUBLIC',t);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON fortnite_bot.%I FROM anon,authenticated',t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE fortnite_bot.conversation_memories_id_seq FROM PUBLIC;
