DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "irc_document_downloads" download
    JOIN "irc_document_versions" version
      ON version."id" = download."version_id"
    WHERE download."document_id" IS DISTINCT FROM version."document_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce document download integrity: version belongs to another document';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "irc_document_versions_id_document_id_uidx"
  ON "irc_document_versions" ("id", "document_id");

ALTER TABLE "irc_document_downloads"
  DROP CONSTRAINT IF EXISTS "irc_document_downloads_version_document_fk";

ALTER TABLE "irc_document_downloads"
  ADD CONSTRAINT "irc_document_downloads_version_document_fk"
  FOREIGN KEY ("version_id", "document_id")
  REFERENCES "irc_document_versions" ("id", "document_id")
  ON DELETE CASCADE;