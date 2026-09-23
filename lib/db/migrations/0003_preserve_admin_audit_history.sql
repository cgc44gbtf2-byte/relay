ALTER TABLE "irc_admin_audit_logs"
  DROP CONSTRAINT IF EXISTS "irc_admin_audit_logs_actor_id_irc_users_clerk_id_fk";

ALTER TABLE "irc_admin_audit_logs"
  ALTER COLUMN "actor_id" DROP NOT NULL;

ALTER TABLE "irc_admin_audit_logs"
  ADD CONSTRAINT "irc_admin_audit_logs_actor_id_irc_users_clerk_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "irc_users"("clerk_id") ON DELETE SET NULL;