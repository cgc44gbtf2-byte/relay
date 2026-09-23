DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "irc_document_folders" child
    LEFT JOIN "irc_document_folders" parent
      ON parent."id" = child."parent_id"
    WHERE child."parent_id" IS NOT NULL
      AND (
        parent."id" IS NULL
        OR parent."community_id" <> child."community_id"
      )
  ) THEN
    RAISE EXCEPTION 'Cannot enforce document folder tenant scope: invalid parent relationships exist';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "irc_document_folders_id_community_uidx"
  ON "irc_document_folders" ("id", "community_id");

ALTER TABLE "irc_document_folders"
  DROP CONSTRAINT IF EXISTS "irc_document_folders_parent_tenant_fk";

ALTER TABLE "irc_document_folders"
  ADD CONSTRAINT "irc_document_folders_parent_tenant_fk"
  FOREIGN KEY ("parent_id", "community_id")
  REFERENCES "irc_document_folders" ("id", "community_id")
  ON DELETE RESTRICT;