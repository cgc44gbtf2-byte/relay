ALTER TABLE "irc_user_roles" ADD COLUMN IF NOT EXISTS "department_id" integer;
ALTER TABLE "irc_user_roles" ADD CONSTRAINT "irc_user_roles_department_id_irc_departments_id_fk"
  FOREIGN KEY ("department_id") REFERENCES "irc_departments" ("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "irc_user_roles_department_idx" ON "irc_user_roles" ("department_id");
CREATE UNIQUE INDEX IF NOT EXISTS "irc_user_roles_department_unique_idx"
  ON "irc_user_roles" ("user_id", "role", "department_id")
  WHERE "scope_type" = 'department' AND "department_id" IS NOT NULL;