import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import { clerkClient } from "@clerk/express";
import { WebSocket } from "ws";
import { pool } from "@workspace/db";
import app from "./app";
import { TEST_EMAIL_DOMAIN, TEST_USERNAME_PREFIX } from "./admin-test-identity";
import { SESSION_STATUS_CACHE_TTL_MS, setTestSessionStatus } from "./lib/auth";
import { hasPermission } from "./lib/permissions";
import { wsHub } from "./lib/ws";

type TestSession = {
  userId: string;
  sessionId: string;
};

type ApiResponse = {
  status: number;
  body: unknown;
};

let server: Server;
let baseUrl: string;
let firstSession: TestSession;
let secondSession: TestSession;
let adminSession: TestSession;
let memberSession: TestSession;
let createdSessions: TestSession[] = [];
const sessionTokens = new Map<string, string>();

async function withClerkRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;
      if (status !== 429 || attempt >= 5) throw error;
      const retryAfter = typeof error === "object" && error !== null && "retryAfter" in error
        ? (error as { retryAfter?: unknown }).retryAfter
        : undefined;
      const delayMs = (typeof retryAfter === "number" ? retryAfter : 1) * 1_000 + 100;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function createTestSession(
  label: string,
  emailStatus: "reserved" | "verified" = "reserved",
): Promise<TestSession> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const maxLabelLength = 64 - TEST_USERNAME_PREFIX.length - suffix.length - 1;
  const uniqueId = `${label.slice(0, maxLabelLength)}_${suffix}`;
  const user = await withClerkRateLimitRetry(() => clerkClient.users.createUser({
    username: `${TEST_USERNAME_PREFIX}${uniqueId}`,
    emailAddress: [`${TEST_USERNAME_PREFIX}${uniqueId}@${TEST_EMAIL_DOMAIN}`],
    emailAddressIdentificationStatus: [emailStatus],
    skipPasswordRequirement: true,
  }));
  const session = await withClerkRateLimitRetry(
    () => clerkClient.sessions.createSession({ userId: user.id }),
  );
  const testSession = { userId: user.id, sessionId: session.id };
  setTestSessionStatus(testSession.sessionId, { active: true, userId: testSession.userId });
  createdSessions.push(testSession);
  return testSession;
}

async function createSessionForUser(userId: string): Promise<TestSession> {
  const session = await withClerkRateLimitRetry(
    () => clerkClient.sessions.createSession({ userId }),
  );
  const testSession = { userId, sessionId: session.id };
  setTestSessionStatus(testSession.sessionId, { active: true, userId: testSession.userId });
  createdSessions.push(testSession);
  return testSession;
}

async function apiRequest(
  session: TestSession,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse> {
  let token = sessionTokens.get(session.sessionId);
  if (!token) {
    token = (await withClerkRateLimitRetry(
      () => clerkClient.sessions.getToken(session.sessionId),
    )).jwt;
    sessionTokens.set(session.sessionId, token);
  }
  return apiRequestWithToken(token, path, init);
}

async function revokeTestSession(session: TestSession): Promise<void> {
  await clerkClient.sessions.revokeSession(session.sessionId);
  setTestSessionStatus(session.sessionId, { active: false, userId: session.userId });
}

async function apiRequestWithToken(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep non-JSON error responses available in the assertion output.
  }
  return { status: response.status, body };
}

function createExpiredToken(userId: string): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  return [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      sub: userId,
      sid: `expired_${randomUUID()}`,
      iat: 1,
      exp: 2,
    }),
    "expired-signature",
  ].join(".");
}

async function unauthenticatedApiRequest(
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep non-JSON error responses available in the assertion output.
  }
  return { status: response.status, body };
}

function expectRejectedWebSocket(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("Timed out waiting for the WebSocket handshake to be rejected."));
      socket.terminate();
    }, 5_000);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    socket.once("open", () => {
      socket.close();
      finish(new Error("The revoked session established a WebSocket connection."));
    });
    socket.once("error", () => finish());
    socket.once("close", () => finish());
  });
}

function waitForWebSocketClose(
  socket: WebSocket,
): Promise<{ code: number; reason: Buffer }> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve({ code: 1006, reason: Buffer.alloc(0) });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the WebSocket to close."));
    }, 5_000);
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      resolve({ code, reason });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("close", onClose);
    };

    socket.once("close", onClose);
  });
}

async function openWebSocket(session: TestSession): Promise<WebSocket> {
  const ticketResponse = await apiRequest(session, "/ws-ticket");
  assert.equal(ticketResponse.status, 200, JSON.stringify(ticketResponse));
  assert.ok(ticketResponse.body && typeof ticketResponse.body === "object");
  const ticket = (ticketResponse.body as { ticket?: unknown }).ticket;
  assert.equal(typeof ticket, "string");

  const socket = new WebSocket(
    `${baseUrl.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket as string)}`,
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the WebSocket ready event."));
    }, 5_000);
    const onMessage = (raw: Buffer): void => {
      try {
        const event = JSON.parse(raw.toString()) as { type?: unknown };
        if (event.type !== "ready") return;
        cleanup();
        resolve();
      } catch {
        // Ignore non-JSON frames while waiting for the ready event.
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("The WebSocket connection failed before it became ready."));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("The WebSocket closed before it became ready."));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
  socket.on("error", () => undefined);
  return socket;
}

function waitForWebSocketEvent(
  socket: WebSocket,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the expected WebSocket event."));
    }, 5_000);
    const onMessage = (raw: Buffer): void => {
      try {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!predicate(event)) return;
        cleanup();
        resolve(event);
      } catch {
        // Ignore malformed frames.
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("The WebSocket closed before the expected event arrived."));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function expectNoWebSocketEvent(
  socket: WebSocket,
  predicate: (event: Record<string, unknown>) => boolean,
  durationMs = 500,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const onMessage = (raw: Buffer): void => {
      try {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!predicate(event)) return;
        cleanup();
        reject(new Error("Received a WebSocket event that should have been blocked."));
      } catch {
        // Ignore malformed frames.
      }
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function collectWebSocketEvents(
  socket: WebSocket,
  predicate: (event: Record<string, unknown>) => boolean,
  durationMs = 1_000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const events: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      cleanup();
      resolve(events);
    }, durationMs);
    const onMessage = (raw: Buffer): void => {
      try {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (predicate(event)) events.push(event);
      } catch {
        // Ignore malformed frames.
      }
    };
    const onClose = (): void => {
      cleanup();
      resolve(events);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function closeWebSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
}

async function waitForProfileStatus(userId: string, status: "online" | "offline"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM irc_users WHERE clerk_id = $1",
      [userId],
    );
    if (result.rows[0]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const result = await pool.query<{ status: string }>(
    "SELECT status FROM irc_users WHERE clerk_id = $1",
    [userId],
  );
  assert.deepEqual(result.rows, [{ status }], `Expected profile ${userId} to become ${status}.`);
}

async function removeTestChannels(channelIds: number[], userIds: string[] = []): Promise<void> {
  if (channelIds.length === 0) return;
  await pool.query("DELETE FROM irc_messages WHERE channel_id = ANY($1::int[])", [channelIds]);
  await pool.query("DELETE FROM irc_channel_join_requests WHERE channel_id = ANY($1::int[])", [channelIds]);
  await pool.query("DELETE FROM irc_channel_invites WHERE channel_id = ANY($1::int[])", [channelIds]);
  await pool.query("DELETE FROM irc_channel_members WHERE channel_id = ANY($1::int[])", [channelIds]);
  await pool.query("DELETE FROM irc_channels WHERE id = ANY($1::int[])", [channelIds]);
  if (userIds.length > 0) {
    await pool.query("DELETE FROM irc_notifications WHERE user_id = ANY($1::text[])", [userIds]);
  }
}

async function removeTestDatabaseRows(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) {
    throw new Error(
      "Refusing to reset test rows outside a dedicated TEST_DATABASE_URL.",
    );
  }
  await pool.query("TRUNCATE TABLE irc_users RESTART IDENTITY CASCADE");
}

async function userOwnedRows(userId: string): Promise<unknown[]> {
  const [
    profiles,
    channels,
    members,
    bans,
    messages,
    blocks,
    notifications,
    auditLogs,
  ] = await Promise.all([
    pool.query("SELECT * FROM irc_users WHERE clerk_id = $1", [userId]),
    pool.query(
      "SELECT * FROM irc_channels WHERE owner_id = $1 ORDER BY id",
      [userId],
    ),
    pool.query(
      "SELECT * FROM irc_channel_members WHERE user_id = $1 ORDER BY channel_id",
      [userId],
    ),
    pool.query(
      "SELECT * FROM irc_channel_bans WHERE user_id = $1 ORDER BY channel_id",
      [userId],
    ),
    pool.query(
      `SELECT * FROM irc_messages
       WHERE sender_id = $1 OR recipient_id = $1
       ORDER BY created_at, id`,
      [userId],
    ),
    pool.query(
      `SELECT * FROM irc_blocks
       WHERE blocker_id = $1 OR blocked_id = $1
       ORDER BY blocker_id, blocked_id`,
      [userId],
    ),
    pool.query(
      "SELECT * FROM irc_notifications WHERE user_id = $1 ORDER BY id",
      [userId],
    ),
    pool.query(
      "SELECT * FROM irc_admin_audit_logs WHERE actor_id = $1 ORDER BY id",
      [userId],
    ),
  ]);

  return [
    profiles.rows,
    channels.rows,
    members.rows,
    bans.rows,
    messages.rows,
    blocks.rows,
    notifications.rows,
    auditLogs.rows,
  ];
}

async function communityOwnedRows(): Promise<unknown[]> {
  const [
    communities,
    categories,
    channels,
    communityMembers,
    channelMembers,
    permissionDefinitions,
    rolePermissions,
    userRoles,
    announcements,
    notifications,
    auditLogs,
  ] = await Promise.all([
    pool.query("SELECT * FROM irc_communities ORDER BY id"),
    pool.query("SELECT * FROM irc_categories ORDER BY id"),
    pool.query("SELECT * FROM irc_channels ORDER BY id"),
    pool.query(
      "SELECT * FROM irc_community_members ORDER BY community_id, user_id",
    ),
    pool.query(
      "SELECT * FROM irc_channel_members ORDER BY channel_id, user_id",
    ),
    pool.query("SELECT * FROM irc_permission_definitions ORDER BY id"),
    pool.query(
      "SELECT * FROM irc_role_permissions ORDER BY role, permission_id",
    ),
    pool.query("SELECT * FROM irc_user_roles ORDER BY id"),
    pool.query("SELECT * FROM irc_server_announcements ORDER BY id"),
    pool.query("SELECT * FROM irc_notifications ORDER BY id"),
    pool.query("SELECT * FROM irc_admin_audit_logs ORDER BY id"),
  ]);

  return [
    communities.rows,
    categories.rows,
    channels.rows,
    communityMembers.rows,
    channelMembers.rows,
    permissionDefinitions.rows,
    rolePermissions.rows,
    userRoles.rows,
    announcements.rows,
    notifications.rows,
    auditLogs.rows,
  ];
}

function ircRequests(
  userId: string,
  query: string,
  moderationTargetUserId = userId,
): Array<[string, RequestInit?]> {
  return [
    ["/me"],
    [
      "/me",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "invalid_user", displayName: "Invalid User" }),
      },
    ],
    ["/channels"],
    [
      "/channels",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "invalid-channel", topic: "Should not exist" }),
      },
    ],
    ["/channels/1/join", { method: "POST" }],
    ["/channels/1/leave", { method: "POST" }],
    ["/channels/1/members"],
    ["/channels/1/messages"],
    [
      "/channels/1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Should not be sent" }),
      },
    ],
    [
      "/channels/1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "Should not change" }),
      },
    ],
    [
      "/channels/1/moderation",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mute", targetUserId: moderationTargetUserId }),
      },
    ],
    [`/users/search?q=${encodeURIComponent(query)}`],
    [`/users/${userId}/block`, { method: "POST" }],
    [`/users/${userId}/block`, { method: "DELETE" }],
    ["/dm/threads"],
    [`/dm/${userId}/messages`],
    [
      `/dm/${userId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Should not be sent" }),
      },
    ],
    [`/search/messages?q=${encodeURIComponent(query)}`],
    ["/notifications"],
    ["/notifications/1/read", { method: "POST" }],
  ];
}

function communityRequests(
  userId: string,
): Array<[string, RequestInit?]> {
  return [
    ["/permissions/me"],
    ["/permissions/catalog"],
    ["/communities"],
    [
      "/communities",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Should not be created",
          slug: `invalid-community-${randomUUID()}`,
        }),
      },
    ],
    ["/communities/1"],
    [
      "/communities/1/categories",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "invalid category" }),
      },
    ],
    [
      "/communities/1/categories/1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "updated category" }),
      },
    ],
    [
      "/communities/1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Should not change" }),
      },
    ],
    [
      "/communities/1/channels",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "invalid-channel" }),
      },
    ],
    [
      `/communities/1/members/${userId}/role`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
    ],
    [
      "/communities/1/announcements",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Should not be published" }),
      },
    ],
    ["/communities/1/moderation-logs"],
  ];
}

before(async () => {
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      "CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required for authenticated API tests.",
    );
  }

  server = createServer(app);
  wsHub.attach(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/api`;

  firstSession = await createTestSession("first");
  secondSession = await createTestSession("second");
});

after(async () => {
  for (const userId of new Set(createdSessions.map((session) => session.userId))) {
    try {
      await clerkClient.users.deleteUser(userId);
    } catch {
      // Scheduled strict-pattern cleanup handles any identity that could not be removed.
    }
  }
  await removeTestDatabaseRows(createdSessions.map(({ userId }) => userId));
  await pool.end();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("admin access controls", () => {
  test("rolls back announcements and all notifications when announcement auditing fails", async () => {
    const owner = await createTestSession("announcement_rollback_owner");
    const member = await createTestSession("announcement_rollback_member");
    const title = `Atomic announcement ${randomUUID()}`;
    const body = "Delivery must match audit history";
    const triggerName = `fail_announcement_audit_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    let communityId: number | null = null;
    let triggerInstalled = false;

    try {
      assert.equal((await apiRequest(member, "/me")).status, 200);
      const community = await apiRequest(owner, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Announcement rollback ${randomUUID().slice(0, 8)}`, isPrivate: true }),
      });
      assert.equal(community.status, 201, JSON.stringify(community));
      communityId = (community.body as { id: number }).id;
      assert.equal(typeof communityId, "number");
      await pool.query(
        "INSERT INTO irc_community_members (community_id, user_id, status) VALUES ($1, $2, 'member')",
        [communityId, member.userId],
      );

      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action = 'published_community_announcement' AND NEW.community_id = ${communityId} THEN
             RAISE EXCEPTION 'forced announcement audit failure';
           END IF;
           RETURN NEW;
         END;
         $$;`,
      );
      await pool.query(
        `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON irc_admin_audit_logs
         FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
      );
      triggerInstalled = true;

      const publish = () => apiRequest(owner, `/communities/${communityId}/announcements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      const failed = await publish();
      assert.equal(failed.status, 500, JSON.stringify(failed));
      const announcementRows = () => pool.query<{ id: number }>(
        "SELECT id FROM irc_server_announcements WHERE community_id = $1 AND title = $2",
        [communityId, title],
      );
      const notificationRows = () => pool.query<{ user_id: string; type: string; entity_id: string }>(
        `SELECT user_id, type, entity_id FROM irc_notifications
         WHERE community_id = $1 AND (
           (type = 'community_announcement' AND body = $2)
           OR (type = 'administrative_action' AND body = $3)
         ) ORDER BY type, user_id`,
        [communityId, `${title}: ${body}`, `published community announcement: ${title}`],
      );
      const auditRows = () => pool.query(
        `SELECT id FROM irc_admin_audit_logs
         WHERE community_id = $1 AND action = 'published_community_announcement' AND details = $2`,
        [communityId, title],
      );
      assert.deepEqual((await announcementRows()).rows, []);
      assert.deepEqual((await notificationRows()).rows, []);
      assert.deepEqual((await auditRows()).rows, []);

      await pool.query(`DROP TRIGGER "${triggerName}" ON irc_admin_audit_logs`);
      triggerInstalled = false;
      const retried = await publish();
      assert.equal(retried.status, 201, JSON.stringify(retried));
      const announcementId = (retried.body as { id: number }).id;
      assert.deepEqual((await announcementRows()).rows, [{ id: announcementId }]);
      assert.deepEqual((await notificationRows()).rows, [
        { user_id: owner.userId, type: "administrative_action", entity_id: String(communityId) },
        { user_id: member.userId, type: "community_announcement", entity_id: String(announcementId) },
        { user_id: owner.userId, type: "community_announcement", entity_id: String(announcementId) },
      ].sort((a, b) => a.type.localeCompare(b.type) || a.user_id.localeCompare(b.user_id)));
      assert.equal((await auditRows()).rowCount, 1);
    } finally {
      if (triggerInstalled) await pool.query(`DROP TRIGGER "${triggerName}" ON irc_admin_audit_logs`);
      await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_notifications WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_admin_audit_logs WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
    }
  });

  test("rejects malformed and expired Clerk credentials before creating profiles", async () => {
    const requests: Array<[string, RequestInit?]> = [
      ["/admin/status"],
      ["/admin/claim", { method: "POST" }],
      ["/admin/health"],
      ["/admin/overview"],
      ["/admin/users"],
      [
        `/admin/users/${firstSession.userId}/role`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        },
      ],
      [
        "/admin/channels/1",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Updated topic" }),
        },
      ],
      [
        "/admin/channels/1/messages",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      ],
    ];
    const credentials = [
      "malformed-clerk-token",
      createExpiredToken(firstSession.userId),
    ];

    const responses = await Promise.all(
      credentials.flatMap((token) =>
        requests.map(([path, init]) => apiRequestWithToken(token, path, init)),
      ),
    );

    for (const response of responses) {
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Sign in to continue" });
    }

    const profiles = await pool.query(
      "SELECT clerk_id FROM irc_users WHERE clerk_id = ANY($1::text[])",
      [[firstSession.userId, secondSession.userId]],
    );
    assert.deepEqual(profiles.rows, []);
  });

  test("rejects unauthenticated requests for every privileged admin route", async () => {
    const requests: Array<[string, RequestInit?]> = [
      ["/admin/status"],
      ["/admin/claim", { method: "POST" }],
      ["/admin/health"],
      ["/admin/overview"],
      ["/admin/users"],
      [
        `/admin/users/${firstSession.userId}/role`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        },
      ],
      [
        "/admin/channels/1",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Updated topic" }),
        },
      ],
      [
        "/admin/channels/1/messages",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      ],
    ];

    const responses = await Promise.all(
      requests.map(([path, init]) => unauthenticatedApiRequest(path, init)),
    );

    for (const response of responses) {
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Sign in to continue" });
    }
  });

  test("rejects a revoked Clerk session without creating or modifying its profile", async () => {
    const revokedSession = await createTestSession("revoked");
    const token = (await clerkClient.sessions.getToken(revokedSession.sessionId)).jwt;
    await revokeTestSession(revokedSession);
    await new Promise((resolve) => setTimeout(resolve, SESSION_STATUS_CACHE_TTL_MS + 25));

    const requests: Array<[string, RequestInit?]> = [
      ["/admin/status"],
      ["/admin/claim", { method: "POST" }],
      ["/admin/health"],
      ["/admin/overview"],
      ["/admin/users"],
      [
        `/admin/users/${firstSession.userId}/role`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        },
      ],
      [
        "/admin/channels/1",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Revoked topic" }),
        },
      ],
      [
        "/admin/channels/1/messages",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      ],
    ];
    const beforeProfiles = await pool.query(
      "SELECT * FROM irc_users ORDER BY clerk_id",
    );
    assert.equal(
      beforeProfiles.rows.some(
        (profile) => profile.clerk_id === revokedSession.userId,
      ),
      false,
    );

    const responses = await Promise.all(
      requests.map(([path, init]) => apiRequestWithToken(token, path, init)),
    );

    for (const response of responses) {
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Sign in to continue" });
    }

    const afterProfiles = await pool.query(
      "SELECT * FROM irc_users ORDER BY clerk_id",
    );
    assert.deepEqual(afterProfiles.rows, beforeProfiles.rows);
  });

  test("rejects a revoked Clerk session across every IRC route without changing user records", async () => {
    const revokedSession = await createTestSession("revoked_irc");
    const profile = await apiRequest(revokedSession, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));

    const token = (await clerkClient.sessions.getToken(revokedSession.sessionId)).jwt;
    await revokeTestSession(revokedSession);
    await new Promise((resolve) => setTimeout(resolve, SESSION_STATUS_CACHE_TTL_MS + 25));

    const requests = ircRequests(revokedSession.userId, "revoked", firstSession.userId);
    const beforeRows = await userOwnedRows(revokedSession.userId);

    const responses = await Promise.all(
      requests.map(([path, init]) => apiRequestWithToken(token, path, init)),
    );

    for (const response of responses) {
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Sign in to continue" });
    }

    const afterRows = await userOwnedRows(revokedSession.userId);
    assert.deepEqual(afterRows, beforeRows);
  });

  test("keeps one IRC profile available to a refreshed sibling session after revoking another session", async () => {
    const revokedSession = await createTestSession("revoked_scoped");
    const activeSession = await createSessionForUser(revokedSession.userId);
    const initialProfile = await apiRequest(revokedSession, "/me");
    assert.equal(initialProfile.status, 200, JSON.stringify(initialProfile));
    const [revokedToken, activeToken] = await Promise.all([
      clerkClient.sessions.getToken(revokedSession.sessionId),
      clerkClient.sessions.getToken(activeSession.sessionId),
    ]);

    await revokeTestSession(revokedSession);
    await new Promise((resolve) => setTimeout(resolve, SESSION_STATUS_CACHE_TTL_MS + 25));

    const revokedResponse = await apiRequestWithToken(revokedToken.jwt, "/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Revoked session update" }),
    });
    assert.equal(revokedResponse.status, 401, JSON.stringify(revokedResponse));
    assert.deepEqual(revokedResponse.body, { error: "Sign in to continue" });

    const activeDisplayName = `Active sibling ${randomUUID().slice(0, 8)}`;
    const activeResponse = await apiRequestWithToken(activeToken.jwt, "/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: activeDisplayName }),
    });
    assert.equal(activeResponse.status, 200, JSON.stringify(activeResponse));
    assert.ok(activeResponse.body && typeof activeResponse.body === "object");
    assert.equal(
      (activeResponse.body as { displayName?: unknown }).displayName,
      activeDisplayName,
    );

    const refreshedActiveToken = await clerkClient.sessions.getToken(activeSession.sessionId);
    const refreshedActiveResponse = await apiRequestWithToken(
      refreshedActiveToken.jwt,
      "/me",
    );
    assert.equal(refreshedActiveResponse.status, 200, JSON.stringify(refreshedActiveResponse));
    assert.ok(refreshedActiveResponse.body && typeof refreshedActiveResponse.body === "object");
    assert.equal(
      (refreshedActiveResponse.body as { id?: unknown }).id,
      revokedSession.userId,
    );
    assert.equal(
      (refreshedActiveResponse.body as { displayName?: unknown }).displayName,
      activeDisplayName,
    );

    const profiles = await pool.query<{ count: string; userId: string }>(
      `SELECT count(*)::text AS count, min(clerk_id) AS "userId"
       FROM irc_users
       WHERE clerk_id = $1`,
      [revokedSession.userId],
    );
    assert.deepEqual(profiles.rows, [{ count: "1", userId: revokedSession.userId }]);
  });

  test("does not create duplicate chat identities during concurrent session refreshes", async () => {
    const session = await createTestSession("profile_bootstrap_race");
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => apiRequest(session, "/me")),
    );

    for (const response of responses) {
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.ok(response.body && typeof response.body === "object");
      assert.equal((response.body as { id?: unknown }).id, session.userId);
    }

    const profiles = await pool.query<{ count: string; userId: string }>(
      `SELECT count(*)::text AS count, min(clerk_id) AS "userId"
       FROM irc_users
       WHERE clerk_id = $1`,
      [session.userId],
    );
    assert.deepEqual(profiles.rows, [{ count: "1", userId: session.userId }]);
  });

  test("rejects malformed and expired Clerk credentials across IRC routes without changing user records", async () => {
    const invalidSession = await createTestSession("invalid_irc");
    const profile = await apiRequest(invalidSession, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));

    const credentials = [
      "malformed-clerk-token",
      createExpiredToken(invalidSession.userId),
    ];
    const requests = ircRequests(invalidSession.userId, "invalid");
    const beforeRows = await userOwnedRows(invalidSession.userId);

    const responses = await Promise.all(
      credentials.flatMap((token) =>
        requests.map(([path, init]) => apiRequestWithToken(token, path, init)),
      ),
    );

    for (const response of responses) {
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Sign in to continue" });
    }

    const afterRows = await userOwnedRows(invalidSession.userId);
    assert.deepEqual(afterRows, beforeRows);
  });

  test("rejects malformed and expired Clerk credentials across community routes without changing community records", async () => {
    const invalidSession = await createTestSession("invalid_community");
    const profile = await apiRequest(invalidSession, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));

    const credentials = [
      "malformed-clerk-token",
      createExpiredToken(invalidSession.userId),
    ];
    const beforeRows = await communityOwnedRows();
    const responses = await Promise.all(
      credentials.flatMap((token) =>
        communityRequests(invalidSession.userId).map(([path, init]) =>
          apiRequestWithToken(token, path, init),
        ),
      ),
    );

    for (const response of responses) {
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Sign in to continue" });
    }

    const afterRows = await communityOwnedRows();
    assert.deepEqual(afterRows, beforeRows);
  });

  test("rejects malformed and expired Clerk credentials for WebSocket tickets without changing presence", async () => {
    const invalidSession = await createTestSession("invalid_ws_ticket");
    const profile = await apiRequest(invalidSession, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));
    await pool.query(
      "UPDATE irc_users SET status = 'offline' WHERE clerk_id = $1",
      [invalidSession.userId],
    );

    const credentials = [
      "malformed-clerk-token",
      createExpiredToken(invalidSession.userId),
    ];
    const beforeRows = await userOwnedRows(invalidSession.userId);
    const responses = await Promise.all(
      credentials.map((token) => apiRequestWithToken(token, "/ws-ticket")),
    );

    for (const response of responses) {
      assert.equal(response.status, 401, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Sign in to continue" });
    }

    const afterRows = await userOwnedRows(invalidSession.userId);
    assert.deepEqual(afterRows, beforeRows);
  });

  test("active Clerk sessions establish live chat presence and go offline after disconnect", async () => {
    const activeSession = await createTestSession("active_ws");
    const profile = await apiRequest(activeSession, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));
    await pool.query(
      "UPDATE irc_users SET status = 'offline' WHERE clerk_id = $1",
      [activeSession.userId],
    );

    let socket: WebSocket | undefined;
    try {
      socket = await openWebSocket(activeSession);
      assert.equal(socket.readyState, WebSocket.OPEN);
      await waitForProfileStatus(activeSession.userId, "online");
    } finally {
      if (socket) closeWebSocket(socket);
      await waitForProfileStatus(activeSession.userId, "offline");
    }
  });

  test("rejects a WebSocket ticket issued before session revocation without changing presence", async () => {
    const revokedSession = await createTestSession("revoked_ws");
    const profile = await apiRequest(revokedSession, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));
    await pool.query(
      "UPDATE irc_users SET status = 'offline' WHERE clerk_id = $1",
      [revokedSession.userId],
    );

    const ticketResponse = await apiRequest(revokedSession, "/ws-ticket");
    assert.equal(ticketResponse.status, 200, JSON.stringify(ticketResponse));
    assert.ok(ticketResponse.body && typeof ticketResponse.body === "object");
    const ticket = (ticketResponse.body as { ticket?: unknown }).ticket;
    assert.equal(typeof ticket, "string");

    await revokeTestSession(revokedSession);

    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket as string)}`;
    await expectRejectedWebSocket(wsUrl);
    await expectRejectedWebSocket(wsUrl);

    const afterConnection = await pool.query(
      "SELECT status FROM irc_users WHERE clerk_id = $1",
      [revokedSession.userId],
    );
    assert.deepEqual(afterConnection.rows, [{ status: "offline" }]);
  });

  test("closes only the revoked session's live socket and preserves shared presence", async () => {
    const revokedSession = await createTestSession("revoked_live_ws");
    const activeSession = await createSessionForUser(revokedSession.userId);
    const sockets: WebSocket[] = [];
    try {
      const profile = await apiRequest(revokedSession, "/me");
      assert.equal(profile.status, 200, JSON.stringify(profile));
      const activeProfile = await apiRequest(activeSession, "/me");
      assert.equal(activeProfile.status, 200, JSON.stringify(activeProfile));
      await pool.query(
        "UPDATE irc_users SET status = 'offline' WHERE clerk_id = $1",
        [revokedSession.userId],
      );

      const revokedSocket = await openWebSocket(revokedSession);
      sockets.push(revokedSocket);
      const activeSocket = await openWebSocket(activeSession);
      sockets.push(activeSocket);

      await revokeTestSession(revokedSession);
      const revokedClose = waitForWebSocketClose(revokedSocket);
      await wsHub.revalidateSession(revokedSession.sessionId);
      const closeEvent = await revokedClose;

      assert.equal(closeEvent.code, 1008);
      assert.equal(activeSocket.readyState, WebSocket.OPEN);
      const stillOnline = await pool.query<{ status: string }>(
        "SELECT status FROM irc_users WHERE clerk_id = $1",
        [revokedSession.userId],
      );
      assert.deepEqual(stillOnline.rows, [{ status: "online" }]);

      const activeClose = waitForWebSocketClose(activeSocket);
      closeWebSocket(activeSocket);
      await activeClose;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const offline = await pool.query<{ status: string }>(
        "SELECT status FROM irc_users WHERE clerk_id = $1",
        [revokedSession.userId],
      );
      assert.deepEqual(offline.rows, [{ status: "offline" }]);
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
    }
  });

  test("rejects self-service admin claims and honors platform-provisioned access", async () => {
    const responses = await Promise.all([
      apiRequest(firstSession, "/admin/claim", { method: "POST" }),
      apiRequest(secondSession, "/admin/claim", { method: "POST" }),
    ]);

    for (const response of responses) {
      assert.equal(response.status, 403, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Admin access is provisioned by the platform." });
    }

    await Promise.all([
      apiRequest(firstSession, "/admin/status"),
      apiRequest(secondSession, "/admin/status"),
    ]);
    await pool.query("UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1", [firstSession.userId]);
    adminSession = firstSession;
    memberSession = secondSession;

    const status = await apiRequest(adminSession, "/admin/status");
    assert.equal(status.status, 200, JSON.stringify(status));
    assert.equal((status.body as { isAdmin?: unknown }).isAdmin, true);
  });

  test("sends one admin DM alert for a pending upgrade without granting a slot", async () => {
    const getUserMock = mock.method(clerkClient.users, "getUser", async () => ({
      emailAddresses: [{ emailAddress: "confirmed@example.invalid", verification: { status: "verified" } }],
    }) as unknown as Awaited<ReturnType<typeof clerkClient.users.getUser>>);
    let requestId: number | null = null;
    try {
      const request = await apiRequest(memberSession, "/community-upgrades/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(request.status, 201, JSON.stringify(request));
      requestId = (request.body as { id: number }).id;
      const duplicate = await apiRequest(memberSession, "/community-upgrades/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(duplicate.status, 200);
      assert.equal((duplicate.body as { id: number }).id, requestId);
      const messages = await pool.query<{ body: string }>(
        "SELECT body FROM irc_messages WHERE sender_id = $1 AND recipient_id = $2 AND body LIKE $3",
        [memberSession.userId, adminSession.userId, `Public community upgrade #${requestId} pending.%`],
      );
      assert.equal(messages.rows.length, 1);
      assert.match(messages.rows[0].body, /confirmed@example\.invalid/);
      const alerts = await pool.query(
        "SELECT id FROM irc_notifications WHERE user_id = $1 AND entity_type = 'community_upgrade_request' AND entity_id = $2",
        [adminSession.userId, String(requestId)],
      );
      assert.equal(alerts.rows.length, 1);
      const status = await apiRequest(memberSession, "/community-upgrades/status");
      assert.equal((status.body as { approvedSlots: number }).approvedSlots, 0);
      assert.equal((await apiRequest(memberSession, "/public-communities", {
        method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Too early"}',
      })).status, 403);
    } finally {
      getUserMock.mock.restore();
      if (requestId !== null) {
        await pool.query("DELETE FROM irc_notifications WHERE entity_type = 'community_upgrade_request' AND entity_id = $1", [String(requestId)]);
        await pool.query(
          "DELETE FROM irc_messages WHERE sender_id = $1 AND recipient_id = $2 AND body LIKE $3",
          [memberSession.userId, adminSession.userId, `Public community upgrade #${requestId} pending.%`],
        );
        await pool.query("DELETE FROM irc_community_upgrade_requests WHERE id = $1", [requestId]);
      }
    }
  });

  test("keeps community upgrade pending until an admin approves and limits creation to one slot", async () => {
    const post = (session: TestSession, path: string, body: object) => apiRequest(session, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const seeded = await pool.query<{ id: number }>(
      `INSERT INTO irc_community_upgrade_requests (user_id, email, display_name, status)
       VALUES ($1, 'test@example.invalid', 'Test requester', 'pending') RETURNING id`,
      [memberSession.userId],
    );
    const requestId = seeded.rows[0].id;
    let communityId: number | null = null;
    try {
      const status = await apiRequest(memberSession, "/community-upgrades/status");
      assert.equal(status.status, 200);
      assert.equal((status.body as { pendingRequest?: { id: number } }).pendingRequest?.id, requestId);
      assert.equal((status.body as { approvedSlots?: number }).approvedSlots, 0);
      assert.equal((await post(memberSession, "/public-communities", { name: "Too early" })).status, 403);
      assert.equal((await post(memberSession, `/admin/community-upgrades/${requestId}/approve`, { paymentReference: "paid-1234" })).status, 403);
      assert.equal((await post(adminSession, `/admin/community-upgrades/${requestId}/approve`, { paymentReference: "" })).status, 400);
      const approved = await post(adminSession, `/admin/community-upgrades/${requestId}/approve`, {
        paymentReference: `test-${randomUUID()}`,
      });
      assert.equal(approved.status, 200, JSON.stringify(approved));
      assert.equal((await post(adminSession, `/admin/community-upgrades/${requestId}/approve`, {
        paymentReference: `test-${randomUUID()}`,
      })).status, 409);
      const attempts = await Promise.all([
        post(memberSession, "/public-communities", { name: "Extra community A" }),
        post(memberSession, "/public-communities", { name: "Extra community B" }),
      ]);
      assert.deepEqual(attempts.map((response) => response.status).sort(), [201, 403]);
      communityId = (attempts.find((response) => response.status === 201)?.body as { id: number }).id;
      const after = await apiRequest(memberSession, "/community-upgrades/status");
      assert.equal((after.body as { approvedSlots: number; usedSlots: number }).approvedSlots, 1);
      assert.equal((after.body as { approvedSlots: number; usedSlots: number }).usedSlots, 1);
    } finally {
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_channel_members WHERE channel_id IN (SELECT id FROM irc_channels WHERE community_id = $1)", [communityId]);
        await pool.query("DELETE FROM irc_channels WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_categories WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_user_roles WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_community_members WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
      await pool.query("DELETE FROM irc_notifications WHERE entity_type = 'community_upgrade_request' AND entity_id = $1", [String(requestId)]);
      await pool.query("DELETE FROM irc_admin_audit_logs WHERE target_id = $1 AND action = 'approved_community_upgrade'", [String(requestId)]);
      await pool.query("DELETE FROM irc_community_upgrade_requests WHERE id = $1", [requestId]);
    }
  });

  test("records a successful role change in admin activity", async () => {
    const roleUpdate = await apiRequest(
      adminSession,
      `/admin/users/${memberSession.userId}/role`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
    );
    assert.equal(roleUpdate.status, 200);
    assert.deepEqual(roleUpdate.body, {
      id: memberSession.userId,
      role: "member",
    });

    const status = await apiRequest(adminSession, "/admin/status");
    assert.equal(status.status, 200);
    assert.ok(status.body && typeof status.body === "object");
    const profile = (status.body as {
      profile?: { id?: unknown; displayName?: unknown };
    }).profile;
    assert.ok(profile && profile.id === adminSession.userId);
    assert.equal(typeof profile.displayName, "string");

    const overview = await apiRequest(adminSession, "/admin/overview");
    assert.equal(overview.status, 200);
    assert.ok(overview.body && typeof overview.body === "object");
    const activity = (overview.body as { activity?: unknown }).activity;
    assert.ok(Array.isArray(activity));
    const matchingActivity = activity.find(
      (
        entry,
      ): entry is {
        actorId: string;
        action: string;
        targetId: string | null;
        details: string | null;
        actor: string | null;
      } =>
        typeof entry === "object" &&
        entry !== null &&
        "action" in entry &&
        "targetId" in entry &&
        (entry as { action?: unknown }).action === "demoted_user" &&
        (entry as { targetId?: unknown }).targetId === memberSession.userId,
    );
    assert.deepEqual(matchingActivity && {
      actorId: matchingActivity.actorId,
      action: matchingActivity.action,
      targetId: matchingActivity.targetId,
      details: matchingActivity.details,
      actor: matchingActivity.actor,
    }, {
      actorId: adminSession.userId,
      action: "demoted_user",
      targetId: memberSession.userId,
      details: "Role changed to member",
      actor: profile.displayName,
    });
  });

  test("publishes one announcement notification for every current user", async () => {
    const body = `Operations update ${randomUUID()}`;
    let announcementId: number | null = null;

    try {
      const [{ count: userCount }] = (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM irc_users",
        )
      ).rows;

      const response = await apiRequest(adminSession, "/admin/announcements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      assert.equal(response.status, 201, JSON.stringify(response));
      assert.ok(response.body && typeof response.body === "object");
      announcementId = (response.body as { id?: unknown }).id as number;
      assert.equal(typeof announcementId, "number");

      const notifications = await pool.query<{
        user_id: string;
        notification_count: number;
      }>(
        `SELECT user_id, count(*)::int AS notification_count
         FROM irc_notifications
         WHERE type = 'server_announcement' AND body = $1
         GROUP BY user_id
         ORDER BY user_id`,
        [body],
      );
      assert.equal(notifications.rows.length, userCount);
      assert.ok(
        notifications.rows.every(
          ({ notification_count }) => notification_count === 1,
        ),
      );

      const audit = await pool.query(
        `SELECT actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE action = 'published_server_announcement' AND target_id = $1`,
        [String(announcementId)],
      );
      assert.deepEqual(audit.rows, [
        {
          actor_id: adminSession.userId,
          action: "published_server_announcement",
          target_id: String(announcementId),
          target_label: "server announcement",
          details: body,
        },
      ]);
    } finally {
      await pool.query(
        "DELETE FROM irc_notifications WHERE type = 'server_announcement' AND body = $1",
        [body],
      );
      if (announcementId !== null) {
        await pool.query(
          "DELETE FROM irc_admin_audit_logs WHERE action = 'published_server_announcement' AND target_id = $1",
          [String(announcementId)],
        );
        await pool.query(
          "DELETE FROM irc_server_announcements WHERE id = $1",
          [announcementId],
        );
      }
    }
  });

  test("repairs a published release whose announcement was deleted", async () => {
    const version = `test-${randomUUID().slice(0, 8)}`;
    const title = `Missing announcement recovery ${randomUUID().slice(0, 8)}`;
    const notes = `Recovery notes ${randomUUID()}`;
    let releaseId: number | null = null;
    let draftAnnouncementId: number | null = null;
    let replacementAnnouncementId: number | null = null;

    try {
      const created = await apiRequest(adminSession, "/developer/releases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version, title, notes }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      releaseId = (created.body as { id?: unknown }).id as number;
      assert.equal(typeof releaseId, "number");

      const review = await apiRequest(
        adminSession,
        `/developer/releases/${releaseId}/status`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "review" }),
        },
      );
      assert.equal(review.status, 200, JSON.stringify(review));

      const published = await apiRequest(
        adminSession,
        `/developer/releases/${releaseId}/status`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "published" }),
        },
      );
      assert.equal(published.status, 200, JSON.stringify(published));
      assert.ok(published.body && typeof published.body === "object");
      draftAnnouncementId = (published.body as { announcementId?: unknown }).announcementId as number;
      assert.equal(typeof draftAnnouncementId, "number");

      await pool.query(
        "DELETE FROM irc_server_announcements WHERE id = $1",
        [draftAnnouncementId],
      );

      const releases = await apiRequest(adminSession, "/developer/releases");
      assert.equal(releases.status, 200, JSON.stringify(releases));
      assert.ok(Array.isArray(releases.body));
      const visibleRelease = releases.body.find(
        (release): release is { id: number; status: string; announcementId: number | null } =>
          typeof release === "object" &&
          release !== null &&
          (release as { id?: unknown }).id === releaseId,
      );
      assert.deepEqual(visibleRelease && {
        id: visibleRelease.id,
        status: visibleRelease.status,
        announcementId: visibleRelease.announcementId,
      }, {
        id: releaseId,
        status: "published",
        announcementId: null,
      });

      const repaired = await apiRequest(
        adminSession,
        `/developer/releases/${releaseId}/announcement`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "published" }),
        },
      );
      assert.equal(repaired.status, 200, JSON.stringify(repaired));
      assert.ok(repaired.body && typeof repaired.body === "object");
      const repairedBody = repaired.body as {
        release?: { id?: unknown; status?: unknown; announcementId?: unknown };
        announcement?: { id?: unknown; status?: unknown; title?: unknown; body?: unknown };
      };
      assert.equal(repairedBody.release?.id, releaseId);
      assert.equal(repairedBody.release?.status, "published");
      replacementAnnouncementId = repairedBody.announcement?.id as number;
      assert.equal(typeof replacementAnnouncementId, "number");
      assert.notEqual(replacementAnnouncementId, draftAnnouncementId);
      assert.equal(repairedBody.announcement?.status, "published");
      assert.equal(
        repairedBody.announcement?.title,
        `Release ${version}: ${title}`,
      );
      assert.equal(repairedBody.announcement?.body, notes);
      assert.equal(repairedBody.release?.announcementId, replacementAnnouncementId);

      const linkedRows = await pool.query<{
        release_status: string;
        announcement_id: number | null;
        announcement_status: string | null;
      }>(
        `SELECT r.status AS release_status,
                r.announcement_id,
                a.status AS announcement_status
         FROM irc_developer_releases r
         LEFT JOIN irc_server_announcements a ON a.id = r.announcement_id
         WHERE r.id = $1`,
        [releaseId],
      );
      assert.deepEqual(linkedRows.rows, [{
        release_status: "published",
        announcement_id: replacementAnnouncementId,
        announcement_status: "published",
      }]);
    } finally {
      const notificationBody = `Release ${version}: ${title}: ${notes}`;
      await pool.query(
        "DELETE FROM irc_notifications WHERE type = 'server_announcement' AND body = $1",
        [notificationBody],
      );
      if (releaseId !== null) {
        await pool.query(
          "DELETE FROM irc_admin_audit_logs WHERE target_id = $1 OR target_id = $2",
          [String(releaseId), replacementAnnouncementId === null ? "" : String(replacementAnnouncementId)],
        );
        await pool.query(
          "DELETE FROM irc_developer_releases WHERE id = $1",
          [releaseId],
        );
      }
      for (const announcementId of [draftAnnouncementId, replacementAnnouncementId]) {
        if (announcementId !== null) {
          await pool.query(
            "DELETE FROM irc_server_announcements WHERE id = $1",
            [announcementId],
          );
        }
      }
    }
  });

  test("reports exact user statistics from the admin overview", async () => {
    const expected = (
      await pool.query<{
        users: number;
        online: number;
        admins: number;
      }>(
        `SELECT
           count(*)::int AS users,
           count(*) FILTER (WHERE status = 'online')::int AS online,
           count(*) FILTER (WHERE role = 'admin')::int AS admins
         FROM irc_users`,
      )
    ).rows[0];

    const response = await apiRequest(adminSession, "/admin/overview");
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.ok(response.body && typeof response.body === "object");
    const stats = (response.body as { stats?: unknown }).stats;
    assert.ok(stats && typeof stats === "object");
    assert.deepEqual(
      {
        users: (stats as { users?: unknown }).users,
        online: (stats as { online?: unknown }).online,
        admins: (stats as { admins?: unknown }).admins,
      },
      expected,
    );
  });

  test("keeps the original actor identity and label after the admin is renamed", async () => {
    const beforeRename = await apiRequest(adminSession, "/me");
    assert.equal(beforeRename.status, 200);
    assert.ok(beforeRename.body && typeof beforeRename.body === "object");
    const originalDisplayName = (beforeRename.body as { displayName?: unknown }).displayName;
    assert.equal(typeof originalDisplayName, "string");

    const renamedDisplayName = `Renamed admin ${randomUUID().slice(0, 8)}`;
    try {
      const rename = await apiRequest(adminSession, "/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: renamedDisplayName }),
      });
      assert.equal(rename.status, 200);

      const overview = await apiRequest(adminSession, "/admin/overview");
      assert.equal(overview.status, 200);
      assert.ok(overview.body && typeof overview.body === "object");
      const activity = (overview.body as { activity?: unknown }).activity;
      assert.ok(Array.isArray(activity));
      const matchingActivity = activity.find(
        (
          entry,
        ): entry is {
          actorId: string;
          action: string;
          targetId: string | null;
          details: string | null;
          actor: string | null;
        } =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { action?: unknown }).action === "demoted_user" &&
          (entry as { targetId?: unknown }).targetId === memberSession.userId,
      );
      assert.deepEqual(matchingActivity && {
        actorId: matchingActivity.actorId,
        action: matchingActivity.action,
        targetId: matchingActivity.targetId,
        details: matchingActivity.details,
        actor: matchingActivity.actor,
      }, {
        actorId: adminSession.userId,
        action: "demoted_user",
        targetId: memberSession.userId,
        details: "Role changed to member",
        actor: originalDisplayName,
      });
    } finally {
      await apiRequest(adminSession, "/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: originalDisplayName }),
      });
    }
  });

  test("paginates activity in bounded ordered pages without changing actor fields", async () => {
    const marker = `activity_page_${randomUUID().replaceAll("-", "")}`;
    const rowCount = 23;
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (let index = 0; index < rowCount; index += 1) {
      const offset = parameters.length;
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
      );
      parameters.push(
        adminSession.userId,
        "Pagination actor",
        `${marker}_${String(index).padStart(2, "0")}`,
        `${marker}_target_${index}`,
        `${marker} label ${index}`,
        `Pagination detail ${index}`,
        new Date(Date.UTC(2099, 0, 1, 0, 0, index)),
      );
    }

    await pool.query(
      `INSERT INTO irc_admin_audit_logs
       (actor_id, actor_display_name, action, target_id, target_label, details, created_at)
       VALUES ${values.join(", ")}`,
      parameters,
    );

    try {
      const pageResponses = [];
      for (const offset of [0, 8, 16]) {
        const response = await apiRequest(
          adminSession,
          `/admin/overview?activityLimit=8&activityOffset=${offset}&activityAction=${marker}`,
        );
        assert.equal(response.status, 200, JSON.stringify(response));
        assert.ok(response.body && typeof response.body === "object");
        pageResponses.push(
          response.body as {
            activity: Array<{
              id: number;
              actorId: string;
              action: string;
              actor: string | null;
              createdAt: string;
            }>;
            activityPagination: {
              limit: number;
              offset: number;
              hasMore: boolean;
              nextOffset: number | null;
              nextCursor: string | null;
            };
          },
        );
      }

      assert.deepEqual(
        pageResponses.map((page) => page.activity.length),
        [8, 8, 7],
      );
      assert.deepEqual(
        pageResponses.map(({ activityPagination: { nextCursor: _nextCursor, ...pagination } }) => pagination),
        [
          { limit: 8, offset: 0, hasMore: true, nextOffset: 8 },
          { limit: 8, offset: 8, hasMore: true, nextOffset: 16 },
          { limit: 8, offset: 16, hasMore: false, nextOffset: null },
        ],
      );
      assert.ok(pageResponses[0]?.activityPagination.nextCursor);
      assert.ok(pageResponses[1]?.activityPagination.nextCursor);
      assert.equal(pageResponses[2]?.activityPagination.nextCursor, null);

      const activity = pageResponses.flatMap((page) => page.activity);
      assert.equal(new Set(activity.map((entry) => entry.id)).size, rowCount);
      assert.deepEqual(
        activity.map((entry) => entry.action),
        Array.from({ length: rowCount }, (_, index) => `${marker}_${String(rowCount - index - 1).padStart(2, "0")}`),
      );
      assert.ok(activity.every((entry) => entry.actorId === adminSession.userId));
      assert.ok(activity.every((entry) => entry.actor === "Pagination actor"));
      assert.ok(
        activity.every(
          (entry, index) =>
            index === 0 || entry.createdAt <= activity[index - 1].createdAt,
        ),
      );

      const invalidLimit = await apiRequest(
        adminSession,
        "/admin/overview?activityLimit=51",
      );
      assert.equal(invalidLimit.status, 400, JSON.stringify(invalidLimit));
    } finally {
      await pool.query("DELETE FROM irc_admin_audit_logs WHERE action LIKE $1", [
        `${marker}%`,
      ]);
    }
  });

  test("filters activity by actor and literal action without returning unrelated events", async () => {
    const marker = `audit_filter_${randomUUID().replaceAll("-", "")}`;
    const fixtures = [
      { actor: `${marker} Alpha`, action: `${marker}_grant_role` },
      { actor: `${marker} Beta`, action: `${marker}_grant_role` },
      { actor: `${marker} Alpha`, action: `${marker}_revoke_role` },
      { actor: `${marker} Alpha`, action: `${marker}Xgrant_role` },
    ];
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (const fixture of fixtures) {
      const offset = parameters.length;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
      parameters.push(
        adminSession.userId,
        fixture.actor,
        fixture.action,
        `${marker}_target`,
        `${marker} target`,
      );
    }

    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO irc_admin_audit_logs
       (actor_id, actor_display_name, action, target_id, target_label)
       VALUES ${values.join(", ")}
       RETURNING id`,
      parameters,
    );
    const fixtureIds = inserted.rows.map((row) => row.id);

    try {
      const actorResponse = await apiRequest(
        adminSession,
        `/admin/overview?activityActor=${encodeURIComponent(`${marker} alpha`)}`,
      );
      assert.equal(actorResponse.status, 200, JSON.stringify(actorResponse));
      const actorActivity = (actorResponse.body as {
        activity: Array<{ id: number; actor: string; action: string }>;
      }).activity;
      assert.ok(actorActivity.every((entry) => entry.actor.toLowerCase().includes("alpha")));
      assert.deepEqual(new Set(actorActivity.map((entry) => entry.id)), new Set([
        fixtureIds[0],
        fixtureIds[2],
        fixtureIds[3],
      ]));

      const actionResponse = await apiRequest(
        adminSession,
        `/admin/overview?activityAction=${encodeURIComponent(`${marker}_grant_role`)}`,
      );
      assert.equal(actionResponse.status, 200, JSON.stringify(actionResponse));
      const actionActivity = (actionResponse.body as {
        activity: Array<{ id: number; actor: string; action: string }>;
      }).activity;
      assert.ok(actionActivity.every((entry) => entry.action === `${marker}_grant_role`));
      assert.deepEqual(new Set(actionActivity.map((entry) => entry.id)), new Set([
        fixtureIds[0],
        fixtureIds[1],
      ]));

      const combinedResponse = await apiRequest(
        adminSession,
        `/admin/overview?activityActor=${encodeURIComponent(`${marker} alpha`)}&activityAction=${encodeURIComponent(`${marker}_grant_role`)}`,
      );
      assert.equal(combinedResponse.status, 200, JSON.stringify(combinedResponse));
      const combinedActivity = (combinedResponse.body as {
        activity: Array<{ id: number; actor: string; action: string }>;
      }).activity;
      assert.deepEqual(combinedActivity.map((entry) => entry.id), [fixtureIds[0]]);
      assert.equal(combinedActivity[0]?.actor, `${marker} Alpha`);
      assert.equal(combinedActivity[0]?.action, `${marker}_grant_role`);
    } finally {
      await pool.query("DELETE FROM irc_admin_audit_logs WHERE action LIKE $1", [
        `${marker}%`,
      ]);
    }
  });

  test("rejects oversized and repeated activity filters", async () => {
    const tooLong = "x".repeat(201);
    for (const path of [
      `/admin/overview?activityActor=${tooLong}`,
      `/admin/overview?activityAction=${tooLong}`,
      "/admin/overview?activityActor=first&activityActor=second",
    ]) {
      const response = await apiRequest(adminSession, path);
      assert.equal(response.status, 400, JSON.stringify(response));
    }

    const boundaryResponse = await apiRequest(
      adminSession,
      `/admin/overview?activityActor=${"x".repeat(200)}`,
    );
    assert.equal(boundaryResponse.status, 200, JSON.stringify(boundaryResponse));
  });

  test("keeps cursor activity pages complete when a newer event arrives between requests", async () => {
    const marker = `activity_cursor_${randomUUID().replaceAll("-", "")}`;
    const rowCount = 23;
    const sharedTimestamp = new Date(Date.UTC(2099, 0, 1));
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (let index = 0; index < rowCount; index += 1) {
      const offset = parameters.length;
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
      );
      parameters.push(
        adminSession.userId,
        "Cursor pagination actor",
        `${marker}_${String(index).padStart(2, "0")}`,
        `${marker}_target_${index}`,
        `${marker} label ${index}`,
        `Cursor pagination detail ${index}`,
        sharedTimestamp,
      );
    }

    await pool.query(
      `INSERT INTO irc_admin_audit_logs
       (actor_id, actor_display_name, action, target_id, target_label, details, created_at)
       VALUES ${values.join(", ")}`,
      parameters,
    );

    try {
      const query = `/admin/overview?activityLimit=8&activityAction=${marker}`;
      const firstResponse = await apiRequest(adminSession, query);
      assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse));
      const firstPage = firstResponse.body as {
        activity: Array<{ id: number; actorId: string; action: string; actor: string | null; createdAt: string }>;
        activityPagination: { hasMore: boolean; nextCursor: string | null };
      };
      assert.equal(firstPage.activity.length, 8);
      assert.equal(firstPage.activityPagination.hasMore, true);
      assert.ok(firstPage.activityPagination.nextCursor);

      await pool.query(
        `INSERT INTO irc_admin_audit_logs
         (actor_id, actor_display_name, action, target_id, target_label, details, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          adminSession.userId,
          "Interleaving actor",
          `${marker}_newer_event`,
          `${marker}_newer_target`,
          `${marker} newer label`,
          "Inserted after the first page",
          sharedTimestamp,
        ],
      );

      const pages = [firstPage];
      let cursor: string | null = firstPage.activityPagination.nextCursor;
      while (cursor) {
        const response = await apiRequest(
          adminSession,
          `${query}&activityCursor=${encodeURIComponent(cursor)}`,
        );
        assert.equal(response.status, 200, JSON.stringify(response));
        const page = response.body as typeof firstPage;
        pages.push(page);
        cursor = page.activityPagination.nextCursor;
      }

      const activity = pages.flatMap((page) => page.activity);
      assert.equal(activity.length, rowCount);
      assert.equal(new Set(activity.map((entry) => entry.id)).size, rowCount);
      assert.deepEqual(
        activity.map((entry) => entry.action),
        Array.from({ length: rowCount }, (_, index) => `${marker}_${String(rowCount - index - 1).padStart(2, "0")}`),
      );
      assert.ok(activity.every((entry) => entry.actorId === adminSession.userId));
      assert.ok(activity.every((entry) => entry.actor === "Cursor pagination actor"));
      assert.ok(activity.every((entry) => entry.createdAt === sharedTimestamp.toISOString()));
      assert.ok(!activity.some((entry) => entry.action === `${marker}_newer_event`));
    } finally {
      await pool.query("DELETE FROM irc_admin_audit_logs WHERE action LIKE $1", [
        `${marker}%`,
      ]);
    }
  });

  test("does not record a rejected second-admin promotion", async () => {
    const beforeAudit = await pool.query(
      "SELECT count(*)::int AS count FROM irc_admin_audit_logs WHERE action = 'promoted_user'",
    );
    const roleUpdate = await apiRequest(
      adminSession,
      `/admin/users/${memberSession.userId}/role`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
    );
    assert.equal(roleUpdate.status, 409, JSON.stringify(roleUpdate));

    const afterAudit = await pool.query(
      "SELECT count(*)::int AS count FROM irc_admin_audit_logs WHERE action = 'promoted_user'",
    );
    assert.deepEqual(afterAudit.rows, beforeAudit.rows);
  });

  test("rolls back a role change when recording admin activity fails", async () => {
    const triggerName = `fail_role_audit_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    const beforeAudit = await pool.query(
      "SELECT id, actor_id, action, target_id, target_label, details FROM irc_admin_audit_logs ORDER BY id",
    );

    try {
      await pool.query(
        "UPDATE irc_users SET role = 'member' WHERE clerk_id = $1",
        [adminSession.userId],
      );
      await pool.query(
        "UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1",
        [memberSession.userId],
      );
      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action IN ('demoted_user', 'promoted_user') THEN
             RAISE EXCEPTION 'forced role audit failure';
           END IF;
           RETURN NEW;
         END;
         $$;`,
      );
      await pool.query(
        `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON irc_admin_audit_logs
         FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
      );

      const response = await apiRequest(
        memberSession,
        `/admin/users/${adminSession.userId}/role`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        },
      );
      assert.equal(response.status, 500, JSON.stringify(response));
      assert.deepEqual(response.body, {
        error: "An unexpected error occurred while processing the admin request.",
      });

      const afterUsers = await pool.query(
        "SELECT clerk_id, role FROM irc_users WHERE clerk_id = $1",
        [adminSession.userId],
      );
      const afterAudit = await pool.query(
        "SELECT id, actor_id, action, target_id, target_label, details FROM irc_admin_audit_logs ORDER BY id",
      );
      assert.deepEqual(afterUsers.rows, [
        { clerk_id: adminSession.userId, role: "member" },
      ]);
      assert.deepEqual(afterAudit.rows, beforeAudit.rows);
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON irc_admin_audit_logs;
         DROP FUNCTION IF EXISTS "${functionName}"();`,
      );
      await pool.query(
        "UPDATE irc_users SET role = 'member' WHERE clerk_id = $1",
        [memberSession.userId],
      );
      await pool.query(
        "UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1",
        [adminSession.userId],
      );
    }
  });

  test("returns 404 without changing roles or audit activity after the target disappears", async () => {
    const targetSession = await createTestSession("removed_role_target");
    const profile = await apiRequest(targetSession, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));
    await pool.query(
      "DELETE FROM irc_users WHERE clerk_id = $1",
      [targetSession.userId],
    );

    const beforeUsers = await pool.query(
      "SELECT clerk_id, role FROM irc_users ORDER BY clerk_id",
    );
    const beforeAudit = await pool.query(
      "SELECT id, actor_id, action, target_id, target_label, details FROM irc_admin_audit_logs ORDER BY id",
    );

    const response = await apiRequest(
      adminSession,
      `/admin/users/${targetSession.userId}/role`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: "User not found." });

    const afterUsers = await pool.query(
      "SELECT clerk_id, role FROM irc_users ORDER BY clerk_id",
    );
    const afterAudit = await pool.query(
      "SELECT id, actor_id, action, target_id, target_label, details FROM irc_admin_audit_logs ORDER BY id",
    );
    assert.deepEqual(afterUsers.rows, beforeUsers.rows);
    assert.deepEqual(afterAudit.rows, beforeAudit.rows);
  });

  test("preserves audit history, actor ID, and actor snapshot after account cleanup", async () => {
    const actorId = `audit_actor_${randomUUID()}`;
    const username = `audit_actor_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const displayName = "Former Audit Actor";
    let auditId: number | undefined;
    try {
      await pool.query(
        `INSERT INTO irc_users (clerk_id, username, display_name)
         VALUES ($1, $2, $3)`,
        [actorId, username, displayName],
      );
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO irc_admin_audit_logs
           (actor_id, actor_display_name, action, target_id, target_label, details)
         VALUES ($1, $2, 'audit_actor_deleted', 'preserved-target', 'Preserved target', 'Preserved details')
         RETURNING id`,
        [actorId, displayName],
      );
      auditId = inserted.rows[0]?.id;
      assert.ok(auditId);

      await pool.query("DELETE FROM irc_users WHERE clerk_id = $1", [actorId]);

      const preserved = await pool.query(
        `SELECT actor_id, actor_display_name, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE id = $1`,
        [auditId],
      );
      assert.deepEqual(preserved.rows, [{
        actor_id: actorId,
        actor_display_name: displayName,
        action: "audit_actor_deleted",
        target_id: "preserved-target",
        target_label: "Preserved target",
        details: "Preserved details",
      }]);

      const overview = await apiRequest(
        adminSession,
        "/admin/overview?activityAction=audit_actor_deleted",
      );
      assert.equal(overview.status, 200, JSON.stringify(overview));
      const activity = (overview.body as {
        activity?: Array<{
          actorId: string | null;
          actor: string | null;
          action: string;
          targetLabel: string | null;
        }>;
      }).activity;
      assert.deepEqual(activity?.find((entry) => entry.action === "audit_actor_deleted"), {
        actorId,
        actor: displayName,
        action: "audit_actor_deleted",
        targetLabel: "Preserved target",
      });
    } finally {
      if (auditId !== undefined) {
        await pool.query("DELETE FROM irc_admin_audit_logs WHERE id = $1", [auditId]);
      }
      await pool.query("DELETE FROM irc_users WHERE clerk_id = $1", [actorId]);
    }
  });

  test("rejects upload URL claims for another workspace before contacting storage", async () => {
    const requester = await createTestSession("cross_workspace_upload_requester");
    const owner = await createTestSession("cross_workspace_upload_owner");
    let workspaceId: number | undefined;
    try {
      await Promise.all([
        apiRequest(requester, "/me"),
        apiRequest(owner, "/me"),
      ]);
      const workspace = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ($1, $2, $3, 'paid_workspace', true)
         RETURNING id`,
        [
          "Protected Upload Workspace",
          `protected-upload-${randomUUID()}`,
          owner.userId,
        ],
      );
      workspaceId = workspace.rows[0]?.id;
      assert.ok(workspaceId);
      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'owner')`,
        [workspaceId, owner.userId],
      );

      const response = await apiRequest(
        requester,
        "/storage/uploads/request-url",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "private-report.pdf",
            size: 1024,
            contentType: "application/pdf",
            workspaceId,
            resourceType: "document",
            resourceId: "new",
          }),
        },
      );

      assert.equal(response.status, 403, JSON.stringify(response));
      assert.deepEqual(response.body, {
        error: "You cannot upload files to this workspace resource.",
      });
    } finally {
      if (workspaceId !== undefined) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [workspaceId]);
      }
    }
  });

  test("rejects invitation organization assignments from another workspace atomically", async () => {
    const recipient = await createTestSession("cross_workspace_invitation_recipient", "verified");
    const workspaceIds: number[] = [];
    const token = randomUUID();
    let foreignTeamId: number | undefined;
    try {
      await apiRequest(recipient, "/me");
      const recipientUser = await clerkClient.users.getUser(recipient.userId);
      const recipientEmail = recipientUser.emailAddresses[0]?.emailAddress;
      assert.ok(recipientEmail);

      for (const label of ["Invitation Home", "Invitation Foreign"]) {
        const workspace = await pool.query<{ id: number }>(
          `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
           VALUES ($1, $2, $3, 'paid_workspace', true)
           RETURNING id`,
          [label, `invitation-scope-${randomUUID()}`, adminSession.userId],
        );
        const id = workspace.rows[0]?.id;
        assert.ok(id);
        workspaceIds.push(id);
      }
      const [homeWorkspaceId, foreignWorkspaceId] = workspaceIds;
      assert.ok(homeWorkspaceId);
      assert.ok(foreignWorkspaceId);

      const foreignDepartment = await pool.query<{ id: number }>(
        `INSERT INTO irc_departments (community_id, name)
         VALUES ($1, 'Foreign Department')
         RETURNING id`,
        [foreignWorkspaceId],
      );
      const foreignLocation = await pool.query<{ id: number }>(
        `INSERT INTO irc_locations (community_id, name)
         VALUES ($1, 'Foreign Location')
         RETURNING id`,
        [foreignWorkspaceId],
      );
      const foreignTeam = await pool.query<{ id: number }>(
        `INSERT INTO irc_teams (community_id, department_id, location_id, name)
         VALUES ($1, $2, $3, 'Foreign Team')
         RETURNING id`,
        [
          foreignWorkspaceId,
          foreignDepartment.rows[0]?.id,
          foreignLocation.rows[0]?.id,
        ],
      );
      foreignTeamId = foreignTeam.rows[0]?.id;
      assert.ok(foreignTeamId);

      await pool.query(
        `INSERT INTO irc_workspace_invitations
           (community_id, email, role, department_id, location_id, team_id, invited_by, token_hash, expires_at)
         VALUES ($1, $2, 'employee', $3, $4, $5, $6, $7, now() + interval '1 day')`,
        [
          homeWorkspaceId,
          recipientEmail.toLowerCase(),
          foreignDepartment.rows[0]?.id,
          foreignLocation.rows[0]?.id,
          foreignTeamId,
          adminSession.userId,
          createHash("sha256").update(token).digest("hex"),
        ],
      );

      const response = await apiRequest(
        recipient,
        `/communities/${homeWorkspaceId}/invitations/accept`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );

      assert.equal(response.status, 409, JSON.stringify(response));
      assert.deepEqual(response.body, {
        error: "This invitation contains organization assignments from another workspace.",
      });
      const [invitation, membership, profile, teamMembership] = await Promise.all([
        pool.query(
          "SELECT status, invited_user_id, accepted_at FROM irc_workspace_invitations WHERE community_id = $1",
          [homeWorkspaceId],
        ),
        pool.query(
          "SELECT 1 FROM irc_community_members WHERE community_id = $1 AND user_id = $2",
          [homeWorkspaceId, recipient.userId],
        ),
        pool.query(
          "SELECT 1 FROM irc_employee_profiles WHERE community_id = $1 AND user_id = $2",
          [homeWorkspaceId, recipient.userId],
        ),
        pool.query(
          "SELECT 1 FROM irc_team_members WHERE team_id = $1 AND user_id = $2",
          [foreignTeamId, recipient.userId],
        ),
      ]);
      assert.deepEqual(invitation.rows, [{
        status: "pending",
        invited_user_id: null,
        accepted_at: null,
      }]);
      assert.equal(membership.rowCount, 0);
      assert.equal(profile.rowCount, 0);
      assert.equal(teamMembership.rowCount, 0);
    } finally {
      if (workspaceIds.length) {
        await pool.query(
          "DELETE FROM irc_communities WHERE id = ANY($1::int[])",
          [workspaceIds],
        );
      }
    }
  });

  test("returns 404 without writing audit activity for unknown channel maintenance targets", async () => {
    const unknownChannelId = -1;
    const beforeAudit = await pool.query(
      "SELECT id, actor_id, action, target_id, target_label, details FROM irc_admin_audit_logs ORDER BY id",
    );

    const topicUpdate = await apiRequest(
      adminSession,
      `/admin/channels/${unknownChannelId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "Unknown topic" }),
      },
    );
    const clearMessages = await apiRequest(
      adminSession,
      `/admin/channels/${unknownChannelId}/messages`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    );

    for (const response of [topicUpdate, clearMessages]) {
      assert.equal(response.status, 404, JSON.stringify(response));
      assert.deepEqual(response.body, {
        error: "Channel not found.",
        code: "CHANNEL_NOT_FOUND",
      });
    }

    const afterAudit = await pool.query(
      "SELECT id, actor_id, action, target_id, target_label, details FROM irc_admin_audit_logs ORDER BY id",
    );
    assert.deepEqual(afterAudit.rows, beforeAudit.rows);
  });

  test("admin channel maintenance changes only the selected channel", async () => {
    const targetName = `maintenance-target-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const neighborName = `maintenance-neighbor-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const created = await pool.query<{ id: number; name: string; topic: string }>(
      `INSERT INTO irc_channels (name, topic, owner_id)
       VALUES ($1, $2, $5), ($3, $4, $5)
       RETURNING id, name, topic`,
      [
        targetName,
        "Original target topic",
        neighborName,
        "Original neighbor topic",
        adminSession.userId,
      ],
    );
    const target = created.rows.find(({ name }) => name === targetName);
    const neighbor = created.rows.find(({ name }) => name === neighborName);
    assert.ok(target);
    assert.ok(neighbor);
    const channelIds = [target.id, neighbor.id];
    const targetBodies = ["Target message one", "Target message two"];
    const neighborBodies = ["Neighbor message one", "Neighbor message two"];

    try {
      await pool.query(
        `INSERT INTO irc_messages (channel_id, sender_id, body)
         VALUES ($1, $3, $4), ($1, $3, $5), ($2, $3, $6), ($2, $3, $7)`,
        [
          target.id,
          neighbor.id,
          adminSession.userId,
          ...targetBodies,
          ...neighborBodies,
        ],
      );
      const [targetMessagesBefore, neighborMessagesBefore] = await Promise.all([
        pool.query<{ id: string; body: string }>(
          "SELECT id, body FROM irc_messages WHERE channel_id = $1 ORDER BY created_at, id",
          [target.id],
        ),
        pool.query<{ id: string; body: string }>(
          "SELECT id, body FROM irc_messages WHERE channel_id = $1 ORDER BY created_at, id",
          [neighbor.id],
        ),
      ]);
      assert.deepEqual(
        targetMessagesBefore.rows.map(({ body }) => body).sort(),
        [...targetBodies].sort(),
      );
      assert.deepEqual(
        neighborMessagesBefore.rows.map(({ body }) => body).sort(),
        [...neighborBodies].sort(),
      );

      const topicUpdate = await apiRequest(
        adminSession,
        `/admin/channels/${target.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Updated target topic" }),
        },
      );
      assert.equal(topicUpdate.status, 200, JSON.stringify(topicUpdate));
      assert.ok(topicUpdate.body && typeof topicUpdate.body === "object");
      assert.equal(
        (topicUpdate.body as { topic?: unknown }).topic,
        "Updated target topic",
      );

      const clearHistory = await apiRequest(
        adminSession,
        `/admin/channels/${target.id}/messages`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      );
      assert.equal(clearHistory.status, 200, JSON.stringify(clearHistory));
      assert.deepEqual(clearHistory.body, { ok: true, deleted: targetBodies.length });

      const [targetChannel, neighborChannel, targetMessages, neighborMessages, audit] =
        await Promise.all([
          pool.query<{ id: number; topic: string }>(
            "SELECT id, topic FROM irc_channels WHERE id = $1",
            [target.id],
          ),
          pool.query<{ id: number; topic: string }>(
            "SELECT id, topic FROM irc_channels WHERE id = $1",
            [neighbor.id],
          ),
          pool.query<{ id: string; body: string }>(
            "SELECT id, body FROM irc_messages WHERE channel_id = $1 ORDER BY created_at, id",
            [target.id],
          ),
          pool.query<{ id: string; body: string }>(
            "SELECT id, body FROM irc_messages WHERE channel_id = $1 ORDER BY created_at, id",
            [neighbor.id],
          ),
          pool.query(
            `SELECT actor_id, action, target_id, target_label, details
             FROM irc_admin_audit_logs
             WHERE target_id = ANY($1::text[])
             ORDER BY id`,
            [channelIds.map(String)],
          ),
        ]);

      assert.deepEqual(targetChannel.rows, [{
        id: target.id,
        topic: "Updated target topic",
      }]);
      assert.deepEqual(neighborChannel.rows, [{
        id: neighbor.id,
        topic: "Original neighbor topic",
      }]);
      assert.deepEqual(targetMessages.rows, []);
      assert.deepEqual(neighborMessages.rows, neighborMessagesBefore.rows);
      assert.deepEqual(audit.rows, [
        {
          actor_id: adminSession.userId,
          action: "updated_channel_topic",
          target_id: String(target.id),
          target_label: targetName,
          details: "Updated target topic",
        },
        {
          actor_id: adminSession.userId,
          action: "cleared_channel_history",
          target_id: String(target.id),
          target_label: targetName,
          details: `${targetBodies.length} messages deleted`,
        },
      ]);
    } finally {
      await pool.query(
        `DELETE FROM irc_admin_audit_logs
         WHERE target_id = ANY($1::text[])
           AND action IN ('updated_channel_topic', 'cleared_channel_history')`,
        [channelIds.map(String)],
      );
      await removeTestChannels(channelIds);
    }
  });

  test("uses the same missing-channel response across public and admin routes", async () => {
    const unknownChannelId = -1;
    const requests: Array<Promise<ApiResponse>> = [
      apiRequest(memberSession, `/channels/${unknownChannelId}/join`, { method: "POST" }),
      apiRequest(memberSession, `/channels/${unknownChannelId}/leave`, { method: "POST" }),
      apiRequest(memberSession, `/channels/${unknownChannelId}/members`),
      apiRequest(memberSession, `/channels/${unknownChannelId}/messages`),
      apiRequest(memberSession, `/channels/${unknownChannelId}/join-requests`),
      apiRequest(memberSession, `/channels/${unknownChannelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Unknown channel message" }),
      }),
      apiRequest(memberSession, `/channels/${unknownChannelId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "Unknown channel topic" }),
      }),
      apiRequest(memberSession, `/channels/${unknownChannelId}/moderation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mute", targetUserId: memberSession.userId }),
      }),
      apiRequest(adminSession, `/admin/channels/${unknownChannelId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "Unknown channel topic" }),
      }),
      apiRequest(adminSession, `/admin/channels/${unknownChannelId}/messages`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    ];

    const responses = await Promise.all(requests);
    for (const response of responses) {
      assert.equal(response.status, 404, JSON.stringify(response));
      assert.deepEqual(response.body, {
        error: "Channel not found.",
        code: "CHANNEL_NOT_FOUND",
      });
    }
  });

  test("keeps malformed channel IDs predictable across public and admin routes", async () => {
    const malformedChannelId = "not-a-channel";
    const publicRequests: Array<Promise<ApiResponse>> = [
      apiRequest(memberSession, `/channels/${malformedChannelId}/join`, { method: "POST" }),
      apiRequest(memberSession, `/channels/${malformedChannelId}/messages`),
    ];
    const adminRequests: Array<Promise<ApiResponse>> = [
      apiRequest(adminSession, `/admin/channels/${malformedChannelId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "Malformed channel topic" }),
      }),
      apiRequest(adminSession, `/admin/channels/${malformedChannelId}/messages`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    ];

    const [publicResponses, adminResponses] = await Promise.all([
      Promise.all(publicRequests),
      Promise.all(adminRequests),
    ]);

    // Public channel lookups normalize malformed IDs to the stable missing-channel contract.
    for (const response of publicResponses) {
      assert.equal(response.status, 404, JSON.stringify(response));
      assert.deepEqual(response.body, {
        error: "Channel not found.",
        code: "CHANNEL_NOT_FOUND",
      });
    }

    // Admin maintenance validates malformed IDs before looking up the channel.
    assert.equal(adminResponses[0].status, 400, JSON.stringify(adminResponses[0]));
    assert.deepEqual(adminResponses[0].body, {
      error: "A valid channel update is required.",
    });
    assert.equal(adminResponses[1].status, 400, JSON.stringify(adminResponses[1]));
    assert.deepEqual(adminResponses[1].body, { error: "Invalid channel." });
  });

  test("keeps malformed invite and join-request decisions at their legacy 400 responses", async () => {
    const ownerSession = await createTestSession("malformed_action_owner");
    const requesterSession = await createTestSession("malformed_action_requester");
    const channelIds: number[] = [];

    try {
      const profile = await apiRequest(requesterSession, "/me");
      assert.equal(profile.status, 200, JSON.stringify(profile));
      assert.ok(profile.body && typeof profile.body === "object");
      const username = (profile.body as { username?: unknown }).username;
      assert.equal(typeof username, "string");

      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `malformed-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          isPrivate: true,
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const channelId = (created.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      const joinRequest = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        { method: "POST" },
      );
      assert.equal(joinRequest.status, 202, JSON.stringify(joinRequest));
      assert.deepEqual(joinRequest.body, { ok: true, status: "pending" });

      const channelRecords = async () => {
        const [members, invites, requests] = await Promise.all([
          pool.query(
            "SELECT * FROM irc_channel_members WHERE channel_id = $1 ORDER BY user_id",
            [channelId],
          ),
          pool.query(
            "SELECT * FROM irc_channel_invites WHERE channel_id = $1 ORDER BY user_id",
            [channelId],
          ),
          pool.query(
            "SELECT * FROM irc_channel_join_requests WHERE channel_id = $1 ORDER BY id",
            [channelId],
          ),
        ]);
        return {
          members: members.rows,
          invites: invites.rows,
          requests: requests.rows,
        };
      };
      const before = await channelRecords();
      assert.deepEqual(
        before.members.map((member) => ({ userId: member.user_id, role: member.role })),
        [{ userId: ownerSession.userId, role: "owner" }],
      );
      assert.deepEqual(before.invites, []);
      assert.equal(before.requests.length, 1);
      const request = before.requests[0] as { id: number; status: string };
      assert.equal(request.status, "pending");

      const malformedInvite = await apiRequest(
        ownerSession,
        "/channels/not-a-channel/invites",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username }),
        },
      );
      assert.equal(malformedInvite.status, 400, JSON.stringify(malformedInvite));
      assert.deepEqual(malformedInvite.body, {
        error: "A channel and username are required.",
      });

      const malformedDecision = await apiRequest(
        ownerSession,
        `/channels/not-a-channel/join-requests/${request.id}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(malformedDecision.status, 400, JSON.stringify(malformedDecision));
      assert.deepEqual(malformedDecision.body, {
        error: "Invalid join-request decision.",
      });

      assert.deepEqual(await channelRecords(), before);
    } finally {
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("a non-admin cannot access admin views, announcements, scoped roles, suspension, or scope options", async () => {
    const overview = await apiRequest(memberSession, "/admin/overview");
    assert.equal(overview.status, 403);
    assert.deepEqual(overview.body, { error: "Admin access required." });

    const roleUpdate = await apiRequest(
      memberSession,
      `/admin/users/${adminSession.userId}/role`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
    );
    assert.equal(roleUpdate.status, 403);
    assert.deepEqual(roleUpdate.body, { error: "Admin access required." });

    const beforeAssignments = await pool.query(
      "SELECT id FROM irc_user_roles ORDER BY id",
    );
    const beforeCustomRoles = await pool.query(
      "SELECT key FROM irc_custom_roles ORDER BY key",
    );
    const beforeAnnouncements = await pool.query(
      "SELECT id FROM irc_server_announcements ORDER BY id",
    );
    const beforeAudit = await pool.query(
      "SELECT id FROM irc_admin_audit_logs ORDER BY id",
    );
    const beforeAccountStatus = await pool.query<{ account_status: string }>(
      "SELECT account_status FROM irc_users WHERE clerk_id = $1",
      [adminSession.userId],
    );
    const [announcement, roleAssignment, customRole, accountStatus, scopeOptions] = await Promise.all([
      apiRequest(memberSession, "/admin/announcements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: `Unauthorized announcement ${randomUUID()}` }),
      }),
      apiRequest(memberSession, "/admin/role-assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: memberSession.userId,
          role: "platform_moderator",
          scopeType: "platform",
        }),
      }),
      apiRequest(memberSession, "/admin/custom-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Unauthorized role",
          scopeType: "community",
          permissions: ["manage_community_members"],
        }),
      }),
      apiRequest(memberSession, `/admin/users/${adminSession.userId}/account-status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountStatus: "suspended" }),
      }),
      apiRequest(memberSession, "/admin/scope-options"),
    ]);
    for (const response of [announcement, roleAssignment, customRole, accountStatus, scopeOptions]) {
      assert.equal(response.status, 403, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Admin access required." });
    }
    assert.deepEqual(
      (await pool.query("SELECT id FROM irc_user_roles ORDER BY id")).rows,
      beforeAssignments.rows,
    );
    assert.deepEqual(
      (await pool.query("SELECT key FROM irc_custom_roles ORDER BY key")).rows,
      beforeCustomRoles.rows,
    );
    assert.deepEqual(
      (await pool.query("SELECT id FROM irc_server_announcements ORDER BY id")).rows,
      beforeAnnouncements.rows,
    );
    assert.deepEqual(
      (await pool.query("SELECT id FROM irc_admin_audit_logs ORDER BY id")).rows,
      beforeAudit.rows,
    );
    assert.deepEqual(
      (await pool.query("SELECT account_status FROM irc_users WHERE clerk_id = $1", [adminSession.userId])).rows,
      beforeAccountStatus.rows,
    );
  });

  test("rejects scoped roles with mismatched community, category, or channel relationships and audits a valid grant", async () => {
    const suffix = randomUUID();
    const communityAResult = await pool.query<{ id: number }>(
      `INSERT INTO irc_communities (name, slug, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`Scope A ${suffix}`, `scope-a-${suffix}`, adminSession.userId],
    );
    const communityBResult = await pool.query<{ id: number }>(
      `INSERT INTO irc_communities (name, slug, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`Scope B ${suffix}`, `scope-b-${suffix}`, adminSession.userId],
    );
    const communityA = communityAResult.rows[0].id;
    const communityB = communityBResult.rows[0].id;
    const categoryAResult = await pool.query<{ id: number }>(
      `INSERT INTO irc_categories (name, owner_id, community_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`Category A ${suffix}`, adminSession.userId, communityA],
    );
    const categoryBResult = await pool.query<{ id: number }>(
      `INSERT INTO irc_categories (name, owner_id, community_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`Category B ${suffix}`, adminSession.userId, communityB],
    );
    const categoryA = categoryAResult.rows[0].id;
    const categoryB = categoryBResult.rows[0].id;
    const channelResult = await pool.query<{ id: number }>(
      `INSERT INTO irc_channels (name, owner_id, community_id, category_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [`channel-${suffix}`, adminSession.userId, communityA, categoryA],
    );
    const channelId = channelResult.rows[0].id;
    const assignmentDetails = "department_admin on category";
    let assignmentId: number | null = null;
    const targetProfile = await pool.query<{ display_name: string }>(
      "SELECT display_name FROM irc_users WHERE clerk_id = $1",
      [memberSession.userId],
    );

    const postAssignment = (body: object) => apiRequest(adminSession, "/admin/role-assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    try {
      const beforeAssignments = await pool.query(
        `SELECT id, role, scope_type, community_id, category_id, channel_id
         FROM irc_user_roles
         WHERE user_id = $1 AND community_id = ANY($2::int[])
         ORDER BY id`,
        [memberSession.userId, [communityA, communityB]],
      );
      const beforeGrantAudit = await pool.query(
        `SELECT id FROM irc_admin_audit_logs
         WHERE actor_id = $1 AND target_id = $2 AND action = 'granted_scoped_role'
         ORDER BY id`,
        [adminSession.userId, memberSession.userId],
      );
      const mismatches = await Promise.all([
        postAssignment({
          userId: memberSession.userId,
          role: "department_admin",
          scopeType: "category",
          communityId: communityB,
          categoryId: categoryA,
        }),
        postAssignment({
          userId: memberSession.userId,
          role: "moderator",
          scopeType: "channel",
          communityId: communityB,
          categoryId: categoryA,
          channelId,
        }),
        postAssignment({
          userId: memberSession.userId,
          role: "moderator",
          scopeType: "channel",
          communityId: communityA,
          categoryId: categoryB,
          channelId,
        }),
      ]);
      for (const response of mismatches) {
        assert.equal(response.status, 400, JSON.stringify(response));
      }
      assert.deepEqual(
        (await pool.query(
          `SELECT id, role, scope_type, community_id, category_id, channel_id
           FROM irc_user_roles
           WHERE user_id = $1 AND community_id = ANY($2::int[])
           ORDER BY id`,
          [memberSession.userId, [communityA, communityB]],
        )).rows,
        beforeAssignments.rows,
      );
      assert.deepEqual(
        (await pool.query(
          `SELECT id FROM irc_admin_audit_logs
           WHERE actor_id = $1 AND target_id = $2 AND action = 'granted_scoped_role'
           ORDER BY id`,
          [adminSession.userId, memberSession.userId],
        )).rows,
        beforeGrantAudit.rows,
      );

      const validAssignment = await postAssignment({
        userId: memberSession.userId,
        role: "department_admin",
        scopeType: "category",
        communityId: communityA,
        categoryId: categoryA,
      });
      assert.equal(validAssignment.status, 201, JSON.stringify(validAssignment));
      assert.ok(validAssignment.body && typeof validAssignment.body === "object");
      assignmentId = (validAssignment.body as { id: number }).id;

      const audit = await pool.query(
        `SELECT actor_id, actor_display_name, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE actor_id = $1 AND action = 'granted_scoped_role'
           AND target_id = $2 AND target_label = $3 AND details = $4`,
        [
          adminSession.userId,
          memberSession.userId,
          targetProfile.rows[0].display_name,
          assignmentDetails,
        ],
      );
      assert.deepEqual(audit.rows, [{
        actor_id: adminSession.userId,
        actor_display_name: (await pool.query<{ display_name: string }>(
          "SELECT display_name FROM irc_users WHERE clerk_id = $1",
          [adminSession.userId],
        )).rows[0].display_name,
        action: "granted_scoped_role",
        target_id: memberSession.userId,
        target_label: targetProfile.rows[0].display_name,
        details: assignmentDetails,
      }]);
    } finally {
      if (assignmentId !== null) {
        await pool.query("DELETE FROM irc_user_roles WHERE id = $1", [assignmentId]);
      }
      await pool.query(
        `DELETE FROM irc_admin_audit_logs
         WHERE actor_id = $1 AND action = 'granted_scoped_role'
           AND target_id = $2 AND details = $3`,
        [adminSession.userId, memberSession.userId, assignmentDetails],
      );
      await pool.query("DELETE FROM irc_channels WHERE id = $1", [channelId]);
      await pool.query("DELETE FROM irc_categories WHERE id = ANY($1::int[])", [[categoryA, categoryB]]);
      await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [[communityA, communityB]]);
    }
  });

  test("a non-admin cannot use health, user, or channel maintenance tools", async () => {
    const channelName = `admin-guard-${randomUUID()}`;
    const channelResult = await pool.query<{ id: number; topic: string }>(
      `INSERT INTO irc_channels (name, topic, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id, topic`,
      [channelName, "Protected topic", adminSession.userId],
    );
    const channel = channelResult.rows[0];
    assert.ok(channel);

    const messageResult = await pool.query<{ id: string; body: string }>(
      `INSERT INTO irc_messages (channel_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body`,
      [channel.id, memberSession.userId, "Protected message"],
    );
    const message = messageResult.rows[0];
    assert.ok(message);

    try {
      const beforeChannel = await pool.query(
        "SELECT id, topic FROM irc_channels WHERE id = $1",
        [channel.id],
      );
      const beforeMessages = await pool.query(
        "SELECT id, body FROM irc_messages WHERE channel_id = $1 ORDER BY created_at, id",
        [channel.id],
      );
      const beforeAudit = await pool.query(
        "SELECT * FROM irc_admin_audit_logs ORDER BY id",
      );

      const [health, users, topicUpdate, clearMessages] = await Promise.all([
        apiRequest(memberSession, "/admin/health"),
        apiRequest(memberSession, "/admin/users"),
        apiRequest(memberSession, `/admin/channels/${channel.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Rejected topic" }),
        }),
        apiRequest(memberSession, `/admin/channels/${channel.id}/messages`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        }),
      ]);

      for (const response of [health, users, topicUpdate, clearMessages]) {
        assert.equal(response.status, 403, JSON.stringify(response));
        assert.deepEqual(response.body, { error: "Admin access required." });
      }

      const afterChannel = await pool.query(
        "SELECT id, topic FROM irc_channels WHERE id = $1",
        [channel.id],
      );
      const afterMessages = await pool.query(
        "SELECT id, body FROM irc_messages WHERE channel_id = $1 ORDER BY created_at, id",
        [channel.id],
      );
      const afterAudit = await pool.query(
        "SELECT * FROM irc_admin_audit_logs ORDER BY id",
      );

      assert.deepEqual(afterChannel.rows, beforeChannel.rows);
      assert.deepEqual(afterMessages.rows, beforeMessages.rows);
      assert.deepEqual(afterAudit.rows, beforeAudit.rows);
    } finally {
      await pool.query("DELETE FROM irc_messages WHERE channel_id = $1", [channel.id]);
      await pool.query("DELETE FROM irc_channels WHERE id = $1", [channel.id]);
    }
  });

  test("rejects promoting a second user to admin without changing their role", async () => {
    const response = await apiRequest(
      adminSession,
      `/admin/users/${memberSession.userId}/role`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: "Only one admin account is allowed.",
    });

    const result = await pool.query(
      "SELECT role FROM irc_users WHERE clerk_id = $1",
      [memberSession.userId],
    );
    assert.equal(result.rows[0]?.role, "member");
  });

  test("rejects simultaneous promotions while an administrator already exists", async () => {
    const [firstTarget, secondTarget] = await Promise.all([
      createTestSession("concurrent_promotion_first"),
      createTestSession("concurrent_promotion_second"),
    ]);

    try {
      await Promise.all([
        apiRequest(firstTarget, "/me"),
        apiRequest(secondTarget, "/me"),
      ]);
      await pool.query(
        "UPDATE irc_users SET role = 'member' WHERE clerk_id = ANY($1::text[])",
        [[firstTarget.userId, secondTarget.userId]],
      );
      await pool.query(
        "UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1",
        [adminSession.userId],
      );

      const responses = await Promise.all(
        [firstTarget, secondTarget].map((target) =>
          apiRequest(
            adminSession,
            `/admin/users/${target.userId}/role`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ role: "admin" }),
            },
          ),
        ),
      );

      assert.deepEqual(
        responses.map(({ status }) => status).sort((a, b) => a - b),
        [409, 409],
        JSON.stringify(responses),
      );
      assert.deepEqual(
        responses.filter(({ status }) => status === 409).map(({ body }) => body),
        [
          { error: "Only one admin account is allowed." },
          { error: "Only one admin account is allowed." },
        ],
      );

      const promotionAudit = await pool.query(
        `SELECT actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE action = 'promoted_user'
           AND target_id = ANY($1::text[])
         ORDER BY id`,
        [[firstTarget.userId, secondTarget.userId]],
      );
      assert.deepEqual(promotionAudit.rows, []);

      for (const target of [firstTarget, secondTarget]) {
        const targetRole = await pool.query(
          "SELECT role FROM irc_users WHERE clerk_id = $1",
          [target.userId],
        );
        assert.equal(targetRole.rows[0]?.role, "member");
      }

      const roles = await pool.query(
        "SELECT clerk_id, role FROM irc_users WHERE clerk_id = ANY($1::text[]) ORDER BY clerk_id",
        [[firstTarget.userId, secondTarget.userId]],
      );
      assert.equal(
        roles.rows.filter(({ role }) => role === "admin").length,
        0,
        JSON.stringify(roles.rows),
      );
      assert.equal(
        roles.rows.filter(({ role }) => role === "member").length,
        2,
        JSON.stringify(roles.rows),
      );

      const adminCount = await pool.query(
        "SELECT count(*)::int AS count FROM irc_users WHERE role = 'admin'",
      );
      assert.equal(adminCount.rows[0]?.count, 1);
    } finally {
      await pool.query(
        "UPDATE irc_users SET role = 'member' WHERE clerk_id = ANY($1::text[])",
        [[firstTarget.userId, secondTarget.userId]],
      );
    }
  });

  test("rejects unsupported role payloads without changing an account's role", async () => {
    for (const payload of [{ role: "owner" }, { role: "ADMIN" }, {}]) {
      const response = await apiRequest(
        adminSession,
        `/admin/users/${adminSession.userId}/role`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        error: "Role must be one of admin, moderator, community_admin, or member.",
      });
    }

    const result = await pool.query(
      "SELECT role FROM irc_users WHERE clerk_id = $1",
      [adminSession.userId],
    );
    assert.equal(result.rows[0]?.role, "admin");
  });

  test("an admin cannot demote their own account", async () => {
    const response = await apiRequest(
      adminSession,
      `/admin/users/${adminSession.userId}/role`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: "You cannot remove your own admin access.",
    });

    const result = await pool.query(
      "SELECT role FROM irc_users WHERE clerk_id = $1",
      [adminSession.userId],
    );
    assert.equal(result.rows[0]?.role, "admin");
  });

  test("batches custom-role permission checks without crossing workspace scopes", async () => {
    const roleUser = await createTestSession("custom_role_batch");
    const roleSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const allowingRole = `custom_allow_${roleSuffix}`;
    const denyingRole = `custom_deny_${roleSuffix}`;
    const communityIds: number[] = [];

    try {
      const profile = await apiRequest(roleUser, "/me");
      assert.equal(profile.status, 200, JSON.stringify(profile));

      const catalog = await apiRequest(adminSession, "/permissions/catalog");
      assert.equal(catalog.status, 200, JSON.stringify(catalog));

      const communities = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, is_private)
         VALUES
           ($1, $2, $5, true),
           ($3, $4, $5, true)
         RETURNING id`,
        [
          `Allowed ${roleSuffix}`,
          `allowed-${roleSuffix}`,
          `Denied ${roleSuffix}`,
          `denied-${roleSuffix}`,
          adminSession.userId,
        ],
      );
      communityIds.push(...communities.rows.map(({ id }) => id));
      assert.equal(communityIds.length, 2);

      await pool.query(
        `INSERT INTO irc_custom_roles
           (key, label, scope_type, created_by)
         VALUES
           ($1, 'Allows business view', 'community', $3),
           ($2, 'Does not allow business view', 'community', $3)`,
        [allowingRole, denyingRole, adminSession.userId],
      );
      await pool.query(
        `INSERT INTO irc_role_permissions (role, permission_id)
         SELECT $1, id
         FROM irc_permission_definitions
         WHERE key = 'view_business'`,
        [allowingRole],
      );
      await pool.query(
        `INSERT INTO irc_user_roles
           (user_id, role, scope_type, community_id, granted_by)
         VALUES
           ($1, $2, 'community', $4, $5),
           ($1, $3, 'community', $4, $5)`,
        [
          roleUser.userId,
          allowingRole,
          denyingRole,
          communityIds[0],
          adminSession.userId,
        ],
      );

      assert.equal(
        await hasPermission(roleUser.userId, "view_business", {
          communityId: communityIds[0],
        }),
        true,
      );
      assert.equal(
        await hasPermission(roleUser.userId, "view_business", {
          communityId: communityIds[1],
        }),
        false,
      );
      assert.equal(
        await hasPermission(roleUser.userId, "manage_community", {
          communityId: communityIds[0],
        }),
        false,
      );
    } finally {
      await pool.query(
        "DELETE FROM irc_user_roles WHERE role = ANY($1::text[])",
        [[allowingRole, denyingRole]],
      );
      await pool.query(
        "DELETE FROM irc_role_permissions WHERE role = ANY($1::text[])",
        [[allowingRole, denyingRole]],
      );
      await pool.query(
        "DELETE FROM irc_custom_roles WHERE key = ANY($1::text[])",
        [[allowingRole, denyingRole]],
      );
      if (communityIds.length) {
        await pool.query(
          "DELETE FROM irc_communities WHERE id = ANY($1::int[])",
          [communityIds],
        );
      }
    }
  });

  test("prevents workspace administrators from promoting at or above their own rank", async () => {
    const ownerSession = await createTestSession("role_guard_owner");
    const actorSession = await createTestSession("role_guard_actor");
    const targetSession = await createTestSession("role_guard_target");
    let communityId: number | null = null;

    try {
      const [actorProfile, targetProfile] = await Promise.all([
        apiRequest(actorSession, "/me"),
        apiRequest(targetSession, "/me"),
      ]);
      assert.equal(actorProfile.status, 200, JSON.stringify(actorProfile));
      assert.equal(targetProfile.status, 200, JSON.stringify(targetProfile));

      const community = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Role guard ${randomUUID().slice(0, 8)}`,
          isPrivate: true,
        }),
      });
      assert.equal(community.status, 201, JSON.stringify(community));
      assert.ok(community.body && typeof community.body === "object");
      communityId = (community.body as { id?: unknown }).id as number;
      assert.equal(typeof communityId, "number");

      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [communityId, actorSession.userId, targetSession.userId],
      );
      await pool.query(
        `INSERT INTO irc_user_roles
           (user_id, role, scope_type, community_id, granted_by)
         VALUES ($1, 'workspace_admin', 'community', $2, $3)`,
        [actorSession.userId, communityId, ownerSession.userId],
      );

      const auditCountBefore = Number(
        (
          await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM irc_admin_audit_logs
             WHERE actor_id = $1
               AND community_id = $2
               AND action = 'changed_community_role'`,
            [actorSession.userId, communityId],
          )
        ).rows[0]?.count ?? 0,
      );

      for (const role of ["workspace_owner", "workspace_admin"]) {
        const rejected = await apiRequest(
          actorSession,
          `/communities/${communityId}/members/${targetSession.userId}/role`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role }),
          },
        );
        assert.equal(rejected.status, 403, JSON.stringify(rejected));
        assert.deepEqual(rejected.body, {
          error: "You can only assign roles below your own workspace role.",
        });
      }

      const rejectedRoles = await pool.query<{ role: string }>(
        `SELECT role
         FROM irc_user_roles
         WHERE user_id = $1 AND community_id = $2
         ORDER BY role`,
        [targetSession.userId, communityId],
      );
      assert.deepEqual(rejectedRoles.rows, []);
      const auditAfterRejections = Number(
        (
          await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM irc_admin_audit_logs
             WHERE actor_id = $1
               AND community_id = $2
               AND action = 'changed_community_role'`,
            [actorSession.userId, communityId],
          )
        ).rows[0]?.count ?? 0,
      );
      assert.equal(auditAfterRejections, auditCountBefore);

      const allowed = await apiRequest(
        actorSession,
        `/communities/${communityId}/members/${targetSession.userId}/role`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "manager" }),
        },
      );
      assert.equal(allowed.status, 200, JSON.stringify(allowed));
      assert.deepEqual(allowed.body, {
        ok: true,
        userId: targetSession.userId,
        role: "manager",
        communityId,
      });
      const assignedRoles = await pool.query<{ role: string }>(
        `SELECT role
         FROM irc_user_roles
         WHERE user_id = $1 AND community_id = $2
         ORDER BY role`,
        [targetSession.userId, communityId],
      );
      assert.deepEqual(assignedRoles.rows, [{ role: "manager" }]);
      const auditAfterSuccess = Number(
        (
          await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM irc_admin_audit_logs
             WHERE actor_id = $1
               AND community_id = $2
               AND action = 'changed_community_role'`,
            [actorSession.userId, communityId],
          )
        ).rows[0]?.count ?? 0,
      );
      assert.equal(auditAfterSuccess, auditCountBefore + 1);
    } finally {
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [
          communityId,
        ]);
      }
    }
  });

  test("does not let a revoked role win a concurrent promotion race", async () => {
    const ownerSession = await createTestSession("role_race_owner");
    const actorSession = await createTestSession("role_race_actor");
    const targetSession = await createTestSession("role_race_target");
    let communityId: number | null = null;
    const revocation = await pool.connect();

    try {
      await Promise.all([
        apiRequest(ownerSession, "/me"),
        apiRequest(actorSession, "/me"),
        apiRequest(targetSession, "/me"),
      ]);
      const community = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Role race ${randomUUID().slice(0, 8)}`,
          isPrivate: true,
        }),
      });
      assert.equal(community.status, 201, JSON.stringify(community));
      assert.ok(community.body && typeof community.body === "object");
      communityId = (community.body as { id?: unknown }).id as number;
      assert.equal(typeof communityId, "number");

      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [communityId, actorSession.userId, targetSession.userId],
      );
      await pool.query(
        `INSERT INTO irc_user_roles
           (user_id, role, scope_type, community_id, granted_by)
         VALUES ($1, 'workspace_admin', 'community', $2, $3)`,
        [actorSession.userId, communityId, ownerSession.userId],
      );

      // Warm the session token before holding the database lock so the request
      // reaches the role endpoint while revocation is still in progress.
      await apiRequest(actorSession, "/me");
      await revocation.query("BEGIN");
      await revocation.query(
        "SELECT clerk_id FROM irc_users WHERE clerk_id = $1 FOR UPDATE",
        [actorSession.userId],
      );

      const promotion = apiRequest(
        actorSession,
        `/communities/${communityId}/members/${targetSession.userId}/role`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "workspace_owner" }),
        },
      );
      let requestBlockedOnAuthorization = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const waiting = await pool.query(
          `SELECT pid
           FROM pg_stat_activity
           WHERE pid <> pg_backend_pid()
             AND state = 'active'
             AND wait_event_type = 'Lock'
             AND query ILIKE '%irc_users%'`,
        );
        if (waiting.rows.length > 0) {
          requestBlockedOnAuthorization = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        requestBlockedOnAuthorization,
        true,
        "the promotion should wait for the actor authorization lock",
      );
      await revocation.query(
        `DELETE FROM irc_user_roles
         WHERE user_id = $1 AND community_id = $2 AND role = 'workspace_admin'`,
        [actorSession.userId, communityId],
      );
      await revocation.query("COMMIT");

      const rejected = await promotion;
      assert.equal(rejected.status, 403, JSON.stringify(rejected));
      assert.deepEqual(rejected.body, {
        error: "You cannot manage members in this community.",
      });

      const targetRoles = await pool.query(
        `SELECT role
         FROM irc_user_roles
         WHERE user_id = $1 AND community_id = $2`,
        [targetSession.userId, communityId],
      );
      assert.deepEqual(targetRoles.rows, []);
    } finally {
      await revocation.query("ROLLBACK").catch(() => undefined);
      revocation.release();
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [
          communityId,
        ]);
      }
    }
  });

  test("creates only one chat identity during concurrent first-session requests", async () => {
    const session = await createTestSession("concurrent_profile");
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        apiRequest(session, index % 2 === 0 ? "/me" : "/channels"),
      ),
    );
    assert.ok(
      responses.every(({ status }) => status === 200),
      JSON.stringify(responses),
    );

    const profiles = await pool.query<{
      clerk_id: string;
      username: string;
    }>(
      `SELECT clerk_id, username
       FROM irc_users
       WHERE clerk_id = $1`,
      [session.userId],
    );
    assert.equal(profiles.rows.length, 1);
    assert.equal(profiles.rows[0]?.clerk_id, session.userId);

    const profile = await apiRequest(session, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));
    assert.equal(
      (profile.body as { id?: unknown }).id,
      session.userId,
    );
  });

  test("prevents suspended accounts from changing their profile", async () => {
    const suspendedSession = await createTestSession("suspended_profile");
    let suspended = false;
    let messageId: string | null = null;
    const messageBody = `Suspension preserves messages ${randomUUID()}`;

    try {
      const initial = await apiRequest(suspendedSession, "/me");
      assert.equal(initial.status, 200, JSON.stringify(initial));
      assert.ok(initial.body && typeof initial.body === "object");
      const initialUsername = (initial.body as { username?: unknown }).username;
      const initialDisplayName = (
        initial.body as { displayName?: unknown }
      ).displayName;
      const seededMessage = await pool.query<{ id: string }>(
        `INSERT INTO irc_messages (sender_id, recipient_id, body)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [suspendedSession.userId, adminSession.userId, messageBody],
      );
      messageId = seededMessage.rows[0].id;

      const suspension = await apiRequest(
        adminSession,
        `/admin/users/${suspendedSession.userId}/account-status`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountStatus: "suspended" }),
        },
      );
      assert.equal(suspension.status, 200, JSON.stringify(suspension));
      suspended = true;

      const rejected = await apiRequest(suspendedSession, "/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: `blocked_${randomUUID().slice(0, 8)}`,
          displayName: "Blocked profile update",
        }),
      });
      assert.equal(rejected.status, 403, JSON.stringify(rejected));
      assert.deepEqual(rejected.body, {
        error: "This account is suspended.",
      });

      const deniedProfileRead = await apiRequest(suspendedSession, "/me");
      const deniedMessageRead = await apiRequest(
        suspendedSession,
        `/dm/${adminSession.userId}/messages`,
      );
      assert.equal(deniedProfileRead.status, 403, JSON.stringify(deniedProfileRead));
      assert.equal(deniedMessageRead.status, 403, JSON.stringify(deniedMessageRead));

      const stored = await pool.query<{
        username: string;
        display_name: string;
        account_status: string;
      }>(
        `SELECT username, display_name, account_status
         FROM irc_users
         WHERE clerk_id = $1`,
        [suspendedSession.userId],
      );
      assert.deepEqual(stored.rows, [
        {
          username: initialUsername,
          display_name: initialDisplayName,
          account_status: "suspended",
        },
      ]);
      const preservedMessage = await pool.query<{ id: string; body: string }>(
        "SELECT id, body FROM irc_messages WHERE id = $1 AND sender_id = $2",
        [messageId, suspendedSession.userId],
      );
      assert.deepEqual(preservedMessage.rows, [{ id: messageId, body: messageBody }]);

      const suspensionAudit = await pool.query(
        `SELECT actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE actor_id = $1 AND target_id = $2 AND action = 'suspended_user'`,
        [adminSession.userId, suspendedSession.userId],
      );
      assert.deepEqual(suspensionAudit.rows, [{
        actor_id: adminSession.userId,
        action: "suspended_user",
        target_id: suspendedSession.userId,
        target_label: suspendedSession.userId,
        details: "Account status changed to suspended",
      }]);

      const restoration = await apiRequest(
        adminSession,
        `/admin/users/${suspendedSession.userId}/account-status`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountStatus: "active" }),
        },
      );
      assert.equal(restoration.status, 200, JSON.stringify(restoration));
      suspended = false;

      const restoredAudit = await pool.query(
        `SELECT actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE actor_id = $1 AND target_id = $2
           AND action IN ('suspended_user', 'restored_user')
         ORDER BY id`,
        [adminSession.userId, suspendedSession.userId],
      );
      assert.deepEqual(restoredAudit.rows, [
        {
          actor_id: adminSession.userId,
          action: "suspended_user",
          target_id: suspendedSession.userId,
          target_label: suspendedSession.userId,
          details: "Account status changed to suspended",
        },
        {
          actor_id: adminSession.userId,
          action: "restored_user",
          target_id: suspendedSession.userId,
          target_label: suspendedSession.userId,
          details: "Account status changed to active",
        },
      ]);
    } finally {
      if (suspended) {
        await apiRequest(
          adminSession,
          `/admin/users/${suspendedSession.userId}/account-status`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ accountStatus: "active" }),
          },
        );
      }
      if (messageId !== null) {
        await pool.query("DELETE FROM irc_messages WHERE id = $1", [messageId]);
      }
      await pool.query(
        `DELETE FROM irc_admin_audit_logs
         WHERE actor_id = $1 AND target_id = $2
           AND action IN ('suspended_user', 'restored_user')`,
        [adminSession.userId, suspendedSession.userId],
      );
    }
  });

  test("rejects malformed and nonexistent realtime subscriptions and typing", async () => {
    const ownerSession = await createTestSession("invalid_subscription_owner");
    const memberSession = await createTestSession("invalid_subscription_member");
    const invalidSession = await createTestSession("invalid_subscription_probe");
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      for (const session of [ownerSession, memberSession, invalidSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }

      const createChannel = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `invalid-sub-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Invalid subscription isolation",
        }),
      });
      assert.equal(createChannel.status, 201, JSON.stringify(createChannel));
      assert.ok(createChannel.body && typeof createChannel.body === "object");
      const channelId = (createChannel.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [channelId, memberSession.userId],
      );

      const unknownChannelId = 2_000_000_000;
      const existingUnknownChannel = await pool.query(
        "SELECT 1 FROM irc_channels WHERE id = $1",
        [unknownChannelId],
      );
      assert.equal(existingUnknownChannel.rowCount, 0);

      const ownerSocket = await openWebSocket(ownerSession);
      const memberSocket = await openWebSocket(memberSession);
      const invalidSocket = await openWebSocket(invalidSession);
      sockets.push(ownerSocket, memberSocket, invalidSocket);
      ownerSocket.send(JSON.stringify({ type: "subscribe", channelId }));
      memberSocket.send(JSON.stringify({ type: "subscribe", channelId }));

      const malformedFrames = [
        "{",
        JSON.stringify({}),
        JSON.stringify({ type: "unknown", channelId }),
        ...[
          String(channelId),
          null,
          1.5,
          -1,
          Number.MAX_SAFE_INTEGER + 1,
        ].map((invalidChannelId) =>
          JSON.stringify({ type: "subscribe", channelId: invalidChannelId }),
        ),
        JSON.stringify({ type: "subscribe", channelId: unknownChannelId }),
        JSON.stringify({ type: "typing", channelId: String(channelId), active: true }),
        JSON.stringify({ type: "typing", channelId: unknownChannelId, active: true }),
      ];
      for (const frame of malformedFrames) invalidSocket.send(frame);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const body = `Valid subscription ${randomUUID()}`;
      const validMessage = waitForWebSocketEvent(
        memberSocket,
        (event) =>
          event.type === "message" &&
          (event.message as { body?: unknown } | undefined)?.body === body,
      );
      const blockedMessage = expectNoWebSocketEvent(
        invalidSocket,
        (event) =>
          event.type === "message" &&
          (event.message as { body?: unknown } | undefined)?.body === body,
        1_000,
      );
      const message = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      assert.equal(message.status, 201, JSON.stringify(message));
      await validMessage;
      await blockedMessage;

      const unknownBroadcastMarker = randomUUID();
      const blockedUnknownBroadcast = expectNoWebSocketEvent(
        invalidSocket,
        (event) =>
          event.type === "subscription_probe" &&
          event.marker === unknownBroadcastMarker,
        250,
      );
      wsHub.broadcastChannel(unknownChannelId, {
        type: "subscription_probe",
        marker: unknownBroadcastMarker,
      });
      await blockedUnknownBroadcast;

      const blockedInvalidTyping = Promise.all([
        expectNoWebSocketEvent(
          ownerSocket,
          (event) => event.type === "typing" && event.userId === invalidSession.userId,
          750,
        ),
        expectNoWebSocketEvent(
          memberSocket,
          (event) => event.type === "typing" && event.userId === invalidSession.userId,
          750,
        ),
      ]);
      invalidSocket.send(
        JSON.stringify({ type: "typing", channelId: String(channelId), active: true }),
      );
      invalidSocket.send(
        JSON.stringify({ type: "typing", channelId: unknownChannelId, active: true }),
      );
      await blockedInvalidTyping;

      const validTyping = waitForWebSocketEvent(
        ownerSocket,
        (event) =>
          event.type === "typing" &&
          event.channelId === channelId &&
          event.userId === memberSession.userId,
      );
      memberSocket.send(JSON.stringify({ type: "typing", channelId, active: true }));
      const typingEvent = await validTyping;
      assert.equal(typingEvent.active, true);
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        memberSession.userId,
        invalidSession.userId,
      ]);
    }
  });

  test("preserves channel history when channel settings change", async () => {
    const ownerSession = await createTestSession("history_preservation");
    const channelIds: number[] = [];

    try {
      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `history-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Initial topic",
          description: "Initial description",
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const channelId = (created.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      const sent = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "History must survive edits." }),
        },
      );
      assert.equal(sent.status, 201, JSON.stringify(sent));

      const ownerEdit = await apiRequest(
        ownerSession,
        `/channels/${channelId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            topic: "Updated topic",
            description: "Updated description",
            isInviteOnly: true,
          }),
        },
      );
      assert.equal(ownerEdit.status, 200, JSON.stringify(ownerEdit));

      const adminEdit = await apiRequest(
        adminSession,
        `/admin/channels/${channelId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Admin updated topic" }),
        },
      );
      assert.equal(adminEdit.status, 200, JSON.stringify(adminEdit));

      const history = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
      );
      assert.equal(history.status, 200, JSON.stringify(history));
      assert.ok(history.body && typeof history.body === "object");
      const messages = (history.body as {
        messages?: Array<{ body?: unknown }>;
      }).messages;
      assert.deepEqual(messages?.map(({ body }) => body), [
        "History must survive edits.",
      ]);
    } finally {
      await removeTestChannels(channelIds, [ownerSession.userId]);
    }
  });

  test("rolls back a channel topic change when recording admin activity fails", async () => {
    const ownerSession = await createTestSession("topic_audit_failure");
    const channelIds: number[] = [];
    const triggerName = `fail_topic_audit_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    let triggerCreated = false;

    try {
      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `topic-failure-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Original topic",
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const channelId = (created.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action = 'updated_channel_topic' THEN
             RAISE EXCEPTION 'forced topic audit failure';
           END IF;
           RETURN NEW;
         END;
         $$;`,
      );
      await pool.query(
        `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON irc_admin_audit_logs
         FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
      );
      triggerCreated = true;

      const beforeAudit = await pool.query(
        `SELECT id, actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE action = 'updated_channel_topic' AND target_id = $1
         ORDER BY id`,
        [String(channelId)],
      );
      const response = await apiRequest(
        adminSession,
        `/admin/channels/${channelId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Must roll back" }),
        },
      );
      assert.equal(response.status, 500);

      const afterChannel = await pool.query(
        "SELECT topic FROM irc_channels WHERE id = $1",
        [channelId],
      );
      const afterAudit = await pool.query(
        `SELECT id, actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE action = 'updated_channel_topic' AND target_id = $1
         ORDER BY id`,
        [String(channelId)],
      );
      assert.deepEqual(afterChannel.rows, [{ topic: "Original topic" }]);
      assert.deepEqual(afterAudit.rows, beforeAudit.rows);
    } finally {
      if (triggerCreated) {
        await pool.query(
          `DROP TRIGGER IF EXISTS "${triggerName}" ON irc_admin_audit_logs;
           DROP FUNCTION IF EXISTS "${functionName}"();`,
        );
      } else {
        await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"();`);
      }
      await removeTestChannels(channelIds, [ownerSession.userId]);
    }
  });

  test("restores messages when recording a channel clear fails", async () => {
    const ownerSession = await createTestSession("clear_audit_failure");
    const channelIds: number[] = [];
    const triggerName = `fail_clear_audit_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    let triggerCreated = false;

    try {
      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `clear-failure-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Clear rollback test",
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const channelId = (created.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      const sent = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "This message must survive." }),
        },
      );
      assert.equal(sent.status, 201, JSON.stringify(sent));

      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action = 'cleared_channel_history' THEN
             RAISE EXCEPTION 'forced clear audit failure';
           END IF;
           RETURN NEW;
         END;
         $$;`,
      );
      await pool.query(
        `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON irc_admin_audit_logs
         FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
      );
      triggerCreated = true;

      const beforeMessages = await pool.query(
        "SELECT id, body FROM irc_messages WHERE channel_id = $1 ORDER BY id",
        [channelId],
      );
      const beforeAudit = await pool.query(
        `SELECT id, actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE action = 'cleared_channel_history' AND target_id = $1
         ORDER BY id`,
        [String(channelId)],
      );
      const response = await apiRequest(
        adminSession,
        `/admin/channels/${channelId}/messages`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      );
      assert.equal(response.status, 500);

      const afterMessages = await pool.query(
        "SELECT id, body FROM irc_messages WHERE channel_id = $1 ORDER BY id",
        [channelId],
      );
      const afterAudit = await pool.query(
        `SELECT id, actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE action = 'cleared_channel_history' AND target_id = $1
         ORDER BY id`,
        [String(channelId)],
      );
      assert.deepEqual(afterMessages.rows, beforeMessages.rows);
      assert.deepEqual(afterAudit.rows, beforeAudit.rows);
    } finally {
      if (triggerCreated) {
        await pool.query(
          `DROP TRIGGER IF EXISTS "${triggerName}" ON irc_admin_audit_logs;
           DROP FUNCTION IF EXISTS "${functionName}"();`,
        );
      } else {
        await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"();`);
      }
      await removeTestChannels(channelIds, [ownerSession.userId]);
    }
  });

  test("reports channel member counts without loading every membership row", async () => {
    const ownerSession = await createTestSession("channel_count_owner");
    const memberSession = await createTestSession("channel_count_member");
    const channelIds: number[] = [];

    try {
      const memberProfile = await apiRequest(memberSession, "/me");
      assert.equal(memberProfile.status, 200, JSON.stringify(memberProfile));

      const createChannel = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `counted-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Member count aggregation",
        }),
      });
      assert.equal(createChannel.status, 201, JSON.stringify(createChannel));
      assert.ok(createChannel.body && typeof createChannel.body === "object");
      const countedChannelId = (createChannel.body as { id?: unknown }).id;
      assert.equal(typeof countedChannelId, "number");
      channelIds.push(countedChannelId as number);

      const zeroMemberChannel = await pool.query<{ id: number }>(
        `INSERT INTO irc_channels (name, topic, owner_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [
          `empty-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          "Zero member count aggregation",
          ownerSession.userId,
        ],
      );
      const zeroMemberChannelId = zeroMemberChannel.rows[0]?.id;
      assert.equal(typeof zeroMemberChannelId, "number");
      channelIds.push(zeroMemberChannelId);

      const initialList = await apiRequest(ownerSession, "/channels");
      assert.equal(initialList.status, 200, JSON.stringify(initialList));
      assert.ok(Array.isArray(initialList.body));
      const initialCounted = initialList.body.find(
        (channel): channel is { id: number; memberCount: number } =>
          typeof channel === "object" &&
          channel !== null &&
          (channel as { id?: unknown }).id === countedChannelId,
      );
      const initialEmpty = initialList.body.find(
        (channel): channel is { id: number; memberCount: number } =>
          typeof channel === "object" &&
          channel !== null &&
          (channel as { id?: unknown }).id === zeroMemberChannelId,
      );
      assert.equal(initialCounted?.memberCount, 1);
      assert.equal(initialEmpty?.memberCount, 0);

      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [countedChannelId, memberSession.userId],
      );

      const updatedList = await apiRequest(ownerSession, "/channels");
      assert.equal(updatedList.status, 200, JSON.stringify(updatedList));
      assert.ok(Array.isArray(updatedList.body));
      const updatedCounted = updatedList.body.find(
        (channel): channel is { id: number; memberCount: number } =>
          typeof channel === "object" &&
          channel !== null &&
          (channel as { id?: unknown }).id === countedChannelId,
      );
      assert.equal(updatedCounted?.memberCount, 2);
    } finally {
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        memberSession.userId,
      ]);
    }
  });

  test("keeps category visibility isolated while batching community access data", async () => {
    const privateOwner = await createTestSession("private_category_owner");
    const publicOwner = await createTestSession("public_category_owner");
    const outsider = await createTestSession("category_outsider");
    const communityIds: number[] = [];

    try {
      const outsiderProfile = await apiRequest(outsider, "/me");
      assert.equal(outsiderProfile.status, 200, JSON.stringify(outsiderProfile));

      const privateCommunity = await apiRequest(privateOwner, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Private category ${randomUUID().slice(0, 8)}`,
          isPrivate: true,
        }),
      });
      assert.equal(privateCommunity.status, 201, JSON.stringify(privateCommunity));
      assert.ok(privateCommunity.body && typeof privateCommunity.body === "object");
      const privateCommunityId = (
        privateCommunity.body as { id?: unknown }
      ).id;
      assert.equal(typeof privateCommunityId, "number");
      communityIds.push(privateCommunityId as number);

      const publicCommunity = await apiRequest(publicOwner, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Public category ${randomUUID().slice(0, 8)}`,
          isPrivate: false,
        }),
      });
      assert.equal(publicCommunity.status, 201, JSON.stringify(publicCommunity));
      assert.ok(publicCommunity.body && typeof publicCommunity.body === "object");
      const publicCommunityId = (
        publicCommunity.body as { id?: unknown }
      ).id;
      assert.equal(typeof publicCommunityId, "number");
      communityIds.push(publicCommunityId as number);

      const ownerChannels = await apiRequest(privateOwner, "/channels");
      assert.equal(ownerChannels.status, 200, JSON.stringify(ownerChannels));
      assert.ok(Array.isArray(ownerChannels.body));
      const visiblePrivateChannels = ownerChannels.body.filter(
        (channel): channel is {
          communityId: number;
          category: { communityId?: unknown } | null;
        } =>
          typeof channel === "object" &&
          channel !== null &&
          (channel as { communityId?: unknown }).communityId ===
            privateCommunityId,
      );
      assert.ok(visiblePrivateChannels.length > 0);
      assert.ok(
        visiblePrivateChannels.every(
          (channel) =>
            channel.category?.communityId === privateCommunityId,
        ),
      );

      const outsiderChannels = await apiRequest(outsider, "/channels");
      assert.equal(outsiderChannels.status, 200, JSON.stringify(outsiderChannels));
      assert.ok(Array.isArray(outsiderChannels.body));
      assert.equal(
        outsiderChannels.body.some(
          (channel) =>
            typeof channel === "object" &&
            channel !== null &&
            (channel as { communityId?: unknown }).communityId ===
              privateCommunityId,
        ),
        false,
      );
      const visiblePublicChannels = outsiderChannels.body.filter(
        (channel): channel is {
          communityId: number;
          category: { communityId?: unknown } | null;
        } =>
          typeof channel === "object" &&
          channel !== null &&
          (channel as { communityId?: unknown }).communityId ===
            publicCommunityId,
      );
      assert.ok(visiblePublicChannels.length > 0);
      assert.ok(
        visiblePublicChannels.every(
          (channel) =>
            channel.category?.communityId === publicCommunityId,
        ),
      );

      const adminChannels = await apiRequest(adminSession, "/channels");
      assert.equal(adminChannels.status, 200, JSON.stringify(adminChannels));
      assert.ok(Array.isArray(adminChannels.body));
      const visibleAdminPrivateChannels = adminChannels.body.filter(
        (channel): channel is {
          communityId: number;
          isPrivate: boolean;
          category: { communityId?: unknown } | null;
        } =>
          typeof channel === "object" &&
          channel !== null &&
          (channel as { communityId?: unknown }).communityId ===
            privateCommunityId,
      );
      assert.ok(visibleAdminPrivateChannels.length > 0);
      assert.ok(
        visibleAdminPrivateChannels.every(
          (channel) =>
            channel.isPrivate === false &&
            channel.category?.communityId === privateCommunityId,
        ),
      );

      const privateOwnerCategories = await apiRequest(
        privateOwner,
        "/categories",
      );
      assert.equal(
        privateOwnerCategories.status,
        200,
        JSON.stringify(privateOwnerCategories),
      );
      assert.ok(Array.isArray(privateOwnerCategories.body));
      assert.equal(
        privateOwnerCategories.body.some(
          (category) =>
            typeof category === "object" &&
            category !== null &&
            (category as { communityId?: unknown }).communityId ===
              privateCommunityId,
        ),
        true,
      );

      const publicOwnerCategories = await apiRequest(publicOwner, "/categories");
      assert.equal(
        publicOwnerCategories.status,
        200,
        JSON.stringify(publicOwnerCategories),
      );
      assert.ok(Array.isArray(publicOwnerCategories.body));
      assert.equal(
        publicOwnerCategories.body.some(
          (category) =>
            typeof category === "object" &&
            category !== null &&
            (category as { communityId?: unknown }).communityId ===
              publicCommunityId,
        ),
        true,
      );

      const outsiderCategories = await apiRequest(outsider, "/categories");
      assert.equal(
        outsiderCategories.status,
        200,
        JSON.stringify(outsiderCategories),
      );
      assert.ok(Array.isArray(outsiderCategories.body));
      assert.equal(
        outsiderCategories.body.some(
          (category) =>
            typeof category === "object" &&
            category !== null &&
            [privateCommunityId, publicCommunityId].includes(
              (category as { communityId?: number }).communityId ?? -1,
            ),
        ),
        false,
      );

      const adminCategories = await apiRequest(adminSession, "/categories");
      assert.equal(adminCategories.status, 200, JSON.stringify(adminCategories));
      assert.ok(Array.isArray(adminCategories.body));
      const adminCommunityIds = new Set(
        adminCategories.body.flatMap((category) =>
          typeof category === "object" &&
          category !== null &&
          typeof (category as { communityId?: unknown }).communityId ===
            "number"
            ? [(category as { communityId: number }).communityId]
            : [],
        ),
      );
      assert.equal(adminCommunityIds.has(privateCommunityId as number), true);
      assert.equal(adminCommunityIds.has(publicCommunityId as number), true);
    } finally {
      if (communityIds.length) {
        await pool.query(
          "DELETE FROM irc_communities WHERE id = ANY($1::int[])",
          [communityIds],
        );
      }
    }
  });

  test("reports exact community dashboard statistics from database aggregates", async () => {
    const ownerSession = await createTestSession("dashboard_owner");
    const workerSession = await createTestSession("dashboard_worker");
    let communityId: number | null = null;

    try {
      const workerProfile = await apiRequest(workerSession, "/me");
      assert.equal(workerProfile.status, 200, JSON.stringify(workerProfile));

      const community = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Dashboard ${randomUUID().slice(0, 8)}`,
          isPrivate: true,
        }),
      });
      assert.equal(community.status, 201, JSON.stringify(community));
      assert.ok(community.body && typeof community.body === "object");
      communityId = (community.body as { id?: unknown }).id as number;
      assert.equal(typeof communityId, "number");

      await pool.query(
        `UPDATE irc_users SET status = CASE
           WHEN clerk_id = $1 THEN 'online'
           WHEN clerk_id = $2 THEN 'offline'
           ELSE status
         END
         WHERE clerk_id IN ($1, $2)`,
        [ownerSession.userId, workerSession.userId],
      );
      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'member')`,
        [communityId, workerSession.userId],
      );

      const channelIds = (
        await pool.query<{ id: number }>(
          "SELECT id FROM irc_channels WHERE community_id = $1 ORDER BY id",
          [communityId],
        )
      ).rows.map(({ id }) => id);
      assert.equal(channelIds.length, 3);

      const now = Date.now();
      await pool.query(
        `INSERT INTO irc_workspace_tasks
           (community_id, title, status, due_date, created_by)
         VALUES
           ($1, 'Open without due date', 'todo', NULL, $2),
           ($1, 'Due this week', 'in_progress', $3, $2),
           ($1, 'Overdue', 'todo', $4, $2),
           ($1, 'Completed future task', 'completed', $3, $2),
           ($1, 'Cancelled overdue task', 'cancelled', $4, $2)`,
        [
          communityId,
          ownerSession.userId,
          new Date(now + 2 * 24 * 60 * 60 * 1000),
          new Date(now - 24 * 60 * 60 * 1000),
        ],
      );
      await pool.query(
        `INSERT INTO irc_server_announcements
           (author_id, community_id, body, status, scheduled_at, expires_at)
         VALUES
           ($1, $2, 'Current unscheduled', 'published', NULL, NULL),
           ($1, $2, 'Current scheduled', 'published', $3, $4),
           ($1, $2, 'Future', 'published', $4, NULL),
           ($1, $2, 'Expired', 'published', NULL, $3),
           ($1, $2, 'Draft', 'draft', NULL, NULL)`,
        [
          ownerSession.userId,
          communityId,
          new Date(now - 60 * 60 * 1000),
          new Date(now + 60 * 60 * 1000),
        ],
      );
      await pool.query(
        `INSERT INTO irc_channel_join_requests (channel_id, user_id, status)
         VALUES ($1, $3, 'pending'), ($2, $3, 'approved')`,
        [channelIds[0], channelIds[1], workerSession.userId],
      );

      const dashboard = await apiRequest(
        ownerSession,
        `/communities/${communityId}/dashboard`,
      );
      assert.equal(dashboard.status, 200, JSON.stringify(dashboard));
      assert.ok(dashboard.body && typeof dashboard.body === "object");
      const body = dashboard.body as {
        stats?: unknown;
        tasks?: unknown;
        recentActivity?: unknown;
      };
      assert.deepEqual(body.stats, {
        employees: 2,
        online: 1,
        channels: 3,
        openTasks: 3,
        announcements: 2,
        pendingRequests: 1,
      });
      assert.deepEqual(body.tasks, {
        open: 3,
        dueThisWeek: 1,
        overdue: 1,
      });
      assert.ok(Array.isArray(body.recentActivity));
    } finally {
      if (communityId !== null) {
        await pool.query(
          `DELETE FROM irc_channel_join_requests
           WHERE channel_id IN (
             SELECT id FROM irc_channels WHERE community_id = $1
           )`,
          [communityId],
        );
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [
          communityId,
        ]);
      }
    }
  });

  test("notifies employees when workspace tasks are assigned or changed", async () => {
    const ownerSession = await createTestSession("task_notification_owner");
    const workerSession = await createTestSession("task_notification_worker");
    const replacementSession = await createTestSession("task_notification_replacement");
    const outsiderSession = await createTestSession("task_notification_outsider");
    let communityId: number | null = null;

    try {
      for (const session of [workerSession, replacementSession, outsiderSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }
      const community = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Task notifications ${randomUUID().slice(0, 8)}`,
          isPrivate: true,
        }),
      });
      assert.equal(community.status, 201, JSON.stringify(community));
      assert.ok(community.body && typeof community.body === "object");
      communityId = (community.body as { id?: unknown }).id as number;
      assert.equal(typeof communityId, "number");

      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [communityId, workerSession.userId, replacementSession.userId],
      );

      const created = await apiRequest(ownerSession, `/communities/${communityId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Prepare onboarding",
          assignedTo: workerSession.userId,
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const taskId = (created.body as { id?: unknown }).id as number;
      assert.equal(typeof taskId, "number");

      const initialNotifications = await pool.query<{
        type: string;
        category: string;
        body: string;
      }>(
        `SELECT type, category, body
         FROM irc_notifications
         WHERE user_id = $1 AND entity_type = 'workspace_task' AND entity_id = $2
         ORDER BY id`,
        [workerSession.userId, String(taskId)],
      );
      assert.deepEqual(initialNotifications.rows, [{
        type: "task_assigned",
        category: "task_assigned",
        body: "You were assigned the task “Prepare onboarding”.",
      }]);

      const changed = await apiRequest(ownerSession, `/communities/${communityId}/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "in_progress", priority: "urgent" }),
      });
      assert.equal(changed.status, 200, JSON.stringify(changed));
      const updateNotification = await pool.query<{ type: string; category: string; body: string }>(
        `SELECT type, category, body
         FROM irc_notifications
         WHERE user_id = $1 AND type = 'task_updated' AND entity_id = $2
         ORDER BY id`,
        [workerSession.userId, String(taskId)],
      );
      assert.deepEqual(updateNotification.rows, [{
        type: "task_updated",
        category: "task_updated",
        body: "Task “Prepare onboarding” updated: status → in_progress, priority → urgent.",
      }]);

      const reassigned = await apiRequest(ownerSession, `/communities/${communityId}/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedTo: replacementSession.userId }),
      });
      assert.equal(reassigned.status, 200, JSON.stringify(reassigned));
      const reassignmentNotifications = await pool.query<{ user_id: string; type: string; body: string }>(
        `SELECT user_id, type, body
         FROM irc_notifications
         WHERE entity_type = 'workspace_task' AND entity_id = $1
           AND user_id = ANY($2::text[])
         ORDER BY id`,
        [String(taskId), [workerSession.userId, replacementSession.userId]],
      );
      const latestReassignmentByUser = new Map(
        reassignmentNotifications.rows.slice(-2).map((notification) => [
          notification.user_id,
          notification,
        ]),
      );
      assert.deepEqual(latestReassignmentByUser.get(workerSession.userId), {
        user_id: workerSession.userId,
        type: "task_updated",
        body: "You are no longer assigned the task “Prepare onboarding”.",
      });
      assert.deepEqual(latestReassignmentByUser.get(replacementSession.userId), {
        user_id: replacementSession.userId,
        type: "task_assigned",
        body: "You were assigned the task “Prepare onboarding”.",
      });

      const crossWorkspaceAssignment = await apiRequest(ownerSession, `/communities/${communityId}/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedTo: outsiderSession.userId }),
      });
      assert.equal(crossWorkspaceAssignment.status, 400, JSON.stringify(crossWorkspaceAssignment));
    } finally {
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
    }
  });

  test("prevents tasks from using another workspace's department or location", async () => {
    const workspaceIds: number[] = [];
    try {
      for (const label of ["Task Scope Home", "Task Scope Foreign"]) {
        const workspace = await pool.query<{ id: number }>(
          `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
           VALUES ($1, $2, $3, 'paid_workspace', true)
           RETURNING id`,
          [label, `task-scope-${randomUUID()}`, adminSession.userId],
        );
        const id = workspace.rows[0]?.id;
        assert.ok(id);
        workspaceIds.push(id);
      }
      const [homeWorkspaceId, foreignWorkspaceId] = workspaceIds;
      assert.ok(homeWorkspaceId);
      assert.ok(foreignWorkspaceId);
      const homeDepartment = await pool.query<{ id: number }>(
        "INSERT INTO irc_departments (community_id, name) VALUES ($1, 'Home Department') RETURNING id",
        [homeWorkspaceId],
      );
      const homeLocation = await pool.query<{ id: number }>(
        "INSERT INTO irc_locations (community_id, name) VALUES ($1, 'Home Location') RETURNING id",
        [homeWorkspaceId],
      );
      const foreignDepartment = await pool.query<{ id: number }>(
        "INSERT INTO irc_departments (community_id, name) VALUES ($1, 'Foreign Department') RETURNING id",
        [foreignWorkspaceId],
      );
      const foreignLocation = await pool.query<{ id: number }>(
        "INSERT INTO irc_locations (community_id, name) VALUES ($1, 'Foreign Location') RETURNING id",
        [foreignWorkspaceId],
      );

      const rejected = await apiRequest(adminSession, `/communities/${homeWorkspaceId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Cross-workspace task",
          departmentId: foreignDepartment.rows[0]?.id,
          locationId: foreignLocation.rows[0]?.id,
        }),
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected));
      assert.deepEqual(rejected.body, {
        error: "Task organization assignments must belong to this workspace.",
      });
      assert.equal(
        (await pool.query(
          "SELECT 1 FROM irc_workspace_tasks WHERE community_id = $1 AND title = 'Cross-workspace task'",
          [homeWorkspaceId],
        )).rowCount,
        0,
      );

      const accepted = await apiRequest(adminSession, `/communities/${homeWorkspaceId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Workspace-scoped task",
          departmentId: homeDepartment.rows[0]?.id,
          locationId: homeLocation.rows[0]?.id,
        }),
      });
      assert.equal(accepted.status, 201, JSON.stringify(accepted));
    } finally {
      if (workspaceIds.length) {
        await pool.query(
          "DELETE FROM irc_communities WHERE id = ANY($1::int[])",
          [workspaceIds],
        );
      }
    }
  });

  test("prevents global channels from using a workspace category", async () => {
    let communityId: number | null = null;
    let channelId: number | null = null;
    const rejectedName = `#foreign-category-${randomUUID().slice(0, 8)}`;
    try {
      const community = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ($1, $2, $3, 'paid_workspace', true)
         RETURNING id`,
        ["Channel Scope Workspace", `channel-scope-${randomUUID()}`, adminSession.userId],
      );
      communityId = community.rows[0]?.id ?? null;
      assert.ok(communityId);
      const category = await pool.query<{ id: number }>(
        `INSERT INTO irc_categories (name, owner_id, community_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [`category-${randomUUID().slice(0, 8)}`, adminSession.userId, communityId],
      );
      const categoryId = category.rows[0]?.id;
      assert.ok(categoryId);

      const rejected = await apiRequest(adminSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: rejectedName, categoryId }),
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected));
      assert.deepEqual(rejected.body, { error: "Category must be valid." });
      assert.equal(
        (await pool.query("SELECT 1 FROM irc_channels WHERE name = $1", [rejectedName])).rowCount,
        0,
      );

      const accepted = await apiRequest(adminSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `#scoped-category-${randomUUID().slice(0, 8)}`,
          categoryId,
          communityId,
        }),
      });
      assert.equal(accepted.status, 201, JSON.stringify(accepted));
      assert.ok(accepted.body && typeof accepted.body === "object");
      channelId = (accepted.body as { id?: unknown }).id as number;
      assert.equal(typeof channelId, "number");
    } finally {
      if (channelId !== null) {
        await pool.query("DELETE FROM irc_channel_members WHERE channel_id = $1", [channelId]);
        await pool.query("DELETE FROM irc_channels WHERE id = $1", [channelId]);
      }
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
    }
  });

  test("moves existing channels between categories without moving them across workspaces or losing history", async () => {
    let channelId: number | null = null;
    let globalCategoryId: number | null = null;
    let workspaceId: number | null = null;
    const patch = (categoryId: number | null | string): RequestInit => ({
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryId }),
    });
    try {
      const createdCategory = await apiRequest(adminSession, "/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `room-${randomUUID().slice(0, 8)}` }),
      });
      assert.equal(createdCategory.status, 201, JSON.stringify(createdCategory));
      globalCategoryId = (createdCategory.body as { id: number }).id;

      const createdChannel = await apiRequest(adminSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `#move-${randomUUID().slice(0, 8)}` }),
      });
      assert.equal(createdChannel.status, 201, JSON.stringify(createdChannel));
      channelId = (createdChannel.body as { id: number }).id;
      const message = await apiRequest(adminSession, `/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Keep this message in place." }),
      });
      assert.equal(message.status, 201, JSON.stringify(message));

      const unauthorized = await apiRequest(memberSession, `/channels/${channelId}`, patch(globalCategoryId));
      assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized));
      const assigned = await apiRequest(adminSession, `/channels/${channelId}`, patch(globalCategoryId));
      assert.equal(assigned.status, 200, JSON.stringify(assigned));
      assert.equal((assigned.body as { categoryId: number }).categoryId, globalCategoryId);

      const workspace = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ($1, $2, $3, 'paid_workspace', true) RETURNING id`,
        ["Move Scope Workspace", `move-scope-${randomUUID()}`, adminSession.userId],
      );
      workspaceId = workspace.rows[0].id;
      const workspaceCategory = await pool.query<{ id: number }>(
        `INSERT INTO irc_categories (name, owner_id, community_id) VALUES ($1, $2, $3) RETURNING id`,
        [`scoped-${randomUUID().slice(0, 8)}`, adminSession.userId, workspaceId],
      );
      for (const route of [`/channels/${channelId}`, `/admin/channels/${channelId}`]) {
        const rejected = await apiRequest(adminSession, route, patch(workspaceCategory.rows[0].id));
        assert.equal(rejected.status, 400, JSON.stringify(rejected));
      }
      const malformed = await apiRequest(adminSession, `/admin/channels/${channelId}`, patch("not-an-id"));
      assert.equal(malformed.status, 400, JSON.stringify(malformed));
      const unassigned = await apiRequest(adminSession, `/admin/channels/${channelId}`, patch(null));
      assert.equal(unassigned.status, 200, JSON.stringify(unassigned));
      assert.equal((unassigned.body as { categoryId: null }).categoryId, null);
      const history = await apiRequest(adminSession, `/channels/${channelId}/messages`);
      assert.equal(history.status, 200, JSON.stringify(history));
      assert.deepEqual((history.body as { messages: Array<{ body: string }> }).messages.map((row) => row.body), ["Keep this message in place."]);
    } finally {
      if (channelId !== null) await removeTestChannels([channelId], [adminSession.userId]);
      if (globalCategoryId !== null) await pool.query("DELETE FROM irc_categories WHERE id = $1", [globalCategoryId]);
      if (workspaceId !== null) await pool.query("DELETE FROM irc_communities WHERE id = $1", [workspaceId]);
    }
  });

  test("moves only owner-controlled public channels to the owner's public community", async () => {
    // Use the sessions created by the suite hook so this test also runs in isolation.
    const memberSession = secondSession;
    const adminSession = firstSession;
    const channelIds: number[] = [];
    let categoryId: number | null = null;
    try {
      await Promise.all([apiRequest(memberSession, "/me"), apiRequest(adminSession, "/me")]);
      await pool.query("UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1", [adminSession.userId]);
      const ownOnboarding = await apiRequest(memberSession, "/onboarding");
      const foreignOnboarding = await apiRequest(adminSession, "/onboarding");
      assert.equal(ownOnboarding.status, 200, JSON.stringify(ownOnboarding));
      assert.equal(foreignOnboarding.status, 200, JSON.stringify(foreignOnboarding));
      const ownId = (ownOnboarding.body as { ownerCommunity: { id: number } }).ownerCommunity.id;
      const foreignId = (foreignOnboarding.body as { ownerCommunity: { id: number } }).ownerCommunity.id;
      assert.notEqual(ownId, foreignId);

      const category = await apiRequest(memberSession, "/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `source-${randomUUID().slice(0, 8)}` }),
      });
      assert.equal(category.status, 201, JSON.stringify(category));
      categoryId = (category.body as { id: number }).id;
      const created = await apiRequest(memberSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `#transfer-${randomUUID().slice(0, 8)}`, categoryId }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      const channelId = (created.body as { id: number }).id;
      channelIds.push(channelId);
      const message = await apiRequest(memberSession, `/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "This history stays with its channel." }),
      });
      assert.equal(message.status, 201, JSON.stringify(message));
      const patch = (communityId: unknown): RequestInit => ({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ communityId }),
      });
      const destinations = await apiRequest(memberSession, `/channels/${channelId}/public-spaces`);
      assert.equal(destinations.status, 200, JSON.stringify(destinations));
      assert.deepEqual((destinations.body as Array<{ id: number }>).map(({ id }) => id), [ownId]);
      assert.equal((await apiRequest(adminSession, `/channels/${channelId}/public-space`, patch(foreignId))).status, 403);
      assert.equal((await apiRequest(memberSession, `/channels/${channelId}/public-space`, patch(foreignId))).status, 400);
      assert.equal((await apiRequest(memberSession, `/channels/${channelId}/public-space`, patch("invalid"))).status, 400);
      assert.equal((await apiRequest(memberSession, `/channels/${channelId}/public-space`, patch(null))).status, 400);
      const moved = await apiRequest(memberSession, `/channels/${channelId}/public-space`, patch(ownId));
      assert.equal(moved.status, 200, JSON.stringify(moved));
      assert.equal((moved.body as { communityId: number; categoryId: null }).communityId, ownId);
      assert.equal((moved.body as { categoryId: null }).categoryId, null);
      assert.equal((moved.body as { passwordHash?: unknown }).passwordHash, undefined);
      const history = await apiRequest(memberSession, `/channels/${channelId}/messages`);
      assert.equal(history.status, 200, JSON.stringify(history));
      assert.deepEqual((history.body as { messages: Array<{ body: string }> }).messages.map(({ body }) => body),
        ["This history stays with its channel."]);
      const privateChannel = await apiRequest(memberSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `#private-transfer-${randomUUID().slice(0, 8)}`, isPrivate: true }),
      });
      assert.equal(privateChannel.status, 201, JSON.stringify(privateChannel));
      const privateId = (privateChannel.body as { id: number }).id;
      channelIds.push(privateId);
      assert.equal((await apiRequest(memberSession, `/channels/${privateId}/public-space`, patch(ownId))).status, 400);
    } finally {
      await removeTestChannels(channelIds, [memberSession.userId]);
      if (categoryId !== null) await pool.query("DELETE FROM irc_categories WHERE id = $1", [categoryId]);
    }
  });

  test("lets workspace admins organize channels they do not own, only within their workspace", async () => {
    const managerSession = await createTestSession("channel_organizer");
    const communityIds: number[] = [];
    let channelId: number | null = null;
    try {
      assert.equal((await apiRequest(managerSession, "/me")).status, 200);
      for (const name of ["Managed Channel", "Foreign Category"]) {
        const created = await pool.query<{ id: number }>(
          `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
           VALUES ($1, $2, $3, 'paid_workspace', true) RETURNING id`,
          [name, `organize-${randomUUID()}`, adminSession.userId],
        );
        communityIds.push(created.rows[0].id);
      }
      const [communityId, foreignCommunityId] = communityIds;
      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status) VALUES ($1, $2, 'member')`,
        [communityId, managerSession.userId],
      );
      await pool.query(
        `INSERT INTO irc_user_roles (user_id, role, scope_type, community_id, granted_by)
         VALUES ($1, 'workspace_admin', 'community', $2, $3)`,
        [managerSession.userId, communityId, adminSession.userId],
      );
      const category = await pool.query<{ id: number; community_id: number }>(
        `INSERT INTO irc_categories (name, owner_id, community_id)
         VALUES ($1, $2, $3), ($4, $2, $5) RETURNING id, community_id`,
        [`team-${randomUUID().slice(0, 8)}`, adminSession.userId, communityId,
          `other-${randomUUID().slice(0, 8)}`, foreignCommunityId],
      );
      const ownCategoryId = category.rows.find((row) => row.community_id === communityId)?.id;
      const foreignCategoryId = category.rows.find((row) => row.community_id === foreignCommunityId)?.id;
      assert.ok(ownCategoryId && foreignCategoryId);
      const createdChannel = await pool.query<{ id: number }>(
        `INSERT INTO irc_channels (name, owner_id, community_id) VALUES ($1, $2, $3) RETURNING id`,
        [`#managed-${randomUUID().slice(0, 8)}`, adminSession.userId, communityId],
      );
      channelId = createdChannel.rows[0].id;
      const route = `/communities/${communityId}/channels/${channelId}/category`;
      const patch = (categoryId: unknown): RequestInit => ({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categoryId }),
      });
      assert.equal((await apiRequest(memberSession, route, patch(ownCategoryId))).status, 403);
      assert.equal((await apiRequest(managerSession, route, patch(foreignCategoryId))).status, 400);
      assert.equal((await apiRequest(managerSession, route, patch(undefined))).status, 400);
      assert.equal((await apiRequest(managerSession, `/communities/${foreignCommunityId}/channels/${channelId}/category`, patch(foreignCategoryId))).status, 403);
      const assigned = await apiRequest(managerSession, route, patch(ownCategoryId));
      assert.equal(assigned.status, 200, JSON.stringify(assigned));
      assert.equal((assigned.body as { categoryId: number }).categoryId, ownCategoryId);
      assert.equal((assigned.body as { passwordHash?: unknown }).passwordHash, undefined);
      const unassigned = await apiRequest(managerSession, route, patch(null));
      assert.equal(unassigned.status, 200, JSON.stringify(unassigned));
      assert.equal((unassigned.body as { categoryId: null }).categoryId, null);
    } finally {
      if (channelId !== null) await removeTestChannels([channelId], [adminSession.userId]);
      if (communityIds.length) await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [communityIds]);
    }
  });

  test("lets channel owners and platform admins delete channels", async () => {
    const ownerSession = await createTestSession("channel_delete_owner");
    const channelIds: number[] = [];
    try {
      const profile = await apiRequest(ownerSession, "/me");
      assert.equal(profile.status, 200, JSON.stringify(profile));
      for (const suffix of ["owner", "admin"]) {
        const created = await apiRequest(ownerSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `#delete-${suffix}-${randomUUID().slice(0, 8)}` }),
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        assert.ok(created.body && typeof created.body === "object");
        const channelId = (created.body as { id?: unknown }).id as number;
        assert.equal(typeof channelId, "number");
        channelIds.push(channelId);
      }

      const ownerDeleted = await apiRequest(ownerSession, `/channels/${channelIds[0]}`, {
        method: "DELETE",
      });
      assert.equal(ownerDeleted.status, 200, JSON.stringify(ownerDeleted));
      channelIds.shift();

      const adminDeleted = await apiRequest(adminSession, `/channels/${channelIds[0]}`, {
        method: "DELETE",
      });
      assert.equal(adminDeleted.status, 200, JSON.stringify(adminDeleted));
      channelIds.shift();
    } finally {
      for (const channelId of channelIds) {
        await pool.query("DELETE FROM irc_channel_members WHERE channel_id = $1", [channelId]);
        await pool.query("DELETE FROM irc_channels WHERE id = $1", [channelId]);
      }
    }
  });

  test("rolls back community setup when a default record or audit insert fails", async () => {
    const owner = await createTestSession("community_setup_failure");
    assert.equal((await apiRequest(owner, "/me")).status, 200);
    const slug = `rollback-${randomUUID().slice(0, 12)}`;
    const body = JSON.stringify({ name: "Rollback workspace", slug });
    const snapshot = async () => (await pool.query(
      `SELECT
        (SELECT count(*)::int FROM irc_communities WHERE slug = $2) AS communities,
        (SELECT count(*)::int FROM irc_community_members WHERE user_id = $1) AS members,
        (SELECT count(*)::int FROM irc_employee_profiles WHERE user_id = $1) AS profiles,
        (SELECT count(*)::int FROM irc_user_roles WHERE user_id = $1) AS roles,
        (SELECT count(*)::int FROM irc_categories WHERE owner_id = $1) AS categories,
        (SELECT count(*)::int FROM irc_channels WHERE owner_id = $1) AS channels,
        (SELECT count(*)::int FROM irc_channel_members WHERE user_id = $1) AS channel_members,
        (SELECT count(*)::int FROM irc_admin_audit_logs WHERE actor_id = $1) AS audit_logs,
        (SELECT count(*)::int FROM irc_notifications WHERE user_id = $1) AS notifications`,
      [owner.userId, slug],
    )).rows[0];
    const before = await snapshot();

    for (const table of [
      "irc_user_roles",
      "irc_categories",
      "irc_channels",
      "irc_channel_members",
      "irc_admin_audit_logs",
      "irc_notifications",
    ]) {
      const triggerName = `fail_setup_${randomUUID().replaceAll("-", "")}`;
      const functionName = `${triggerName}_fn`;
      let triggerCreated = false;
      try {
        await pool.query(
          `CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             RAISE EXCEPTION 'forced community setup failure';
           END;
           $$;`,
        );
        await pool.query(
          `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON ${table}
           FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
        );
        triggerCreated = true;
        const response = await apiRequest(owner, "/communities", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        assert.equal(response.status, 500, `${table}: ${JSON.stringify(response)}`);
        assert.deepEqual(response.body, { error: "Unable to create the community. Please try again." });
        assert.deepEqual(await snapshot(), before, `${table} left partial community records`);
      } finally {
        if (triggerCreated) await pool.query(`DROP TRIGGER "${triggerName}" ON ${table}`);
        await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      }
    }

    const retry = await apiRequest(owner, "/communities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(retry.status, 201, JSON.stringify(retry));
    const communityId = (retry.body as { id: number }).id;
    await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
  });

  test("lets organization managers assign employees without crossing workspace boundaries", async () => {
    const ownerSession = await createTestSession("organization_owner");
    const managerSession = await createTestSession("organization_manager");
    const employeeSession = await createTestSession("organization_employee");
    const communityIds: number[] = [];

    try {
      for (const session of [managerSession, employeeSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }
      const createCommunity = async (name: string) => {
        const response = await apiRequest(ownerSession, "/communities", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, isPrivate: true }),
        });
        assert.equal(response.status, 201, JSON.stringify(response));
        assert.ok(response.body && typeof response.body === "object");
        const id = (response.body as { id?: unknown }).id;
        assert.equal(typeof id, "number");
        communityIds.push(id as number);
        return id as number;
      };
      const communityId = await createCommunity(`Organization ${randomUUID().slice(0, 8)}`);
      const foreignCommunityId = await createCommunity(`Foreign ${randomUUID().slice(0, 8)}`);

      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [communityId, managerSession.userId, employeeSession.userId],
      );
      await pool.query(
        `INSERT INTO irc_employee_profiles (community_id, user_id, employment_status)
         VALUES ($1, $2, 'active'), ($1, $3, 'active')`,
        [communityId, managerSession.userId, employeeSession.userId],
      );
      await pool.query(
        `INSERT INTO irc_user_roles
           (user_id, role, scope_type, community_id, granted_by)
         VALUES ($1, 'manager', 'community', $2, $3)`,
        [managerSession.userId, communityId, ownerSession.userId],
      );

      const createDepartment = async (session: TestSession, targetCommunityId: number, name: string) => {
        const response = await apiRequest(session, `/communities/${targetCommunityId}/departments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        assert.equal(response.status, 201, JSON.stringify(response));
        assert.ok(response.body && typeof response.body === "object");
        return (response.body as { id?: unknown }).id as number;
      };
      const createLocation = async (targetCommunityId: number) => {
        const response = await apiRequest(ownerSession, `/communities/${targetCommunityId}/locations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `Office ${randomUUID().slice(0, 6)}` }),
        });
        assert.equal(response.status, 201, JSON.stringify(response));
        assert.ok(response.body && typeof response.body === "object");
        return (response.body as { id?: unknown }).id as number;
      };
      const departmentId = await createDepartment(ownerSession, communityId, "Operations");
      const foreignDepartmentId = await createDepartment(ownerSession, foreignCommunityId, "Foreign Operations");
      const locationId = await createLocation(communityId);
      const teamResponse = await apiRequest(ownerSession, `/communities/${communityId}/teams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Field team", departmentId, locationId }),
      });
      assert.equal(teamResponse.status, 201, JSON.stringify(teamResponse));
      assert.ok(teamResponse.body && typeof teamResponse.body === "object");
      const teamId = (teamResponse.body as { id?: unknown }).id as number;
      const foreignTeamResponse = await apiRequest(ownerSession, `/communities/${foreignCommunityId}/teams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Foreign team" }),
      });
      assert.equal(foreignTeamResponse.status, 201, JSON.stringify(foreignTeamResponse));
      assert.ok(foreignTeamResponse.body && typeof foreignTeamResponse.body === "object");
      const foreignTeamId = (foreignTeamResponse.body as { id?: unknown }).id as number;

      const crossWorkspaceAssignment = await apiRequest(
        managerSession,
        `/communities/${communityId}/employees/${employeeSession.userId}/organization`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ departmentId: foreignDepartmentId }),
        },
      );
      assert.equal(crossWorkspaceAssignment.status, 400, JSON.stringify(crossWorkspaceAssignment));

      const assignment = await apiRequest(
        managerSession,
        `/communities/${communityId}/employees/${employeeSession.userId}/organization`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ departmentId, locationId, managerId: managerSession.userId }),
        },
      );
      assert.equal(assignment.status, 200, JSON.stringify(assignment));
      assert.ok(assignment.body && typeof assignment.body === "object");
      assert.deepEqual(
        await pool.query(
          `SELECT department_id AS "departmentId", location_id AS "locationId", manager_id AS "managerId"
           FROM irc_employee_profiles
           WHERE community_id = $1 AND user_id = $2`,
          [communityId, employeeSession.userId],
        ).then((result) => result.rows),
        [{ departmentId, locationId, managerId: managerSession.userId }],
      );

      const addToTeam = async (targetTeamId: number) => apiRequest(
        managerSession,
        `/communities/${communityId}/teams/${targetTeamId}/members/${employeeSession.userId}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "member", status: "active" }),
        },
      );
      const firstMembership = await addToTeam(teamId);
      assert.equal(firstMembership.status, 200, JSON.stringify(firstMembership));
      const repeatedMembership = await addToTeam(teamId);
      assert.equal(repeatedMembership.status, 200, JSON.stringify(repeatedMembership));
      const membershipCount = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM irc_team_members
         WHERE team_id = $1 AND user_id = $2`,
        [teamId, employeeSession.userId],
      );
      assert.deepEqual(membershipCount.rows, [{ count: 1 }]);

      const detail = await apiRequest(managerSession, `/communities/${communityId}`);
      assert.equal(detail.status, 200, JSON.stringify(detail));
      assert.ok(detail.body && typeof detail.body === "object");
      const detailEmployee = (detail.body as { employees?: Array<{ userId: string; teamIds: number[] }> }).employees
        ?.find((employee) => employee.userId === employeeSession.userId);
      assert.deepEqual(detailEmployee?.teamIds, [teamId]);

      const foreignTeamAssignment = await apiRequest(
        managerSession,
        `/communities/${communityId}/teams/${foreignTeamId}/members/${employeeSession.userId}`,
        { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" },
      );
      assert.equal(foreignTeamAssignment.status, 404, JSON.stringify(foreignTeamAssignment));

      const removeFromTeam = await apiRequest(
        managerSession,
        `/communities/${communityId}/teams/${teamId}/members/${employeeSession.userId}`,
        { method: "DELETE" },
      );
      assert.equal(removeFromTeam.status, 200, JSON.stringify(removeFromTeam));
    } finally {
      if (communityIds.length) {
        await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [communityIds]);
      }
    }
  });

  test("filters workspace activity by actor and action", async () => {
    const ownerSession = await createTestSession("activity_filter_owner");
    const actorSession = await createTestSession("activity_filter_actor");
    const communityIds: number[] = [];
    const unique = randomUUID().replaceAll("-", "");

    try {
      for (const session of [ownerSession, actorSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }

      const createCommunity = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Activity filters ${unique.slice(0, 8)}`, isPrivate: true }),
      });
      assert.equal(createCommunity.status, 201, JSON.stringify(createCommunity));
      assert.ok(createCommunity.body && typeof createCommunity.body === "object");
      const communityId = (createCommunity.body as { id?: unknown }).id;
      assert.equal(typeof communityId, "number");
      communityIds.push(communityId as number);

      await pool.query(
        `INSERT INTO irc_admin_audit_logs
          (actor_id, actor_display_name, community_id, action, resource_type, resource_id, target_id, target_label, details)
         VALUES
          ($1, 'Owner actor', $3, 'created_workspace_team', 'team', 'owner-team', $4, $5, 'owner event'),
          ($2, 'Filtered actor', $3, 'assigned_employee_team', 'team_membership', 'actor-team', $4, $5, 'matching event'),
          ($2, 'Filtered actor', $3, 'updated_workspace_task', 'task', 'actor-task', $4, $5, 'different action')`,
        [
          ownerSession.userId,
          actorSession.userId,
          communityId,
          String(communityId),
          `community:${communityId}`,
        ],
      );

      const actorFiltered = await apiRequest(
        ownerSession,
        `/communities/${communityId}/activity?userId=${encodeURIComponent(actorSession.userId)}`,
      );
      assert.equal(actorFiltered.status, 200, JSON.stringify(actorFiltered));
      assert.ok(actorFiltered.body && typeof actorFiltered.body === "object");
      const actorPayload = actorFiltered.body as { entries?: Array<{ actorId: string; action: string }>; actions?: string[] };
      assert.deepEqual(
        actorPayload.entries?.map((entry) => [entry.actorId, entry.action]),
        [
          [actorSession.userId, "updated_workspace_task"],
          [actorSession.userId, "assigned_employee_team"],
        ],
      );
      assert.deepEqual(actorPayload.actions, ["assigned_employee_team", "created_community", "created_workspace_team", "updated_workspace_task"]);

      const actionFiltered = await apiRequest(
        ownerSession,
        `/communities/${communityId}/activity?action=assigned_employee_team`,
      );
      assert.equal(actionFiltered.status, 200, JSON.stringify(actionFiltered));
      assert.ok(actionFiltered.body && typeof actionFiltered.body === "object");
      const actionPayload = actionFiltered.body as { entries?: Array<{ actorId: string; action: string }> };
      assert.deepEqual(actionPayload.entries?.map((entry) => [entry.actorId, entry.action]), [
        [actorSession.userId, "assigned_employee_team"],
      ]);
    } finally {
      if (communityIds.length) {
        await pool.query("DELETE FROM irc_admin_audit_logs WHERE community_id = ANY($1::int[])", [communityIds]);
        await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [communityIds]);
      }
    }
  });

  test("keeps private history and WebSocket subscriptions behind moderator approval", async () => {
    const ownerSession = await createTestSession("channel_owner");
    const requesterSession = await createTestSession("channel_requester");
    const reviewerSession = await createTestSession("channel_reviewer");
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      const reviewerProfile = await apiRequest(reviewerSession, "/me");
      assert.equal(reviewerProfile.status, 200, JSON.stringify(reviewerProfile));

      const createChannel = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `private-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Approval-protected history",
          isPrivate: true,
        }),
      });
      assert.equal(createChannel.status, 201, JSON.stringify(createChannel));
      assert.ok(createChannel.body && typeof createChannel.body === "object");
      const channelId = (createChannel.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'moderator')`,
        [channelId, reviewerSession.userId],
      );

      const seedMessage = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Visible after approval" }),
        },
      );
      assert.equal(seedMessage.status, 201, JSON.stringify(seedMessage));

      const deniedHistory = await apiRequest(
        requesterSession,
        `/channels/${channelId}/messages`,
      );
      assert.equal(deniedHistory.status, 403, JSON.stringify(deniedHistory));
      assert.deepEqual(deniedHistory.body, {
        error: "Join the private channel before reading its history.",
      });

      const deniedMembers = await apiRequest(
        requesterSession,
        `/channels/${channelId}/members`,
      );
      assert.equal(deniedMembers.status, 403, JSON.stringify(deniedMembers));
      assert.deepEqual(deniedMembers.body, {
        error: "Join the private channel before viewing its members.",
      });

      const pendingJoin = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        { method: "POST" },
      );
      assert.equal(pendingJoin.status, 202, JSON.stringify(pendingJoin));
      assert.deepEqual(pendingJoin.body, { ok: true, status: "pending" });

      const repeatedPendingJoin = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        { method: "POST" },
      );
      assert.equal(repeatedPendingJoin.status, 202, JSON.stringify(repeatedPendingJoin));
      assert.deepEqual(repeatedPendingJoin.body, { ok: true, status: "pending" });

      const pendingRequests = await apiRequest(
        reviewerSession,
        `/channels/${channelId}/join-requests`,
      );
      assert.equal(pendingRequests.status, 200, JSON.stringify(pendingRequests));
      assert.ok(Array.isArray(pendingRequests.body));
      assert.equal(pendingRequests.body.length, 1);
      const requestId = (
        pendingRequests.body[0] as { id?: unknown }
      ).id;
      assert.equal(typeof requestId, "number");

      const pendingSocket = await openWebSocket(requesterSession);
      sockets.push(pendingSocket);
      pendingSocket.send(JSON.stringify({ type: "subscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const blockedEvent = expectNoWebSocketEvent(
        pendingSocket,
        (event) =>
          event.type === "message" &&
          Boolean(event.message) &&
          (event.message as { channelId?: unknown }).channelId === channelId,
      );
      const blockedMessage = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Blocked before approval" }),
        },
      );
      assert.equal(blockedMessage.status, 201, JSON.stringify(blockedMessage));
      await blockedEvent;

      const approval = await apiRequest(
        reviewerSession,
        `/channels/${channelId}/join-requests/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(approval.status, 200, JSON.stringify(approval));
      assert.deepEqual(approval.body, { ok: true, status: "approved" });

      const history = await apiRequest(
        requesterSession,
        `/channels/${channelId}/messages`,
      );
      assert.equal(history.status, 200, JSON.stringify(history));
      assert.ok(history.body && typeof history.body === "object");
      const messages = (history.body as { messages?: unknown }).messages;
      assert.ok(Array.isArray(messages));
      assert.deepEqual(
        messages.map((message) => (message as { body?: unknown }).body),
        ["Visible after approval", "Blocked before approval"],
      );

      const joinAfterApproval = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        { method: "POST" },
      );
      assert.equal(joinAfterApproval.status, 200, JSON.stringify(joinAfterApproval));
      assert.deepEqual(joinAfterApproval.body, { ok: true, status: "member" });

      const members = await apiRequest(
        requesterSession,
        `/channels/${channelId}/members`,
      );
      assert.equal(members.status, 200, JSON.stringify(members));
      assert.ok(Array.isArray(members.body));
      assert.ok(
        members.body.some(
          (user) =>
            user &&
            typeof user === "object" &&
            (user as { id?: unknown }).id === requesterSession.userId,
        ),
      );

      const approvedSocket = await openWebSocket(requesterSession);
      sockets.push(approvedSocket);
      approvedSocket.send(JSON.stringify({ type: "subscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const realtimeEvent = waitForWebSocketEvent(
        approvedSocket,
        (event) =>
          event.type === "message" &&
          Boolean(event.message) &&
          (event.message as { body?: unknown }).body === "Delivered after approval",
      );
      const realtimeMessage = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Delivered after approval" }),
        },
      );
      assert.equal(realtimeMessage.status, 201, JSON.stringify(realtimeMessage));
      const event = await realtimeEvent;
      assert.equal(
        (event.message as { channelId?: unknown }).channelId,
        channelId,
      );
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        requesterSession.userId,
        reviewerSession.userId,
      ]);
    }
  });

  test("blocks a removed channel moderator from reviewing private-room requests", async () => {
    const ownerSession = await createTestSession("moderator_revoke_owner");
    const reviewerSession = await createTestSession("moderator_revoke_reviewer");
    const requesterSession = await createTestSession("moderator_revoke_requester");
    const channelIds: number[] = [];

    try {
      const reviewerProfile = await apiRequest(reviewerSession, "/me");
      const requesterProfile = await apiRequest(requesterSession, "/me");
      assert.equal(reviewerProfile.status, 200, JSON.stringify(reviewerProfile));
      assert.equal(requesterProfile.status, 200, JSON.stringify(requesterProfile));

      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `revoke-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          isPrivate: true,
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const channelId = (created.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'moderator')`,
        [channelId, reviewerSession.userId],
      );
      const pending = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        { method: "POST" },
      );
      assert.equal(pending.status, 202, JSON.stringify(pending));

      const requests = await apiRequest(
        reviewerSession,
        `/channels/${channelId}/join-requests`,
      );
      assert.equal(requests.status, 200, JSON.stringify(requests));
      assert.ok(Array.isArray(requests.body));
      const requestId = (requests.body[0] as { id?: unknown })?.id;
      assert.equal(typeof requestId, "number");

      const kick = await apiRequest(
        ownerSession,
        `/channels/${channelId}/moderation`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "kick",
            targetUserId: reviewerSession.userId,
          }),
        },
      );
      assert.equal(kick.status, 200, JSON.stringify(kick));

      const deniedList = await apiRequest(
        reviewerSession,
        `/channels/${channelId}/join-requests`,
      );
      assert.equal(deniedList.status, 403, JSON.stringify(deniedList));
      assert.deepEqual(deniedList.body, {
        error: "Only channel operators can review join requests.",
      });
      const deniedDecision = await apiRequest(
        reviewerSession,
        `/channels/${channelId}/join-requests/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(deniedDecision.status, 403, JSON.stringify(deniedDecision));
      assert.deepEqual(deniedDecision.body, {
        error: "Only channel operators can review join requests.",
      });

      const stillPending = await pool.query<{ status: string }>(
        `SELECT status
         FROM irc_channel_join_requests
         WHERE id = $1`,
        [requestId],
      );
      assert.deepEqual(stillPending.rows, [{ status: "pending" }]);
    } finally {
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        reviewerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("removes pending private-room requests when the room is deleted", async () => {
    const ownerSession = await createTestSession("request_cleanup_owner");
    const requesterSession = await createTestSession("request_cleanup_requester");
    const channelIds: number[] = [];

    try {
      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `cleanup-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          isPrivate: true,
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const channelId = (created.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      const pending = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        { method: "POST" },
      );
      assert.equal(pending.status, 202, JSON.stringify(pending));
      const beforeDelete = await pool.query(
        "SELECT id FROM irc_channel_join_requests WHERE channel_id = $1",
        [channelId],
      );
      assert.equal(beforeDelete.rows.length, 1);

      const deleted = await apiRequest(
        ownerSession,
        `/channels/${channelId}`,
        { method: "DELETE" },
      );
      assert.equal(deleted.status, 200, JSON.stringify(deleted));
      const afterDelete = await pool.query(
        "SELECT id FROM irc_channel_join_requests WHERE channel_id = $1",
        [channelId],
      );
      assert.deepEqual(afterDelete.rows, []);
    } finally {
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("revokes private-room access after leaving and requires approval again to rejoin", async () => {
    const ownerSession = await createTestSession("leave_owner");
    const memberSession = await createTestSession("leave_member");
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      const memberProfile = await apiRequest(memberSession, "/me");
      assert.equal(memberProfile.status, 200, JSON.stringify(memberProfile));
      assert.ok(memberProfile.body && typeof memberProfile.body === "object");
      const username = (memberProfile.body as { username?: unknown }).username;
      assert.equal(typeof username, "string");

      const createChannel = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `leave-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Leave access revocation",
          isPrivate: true,
          isInviteOnly: true,
          password: "room-pass",
        }),
      });
      assert.equal(createChannel.status, 201, JSON.stringify(createChannel));
      assert.ok(createChannel.body && typeof createChannel.body === "object");
      const channelId = (createChannel.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      const invite = await apiRequest(ownerSession, `/channels/${channelId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username }),
      });
      assert.equal(invite.status, 201, JSON.stringify(invite));

      const joinRequest = await apiRequest(memberSession, `/channels/${channelId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "room-pass" }),
      });
      assert.equal(joinRequest.status, 202, JSON.stringify(joinRequest));
      assert.deepEqual(joinRequest.body, { ok: true, status: "pending" });

      const requests = await apiRequest(ownerSession, `/channels/${channelId}/join-requests`);
      assert.equal(requests.status, 200, JSON.stringify(requests));
      assert.ok(Array.isArray(requests.body));
      assert.equal(requests.body.length, 1);
      const requestId = (requests.body[0] as { id?: unknown }).id;
      assert.equal(typeof requestId, "number");

      const approval = await apiRequest(ownerSession, `/channels/${channelId}/join-requests/${requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      assert.equal(approval.status, 200, JSON.stringify(approval));

      const joinAfterApproval = await apiRequest(memberSession, `/channels/${channelId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "room-pass" }),
      });
      assert.equal(joinAfterApproval.status, 200, JSON.stringify(joinAfterApproval));

      const memberSocket = await openWebSocket(memberSession);
      const postLeaveSocket = await openWebSocket(memberSession);
      sockets.push(memberSocket, postLeaveSocket);
      memberSocket.send(JSON.stringify({ type: "subscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const leave = await apiRequest(memberSession, `/channels/${channelId}/leave`, {
        method: "POST",
      });
      assert.equal(leave.status, 200, JSON.stringify(leave));
      assert.deepEqual(leave.body, { ok: true });

      const deniedHistory = await apiRequest(memberSession, `/channels/${channelId}/messages`);
      assert.equal(deniedHistory.status, 403, JSON.stringify(deniedHistory));
      assert.deepEqual(deniedHistory.body, {
        error: "Join the private channel before reading its history.",
      });

      const deniedMembers = await apiRequest(memberSession, `/channels/${channelId}/members`);
      assert.equal(deniedMembers.status, 403, JSON.stringify(deniedMembers));
      assert.deepEqual(deniedMembers.body, {
        error: "Join the private channel before viewing its members.",
      });

      postLeaveSocket.send(JSON.stringify({ type: "subscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const blockedExistingSubscription = expectNoWebSocketEvent(
        memberSocket,
        (event) =>
          event.type === "message" &&
          Boolean(event.message) &&
          (event.message as { channelId?: unknown }).channelId === channelId,
      );
      const blockedNewSubscription = expectNoWebSocketEvent(
        postLeaveSocket,
        (event) =>
          event.type === "message" &&
          Boolean(event.message) &&
          (event.message as { channelId?: unknown }).channelId === channelId,
      );
      const postLeaveMessage = await apiRequest(ownerSession, `/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Should stay hidden after leaving" }),
      });
      assert.equal(postLeaveMessage.status, 201, JSON.stringify(postLeaveMessage));
      await Promise.all([blockedExistingSubscription, blockedNewSubscription]);

      const wrongPassword = await apiRequest(memberSession, `/channels/${channelId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong-pass" }),
      });
      assert.equal(wrongPassword.status, 403, JSON.stringify(wrongPassword));
      assert.deepEqual(wrongPassword.body, { error: "A channel password is required." });

      const withoutInvite = await apiRequest(memberSession, `/channels/${channelId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "room-pass" }),
      });
      assert.equal(withoutInvite.status, 403, JSON.stringify(withoutInvite));
      assert.deepEqual(withoutInvite.body, { error: "This channel is invite-only." });

      const reInvite = await apiRequest(ownerSession, `/channels/${channelId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username }),
      });
      assert.equal(reInvite.status, 201, JSON.stringify(reInvite));

      const rejoinRequest = await apiRequest(memberSession, `/channels/${channelId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "room-pass" }),
      });
      assert.equal(rejoinRequest.status, 202, JSON.stringify(rejoinRequest));
      assert.deepEqual(rejoinRequest.body, { ok: true, status: "pending" });

      const rejoinRequests = await apiRequest(ownerSession, `/channels/${channelId}/join-requests`);
      assert.equal(rejoinRequests.status, 200, JSON.stringify(rejoinRequests));
      assert.ok(Array.isArray(rejoinRequests.body));
      assert.equal(rejoinRequests.body.length, 1);
      const rejoinRequestId = (rejoinRequests.body[0] as { id?: unknown }).id;
      assert.equal(typeof rejoinRequestId, "number");

      const reapproval = await apiRequest(
        ownerSession,
        `/channels/${channelId}/join-requests/${rejoinRequestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(reapproval.status, 200, JSON.stringify(reapproval));

      const rejoinAfterApproval = await apiRequest(memberSession, `/channels/${channelId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "room-pass" }),
      });
      assert.equal(rejoinAfterApproval.status, 200, JSON.stringify(rejoinAfterApproval));

      const restoredHistory = await apiRequest(memberSession, `/channels/${channelId}/messages`);
      assert.equal(restoredHistory.status, 200, JSON.stringify(restoredHistory));
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [ownerSession.userId, memberSession.userId]);
    }
  });

  test("scopes private-room join-request review to the moderator's channel", async () => {
    const ownerSession = await createTestSession("scoped_request_owner");
    const requesterSession = await createTestSession("scoped_request_requester");
    const reviewerSession = await createTestSession("scoped_request_reviewer");
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      const reviewerProfile = await apiRequest(reviewerSession, "/me");
      assert.equal(reviewerProfile.status, 200, JSON.stringify(reviewerProfile));
      await pool.query(
        "UPDATE irc_users SET role = 'moderator' WHERE clerk_id = $1",
        [reviewerSession.userId],
      );

      const createChannel = async (name: string): Promise<number> => {
        const response = await apiRequest(ownerSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `${name}-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            topic: "Scoped join-request review",
            isPrivate: true,
          }),
        });
        assert.equal(response.status, 201, JSON.stringify(response));
        assert.ok(response.body && typeof response.body === "object");
        const channelId = (response.body as { id?: unknown }).id;
        assert.equal(typeof channelId, "number");
        channelIds.push(channelId as number);
        return channelId as number;
      };

      const moderatedChannelId = await createChannel("scoped-moderated");
      const requestedChannelId = await createChannel("scoped-requested");
      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'moderator')`,
        [moderatedChannelId, reviewerSession.userId],
      );

      const pendingJoin = await apiRequest(
        requesterSession,
        `/channels/${requestedChannelId}/join`,
        { method: "POST" },
      );
      assert.equal(pendingJoin.status, 202, JSON.stringify(pendingJoin));
      assert.deepEqual(pendingJoin.body, { ok: true, status: "pending" });

      const moderatedRequests = await apiRequest(
        reviewerSession,
        `/channels/${moderatedChannelId}/join-requests`,
      );
      assert.equal(moderatedRequests.status, 200, JSON.stringify(moderatedRequests));
      assert.deepEqual(moderatedRequests.body, []);

      const unmoderatedRequests = await apiRequest(
        reviewerSession,
        `/channels/${requestedChannelId}/join-requests`,
      );
      assert.equal(unmoderatedRequests.status, 403, JSON.stringify(unmoderatedRequests));
      assert.deepEqual(unmoderatedRequests.body, {
        error: "Only channel operators can review join requests.",
      });

      const ownerRequests = await apiRequest(
        ownerSession,
        `/channels/${requestedChannelId}/join-requests`,
      );
      assert.equal(ownerRequests.status, 200, JSON.stringify(ownerRequests));
      assert.ok(Array.isArray(ownerRequests.body));
      assert.equal(ownerRequests.body.length, 1);
      const requestId = (ownerRequests.body[0] as { id?: unknown }).id;
      assert.equal(typeof requestId, "number");

      const crossChannelApproval = await apiRequest(
        reviewerSession,
        `/channels/${moderatedChannelId}/join-requests/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(crossChannelApproval.status, 404, JSON.stringify(crossChannelApproval));
      assert.deepEqual(crossChannelApproval.body, {
        error: "Join request not found.",
      });

      const requestAfterCrossChannelAttempt = await apiRequest(
        ownerSession,
        `/channels/${requestedChannelId}/join-requests`,
      );
      assert.equal(
        requestAfterCrossChannelAttempt.status,
        200,
        JSON.stringify(requestAfterCrossChannelAttempt),
      );
      assert.ok(Array.isArray(requestAfterCrossChannelAttempt.body));
      assert.deepEqual(
        requestAfterCrossChannelAttempt.body.map((request) => ({
          id: (request as { id?: unknown }).id,
          status: (request as { status?: unknown }).status,
        })),
        [{ id: requestId, status: "pending" }],
      );

      const deniedHistory = await apiRequest(
        requesterSession,
        `/channels/${requestedChannelId}/messages`,
      );
      assert.equal(deniedHistory.status, 403, JSON.stringify(deniedHistory));
      assert.deepEqual(deniedHistory.body, {
        error: "Join the private channel before reading its history.",
      });

      const pendingSocket = await openWebSocket(requesterSession);
      sockets.push(pendingSocket);
      pendingSocket.send(JSON.stringify({ type: "subscribe", channelId: requestedChannelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const blockedEvent = expectNoWebSocketEvent(
        pendingSocket,
        (event) =>
          event.type === "message" &&
          Boolean(event.message) &&
          (event.message as { channelId?: unknown }).channelId === requestedChannelId,
      );
      const roomMessage = await apiRequest(
        ownerSession,
        `/channels/${requestedChannelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Should remain private" }),
        },
      );
      assert.equal(roomMessage.status, 201, JSON.stringify(roomMessage));
      await blockedEvent;

      const deniedMembers = await apiRequest(
        requesterSession,
        `/channels/${requestedChannelId}/members`,
      );
      assert.equal(deniedMembers.status, 403, JSON.stringify(deniedMembers));
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        requesterSession.userId,
        reviewerSession.userId,
      ]);
    }
  });

  test("keeps private room typing, reactions, and deletion synchronized across members", async () => {
    const ownerSession = await createTestSession("realtime_owner");
    const memberSession = await createTestSession("realtime_member");
    const outsiderSession = await createTestSession("realtime_outsider");
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      for (const session of [ownerSession, memberSession, outsiderSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }

      const createChannel = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `realtime-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Realtime synchronization",
          isPrivate: true,
        }),
      });
      assert.equal(createChannel.status, 201, JSON.stringify(createChannel));
      assert.ok(createChannel.body && typeof createChannel.body === "object");
      const channelId = (createChannel.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [channelId, memberSession.userId],
      );

      const ownerSocket = await openWebSocket(ownerSession);
      const memberSocket = await openWebSocket(memberSession);
      const outsiderSocket = await openWebSocket(outsiderSession);
      sockets.push(ownerSocket, memberSocket, outsiderSocket);
      for (const socket of sockets) {
        socket.send(JSON.stringify({ type: "subscribe", channelId }));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      const ownerTyping = collectWebSocketEvents(
        ownerSocket,
        (event) =>
          event.type === "typing" &&
          event.channelId === channelId &&
          event.userId === memberSession.userId,
      );
      const memberTyping = collectWebSocketEvents(
        memberSocket,
        (event) =>
          event.type === "typing" &&
          event.channelId === channelId &&
          event.userId === ownerSession.userId,
      );
      const outsiderTyping = collectWebSocketEvents(
        outsiderSocket,
        (event) => event.type === "typing" && event.channelId === channelId,
      );
      memberSocket.send(JSON.stringify({ type: "typing", channelId, active: true }));
      ownerSocket.send(JSON.stringify({ type: "typing", channelId, active: true }));
      assert.equal((await ownerTyping).length, 1);
      assert.equal((await memberTyping).length, 1);
      assert.equal((await outsiderTyping).length, 0);

      ownerSocket.send(JSON.stringify({ type: "unsubscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const unsubscribedOwnerTyping = expectNoWebSocketEvent(
        ownerSocket,
        (event) =>
          event.type === "typing" &&
          event.channelId === channelId &&
          event.userId === memberSession.userId,
      );
      memberSocket.send(JSON.stringify({ type: "typing", channelId, active: false }));
      await unsubscribedOwnerTyping;
      ownerSocket.send(JSON.stringify({ type: "subscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const ownerMessageEvents = collectWebSocketEvents(
        ownerSocket,
        (event) =>
          event.type === "message" &&
          (event.message as { id?: unknown } | undefined)?.id !== undefined,
      );
      const memberMessageEvents = collectWebSocketEvents(
        memberSocket,
        (event) =>
          event.type === "message" &&
          (event.message as { id?: unknown } | undefined)?.id !== undefined,
      );
      const outsiderMessageEvents = collectWebSocketEvents(
        outsiderSocket,
        (event) => event.type === "message" && event.message !== undefined,
      );
      const createdMessage = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "One live history entry" }),
        },
      );
      assert.equal(createdMessage.status, 201, JSON.stringify(createdMessage));
      assert.ok(createdMessage.body && typeof createdMessage.body === "object");
      const messageId = (createdMessage.body as { id?: unknown }).id;
      assert.equal(typeof messageId, "string");
      const [ownerMessageEventList, memberMessageEventList, outsiderMessageEventList] =
        await Promise.all([ownerMessageEvents, memberMessageEvents, outsiderMessageEvents]);
      assert.equal(ownerMessageEventList.length, 1);
      assert.equal(memberMessageEventList.length, 1);
      assert.equal(outsiderMessageEventList.length, 0);

      const history = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
      );
      assert.equal(history.status, 200, JSON.stringify(history));
      assert.ok(history.body && typeof history.body === "object");
      const historyMessages = (history.body as { messages?: unknown }).messages;
      assert.ok(Array.isArray(historyMessages));
      assert.equal(
        historyMessages.filter(
          (message) => (message as { id?: unknown }).id === messageId,
        ).length,
        1,
      );

      const ownerReactionEvents = collectWebSocketEvents(
        ownerSocket,
        (event) => event.type === "reaction" && event.messageId === messageId,
      );
      const memberReactionEvents = collectWebSocketEvents(
        memberSocket,
        (event) => event.type === "reaction" && event.messageId === messageId,
      );
      const outsiderReactionEvents = collectWebSocketEvents(
        outsiderSocket,
        (event) => event.type === "reaction" && event.messageId === messageId,
      );
      const reaction = await apiRequest(
        memberSession,
        `/messages/${messageId}/reactions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji: "👍" }),
        },
      );
      assert.equal(reaction.status, 200, JSON.stringify(reaction));
      const [ownerReactionEventList, memberReactionEventList, outsiderReactionEventList] =
        await Promise.all([ownerReactionEvents, memberReactionEvents, outsiderReactionEvents]);
      assert.equal(ownerReactionEventList.length, 1);
      assert.equal(memberReactionEventList.length, 1);
      assert.equal(outsiderReactionEventList.length, 0);
      const reactedHistory = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
      );
      assert.equal(reactedHistory.status, 200, JSON.stringify(reactedHistory));
      assert.ok(reactedHistory.body && typeof reactedHistory.body === "object");
      const reactedMessage = ((reactedHistory.body as { messages?: unknown }).messages as Array<{ id?: unknown; reactions?: unknown }> | undefined)
        ?.find((message) => message.id === messageId);
      assert.ok(reactedMessage);
      assert.deepEqual(reactedMessage.reactions, [{ emoji: "👍", count: 1, reacted: false }]);

      const ownerDeletionEvents = collectWebSocketEvents(
        ownerSocket,
        (event) => event.type === "message_deleted" && event.messageId === messageId,
      );
      const memberDeletionEvents = collectWebSocketEvents(
        memberSocket,
        (event) => event.type === "message_deleted" && event.messageId === messageId,
      );
      const outsiderDeletionEvents = collectWebSocketEvents(
        outsiderSocket,
        (event) => event.type === "message_deleted" && event.messageId === messageId,
      );
      const deletion = await apiRequest(
        ownerSession,
        `/messages/${messageId}`,
        { method: "DELETE" },
      );
      assert.equal(deletion.status, 200, JSON.stringify(deletion));
      const [ownerDeletionEventList, memberDeletionEventList, outsiderDeletionEventList] =
        await Promise.all([ownerDeletionEvents, memberDeletionEvents, outsiderDeletionEvents]);
      assert.equal(ownerDeletionEventList.length, 1);
      assert.equal(memberDeletionEventList.length, 1);
      assert.equal(outsiderDeletionEventList.length, 0);
      const deletedHistory = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
      );
      assert.equal(deletedHistory.status, 200, JSON.stringify(deletedHistory));
      assert.ok(deletedHistory.body && typeof deletedHistory.body === "object");
      const deletedMessage = ((deletedHistory.body as { messages?: unknown }).messages as Array<{ id?: unknown; body?: unknown; kind?: unknown; deletedAt?: unknown }> | undefined)
        ?.find((message) => message.id === messageId);
      assert.ok(deletedMessage);
      assert.equal(deletedMessage.body, "[message deleted]");
      assert.equal(deletedMessage.kind, "deleted");
      assert.ok(deletedMessage.deletedAt);
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        memberSession.userId,
        outsiderSession.userId,
      ]);
    }
  });

  test("rejects unauthorized invite-only and password-protected room joins", async () => {
    const ownerSession = await createTestSession("invite_owner");
    const requesterSession = await createTestSession("invite_requester");
    const channelIds: number[] = [];

    try {
      const profile = await apiRequest(requesterSession, "/me");
      assert.equal(profile.status, 200, JSON.stringify(profile));
      assert.ok(profile.body && typeof profile.body === "object");
      const username = (profile.body as { username?: unknown }).username;
      assert.equal(typeof username, "string");

      const createChannel = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `invite-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Invite and password protected",
          isPrivate: true,
          isInviteOnly: true,
          password: "room-pass",
        }),
      });
      assert.equal(createChannel.status, 201, JSON.stringify(createChannel));
      assert.ok(createChannel.body && typeof createChannel.body === "object");
      const channelId = (createChannel.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      const missingPassword = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        { method: "POST" },
      );
      assert.equal(missingPassword.status, 403, JSON.stringify(missingPassword));
      assert.deepEqual(missingPassword.body, {
        error: "A channel password is required.",
      });

      const withoutInvite = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "room-pass" }),
        },
      );
      assert.equal(withoutInvite.status, 403, JSON.stringify(withoutInvite));
      assert.deepEqual(withoutInvite.body, {
        error: "This channel is invite-only.",
      });

      const invite = await apiRequest(
        ownerSession,
        `/channels/${channelId}/invites`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username }),
        },
      );
      assert.equal(invite.status, 201, JSON.stringify(invite));
      assert.deepEqual(invite.body, { ok: true });

      const invitedWithWrongPassword = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "wrong-pass" }),
        },
      );
      assert.equal(invitedWithWrongPassword.status, 403, JSON.stringify(invitedWithWrongPassword));
      assert.deepEqual(invitedWithWrongPassword.body, {
        error: "A channel password is required.",
      });

      const invitedWithPassword = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "room-pass" }),
        },
      );
      assert.equal(invitedWithPassword.status, 202, JSON.stringify(invitedWithPassword));
      assert.deepEqual(invitedWithPassword.body, { ok: true, status: "pending" });

      const pendingRequests = await apiRequest(
        ownerSession,
        `/channels/${channelId}/join-requests`,
      );
      assert.equal(pendingRequests.status, 200, JSON.stringify(pendingRequests));
      assert.ok(Array.isArray(pendingRequests.body));
      assert.equal(pendingRequests.body.length, 1);
      const requestId = (pendingRequests.body[0] as { id?: unknown }).id;
      assert.equal(typeof requestId, "number");

      const approval = await apiRequest(
        ownerSession,
        `/channels/${channelId}/join-requests/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(approval.status, 200, JSON.stringify(approval));
      assert.deepEqual(approval.body, { ok: true, status: "approved" });

      const joinAfterApproval = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "room-pass" }),
        },
      );
      assert.equal(joinAfterApproval.status, 200, JSON.stringify(joinAfterApproval));
      assert.deepEqual(joinAfterApproval.body, { ok: true, status: "member" });

      const history = await apiRequest(
        requesterSession,
        `/channels/${channelId}/messages`,
      );
      assert.equal(history.status, 200, JSON.stringify(history));
    } finally {
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("keeps channel and direct messages committed when notifications fail", async () => {
    const senderSession = await createTestSession("notify_sender");
    const recipientSession = await createTestSession("notify_recipient");
    const channelIds: number[] = [];
    const messageIds: string[] = [];
    let communityId: number | null = null;
    const triggerName = `fail_message_notification_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;

    try {
      const [senderProfile, recipientProfile] = await Promise.all([
        apiRequest(senderSession, "/me"),
        apiRequest(recipientSession, "/me"),
      ]);
      assert.equal(senderProfile.status, 200, JSON.stringify(senderProfile));
      assert.equal(recipientProfile.status, 200, JSON.stringify(recipientProfile));
      assert.ok(recipientProfile.body && typeof recipientProfile.body === "object");
      const recipientUsername = (recipientProfile.body as { username?: unknown }).username;
      assert.equal(typeof recipientUsername, "string");

      const community = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, is_private)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [
          `Notification failure ${randomUUID().slice(0, 8)}`,
          `notification-failure-${randomUUID()}`,
          senderSession.userId,
        ],
      );
      communityId = community.rows[0]?.id ?? null;
      assert.equal(typeof communityId, "number");
      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [communityId, senderSession.userId, recipientSession.userId],
      );

      const channelResponse = await apiRequest(senderSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `notify-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Notification failure boundary",
        }),
      });
      assert.equal(channelResponse.status, 201, JSON.stringify(channelResponse));
      assert.ok(channelResponse.body && typeof channelResponse.body === "object");
      const channelId = (channelResponse.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);
      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [channelId, recipientSession.userId],
      );

      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'forced notification failure';
         END;
         $$;`,
      );
      await pool.query(
        `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON irc_notifications
         FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
      );

      const channelBody = `Channel delivery survives @${recipientUsername}`;
      const directBody = "Direct delivery survives notification failure";
      const [channelMessage, directMessage] = await Promise.all([
        apiRequest(senderSession, `/channels/${channelId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: channelBody }),
        }),
        apiRequest(senderSession, `/dm/${recipientSession.userId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: directBody }),
        }),
      ]);
      for (const response of [channelMessage, directMessage]) {
        assert.equal(response.status, 201, JSON.stringify(response));
        assert.ok(response.body && typeof response.body === "object");
        const messageId = (response.body as { id?: unknown }).id;
        assert.equal(typeof messageId, "string");
        messageIds.push(messageId as string);
      }

      const committedMessages = await pool.query<{ body: string }>(
        `SELECT body
         FROM irc_messages
         WHERE id = ANY($1::uuid[])`,
        [messageIds],
      );
      assert.deepEqual(
        committedMessages.rows.map((row) => row.body).sort(),
        [channelBody, directBody].sort(),
      );
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON irc_notifications`);
      await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      if (messageIds.length) {
        await pool.query("DELETE FROM irc_messages WHERE id = ANY($1::uuid[])", [messageIds]);
      }
      await removeTestChannels(channelIds, [
        senderSession.userId,
        recipientSession.userId,
      ]);
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_community_members WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
    }
  });

  test("keeps room and direct-message attachments behind message access", async () => {
    const ownerSession = await createTestSession("attachment_owner");
    const memberSession = await createTestSession("attachment_member");
    const outsiderSession = await createTestSession("attachment_outsider");
    const channelIds: number[] = [];
    let directMessageId: string | undefined;
    const originalFetch = globalThis.fetch;
    const previousPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;

    try {
      for (const session of [ownerSession, memberSession, outsiderSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }

      const createChannel = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `files-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Private attachment access",
          isPrivate: true,
        }),
      });
      assert.equal(createChannel.status, 201, JSON.stringify(createChannel));
      assert.ok(createChannel.body && typeof createChannel.body === "object");
      const channelId = (createChannel.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [channelId, memberSession.userId],
      );

      const roomMessage = await apiRequest(
        memberSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Room file" }),
        },
      );
      assert.equal(roomMessage.status, 201, JSON.stringify(roomMessage));
      assert.ok(roomMessage.body && typeof roomMessage.body === "object");
      const roomMessageId = (roomMessage.body as { id?: unknown }).id;
      assert.equal(typeof roomMessageId, "string");

      const roomAttachment = await apiRequest(
        memberSession,
        `/messages/${roomMessageId}/attachments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            objectPath: `/objects/uploads/${randomUUID()}`,
            fileName: "room.txt",
            contentType: "text/plain",
            fileSize: 12,
          }),
        },
      );
      assert.equal(roomAttachment.status, 201, JSON.stringify(roomAttachment));
      assert.ok(roomAttachment.body && typeof roomAttachment.body === "object");
      const roomAttachmentId = (roomAttachment.body as { id?: unknown }).id;
      assert.equal(typeof roomAttachmentId, "number");

      process.env.PRIVATE_OBJECT_DIR = "private";
      globalThis.fetch = async (input, init) => {
        const requestUrl = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        if (requestUrl === "http://127.0.0.1:1106/object-storage/signed-object-url") {
          return new Response(JSON.stringify({ signed_url: "https://storage.example/signed" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      const memberRoomDownload = await apiRequest(
        memberSession,
        `/attachments/${roomAttachmentId}`,
        { redirect: "manual" },
      );
      assert.equal(memberRoomDownload.status, 302, JSON.stringify(memberRoomDownload));

      const outsiderRoomDownload = await apiRequest(
        outsiderSession,
        `/attachments/${roomAttachmentId}`,
      );
      assert.equal(outsiderRoomDownload.status, 404, JSON.stringify(outsiderRoomDownload));
      assert.deepEqual(outsiderRoomDownload.body, { error: "Attachment not found." });

      const threadKey = [ownerSession.userId, memberSession.userId].sort().join(":");
      directMessageId = randomUUID();
      await pool.query(
        `INSERT INTO irc_messages (id, sender_id, recipient_id, thread_key, body)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          directMessageId,
          ownerSession.userId,
          memberSession.userId,
          threadKey,
          "Direct file",
        ],
      );

      const directAttachment = await apiRequest(
        ownerSession,
        `/messages/${directMessageId}/attachments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            objectPath: `/objects/uploads/${randomUUID()}`,
            fileName: "direct.txt",
            contentType: "text/plain",
            fileSize: 14,
          }),
        },
      );
      assert.equal(directAttachment.status, 201, JSON.stringify(directAttachment));
      assert.ok(directAttachment.body && typeof directAttachment.body === "object");
      const directAttachmentId = (directAttachment.body as { id?: unknown }).id;
      assert.equal(typeof directAttachmentId, "number");

      const directRecipientDownload = await apiRequest(
        memberSession,
        `/attachments/${directAttachmentId}`,
        { redirect: "manual" },
      );
      assert.equal(directRecipientDownload.status, 302, JSON.stringify(directRecipientDownload));

      const outsiderDirectDownload = await apiRequest(
        outsiderSession,
        `/attachments/${directAttachmentId}`,
      );
      assert.equal(outsiderDirectDownload.status, 404, JSON.stringify(outsiderDirectDownload));
      assert.deepEqual(outsiderDirectDownload.body, { error: "Attachment not found." });

      const atomicFileName = `atomic-${randomUUID().slice(0, 8)}.txt`;
      const atomicFileMessage = await apiRequest(
        memberSession,
        `/channels/${channelId}/file-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            objectPath: `/objects/uploads/${randomUUID()}`,
            fileName: atomicFileName,
            contentType: "text/plain",
            fileSize: 18,
          }),
        },
      );
      assert.equal(atomicFileMessage.status, 201, JSON.stringify(atomicFileMessage));
      assert.ok(atomicFileMessage.body && typeof atomicFileMessage.body === "object");
      const atomicMessageBody = atomicFileMessage.body as {
        id?: unknown;
        body?: unknown;
        attachments?: unknown;
      };
      assert.equal(typeof atomicMessageBody.id, "string");
      assert.equal(atomicMessageBody.body, atomicFileName);
      assert.ok(Array.isArray(atomicMessageBody.attachments));
      assert.equal(atomicMessageBody.attachments.length, 1);

      const triggerName = `fail_atomic_attachment_${randomUUID().replaceAll("-", "")}`;
      const functionName = `${triggerName}_fn`;
      const failedFileName = `failed-${randomUUID().slice(0, 8)}.txt`;
      try {
        await pool.query(
          `CREATE FUNCTION "${functionName}"() RETURNS trigger
           LANGUAGE plpgsql AS $$
           BEGIN
             RAISE EXCEPTION 'forced attachment insert failure';
           END;
           $$;`,
        );
        await pool.query(
          `CREATE TRIGGER "${triggerName}"
           BEFORE INSERT ON irc_message_attachments
           FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
        );
        const failedAtomicMessage = await apiRequest(
          memberSession,
          `/channels/${channelId}/file-messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              objectPath: `/objects/uploads/${randomUUID()}`,
              fileName: failedFileName,
              contentType: "text/plain",
              fileSize: 21,
            }),
          },
        );
        assert.equal(failedAtomicMessage.status, 500, JSON.stringify(failedAtomicMessage));
        const rolledBackMessages = await pool.query(
          `SELECT id
           FROM irc_messages
           WHERE channel_id = $1 AND sender_id = $2 AND body = $3`,
          [channelId, memberSession.userId, failedFileName],
        );
        assert.deepEqual(rolledBackMessages.rows, []);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON irc_message_attachments`);
        await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (previousPrivateObjectDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
      else process.env.PRIVATE_OBJECT_DIR = previousPrivateObjectDir;
      if (directMessageId) {
        await pool.query("DELETE FROM irc_messages WHERE id = $1", [directMessageId]);
      }
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        memberSession.userId,
        outsiderSession.userId,
      ]);
    }
  });

  test("manages notifications only for their recipient and retains cleared deadline tombstones", async () => {
    await apiRequest(firstSession, "/me");
    await apiRequest(secondSession, "/me");
    const unique = randomUUID();
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO irc_notifications (user_id, type, category, body, entity_type, entity_id)
       VALUES ($1, 'task_deadline', 'task_deadline', $2, 'workspace_task', $3),
              ($1, 'general', 'general', $4, NULL, NULL),
              ($5, 'general', 'general', $6, NULL, NULL)
       RETURNING id`,
      [firstSession.userId, `Deadline ${unique}`, `test-${unique}`, `Other ${unique}`, secondSession.userId, `Keep ${unique}`],
    );
    const [deadlineId, otherId, otherUserId] = inserted.rows.map((row) => row.id);
    let directMessageId: string | undefined;
    let directNoticeId: number | undefined;
    try {
      const directMessage = await pool.query<{ id: string }>(
        "INSERT INTO irc_messages (sender_id, recipient_id, thread_key, body) VALUES ($1, $2, $3, $4) RETURNING id",
        [secondSession.userId, firstSession.userId, `notification-test:${unique}`, `Private details ${unique}`],
      );
      directMessageId = directMessage.rows[0].id;
      const directNotice = await pool.query<{ id: number }>(
        `INSERT INTO irc_notifications (user_id, type, category, body, entity_type, entity_id)
         VALUES ($1, 'direct_message', 'direct_message', 'You have a new direct message.', 'message', $2)
         RETURNING id`,
        [firstSession.userId, directMessageId],
      );
      directNoticeId = directNotice.rows[0].id;
      const directDetail = await apiRequest(firstSession, `/notifications/${directNoticeId}/detail`);
      assert.equal(directDetail.status, 200, JSON.stringify(directDetail));
      assert.equal((directDetail.body as { message: { body: string } }).message.body, `Private details ${unique}`);
      assert.equal((await apiRequest(secondSession, `/messages/${directMessageId}`, { method: "DELETE" })).status, 200);
      const deletedMessageDetail = await apiRequest(firstSession, `/notifications/${directNoticeId}/detail`);
      assert.equal((deletedMessageDetail.body as { message: { body: string } }).message.body, "[message deleted]");

      for (const [path, init] of [
        [`/notifications/${deadlineId}/detail`, undefined],
        [`/notifications/${deadlineId}/archive`, { method: "POST" }],
        [`/notifications/${deadlineId}/restore`, { method: "POST" }],
        [`/notifications/${deadlineId}`, { method: "DELETE" }],
      ] as const) {
        const response = await apiRequest(secondSession, path, init);
        assert.equal(response.status, 404, JSON.stringify(response));
      }
      const detail = await apiRequest(firstSession, `/notifications/${deadlineId}/detail`);
      assert.equal(detail.status, 200);
      assert.equal((detail.body as { notification: { body: string } }).notification.body, `Deadline ${unique}`);

      assert.equal((await apiRequest(firstSession, `/notifications/${deadlineId}/archive`, { method: "POST" })).status, 200);
      const inbox = await apiRequest(firstSession, "/notifications");
      assert.equal((inbox.body as Array<{ id: number }>).some(({ id }) => id === deadlineId), false);
      const archived = await apiRequest(firstSession, "/notifications?archived=true");
      assert.equal((archived.body as Array<{ id: number }>).some(({ id }) => id === deadlineId), true);

      assert.equal((await apiRequest(firstSession, `/notifications/${deadlineId}/restore`, { method: "POST" })).status, 200);
      assert.equal((await apiRequest(firstSession, "/notifications/read-all", { method: "POST" })).status, 200);
      const read = await pool.query<{ read_at: Date | null }>("SELECT read_at FROM irc_notifications WHERE id = $1", [deadlineId]);
      assert.notEqual(read.rows[0]?.read_at, null);
      const otherUserRead = await pool.query<{ read_at: Date | null }>("SELECT read_at FROM irc_notifications WHERE id = $1", [otherUserId]);
      assert.equal(otherUserRead.rows[0]?.read_at, null);
      assert.equal((await apiRequest(firstSession, `/notifications/${otherId}`, { method: "DELETE" })).status, 200);
      assert.equal((await apiRequest(firstSession, "/notifications/clear", { method: "DELETE" })).status, 200);
      const cleared = await pool.query<{ body: string; deleted_at: Date | null }>(
        "SELECT body, deleted_at FROM irc_notifications WHERE id = $1",
        [deadlineId],
      );
      assert.equal(cleared.rows[0]?.body, "");
      assert.notEqual(cleared.rows[0]?.deleted_at, null);
      const otherUserNotice = await pool.query<{ body: string; deleted_at: Date | null }>(
        "SELECT body, deleted_at FROM irc_notifications WHERE id = $1",
        [otherUserId],
      );
      assert.equal(otherUserNotice.rows[0]?.body, `Keep ${unique}`);
      assert.equal(otherUserNotice.rows[0]?.deleted_at, null);
      const afterClear = await apiRequest(firstSession, "/notifications");
      assert.equal((afterClear.body as Array<{ id: number }>).some(({ id }) => id === deadlineId), false);
      assert.equal((await apiRequest(firstSession, `/notifications/${deadlineId}/detail`)).status, 404);
    } finally {
      await pool.query("DELETE FROM irc_notifications WHERE id = ANY($1::int[])", [[deadlineId, otherId, otherUserId, directNoticeId].filter((id): id is number => id !== undefined)]);
      if (directMessageId) await pool.query("DELETE FROM irc_messages WHERE id = $1", [directMessageId]);
    }
  });
});
