ALTER TABLE "irc_moderation_actions"
  ADD COLUMN "actor_display_name" text;

UPDATE "irc_moderation_actions" AS moderation
SET "actor_display_name" = users."display_name"
FROM "irc_users" AS users
WHERE users."clerk_id" = moderation."actor_id"
  AND moderation."actor_display_name" IS NULL;