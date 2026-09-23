DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "irc_channels" channel
    LEFT JOIN "irc_categories" category
      ON category."id" = channel."category_id"
    WHERE channel."category_id" IS NOT NULL
      AND category."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce channel category integrity: orphan category references exist';
  END IF;
END
$$;

ALTER TABLE "irc_channels"
  DROP CONSTRAINT IF EXISTS "irc_channels_category_id_fk";

ALTER TABLE "irc_channels"
  ADD CONSTRAINT "irc_channels_category_id_fk"
  FOREIGN KEY ("category_id")
  REFERENCES "irc_categories" ("id")
  ON DELETE SET NULL;