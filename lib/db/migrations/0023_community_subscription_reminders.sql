-- A reminder belongs to a paid term, not the account: a later renewal can be
-- reminded independently. Permanent historical purchases have no expiry.
ALTER TABLE "irc_community_upgrade_requests"
  ADD COLUMN IF NOT EXISTS "reminder_sent_at" TIMESTAMPTZ;