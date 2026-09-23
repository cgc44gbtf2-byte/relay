-- Add indexes for the current high-growth read, cleanup, and audit paths.
-- Keep these additive so the migration is safe for existing installations.
CREATE INDEX IF NOT EXISTS "irc_team_members_user_idx"
  ON "irc_team_members" ("user_id");

CREATE INDEX IF NOT EXISTS "irc_employee_profiles_community_department_idx"
  ON "irc_employee_profiles" ("community_id", "department_id");

CREATE INDEX IF NOT EXISTS "irc_employee_profiles_community_location_idx"
  ON "irc_employee_profiles" ("community_id", "location_id");

CREATE INDEX IF NOT EXISTS "irc_employee_profiles_manager_idx"
  ON "irc_employee_profiles" ("manager_id");

CREATE INDEX IF NOT EXISTS "irc_document_acknowledgements_user_idx"
  ON "irc_document_acknowledgements" ("user_id");

CREATE INDEX IF NOT EXISTS "irc_document_downloads_user_idx"
  ON "irc_document_downloads" ("user_id");

CREATE INDEX IF NOT EXISTS "irc_workspace_tasks_assignee_status_due_idx"
  ON "irc_workspace_tasks" ("assigned_to", "status", "due_date");

CREATE INDEX IF NOT EXISTS "irc_policy_acknowledgements_user_idx"
  ON "irc_policy_acknowledgements" ("user_id");

CREATE INDEX IF NOT EXISTS "irc_channel_join_requests_channel_status_idx"
  ON "irc_channel_join_requests" ("channel_id", "status");

CREATE INDEX IF NOT EXISTS "irc_blocks_blocked_idx"
  ON "irc_blocks" ("blocked_id");

CREATE INDEX IF NOT EXISTS "irc_notifications_user_visibility_idx"
  ON "irc_notifications" ("user_id", "archived_at", "deleted_at", "created_at");

CREATE INDEX IF NOT EXISTS "irc_moderation_actions_community_created_idx"
  ON "irc_moderation_actions" ("community_id", "created_at");

CREATE INDEX IF NOT EXISTS "irc_moderation_actions_channel_created_idx"
  ON "irc_moderation_actions" ("channel_id", "created_at");

CREATE INDEX IF NOT EXISTS "irc_moderation_actions_actor_created_idx"
  ON "irc_moderation_actions" ("actor_id", "created_at");

CREATE INDEX IF NOT EXISTS "irc_admin_audit_logs_community_action_created_idx"
  ON "irc_admin_audit_logs" ("community_id", "action", "created_at", "id");

CREATE INDEX IF NOT EXISTS "irc_admin_audit_logs_community_actor_created_idx"
  ON "irc_admin_audit_logs" ("community_id", "actor_id", "created_at", "id");