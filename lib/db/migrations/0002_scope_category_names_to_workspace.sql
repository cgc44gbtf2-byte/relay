DROP INDEX IF EXISTS "irc_categories_owner_name_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "irc_categories_owner_community_name_idx"
  ON "irc_categories" ("owner_id", "community_id", "name");