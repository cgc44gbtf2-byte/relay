ALTER TABLE "irc_workspace_object_deletion_jobs"
  ADD COLUMN IF NOT EXISTS "alerted_at" timestamptz;