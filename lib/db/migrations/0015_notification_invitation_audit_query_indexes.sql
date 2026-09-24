-- Cover notification deduplication, pending invitation checks, and the
-- unscoped admin activity cursor query.
CREATE INDEX IF NOT EXISTS "irc_notifications_user_entity_idx"
  ON "irc_notifications" ("user_id", "type", "entity_type", "entity_id");

CREATE INDEX IF NOT EXISTS "irc_workspace_invitations_community_email_status_idx"
  ON "irc_workspace_invitations" ("community_id", "email", "status");

CREATE INDEX IF NOT EXISTS "irc_admin_audit_logs_created_idx"
  ON "irc_admin_audit_logs" ("created_at", "id");