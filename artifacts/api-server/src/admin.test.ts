import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { clerkClient } from "@clerk/express";
import { WebSocket } from "ws";
import { pool } from "@workspace/db";
import app from "./app";
import { TEST_EMAIL_DOMAIN, TEST_USERNAME_PREFIX } from "./admin-test-identity";
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

async function createTestSession(label: string): Promise<TestSession> {
  const uniqueId = `${label}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const user = await clerkClient.users.createUser({
    username: `${TEST_USERNAME_PREFIX}${uniqueId}`,
    emailAddress: [`${TEST_USERNAME_PREFIX}${uniqueId}@${TEST_EMAIL_DOMAIN}`],
    emailAddressIdentificationStatus: ["reserved"],
    skipPasswordRequirement: true,
  });
  const session = await clerkClient.sessions.createSession({ userId: user.id });
  const testSession = { userId: user.id, sessionId: session.id };
  createdSessions.push(testSession);
  return testSession;
}

async function apiRequest(
  session: TestSession,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse> {
  const token = await clerkClient.sessions.getToken(session.sessionId);
  return apiRequestWithToken(token.jwt, path, init);
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

async function removeTestDatabaseRows(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await pool.query("DELETE FROM irc_users WHERE clerk_id = ANY($1::text[])", [
    userIds,
  ]);
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
  await Promise.allSettled(
    createdSessions.map(({ sessionId }) =>
      clerkClient.sessions.revokeSession(sessionId),
    ),
  );
  await Promise.allSettled(
    createdSessions.map(({ userId }) => clerkClient.users.deleteUser(userId)),
  );
  await removeTestDatabaseRows(createdSessions.map(({ userId }) => userId));
  await pool.end();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("admin access controls", () => {
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
    await clerkClient.sessions.revokeSession(revokedSession.sessionId);

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
    await clerkClient.sessions.revokeSession(revokedSession.sessionId);

    const requests: Array<[string, RequestInit?]> = [
      ["/me"],
      [
        "/me",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "revoked_user", displayName: "Revoked User" }),
        },
      ],
      ["/channels"],
      [
        "/channels",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "revoked-channel", topic: "Should not exist" }),
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
          body: JSON.stringify({ action: "mute", targetUserId: firstSession.userId }),
        },
      ],
      ["/users/search?q=revoked"],
      [
        `/users/${firstSession.userId}/block`,
        { method: "POST" },
      ],
      [
        `/users/${firstSession.userId}/block`,
        { method: "DELETE" },
      ],
      ["/dm/threads"],
      [`/dm/${firstSession.userId}/messages`],
      [
        `/dm/${firstSession.userId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Should not be sent" }),
        },
      ],
      ["/search/messages?q=revoked"],
      ["/notifications"],
      ["/notifications/1/read", { method: "POST" }],
    ];
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

    await clerkClient.sessions.revokeSession(revokedSession.sessionId);

    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket as string)}`;
    await expectRejectedWebSocket(wsUrl);
    await expectRejectedWebSocket(wsUrl);

    const afterConnection = await pool.query(
      "SELECT status FROM irc_users WHERE clerk_id = $1",
      [revokedSession.userId],
    );
    assert.deepEqual(afterConnection.rows, [{ status: "offline" }]);
  });

  test("only one concurrent first-account claim succeeds", async () => {
    const responses = await Promise.all([
      apiRequest(firstSession, "/admin/claim", { method: "POST" }),
      apiRequest(secondSession, "/admin/claim", { method: "POST" }),
    ]);

    assert.deepEqual(
      responses.map(({ status }) => status).sort((a, b) => a - b),
      [200, 403],
      JSON.stringify(responses),
    );

    const winnerIndex = responses.findIndex(({ status }) => status === 200);
    assert.notEqual(winnerIndex, -1);
    adminSession = winnerIndex === 0 ? firstSession : secondSession;
    memberSession = winnerIndex === 0 ? secondSession : firstSession;
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
    assert.deepEqual(matchingActivity, {
      actorId: adminSession.userId,
      action: "demoted_user",
      targetId: memberSession.userId,
      details: "Role changed to member",
      actor: profile.displayName,
    });
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
      assert.deepEqual(matchingActivity, {
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

  test("records a successful promotion with the acting admin in activity", async () => {
    try {
      await pool.query(
        "UPDATE irc_users SET role = 'member' WHERE clerk_id = $1",
        [adminSession.userId],
      );
      await pool.query(
        "UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1",
        [memberSession.userId],
      );

      const roleUpdate = await apiRequest(
        memberSession,
        `/admin/users/${adminSession.userId}/role`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "admin" }),
        },
      );
      assert.equal(roleUpdate.status, 200);
      assert.deepEqual(roleUpdate.body, {
        id: adminSession.userId,
        role: "admin",
      });

      const status = await apiRequest(memberSession, "/admin/status");
      assert.equal(status.status, 200);
      assert.ok(status.body && typeof status.body === "object");
      const profile = (status.body as {
        profile?: { id?: unknown; displayName?: unknown };
      }).profile;
      assert.ok(profile && profile.id === memberSession.userId);
      assert.equal(typeof profile.displayName, "string");

      const overview = await apiRequest(memberSession, "/admin/overview");
      assert.equal(overview.status, 200);
      assert.ok(overview.body && typeof overview.body === "object");
      const activity = (overview.body as { activity?: unknown }).activity;
      assert.ok(Array.isArray(activity));
      const matchingActivity = activity.find(
        (
          entry,
        ): entry is {
          action: string;
          targetId: string | null;
          details: string | null;
          actor: string | null;
        } =>
          typeof entry === "object" &&
          entry !== null &&
          "action" in entry &&
          "targetId" in entry &&
          (entry as { action?: unknown }).action === "promoted_user" &&
          (entry as { targetId?: unknown }).targetId === adminSession.userId,
      );
      assert.deepEqual(matchingActivity, {
        actorId: memberSession.userId,
        action: "promoted_user",
        targetId: adminSession.userId,
        details: "Role changed to admin",
        actor: profile.displayName,
      });
    } finally {
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
      assert.equal(response.status, 500);

      const afterUsers = await pool.query(
        "SELECT clerk_id, role FROM irc_users WHERE clerk_id = $1",
        [adminSession.userId],
      );
      const afterAudit = await pool.query(
        "SELECT id, actor_id, action, target_id, target_label, details FROM irc_admin_audit_logs ORDER BY id",
      );
      assert.deepEqual(afterUsers.rows, [
        { clerk_id: adminSession.userId, role: "admin" },
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

  test("returns 404 without changing roles or audit activity for an unknown user", async () => {
    const unknownUserId = `unknown_${randomUUID()}`;
    const beforeUsers = await pool.query(
      "SELECT clerk_id, role FROM irc_users ORDER BY clerk_id",
    );
    const beforeAudit = await pool.query(
      "SELECT id, actor_id, action, target_id, target_label, details FROM irc_admin_audit_logs ORDER BY id",
    );

    const response = await apiRequest(
      adminSession,
      `/admin/users/${unknownUserId}/role`,
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

  test("a non-admin cannot read the overview or update roles", async () => {
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

      assert.deepEqual(afterChannel.rows, beforeChannel.rows);
      assert.deepEqual(afterMessages.rows, beforeMessages.rows);
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
        error: "Role must be either admin or member.",
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
});
