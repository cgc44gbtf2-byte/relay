-- Add the unique key tie-breaker used by paginated collection orderings.
-- Rebuild equivalent indexes in place rather than retaining redundant
-- timestamp-only variants.
DROP INDEX IF EXISTS "irc_workspace_invitations_community_created_idx";
CREATE INDEX IF NOT EXISTS "irc_workspace_invitations_community_created_idx"
  ON "irc_workspace_invitations" ("community_id", "created_at", "id");

DROP INDEX IF EXISTS "irc_workspace_tasks_community_updated_idx";
CREATE INDEX IF NOT EXISTS "irc_workspace_tasks_community_updated_idx"
  ON "irc_workspace_tasks" ("community_id", "updated_at", "id");

DROP INDEX IF EXISTS "irc_business_documents_community_updated_idx";
CREATE INDEX IF NOT EXISTS "irc_business_documents_community_updated_idx"
  ON "irc_business_documents" ("community_id", "updated_at", "id");

DROP INDEX IF EXISTS "irc_moderation_actions_community_created_idx";
CREATE INDEX IF NOT EXISTS "irc_moderation_actions_community_created_idx"
  ON "irc_moderation_actions" ("community_id", "created_at", "id");