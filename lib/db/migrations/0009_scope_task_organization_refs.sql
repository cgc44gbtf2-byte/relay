DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "irc_workspace_tasks" task
    JOIN "irc_departments" department
      ON department."id" = task."department_id"
    WHERE task."community_id" IS DISTINCT FROM department."community_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce task department scope: cross-workspace references exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "irc_workspace_tasks" task
    JOIN "irc_locations" location
      ON location."id" = task."location_id"
    WHERE task."community_id" IS DISTINCT FROM location."community_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce task location scope: cross-workspace references exist';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "irc_departments_id_community_uidx"
  ON "irc_departments" ("id", "community_id");

CREATE UNIQUE INDEX IF NOT EXISTS "irc_locations_id_community_uidx"
  ON "irc_locations" ("id", "community_id");

ALTER TABLE "irc_workspace_tasks"
  DROP CONSTRAINT IF EXISTS "irc_workspace_tasks_department_tenant_fk";

ALTER TABLE "irc_workspace_tasks"
  ADD CONSTRAINT "irc_workspace_tasks_department_tenant_fk"
  FOREIGN KEY ("department_id", "community_id")
  REFERENCES "irc_departments" ("id", "community_id");

ALTER TABLE "irc_workspace_tasks"
  DROP CONSTRAINT IF EXISTS "irc_workspace_tasks_location_tenant_fk";

ALTER TABLE "irc_workspace_tasks"
  ADD CONSTRAINT "irc_workspace_tasks_location_tenant_fk"
  FOREIGN KEY ("location_id", "community_id")
  REFERENCES "irc_locations" ("id", "community_id");