-- Soft-deleted notifications keep only their delivery metadata so deadline
-- deduplication cannot recreate notices the recipient cleared.
ALTER TABLE "irc_notifications"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;