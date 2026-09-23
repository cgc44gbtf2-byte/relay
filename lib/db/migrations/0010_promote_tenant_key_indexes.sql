-- Drizzle's PostgreSQL introspection omits standalone unique indexes referenced
-- by foreign keys. Attach the existing indexes as constraints without rebuilding
-- them, changing their names, or dropping the foreign keys that rely on them.
BEGIN;

ALTER TABLE "irc_departments"
  ADD CONSTRAINT "irc_departments_id_community_uidx"
  UNIQUE USING INDEX "irc_departments_id_community_uidx";

ALTER TABLE "irc_locations"
  ADD CONSTRAINT "irc_locations_id_community_uidx"
  UNIQUE USING INDEX "irc_locations_id_community_uidx";

ALTER TABLE "irc_document_folders"
  ADD CONSTRAINT "irc_document_folders_id_community_uidx"
  UNIQUE USING INDEX "irc_document_folders_id_community_uidx";

ALTER TABLE "irc_document_versions"
  ADD CONSTRAINT "irc_document_versions_id_document_id_uidx"
  UNIQUE USING INDEX "irc_document_versions_id_document_id_uidx";

COMMIT;