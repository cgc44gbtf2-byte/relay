-- Support the admin overview's global recent-message snapshot.
CREATE INDEX IF NOT EXISTS "irc_messages_created_idx"
  ON "irc_messages" ("created_at");