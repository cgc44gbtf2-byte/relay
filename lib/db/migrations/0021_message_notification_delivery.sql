ALTER TABLE "irc_messages"
  ADD COLUMN IF NOT EXISTS "notification_status" text NOT NULL DEFAULT 'skipped',
  ADD COLUMN IF NOT EXISTS "notification_recipient_ids" text[] DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS "notification_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "notification_next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "notification_last_error" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'irc_messages_notification_status_check'
      AND conrelid = 'irc_messages'::regclass
  ) THEN
    ALTER TABLE "irc_messages"
      ADD CONSTRAINT "irc_messages_notification_status_check"
      CHECK ("notification_status" IN ('pending', 'delivered', 'failed', 'skipped'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "irc_messages_notification_due_idx"
  ON "irc_messages" ("notification_next_attempt_at", "id")
  WHERE "notification_status" = 'pending';