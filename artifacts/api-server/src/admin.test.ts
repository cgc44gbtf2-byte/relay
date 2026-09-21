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

async function createSessionForUser(userId: string): Promise<TestSession> {
  const session = await clerkClient.sessions.createSession({ userId });
  const testSession = { userId, sessionId: session.id };
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

  test("keeps another IRC session active for profile updates when one session is revoked", async () => {
    const revokedSession = await createTestSession("revoked_scoped");
    const activeSession = await createSessionForUser(revokedSession.userId);
    const initialProfile = await apiRequest(revokedSession, "/me");
    assert.equal(initialProfile.status, 200, JSON.stringify(initialProfile));
    const [revokedToken, activeToken] = await Promise.all([
      clerkClient.sessions.getToken(revokedSession.sessionId),
      clerkClient.sessions.getToken(activeSession.sessionId),
    ]);

    await clerkClient.sessions.revokeSession(revokedSession.sessionId);

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
      (refreshedActiveResponse.body as { displayName?: unknown }).displayName,
      activeDisplayName,
    );
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
          `/admin/overview?activityLimit=8&activityOffset=${offset}`,
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
            };
          },
        );
      }

      assert.deepEqual(
        pageResponses.map((page) => page.activity.length),
        [8, 8, 7],
      );
      assert.deepEqual(
        pageResponses.map((page) => page.activityPagination),
        [
          { limit: 8, offset: 0, hasMore: true, nextOffset: 8 },
          { limit: 8, offset: 8, hasMore: true, nextOffset: 16 },
          { limit: 8, offset: 16, hasMore: false, nextOffset: null },
        ],
      );

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

    // Admin maintenance keeps its legacy validation errors for malformed IDs.
    assert.equal(adminResponses[0].status, 400, JSON.stringify(adminResponses[0]));
    assert.deepEqual(adminResponses[0].body, {
      error: "A valid channel and topic are required.",
    });
    assert.equal(adminResponses[1].status, 400, JSON.stringify(adminResponses[1]));
    assert.deepEqual(adminResponses[1].body, { error: "Invalid channel." });
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

  test("keeps simultaneous promotions to one administrator", async () => {
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
        [200, 409],
        JSON.stringify(responses),
      );
      assert.deepEqual(
        responses.filter(({ status }) => status === 409).map(({ body }) => body),
        [{ error: "Only one admin account is allowed." }],
      );

      for (const [index, response] of responses.entries()) {
        const targetRole = await pool.query(
          "SELECT role FROM irc_users WHERE clerk_id = $1",
          [[firstTarget, secondTarget][index].userId],
        );
        assert.equal(
          targetRole.rows[0]?.role,
          response.status === 200 ? "admin" : "member",
        );
      }

      const roles = await pool.query(
        "SELECT clerk_id, role FROM irc_users WHERE clerk_id = ANY($1::text[]) ORDER BY clerk_id",
        [[firstTarget.userId, secondTarget.userId]],
      );
      assert.equal(
        roles.rows.filter(({ role }) => role === "admin").length,
        1,
        JSON.stringify(roles.rows),
      );
      assert.equal(
        roles.rows.filter(({ role }) => role === "member").length,
        1,
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
            objectPath: "/objects/uploads/private-room-file",
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
            objectPath: "/objects/uploads/direct-file",
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
});
