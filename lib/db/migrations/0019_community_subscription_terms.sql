-- Existing approved upgrades (expires_at IS NULL) are permanent purchases.
-- New approvals have a paid-through date; no historical purchase is revoked.
ALTER TABLE "irc_community_upgrade_requests"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "irc_community_upgrade_active_idx"
  ON "irc_community_upgrade_requests" ("user_id", "expires_at")
  WHERE "status" = 'approved' AND "expires_at" IS NOT NULL;