ALTER TABLE "irc_workspace_invitations"
  ADD COLUMN IF NOT EXISTS "email_attempt_id" uuid,
  ADD COLUMN IF NOT EXISTS "email_provider_id" text,
  ADD COLUMN IF NOT EXISTS "email_delivery_status" text NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS "email_delivery_updated_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "irc_workspace_invitations_email_attempt_idx"
  ON "irc_workspace_invitations" ("email_attempt_id");