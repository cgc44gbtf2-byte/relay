-- Partial page indexes preserve created_at,id ordering for each notification
-- visibility state while excluding deleted rows.
DROP INDEX IF EXISTS "irc_notifications_user_visibility_idx";

CREATE INDEX IF NOT EXISTS "irc_notifications_user_active_page_idx"
  ON "irc_notifications" ("user_id", "created_at", "id")
  WHERE "deleted_at" IS NULL AND "archived_at" IS NULL;

CREATE INDEX IF NOT EXISTS "irc_notifications_user_archived_page_idx"
  ON "irc_notifications" ("user_id", "created_at", "id")
  WHERE "deleted_at" IS NULL AND "archived_at" IS NOT NULL;