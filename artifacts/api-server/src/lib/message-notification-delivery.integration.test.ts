import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { pool } from "@workspace/db";
import { processMessageNotificationDeliveries } from "./message-notification-delivery";

if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) {
  throw new Error("Message notification integration tests require TEST_DATABASE_URL and refuse DATABASE_URL.");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const users = {
  sender: `notify_sender_${suffix}`,
  first: `notify_first_${suffix}`,
  second: `notify_second_${suffix}`,
};
let communityId: number;
let channelId: number;

async function insertPendingMessage(values: {
  body: string;
  channelId?: number;
  recipientId?: string;
  notificationRecipientIds: string[];
  deleted?: boolean;
}): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO irc_messages
       (channel_id, sender_id, recipient_id, thread_key, body, deleted_at,
        notification_status, notification_recipient_ids)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     RETURNING id`,
    [
      values.channelId ?? null,
      users.sender,
      values.recipientId ?? null,
      values.recipientId ? [users.sender, values.recipientId].sort().join(":") : null,
      values.body,
      values.deleted ? new Date() : null,
      values.notificationRecipientIds,
    ],
  );
  return inserted.rows[0].id;
}

describe("message notification delivery PostgreSQL integration", () => {
  before(async () => {
    await pool.query(
      `INSERT INTO irc_users (clerk_id, username, display_name)
       VALUES ($1, $1, $1), ($2, $2, $2), ($3, $3, $3)`,
      [users.sender, users.first, users.second],
    );
    const community = await pool.query<{ id: number }>(
      `INSERT INTO irc_communities (name, slug, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`Notification delivery ${suffix}`, `notification-delivery-${suffix}`, users.sender],
    );
    communityId = community.rows[0].id;
    const channel = await pool.query<{ id: number }>(
      `INSERT INTO irc_channels (name, owner_id, community_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`notify-${suffix}`, users.sender, communityId],
    );
    channelId = channel.rows[0].id;
    await pool.query(
      `INSERT INTO irc_channel_members (channel_id, user_id)
       VALUES ($1, $2), ($1, $3), ($1, $4)`,
      [channelId, users.sender, users.first, users.second],
    );
  });

  after(async () => {
    await pool.query("DELETE FROM irc_notifications WHERE user_id = ANY($1::text[])", [Object.values(users)]);
    await pool.query("DELETE FROM irc_messages WHERE sender_id = $1", [users.sender]);
    await pool.query("DELETE FROM irc_channel_members WHERE channel_id = $1", [channelId]);
    await pool.query("DELETE FROM irc_channels WHERE id = $1", [channelId]);
    await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
    await pool.query("DELETE FROM irc_users WHERE clerk_id = ANY($1::text[])", [Object.values(users)]);
    await pool.end();
  });

  test("bounds retries and leaves terminal failures unclaimable", async () => {
    const messageId = await insertPendingMessage({
      body: `Terminal failure ${suffix}`,
      recipientId: users.first,
      notificationRecipientIds: [users.first],
    });
    const trigger = `fail_terminal_notification_${suffix}`;
    await pool.query(
      `CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.entity_id = '${messageId}' THEN
           RAISE EXCEPTION 'forced terminal notification failure';
         END IF;
         RETURN NEW;
       END; $$;
       CREATE TRIGGER "${trigger}" BEFORE INSERT ON irc_notifications
       FOR EACH ROW EXECUTE FUNCTION "${trigger}"();`,
    );
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await processMessageNotificationDeliveries({ batchSize: 1 });
        assert.deepEqual(result, { processed: 1, delivered: 0, skipped: 0, failed: 1 });
        const state = await pool.query<{
          notification_status: string;
          notification_attempts: number;
          notification_last_error: string;
        }>(
          `SELECT notification_status, notification_attempts, notification_last_error
           FROM irc_messages WHERE id = $1`,
          [messageId],
        );
        assert.equal(state.rows[0].notification_attempts, attempt);
        assert.equal(state.rows[0].notification_status, attempt === 5 ? "failed" : "pending");
        assert.equal(state.rows[0].notification_last_error, "sqlstate:P0001");
        await pool.query(
          "UPDATE irc_messages SET notification_next_attempt_at = now() WHERE id = $1",
          [messageId],
        );
      }
      assert.deepEqual(
        await processMessageNotificationDeliveries({ batchSize: 1 }),
        { processed: 0, delivered: 0, skipped: 0, failed: 0 },
      );
      const notices = await pool.query(
        "SELECT id FROM irc_notifications WHERE entity_type = 'message' AND entity_id = $1",
        [messageId],
      );
      assert.equal(notices.rowCount, 0);
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS "${trigger}" ON irc_notifications;
         DROP FUNCTION IF EXISTS "${trigger}"();`,
      );
    }
  });

  test("rolls back a partial mention fanout before a clean retry", async () => {
    const messageId = await insertPendingMessage({
      body: `Hello @${users.first} and @${users.second}`,
      channelId,
      notificationRecipientIds: [users.first, users.second],
    });
    const trigger = `fail_fanout_notification_${suffix}`;
    await pool.query(
      `CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.entity_id = '${messageId}' AND NEW.user_id = '${users.second}' THEN
           RAISE EXCEPTION 'forced partial fanout failure';
         END IF;
         RETURN NEW;
       END; $$;
       CREATE TRIGGER "${trigger}" BEFORE INSERT ON irc_notifications
       FOR EACH ROW EXECUTE FUNCTION "${trigger}"();`,
    );
    try {
      assert.deepEqual(
        await processMessageNotificationDeliveries({ batchSize: 1 }),
        { processed: 1, delivered: 0, skipped: 0, failed: 1 },
      );
      assert.equal((await pool.query(
        "SELECT id FROM irc_notifications WHERE entity_type = 'message' AND entity_id = $1",
        [messageId],
      )).rowCount, 0);
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS "${trigger}" ON irc_notifications;
         DROP FUNCTION IF EXISTS "${trigger}"();`,
      );
    }

    await pool.query("UPDATE irc_messages SET body = 'edited after enqueue' WHERE id = $1", [messageId]);
    await pool.query(
      "UPDATE irc_users SET username = $1 WHERE clerk_id = $2",
      [`renamed_${suffix}`, users.first],
    );
    await pool.query(
      "UPDATE irc_messages SET notification_next_attempt_at = now() WHERE id = $1",
      [messageId],
    );
    assert.deepEqual(
      await processMessageNotificationDeliveries({ batchSize: 1 }),
      { processed: 1, delivered: 1, skipped: 0, failed: 0 },
    );
    const recipients = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM irc_notifications
       WHERE entity_type = 'message' AND entity_id = $1
       ORDER BY user_id`,
      [messageId],
    );
    assert.deepEqual(recipients.rows.map(({ user_id }) => user_id), [users.first, users.second].sort());
  });

  test("skips a deleted pending message without creating a notification", async () => {
    const messageId = await insertPendingMessage({
      body: `Deleted message ${suffix}`,
      recipientId: users.first,
      notificationRecipientIds: [users.first],
      deleted: true,
    });
    assert.deepEqual(
      await processMessageNotificationDeliveries({ batchSize: 1 }),
      { processed: 1, delivered: 0, skipped: 1, failed: 0 },
    );
    const state = await pool.query<{ notification_status: string; notification_attempts: number }>(
      `SELECT notification_status, notification_attempts
       FROM irc_messages WHERE id = $1`,
      [messageId],
    );
    assert.deepEqual(state.rows[0], { notification_status: "skipped", notification_attempts: 0 });
    assert.equal((await pool.query(
      "SELECT id FROM irc_notifications WHERE entity_type = 'message' AND entity_id = $1",
      [messageId],
    )).rowCount, 0);
  });
});