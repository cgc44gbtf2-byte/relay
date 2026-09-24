ALTER TABLE "irc_workspace_object_deletion_jobs"
  ADD COLUMN IF NOT EXISTS "claim_token" text,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz;

CREATE INDEX IF NOT EXISTS "irc_object_deletion_claim_idx"
  ON "irc_workspace_object_deletion_jobs" ("status", "lease_expires_at", "created_at");