ALTER TABLE "irc_users"
  ADD COLUMN IF NOT EXISTS "deletion_status" text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "deletion_requested_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "clerk_deletion_status" text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "clerk_deletion_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "clerk_deletion_last_error" text;

ALTER TABLE "irc_admin_audit_logs"
  DROP CONSTRAINT IF EXISTS "irc_admin_audit_logs_community_id_irc_communities_id_fk";
ALTER TABLE "irc_admin_audit_logs"
  ADD CONSTRAINT "irc_admin_audit_logs_community_id_irc_communities_id_fk"
  FOREIGN KEY ("community_id") REFERENCES "irc_communities"("id") ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "irc_workspace_object_deletion_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "object_path" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "context" text NOT NULL DEFAULT 'workspace',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz
);