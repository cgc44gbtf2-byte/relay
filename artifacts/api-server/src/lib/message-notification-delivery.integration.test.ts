import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
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

const crashWorkerPath = path.join(__dirname, "message-notification-delivery.crash-worker.cjs");

function startCrashWorker(applicationName: string, mode = "deliver"): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, PGAPPNAME: applicationName };
  delete env.DATABASE_URL;
  return spawn(process.execPath, [crashWorkerPath, mode], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function assertMessageLockHeld(messageId: string): Promise<void> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await assert.rejects(
      connection.query("SELECT id FROM irc_messages WHERE id = $1 FOR UPDATE NOWAIT", [messageId]),
      (error: unknown) => (error as { code?: string }).code === "55P03",
      "the worker should hold the claimed message row lock",
    );
  } finally {
    await connection.query("ROLLBACK").catch(() => {});
    connection.release();
  }
}

function waitForWorkerOutput(worker: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Worker did not write ${JSON.stringify(expected)} in time. Output: ${output}`));
    }, 10_000);

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(
        `Worker exited before writing ${JSON.stringify(expected)} (code=${code}, signal=${signal}). Output: ${output}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.stdout?.off("data", onData);
      worker.off("close", onClose);
    };

    worker.stdout?.on("data", onData);
    worker.once("close", onClose);
  });
}

async function waitForWorkerSleep(applicationName: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const active = await pool.query<{ pid: number }>(
      `SELECT pid
       FROM pg_stat_activity
       WHERE application_name = $1 AND wait_event = 'PgSleep'
       LIMIT 1`,
      [applicationName],
    );
    if (active.rows[0]) return active.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Worker ${applicationName} did not reach the blocking notification trigger.`);
}

async function waitForMessageLockRelease(messageId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "SELECT id FROM irc_messages WHERE id = $1 FOR UPDATE NOWAIT",
        [messageId],
      );
      await connection.query("ROLLBACK");
      return;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      if ((error as { code?: string }).code !== "55P03") throw error;
    } finally {
      connection.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`The crashed worker did not release the message lock for ${messageId}.`);
}

function waitForWorkerClose(worker: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The killed notification worker did not exit."));
    }, 10_000);
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("close", onClose);
    };
    worker.once("close", onClose);
  });
}

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

  test("does not send delayed mentions to a member removed before retry", async () => {
    const messageId = await insertPendingMessage({
      body: `Delayed mention for ${suffix}`,
      channelId,
      notificationRecipientIds: [users.first, users.second],
    });
    const trigger = `fail_removed_member_notification_${suffix}`;
    await pool.query(
      `CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.entity_id = '${messageId}' THEN
           RAISE EXCEPTION 'forced delayed mention failure';
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

    await pool.query(
      "DELETE FROM irc_channel_members WHERE channel_id = $1 AND user_id = $2",
      [channelId, users.second],
    );
    try {
      await pool.query(
        "UPDATE irc_messages SET notification_next_attempt_at = now() WHERE id = $1",
        [messageId],
      );
      assert.deepEqual(
        await processMessageNotificationDeliveries({ batchSize: 1 }),
        { processed: 1, delivered: 1, skipped: 0, failed: 0 },
      );
      const notices = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM irc_notifications
         WHERE entity_type = 'message' AND entity_id = $1`,
        [messageId],
      );
      assert.deepEqual(notices.rows.map(({ user_id }) => user_id), [users.first]);
      const state = await pool.query<{
        notification_status: string;
        notification_attempts: number;
        notification_recipient_ids: string[];
      }>(
        `SELECT notification_status, notification_attempts, notification_recipient_ids
         FROM irc_messages WHERE id = $1`,
        [messageId],
      );
      assert.equal(state.rows[0].notification_status, "delivered");
      assert.equal(state.rows[0].notification_attempts, 1);
      assert.deepEqual(
        state.rows[0].notification_recipient_ids.sort(),
        [users.first, users.second].sort(),
        "the retry must retain the send-time recipient snapshot without notifying the removed member",
      );

      const removedOnlyMessageId = await insertPendingMessage({
        body: `Only removed member ${suffix}`,
        channelId,
        notificationRecipientIds: [users.second],
      });
      assert.deepEqual(
        await processMessageNotificationDeliveries({ batchSize: 1 }),
        { processed: 1, delivered: 0, skipped: 1, failed: 0 },
      );
      const skipped = await pool.query<{ notification_status: string }>(
        "SELECT notification_status FROM irc_messages WHERE id = $1",
        [removedOnlyMessageId],
      );
      assert.equal(skipped.rows[0].notification_status, "skipped");
      assert.equal((await pool.query(
        "SELECT id FROM irc_notifications WHERE entity_type = 'message' AND entity_id = $1",
        [removedOnlyMessageId],
      )).rowCount, 0);
    } finally {
      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [channelId, users.second],
      );
    }
  });

  test("releases claimed messages and preserves recipient intent after a worker process crash", async () => {
    const messageId = await insertPendingMessage({
      body: `Crash during delivery ${suffix}`,
      channelId,
      notificationRecipientIds: [users.first, users.second],
    });
    const trigger = `pause_crash_notification_${suffix}`;
    const applicationName = `notify-crash-${suffix}`;
    await pool.query(
      `CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.entity_id = '${messageId}' THEN
           PERFORM pg_sleep(2);
         END IF;
         RETURN NEW;
       END; $$;
       CREATE TRIGGER "${trigger}" BEFORE INSERT ON irc_notifications
       FOR EACH ROW EXECUTE FUNCTION "${trigger}"();`,
    );

    let worker: ChildProcess | undefined;
    try {
      worker = startCrashWorker(applicationName);
      await waitForWorkerSleep(applicationName);
      await assertMessageLockHeld(messageId);
      worker.kill("SIGKILL");
      await waitForWorkerClose(worker);
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
        await waitForWorkerClose(worker).catch(() => {});
      }
      try {
        await waitForMessageLockRelease(messageId);
      } finally {
        await pool.query(
          `DROP TRIGGER IF EXISTS "${trigger}" ON irc_notifications;
           DROP FUNCTION IF EXISTS "${trigger}"();`,
        );
      }
    }

    const pending = await pool.query<{
      notification_status: string;
      notification_recipient_ids: string[];
    }>(
      `SELECT notification_status, notification_recipient_ids
       FROM irc_messages WHERE id = $1`,
      [messageId],
    );
    assert.equal(pending.rows[0].notification_status, "pending");
    assert.deepEqual(pending.rows[0].notification_recipient_ids.sort(), [users.first, users.second].sort());
    assert.equal((await pool.query(
      "SELECT id FROM irc_notifications WHERE entity_type = 'message' AND entity_id = $1",
      [messageId],
    )).rowCount, 0);

    assert.deepEqual(
      await processMessageNotificationDeliveries({ batchSize: 1 }),
      { processed: 1, delivered: 1, skipped: 0, failed: 0 },
    );
    const recipients = await pool.query<{ user_id: string; alert_count: number }>(
      `SELECT user_id, count(*)::int AS alert_count
       FROM irc_notifications
       WHERE entity_type = 'message' AND entity_id = $1
       GROUP BY user_id
       ORDER BY user_id`,
      [messageId],
    );
    assert.deepEqual(recipients.rows, [
      { user_id: users.first, alert_count: 1 },
      { user_id: users.second, alert_count: 1 },
    ].sort((left, right) => left.user_id.localeCompare(right.user_id)));
  });

  test("keeps committed alerts readable and avoids reinsertion after a pre-broadcast crash", async () => {
    const messageId = await insertPendingMessage({
      body: `Crash after commit ${suffix}`,
      recipientId: users.first,
      notificationRecipientIds: [users.first],
    });
    const applicationName = `notify-commit-${suffix}`;
    let worker: ChildProcess | undefined;
    try {
      worker = startCrashWorker(applicationName, "pause-after-commit");
      await waitForWorkerOutput(worker, "committed-before-broadcast");
      worker.kill("SIGKILL");
      await waitForWorkerClose(worker);
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL");
        await waitForWorkerClose(worker).catch(() => {});
      }
    }

    const committed = await pool.query<{
      id: string;
      user_id: string;
      type: string;
      body: string;
      entity_type: string;
      entity_id: string;
    }>(
      `SELECT id, user_id, type, body, entity_type, entity_id
       FROM irc_notifications
       WHERE entity_type = 'message' AND entity_id = $1`,
      [messageId],
    );
    assert.equal(committed.rowCount, 1);
    assert.deepEqual(
      {
        user_id: committed.rows[0].user_id,
        type: committed.rows[0].type,
        body: committed.rows[0].body,
        entity_type: committed.rows[0].entity_type,
        entity_id: committed.rows[0].entity_id,
      },
      {
        user_id: users.first,
        type: "direct_message",
        body: "You have a new direct message.",
        entity_type: "message",
        entity_id: messageId,
      },
    );

    assert.deepEqual(
      await processMessageNotificationDeliveries({ batchSize: 1 }),
      { processed: 0, delivered: 0, skipped: 0, failed: 0 },
    );
    const afterRetry = await pool.query<{ id: string }>(
      `SELECT id FROM irc_notifications
       WHERE entity_type = 'message' AND entity_id = $1`,
      [messageId],
    );
    assert.deepEqual(afterRetry.rows, [{ id: committed.rows[0].id }]);
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