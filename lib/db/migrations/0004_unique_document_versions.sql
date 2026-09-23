DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "irc_document_versions"
    GROUP BY "document_id", "version"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique document versions: duplicate document_id/version rows exist';
  END IF;
END
$$;

DROP INDEX IF EXISTS "irc_document_versions_document_version_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "irc_document_versions_document_version_uidx"
  ON "irc_document_versions" ("document_id", "version");