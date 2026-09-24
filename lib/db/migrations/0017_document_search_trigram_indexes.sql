-- Support the document search endpoint's leading-wildcard ILIKE predicates.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "irc_business_documents_title_trgm_idx"
  ON "irc_business_documents" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "irc_business_documents_description_trgm_idx"
  ON "irc_business_documents" USING gin ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "irc_business_documents_category_trgm_idx"
  ON "irc_business_documents" USING gin ("category" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "irc_document_versions_filename_trgm_idx"
  ON "irc_document_versions" USING gin ("file_name" gin_trgm_ops);