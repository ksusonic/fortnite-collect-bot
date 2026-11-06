SET LOCAL search_path = fortnite_bot;
-- Legacy rows and old deployments continue to represent Fortnite.
CREATE UNIQUE INDEX sessions_one_open_per_game
ON sessions(chat_id, (COALESCE(gathering->>'game', 'fortnite')))
WHERE NOT is_closed;
DROP INDEX sessions_one_open;
