SET search_path = fortnite_bot, public;

-- The most recently linked account wins when a user had links in multiple chats.
-- chat_id breaks equal-timestamp ties deterministically.
LOCK TABLE epic_links IN ACCESS EXCLUSIVE MODE;
DELETE FROM epic_links older USING epic_links newer
WHERE older.user_id = newer.user_id
  AND (older.linked_at, older.chat_id) < (newer.linked_at, newer.chat_id);
ALTER TABLE epic_links DROP CONSTRAINT epic_links_pkey;
ALTER TABLE epic_links DROP COLUMN chat_id;
ALTER TABLE epic_links ADD PRIMARY KEY (user_id);
