DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "irc_messages" message
    LEFT JOIN "irc_messages" parent
      ON parent."id" = message."reply_to_id"
    WHERE message."reply_to_id" IS NOT NULL
      AND parent."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce message reply integrity: orphan reply references exist';
  END IF;
END
$$;

ALTER TABLE "irc_messages"
  DROP CONSTRAINT IF EXISTS "irc_messages_reply_to_id_fk";

ALTER TABLE "irc_messages"
  ADD CONSTRAINT "irc_messages_reply_to_id_fk"
  FOREIGN KEY ("reply_to_id")
  REFERENCES "irc_messages" ("id")
  ON DELETE SET NULL;