ALTER TABLE "irc_community_upgrade_requests"
  ADD COLUMN IF NOT EXISTS "reminder_email_attempted_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "reminder_email_sent_at" TIMESTAMPTZ;