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
import { processMessageNotificationDeliveries } from "./lib/message-notification-delivery";
import { sendCommunitySubscriptionReminders } from "./lib/community-subscription-reminders";
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
  // Long integration runs must not reuse short-lived session JWTs past expiry.
  const expiresAt = token
    ? Number(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp) * 1000
    : 0;
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 10_000) {
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

async function waitForChannelSubscription(socket: WebSocket, channelId: number): Promise<void> {
  const marker = randomUUID();
  const receivedProbe = waitForWebSocketEvent(
    socket,
    (event) => event.type === "channel_subscription_probe" && event.marker === marker,
  );
  const sendProbe = (): void => {
    wsHub.broadcastChannel(channelId, {
      type: "channel_subscription_probe",
      marker,
    });
  };
  const probeInterval = setInterval(sendProbe, 25);
  sendProbe();
  try {
    await receivedProbe;
  } finally {
    clearInterval(probeInterval);
  }
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

describe("free community onboarding", () => {
  test("keeps repeated onboarding retries to one free community and separates paid workspaces", async () => {
    const owner = await createTestSession("free_community_onboarding");

    try {
      const profile = await apiRequest(owner, "/me");
      assert.equal(profile.status, 200, JSON.stringify(profile));

      const onboardingResponses = await Promise.all(
        Array.from({ length: 4 }, () => apiRequest(owner, "/onboarding")),
      );
      for (const response of onboardingResponses) {
        assert.equal(response.status, 200, JSON.stringify(response));
      }

      type OnboardingState = {
        ownerCommunity: { id: number; plan: string } | null;
        communities: Array<{ id: number; plan: string }>;
      };
      const onboardingStates = onboardingResponses.map(
        (response) => response.body as OnboardingState,
      );
      const freeCommunity = onboardingStates[0].ownerCommunity;
      assert.ok(freeCommunity);
      assert.equal(freeCommunity.plan, "free_community");
      assert.ok(onboardingStates.every(
        (state) => state.ownerCommunity?.id === freeCommunity.id,
      ));

      const storedFreeCommunities = await pool.query<{ id: number; plan: string }>(
        `SELECT id, plan
         FROM irc_communities
         WHERE owner_id = $1 AND plan = 'free_community'`,
        [owner.userId],
      );
      assert.deepEqual(storedFreeCommunities.rows, [{
        id: freeCommunity.id,
        plan: "free_community",
      }]);

      const starterRooms = await pool.query<{ name: string }>(
        "SELECT name FROM irc_channels WHERE community_id = $1 ORDER BY name",
        [freeCommunity.id],
      );
      assert.deepEqual(starterRooms.rows.map((room) => room.name), ["#general", "#welcome"]);

      const workspace = await apiRequest(owner, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Paid onboarding boundary ${randomUUID().slice(0, 8)}`,
          slug: `paid-onboarding-${randomUUID().slice(0, 12)}`,
          isPrivate: true,
        }),
      });
      assert.equal(workspace.status, 201, JSON.stringify(workspace));
      const paidWorkspace = workspace.body as { id: number; plan: string };
      assert.equal(paidWorkspace.plan, "paid_workspace");

      const workspaceListing = await apiRequest(owner, "/communities");
      assert.equal(workspaceListing.status, 200, JSON.stringify(workspaceListing));
      assert.ok(Array.isArray(workspaceListing.body));
      assert.ok((workspaceListing.body as Array<{ id: number; plan: string }>).some(
        (community) => community.id === paidWorkspace.id && community.plan === "paid_workspace",
      ));
      assert.equal((await apiRequest(owner, "/communities?limit=-1")).status, 400);
      const workspacePage = await apiRequest(owner, "/communities?limit=1&offset=0");
      assert.equal(workspacePage.status, 200);
      assert.ok(Array.isArray(workspacePage.body));
      assert.ok((workspacePage.body as unknown[]).length <= 1);
      assert.equal((await apiRequest(owner, `/communities/${paidWorkspace.id}?announcementsLimit=0`)).status, 400);
      assert.equal((await apiRequest(owner, `/communities/${paidWorkspace.id}/activity?auditOffset=-1`)).status, 400);
      assert.equal((await apiRequest(owner, `/communities/${paidWorkspace.id}/documents?foldersLimit=nope`)).status, 400);
      assert.equal((await apiRequest(owner, `/communities/${paidWorkspace.id}/moderation-logs?moderationLimit=0`)).status, 400);
      const detailPage = await apiRequest(owner, `/communities/${paidWorkspace.id}?announcementsLimit=1`);
      assert.equal(detailPage.status, 200);
      assert.deepEqual((detailPage.body as { pagination: { announcements: { limit: number; offset: number; hasMore: boolean } } }).pagination.announcements, {
        limit: 1, offset: 0, hasMore: false,
      });

      // Real high-count pages: stable tie breaking and no missing items at the
      // boundary, including announcements hidden from an ordinary member.
      const member = await createTestSession("workspace_pages_member");
      assert.equal((await apiRequest(member, "/me")).status, 200);
      await pool.query("INSERT INTO irc_community_members (community_id, user_id, status) VALUES ($1, $2, 'member')", [paidWorkspace.id, member.userId]);
      await pool.query(
        `INSERT INTO irc_channels (community_id, owner_id, name)
         SELECT $1, $2, 'paged-' || lpad(n::text, 3, '0') FROM generate_series(1, 125) n`,
        [paidWorkspace.id, owner.userId],
      );
      await pool.query(
        `INSERT INTO irc_server_announcements (community_id, author_id, title, body, status, created_at)
         SELECT $1, $2, 'paged-announcement-' || n, 'Body', CASE WHEN n > 25 THEN 'draft' ELSE 'published' END,
                timestamp with time zone '2025-01-01' + n * interval '1 second'
         FROM generate_series(1, 30) n`,
        [paidWorkspace.id, owner.userId],
      );
      const foreignTeam = await pool.query<{ id: number }>(
        "INSERT INTO irc_teams (community_id, name) VALUES ($1, 'other-workspace-team') RETURNING id",
        [freeCommunity.id],
      );
      await pool.query("INSERT INTO irc_team_members (team_id, user_id) VALUES ($1, $2)", [foreignTeam.rows[0].id, member.userId]);
      await pool.query(
        `INSERT INTO irc_server_announcements (community_id, author_id, title, body, audience_type, team_id, created_at)
         VALUES ($1, $2, 'cross-workspace-team', 'Private', 'team', $3, timestamp with time zone '2026-01-01')`,
        [paidWorkspace.id, owner.userId, foreignTeam.rows[0].id],
      );
      const channelPages = await Promise.all([0, 100].map((offset) =>
        apiRequest(owner, `/communities/${paidWorkspace.id}?view=summary&channelsLimit=100&channelsOffset=${offset}`)));
      const channelIds = channelPages.flatMap((response) =>
        (response.body as { channels: Array<{ id: number }> }).channels.map((channel) => channel.id));
      assert.equal(channelPages[0].status, 200);
      assert.equal(channelPages[1].status, 200);
      assert.equal(channelIds.length, 128); // three default rooms + 125 additional rooms
      assert.equal(new Set(channelIds).size, channelIds.length);
      assert.equal((channelPages[0].body as { pagination: { channels: { hasMore: boolean } } }).pagination.channels.hasMore, true);
      assert.equal((channelPages[1].body as { pagination: { channels: { hasMore: boolean } } }).pagination.channels.hasMore, false);
      const announcementPages = await Promise.all([0, 20].map((offset) =>
        apiRequest(member, `/communities/${paidWorkspace.id}?view=summary&announcementsLimit=20&announcementsOffset=${offset}`)));
      assert.deepEqual(announcementPages.map((response) =>
        (response.body as { announcements: Array<{ title: string }> }).announcements.length), [20, 5]);
      assert.deepEqual(announcementPages.map((response) =>
        (response.body as { pagination: { announcements: { hasMore: boolean } } }).pagination.announcements.hasMore), [true, false]);
      assert.equal(new Set(announcementPages.flatMap((response) =>
        (response.body as { announcements: Array<{ id: number }> }).announcements.map((item) => item.id))).size, 25);

      const onboardingAfterWorkspaceCreation = await apiRequest(owner, "/onboarding");
      assert.equal(onboardingAfterWorkspaceCreation.status, 200, JSON.stringify(onboardingAfterWorkspaceCreation));
      const finalOnboarding = onboardingAfterWorkspaceCreation.body as OnboardingState;
      assert.equal(finalOnboarding.ownerCommunity?.id, freeCommunity.id);
      assert.equal(finalOnboarding.ownerCommunity?.plan, "free_community");
      assert.ok(finalOnboarding.communities.every(
        (community) => community.id !== paidWorkspace.id && community.plan !== "paid_workspace",
      ));
    } finally {
      await pool.query("DELETE FROM irc_channels WHERE owner_id = $1 AND name LIKE 'paged-%'", [owner.userId]);
      await pool.query(
        "DELETE FROM irc_communities WHERE owner_id = $1",
        [owner.userId],
      );
    }
  });
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

  test("cannot regain IRC access by requesting a token after session revocation", async () => {
    const revokedSession = await createTestSession("revoked_replacement_token");
    const profile = await apiRequest(revokedSession, "/me");
    assert.equal(profile.status, 200, JSON.stringify(profile));

    await revokeTestSession(revokedSession);
    await new Promise((resolve) => setTimeout(resolve, SESSION_STATUS_CACHE_TTL_MS + 25));

    const tokenResult = await withClerkRateLimitRetry(
      () => clerkClient.sessions.getToken(revokedSession.sessionId),
    ).then(
      (token) => ({ kind: "issued" as const, jwt: token.jwt }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    if (tokenResult.kind === "rejected") {
      const status = tokenResult.error && typeof tokenResult.error === "object" &&
          "status" in tokenResult.error
        ? tokenResult.error.status
        : undefined;
      assert.ok(
        typeof status === "number" && status >= 400 && status < 500 && status !== 429,
        "Clerk should explicitly reject token requests for a revoked session",
      );
      return;
    }

    const response = await apiRequestWithToken(tokenResult.jwt, "/me");
    assert.equal(response.status, 401, JSON.stringify(response));
    assert.deepEqual(response.body, { error: "Sign in to continue" });
  });

  test("keeps a refreshed sibling session active for username and profile updates when another session is revoked", async () => {
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

    const revokedUsername = `revoked_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const revokedResponse = await apiRequestWithToken(revokedToken.jwt, "/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: revokedUsername,
        displayName: "Revoked session update",
      }),
    });
    assert.equal(revokedResponse.status, 401, JSON.stringify(revokedResponse));
    assert.deepEqual(revokedResponse.body, { error: "Sign in to continue" });

    const activeUsername = `active_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const activeDisplayName = `Active sibling ${randomUUID().slice(0, 8)}`;
    const activeResponse = await apiRequestWithToken(activeToken.jwt, "/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: activeUsername, displayName: activeDisplayName }),
    });
    assert.equal(activeResponse.status, 200, JSON.stringify(activeResponse));
    assert.ok(activeResponse.body && typeof activeResponse.body === "object");
    assert.equal(
      (activeResponse.body as { username?: unknown }).username,
      activeUsername,
    );
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
      (refreshedActiveResponse.body as { username?: unknown }).username,
      activeUsername,
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

  test("returns a stable conflict when PATCH /me claims an existing username", async () => {
    const firstProfile = await apiRequest(firstSession, "/me");
    const secondProfile = await apiRequest(secondSession, "/me");
    assert.equal(firstProfile.status, 200, JSON.stringify(firstProfile));
    assert.equal(secondProfile.status, 200, JSON.stringify(secondProfile));
    const claimedUsername = (firstProfile.body as { username?: unknown }).username;
    const originalUsername = (secondProfile.body as { username?: unknown }).username;
    assert.equal(typeof claimedUsername, "string");
    assert.equal(typeof originalUsername, "string");

    const conflict = await apiRequest(secondSession, "/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: claimedUsername }),
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict));
    assert.deepEqual(conflict.body, {
      error: "That username is already taken.",
      code: "USERNAME_TAKEN",
    });

    const unchanged = await pool.query<{ username: string }>(
      "SELECT username FROM irc_users WHERE clerk_id = $1",
      [secondSession.userId],
    );
    assert.deepEqual(unchanged.rows, [{ username: originalUsername }]);
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

  test("validates collection page bounds and preserves release rows across stable pages", async () => {
    const invalidPaths = [
      "/admin/overview?channelLimit=101",
      "/admin/overview?categoryOffset=-1",
      "/admin/users?limit=0",
      "/admin/role-assignments?offset=NaN",
      "/admin/scope-options?limit=1&limit=2",
      "/admin/custom-roles?limit=101",
      "/developer/releases?offset=2147483648",
      "/developer/releases?limit=101",
    ];
    for (const path of invalidPaths) {
      const response = await apiRequest(adminSession, path);
      assert.equal(response.status, 400, `${path}: ${JSON.stringify(response.body)}`);
    }

    const marker = `pagination_${randomUUID().replaceAll("-", "")}`;
    try {
      await pool.query(
        `INSERT INTO irc_developer_releases (version, title, created_by, created_at)
         SELECT $1 || '_' || series, $1, $2, '2024-02-01T00:00:00Z'
         FROM generate_series(1, 101) AS series`,
        [marker, adminSession.userId],
      );
      const seen = new Set<number>();
      const matchingOrder: number[] = [];
      let offset = 0;
      while (true) {
        const page = await apiRequest(adminSession, `/developer/releases?limit=37&offset=${offset}`);
        assert.equal(page.status, 200, JSON.stringify(page.body));
        const rows = page.body as Array<{ id: number; title: string }>;
        for (const row of rows) {
          assert.equal(seen.has(row.id), false, `duplicate release ${row.id}`);
          seen.add(row.id);
          if (row.title === marker) matchingOrder.push(row.id);
        }
        if (rows.length < 37) break;
        offset += rows.length;
      }
      const matching = await pool.query<{ id: number }>("SELECT id FROM irc_developer_releases WHERE title = $1", [marker]);
      assert.equal(matching.rows.length, 101);
      for (const row of matching.rows) assert.ok(seen.has(row.id), `missing release ${row.id}`);
      assert.deepEqual(matchingOrder, [...matchingOrder].sort((a, b) => b - a), "equal-timestamp releases must use id as a stable tie-breaker");
    } finally {
      await pool.query("DELETE FROM irc_developer_releases WHERE title = $1", [marker]);
    }
  });

  test("bounds each admin collection without changing its response shape", async () => {
    const overview = await apiRequest(adminSession, "/admin/overview?channelLimit=1&categoryLimit=1");
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    const body = overview.body as {
      channels: Array<{ id: number }>;
      categories: Array<{ id: number }>;
      collectionPagination: {
        channels: { limit: number; offset: number; hasMore: boolean };
        categories: { limit: number; offset: number; hasMore: boolean };
      };
    };
    assert.ok(body.channels.length <= 1);
    assert.ok(body.categories.length <= 1);
    assert.equal(body.collectionPagination.channels.limit, 1);
    assert.equal(body.collectionPagination.categories.limit, 1);
    if (body.channels.length) {
      const next = await apiRequest(adminSession, "/admin/overview?channelLimit=1&channelOffset=1&categoryLimit=1");
      assert.equal(next.status, 200);
      assert.notEqual((next.body as typeof body).channels[0]?.id, body.channels[0]?.id);
    }
    for (const [path, extract] of [
      ["/admin/users", (data: unknown) => data as Array<{ id: string | number }>],
      ["/admin/role-assignments", (data: unknown) => data as Array<{ id: string | number }>],
      ["/admin/scope-options", (data: unknown) => (data as { channels: Array<{ id: number }> }).channels],
      ["/admin/custom-roles", (data: unknown) => (data as { roles: Array<{ key: string }> }).roles.map((role) => ({ id: role.key }))],
    ] as const) {
      const first = await apiRequest(adminSession, `${path}?limit=1`);
      const second = await apiRequest(adminSession, `${path}?limit=1&offset=1`);
      assert.equal(first.status, 200, path);
      assert.equal(second.status, 200, path);
      const firstRows = extract(first.body);
      const secondRows = extract(second.body);
      assert.ok(firstRows.length <= 1 && secondRows.length <= 1, path);
      if (firstRows.length && secondRows.length) assert.notEqual(firstRows[0]?.id, secondRows[0]?.id, path);
    }
  });

  test("admin directory pages preserve all users beyond the former 100-row cap", async () => {
    const marker = `page_${randomUUID().replaceAll("-", "")}`;
    try {
      await pool.query(
        `INSERT INTO irc_users (clerk_id, username, display_name, created_at)
         SELECT $1 || '_' || series, $1 || '_' || series, $1, '2024-02-01T00:00:00Z'
         FROM generate_series(1, 101) AS series`,
        [marker],
      );
      const ids = new Set<string>();
      const orderedIds: string[] = [];
      for (let offset = 0; ; offset += 40) {
        const response = await apiRequest(adminSession, `/admin/users?q=${marker}&limit=40&offset=${offset}`);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const rows = response.body as Array<{ id: string }>;
        for (const row of rows) {
          assert.equal(ids.has(row.id), false);
          ids.add(row.id);
          orderedIds.push(row.id);
        }
        if (rows.length < 40) break;
      }
      assert.equal(ids.size, 101);
      const expected = await pool.query<{ clerk_id: string }>(
        "SELECT clerk_id FROM irc_users WHERE display_name = $1 ORDER BY created_at DESC, clerk_id DESC",
        [marker],
      );
      assert.deepEqual(orderedIds, expected.rows.map((row) => row.clerk_id), "equal-timestamp users must use id as a stable tie-breaker");
    } finally {
      await pool.query("DELETE FROM irc_users WHERE username LIKE $1", [`${marker}%`]);
    }
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

  test("requires a verified active subscription, owns multiple public communities, and pauses them on downgrade", async () => {
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
    let renewalId: number | null = null;
    const communityIds: number[] = [];
    try {
      const status = await apiRequest(memberSession, "/community-upgrades/status");
      assert.equal(status.status, 200);
      assert.equal((status.body as { pendingRequest?: { id: number } }).pendingRequest?.id, requestId);
      assert.equal((status.body as { approvedSlots?: number }).approvedSlots, 0);
      assert.equal((await post(memberSession, "/public-communities", { name: "Too early" })).status, 403);
      assert.equal((await post(memberSession, `/admin/community-upgrades/${requestId}/approve`, { paymentReference: "paid-1234" })).status, 403);
      assert.equal((await post(adminSession, `/admin/community-upgrades/${requestId}/approve`, { paymentReference: "" })).status, 400);
      assert.equal((await post(adminSession, `/admin/community-upgrades/${requestId}/approve`, {
        paymentReference: "paid-1234", paidThrough: new Date(Date.now() - 1000).toISOString(),
      })).status, 400);
      const paidThrough = new Date(Date.now() + 30 * 86400_000).toISOString();
      const approved = await post(adminSession, `/admin/community-upgrades/${requestId}/approve`, {
        paymentReference: `test-${randomUUID()}`, paidThrough,
      });
      assert.equal(approved.status, 200, JSON.stringify(approved));
      assert.equal((await post(adminSession, `/admin/community-upgrades/${requestId}/approve`, {
        paymentReference: `test-${randomUUID()}`,
      })).status, 409);
      const attempts = await Promise.all([
        post(memberSession, "/public-communities", { name: "Extra community A" }),
        post(memberSession, "/public-communities", { name: "Extra community B" }),
      ]);
      assert.deepEqual(attempts.map((response) => response.status).sort(), [201, 201]);
      communityIds.push(...attempts.map((response) => (response.body as { id: number }).id));
      assert.equal((attempts[0].body as { ownerId: string; plan: string }).ownerId, memberSession.userId);
      assert.equal((attempts[0].body as { plan: string }).plan, "subscriber_community");
      const after = await apiRequest(memberSession, "/community-upgrades/status");
      assert.equal((after.body as { approvedSlots: number; usedSlots: number }).approvedSlots, 0);
      assert.ok((after.body as { subscriptionEndsAt: string }).subscriptionEndsAt);
      const ownChannel = await pool.query<{ id: number }>("SELECT id FROM irc_channels WHERE community_id = $1 LIMIT 1", [communityIds[0]]);
      const destinations = await apiRequest(memberSession, `/channels/${ownChannel.rows[0].id}/public-spaces`);
      assert.equal(destinations.status, 200);
      assert.ok((destinations.body as Array<{ id: number }>).some((item) => item.id === communityIds[1]));
      assert.equal((await post(adminSession, `/admin/community-upgrades/${requestId}/end`, {})).status, 200);
      assert.equal((await post(memberSession, "/public-communities", { name: "After downgrade" })).status, 403);
      assert.equal((await apiRequest(memberSession, `/channels/${ownChannel.rows[0].id}/public-spaces`)).status, 400);
      assert.equal((await apiRequest(memberSession, `/communities/${communityIds[0]}`)).status, 403);
      assert.equal((await apiRequest(memberSession, `/channels/${ownChannel.rows[0].id}/messages`)).status, 403);
      assert.equal((await apiRequest(memberSession, `/channels/${ownChannel.rows[0].id}/public-space`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ communityId: communityIds[1] }),
      })).status, 403);
      const saved = await pool.query("SELECT id FROM irc_communities WHERE id = ANY($1::int[])", [communityIds]);
      assert.equal(saved.rows.length, 2);
      const renewal = await pool.query<{ id: number }>(
        `INSERT INTO irc_community_upgrade_requests (user_id, email, display_name, status)
         VALUES ($1, 'test@example.invalid', 'Test requester', 'pending') RETURNING id`,
        [memberSession.userId],
      );
      renewalId = renewal.rows[0].id;
      assert.equal((await post(memberSession, `/admin/community-upgrades/${renewalId}/approve`, {
        paymentReference: `test-${randomUUID()}`, paidThrough: new Date(Date.now() + 60 * 86400_000).toISOString(),
      })).status, 403);
      assert.equal((await post(adminSession, `/admin/community-upgrades/${renewalId}/approve`, {
        paymentReference: `test-${randomUUID()}`, paidThrough: new Date(Date.now() + 60 * 86400_000).toISOString(),
      })).status, 200);
      assert.equal((await apiRequest(memberSession, `/channels/${ownChannel.rows[0].id}/public-spaces`)).status, 200);
      await pool.query("UPDATE irc_community_upgrade_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [renewalId]);
      assert.equal((await post(memberSession, "/public-communities", { name: "Expired" })).status, 403);
      assert.equal((await apiRequest(memberSession, `/communities/${communityIds[0]}`)).status, 403);
    } finally {
      for (const communityId of communityIds) {
        await pool.query("DELETE FROM irc_channel_members WHERE channel_id IN (SELECT id FROM irc_channels WHERE community_id = $1)", [communityId]);
        await pool.query("DELETE FROM irc_channels WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_categories WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_user_roles WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_community_members WHERE community_id = $1", [communityId]);
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
      await pool.query("DELETE FROM irc_notifications WHERE entity_type = 'community_upgrade_request' AND entity_id = $1", [String(requestId)]);
      await pool.query("DELETE FROM irc_admin_audit_logs WHERE target_id = $1 AND action = 'approved_community_upgrade'", [String(requestId)]);
      await pool.query("DELETE FROM irc_admin_audit_logs WHERE target_id = $1 AND action = 'ended_community_subscription'", [String(requestId)]);
      if (renewalId !== null) {
        await pool.query("DELETE FROM irc_notifications WHERE entity_type = 'community_upgrade_request' AND entity_id = $1", [String(renewalId)]);
        await pool.query("DELETE FROM irc_admin_audit_logs WHERE target_id = $1 AND action = 'approved_community_upgrade'", [String(renewalId)]);
        await pool.query("DELETE FROM irc_community_upgrade_requests WHERE id = $1", [renewalId]);
      }
      await pool.query("DELETE FROM irc_community_upgrade_requests WHERE id = $1", [requestId]);
    }
  });

  test("reminds once per latest paid term, not legacy slots or superseded terms", async () => {
    const ids: number[] = [];
    const seed = async (status: string, expiresAt: Date | null) => {
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO irc_community_upgrade_requests (user_id, email, display_name, status, expires_at)
         VALUES ($1, 'test@example.invalid', 'Reminder test owner', $2, $3) RETURNING id`,
        [memberSession.userId, status, expiresAt],
      );
      ids.push(inserted.rows[0].id);
      return inserted.rows[0].id;
    };
    const now = new Date();
    try {
      const permanent = await seed("approved", null);
      const ended = await seed("ended", new Date(now.getTime() + 2 * 86400_000));
      const expired = await seed("approved", new Date(now.getTime() - 86400_000));
      const superseded = await seed("approved", new Date(now.getTime() + 2 * 86400_000));
      const latest = await seed("approved", new Date(now.getTime() + 4 * 86400_000));
      assert.equal((await Promise.all([
        sendCommunitySubscriptionReminders(now), sendCommunitySubscriptionReminders(now),
      ])).reduce((sum, count) => sum + count, 0), 1);
      const alerts = await pool.query<{ user_id: string; entity_id: string }>(
        `SELECT user_id, entity_id FROM irc_notifications
         WHERE entity_type = 'community_subscription_reminder' AND entity_id = ANY($1::text[])`,
        [ids.map(String)],
      );
      assert.equal(alerts.rows.length, 2);
      assert.deepEqual(new Set(alerts.rows.map((row) => row.user_id)),
        new Set([memberSession.userId, adminSession.userId]));
      assert.ok(alerts.rows.every((row) => row.entity_id === String(latest)));
      assert.equal(await sendCommunitySubscriptionReminders(now), 0);
      const renewed = await seed("approved", new Date(now.getTime() + 6 * 86400_000));
      assert.equal(await sendCommunitySubscriptionReminders(now), 1);
      const refreshed = await pool.query<{ entity_id: string }>(
        `SELECT entity_id FROM irc_notifications WHERE entity_type = 'community_subscription_reminder'
         AND entity_id = ANY($1::text[])`, [ids.map(String)],
      );
      assert.equal(refreshed.rows.length, 4);
      assert.equal(refreshed.rows.filter((row) => row.entity_id === String(renewed)).length, 2);
      assert.ok(!refreshed.rows.some((row) => [permanent, ended, expired, superseded].includes(Number(row.entity_id))));
    } finally {
      await pool.query(
        "DELETE FROM irc_notifications WHERE entity_type = 'community_subscription_reminder' AND entity_id = ANY($1::text[])",
        [ids.map(String)],
      );
      await pool.query("DELETE FROM irc_community_upgrade_requests WHERE id = ANY($1::int[])", [ids]);
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

  test("denies every release endpoint to the actor's current non-developer role without side effects", async () => {
    const releaseMarker = `denied-${randomUUID().slice(0, 8)}`;
    const before = await pool.query<{ releases: number; audits: number; announcements: number; notifications: number }>(
      `SELECT
         (SELECT count(*)::int FROM irc_developer_releases WHERE version = $1) AS releases,
         (SELECT count(*)::int FROM irc_admin_audit_logs WHERE actor_id = $2 AND action LIKE '%release%') AS audits,
         (SELECT count(*)::int FROM irc_server_announcements WHERE author_id = $2) AS announcements,
         (SELECT count(*)::int FROM irc_notifications WHERE user_id = $2) AS notifications`,
      [releaseMarker, memberSession.userId],
    );
    const requests: Array<[string, RequestInit]> = [
      ["/developer/releases", {}],
      ["/developer/releases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: releaseMarker, title: "Must not be created" }),
      }],
      ["/developer/releases/2147483647/status", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "review" }),
      }],
      ["/developer/releases/2147483647/announcement", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "published" }),
      }],
    ];

    for (const [path, init] of requests) {
      const denied = await apiRequest(memberSession, path, init);
      assert.equal(denied.status, 403, JSON.stringify(denied));
      assert.deepEqual(denied.body, { error: "Developer access required." });
    }
    const after = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM irc_developer_releases WHERE version = $1) AS releases,
         (SELECT count(*)::int FROM irc_admin_audit_logs WHERE actor_id = $2 AND action LIKE '%release%') AS audits,
         (SELECT count(*)::int FROM irc_server_announcements WHERE author_id = $2) AS announcements,
         (SELECT count(*)::int FROM irc_notifications WHERE user_id = $2) AS notifications`,
      [releaseMarker, memberSession.userId],
    );
    assert.deepEqual(after.rows, before.rows);
  });

  test("keeps release announcements hidden until approved and notifies each account once", async () => {
    const version = `test-${randomUUID().slice(0, 8)}`;
    const title = `Approval-gated release ${randomUUID().slice(0, 8)}`;
    const notes = `Approved release notes ${randomUUID()}`;
    let releaseId: number | null = null;
    let announcementId: number | null = null;
    const jsonHeaders = { "content-type": "application/json" };
    const setReleaseStatus = (status: string) => apiRequest(
      adminSession,
      `/developer/releases/${releaseId}/status`,
      { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ status }) },
    );
    const publishAnnouncement = () => apiRequest(
      adminSession,
      `/developer/releases/${releaseId}/announcement`,
      { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ status: "published" }) },
    );

    try {
      const created = await apiRequest(adminSession, "/developer/releases", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ version, title, notes }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      releaseId = (created.body as { id: number }).id;

      const invalidReleaseTransition = await setReleaseStatus("published");
      assert.equal(invalidReleaseTransition.status, 400);
      assert.deepEqual(invalidReleaseTransition.body, {
        error: "A draft release cannot move to published.",
      });
      const prematureAnnouncement = await publishAnnouncement();
      assert.equal(prematureAnnouncement.status, 400);
      assert.deepEqual(prematureAnnouncement.body, {
        error: "Publish the release before publishing its announcement.",
      });

      const review = await setReleaseStatus("review");
      assert.equal(review.status, 200, JSON.stringify(review));
      const publishedRelease = await setReleaseStatus("published");
      assert.equal(publishedRelease.status, 200, JSON.stringify(publishedRelease));
      announcementId = (publishedRelease.body as { announcementId: number }).announcementId;
      assert.equal(typeof announcementId, "number");

      const linkedRows = await pool.query<{
        status: string;
        announcement_id: number;
        announcement_status: string;
        community_id: number | null;
      }>(
        `SELECT r.status, r.announcement_id, a.status AS announcement_status, a.community_id
         FROM irc_developer_releases r
         JOIN irc_server_announcements a ON a.id = r.announcement_id
         WHERE r.id = $1`,
        [releaseId],
      );
      assert.deepEqual(linkedRows.rows, [{
        status: "published",
        announcement_id: announcementId,
        announcement_status: "draft",
        community_id: null,
      }]);
      const matchingDrafts = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM irc_server_announcements
         WHERE id = $1 AND status = 'draft' AND community_id IS NULL`,
        [announcementId],
      );
      assert.deepEqual(matchingDrafts.rows, [{ count: 1 }]);

      const feedBeforeApproval = await apiRequest(memberSession, "/announcements");
      assert.equal(feedBeforeApproval.status, 200, JSON.stringify(feedBeforeApproval));
      assert.ok(Array.isArray(feedBeforeApproval.body));
      assert.equal(
        (feedBeforeApproval.body as Array<{ id?: unknown }>).some((item) => item.id === announcementId),
        false,
      );

      const approved = await publishAnnouncement();
      assert.equal(approved.status, 200, JSON.stringify(approved));
      assert.equal(
        (approved.body as { announcement?: { id?: unknown; status?: unknown } }).announcement?.status,
        "published",
      );

      const feedAfterApproval = await apiRequest(memberSession, "/announcements");
      assert.equal(feedAfterApproval.status, 200, JSON.stringify(feedAfterApproval));
      assert.ok(Array.isArray(feedAfterApproval.body));
      assert.ok(
        (feedAfterApproval.body as Array<{ body?: unknown }>).some((item) => item.body === notes),
        "published global release announcement should appear in a regular user's feed",
      );

      const accountRows = await pool.query<{ clerk_id: string }>(
        "SELECT clerk_id FROM irc_users ORDER BY clerk_id",
      );
      const notificationRows = await pool.query<{ user_id: string; count: number }>(
        `SELECT user_id, count(*)::int AS count
         FROM irc_notifications
         WHERE type = 'server_announcement'
           AND entity_type = 'server_announcement'
           AND entity_id = $1
         GROUP BY user_id
         ORDER BY user_id`,
        [String(announcementId)],
      );
      assert.deepEqual(
        notificationRows.rows.map(({ user_id }) => user_id),
        accountRows.rows.map(({ clerk_id }) => clerk_id),
      );
      assert.ok(notificationRows.rows.every(({ count }) => count === 1));

      const auditRows = await pool.query<{
        actor_id: string;
        action: string;
        target_id: string;
        target_label: string;
        details: string;
      }>(
        `SELECT actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE action = 'published_release_announcement' AND target_id = $1`,
        [String(announcementId)],
      );
      assert.deepEqual(auditRows.rows, [{
        actor_id: adminSession.userId,
        action: "published_release_announcement",
        target_id: String(announcementId),
        target_label: "release announcement",
        details: `${version} · ${title}`,
      }]);

      const duplicateAnnouncementPublish = await publishAnnouncement();
      assert.equal(duplicateAnnouncementPublish.status, 409);
      assert.deepEqual(duplicateAnnouncementPublish.body, {
        error: "A published release announcement cannot be published.",
      });
      const duplicateReleasePublish = await setReleaseStatus("published");
      assert.equal(duplicateReleasePublish.status, 400);
      assert.deepEqual(duplicateReleasePublish.body, {
        error: "A published release cannot move to published.",
      });

      const finalAnnouncementCount = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM irc_server_announcements WHERE id = $1",
        [announcementId],
      );
      assert.deepEqual(finalAnnouncementCount.rows, [{ count: 1 }]);
      const finalNotificationCount = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM irc_notifications
         WHERE type = 'server_announcement' AND entity_id = $1`,
        [String(announcementId)],
      );
      assert.deepEqual(finalNotificationCount.rows, [{ count: accountRows.rows.length }]);
      assert.equal(
        (await pool.query(
          `SELECT count(*)::int AS count FROM irc_admin_audit_logs
           WHERE action = 'published_release_announcement' AND target_id = $1`,
          [String(announcementId)],
        )).rows[0]?.count,
        1,
      );
    } finally {
      if (announcementId !== null) {
        await pool.query(
          "DELETE FROM irc_notifications WHERE entity_type = 'server_announcement' AND entity_id = $1",
          [String(announcementId)],
        );
        await pool.query(
          "DELETE FROM irc_admin_audit_logs WHERE target_id = $1",
          [String(announcementId)],
        );
      }
      if (releaseId !== null) {
        await pool.query(
          "DELETE FROM irc_admin_audit_logs WHERE target_id = $1",
          [String(releaseId)],
        );
        await pool.query("DELETE FROM irc_developer_releases WHERE id = $1", [releaseId]);
      }
      if (announcementId !== null) {
        await pool.query("DELETE FROM irc_server_announcements WHERE id = $1", [announcementId]);
      }
    }
  });

  test("repairs a published release whose announcement was deleted without bypassing approval", async () => {
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

      const listedAfterCreate = await apiRequest(adminSession, "/developer/releases");
      assert.equal(listedAfterCreate.status, 200, JSON.stringify(listedAfterCreate));
      assert.ok(Array.isArray(listedAfterCreate.body));
      assert.ok(listedAfterCreate.body.some(
        (release) =>
          typeof release === "object" &&
          release !== null &&
          (release as { id?: unknown }).id === releaseId,
      ));

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

      const repairedDraft = await apiRequest(
        adminSession,
        `/developer/releases/${releaseId}/announcement`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "published" }),
        },
      );
      assert.equal(repairedDraft.status, 409, JSON.stringify(repairedDraft));
      assert.ok(repairedDraft.body && typeof repairedDraft.body === "object");
      assert.equal(
        (repairedDraft.body as { error?: unknown }).error,
        "The linked announcement draft was missing. A replacement draft was created and must be published separately.",
      );
      const restoredBody = repairedDraft.body as {
        release?: { id?: unknown; status?: unknown; announcementId?: unknown };
        announcement?: { id?: unknown; status?: unknown; title?: unknown; body?: unknown };
      };
      assert.equal(restoredBody.release?.id, releaseId);
      assert.equal(restoredBody.release?.status, "published");
      replacementAnnouncementId = restoredBody.announcement?.id as number;
      assert.equal(typeof replacementAnnouncementId, "number");
      assert.notEqual(replacementAnnouncementId, draftAnnouncementId);
      assert.equal(restoredBody.announcement?.status, "draft");
      assert.equal(restoredBody.release?.announcementId, replacementAnnouncementId);

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
      const repairedBody = repaired.body as {
        release?: { id?: unknown; status?: unknown; announcementId?: unknown };
        announcement?: { id?: unknown; status?: unknown; title?: unknown; body?: unknown };
      };
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

  test("filters activity by inclusive date range together with actor, action, and pagination", async () => {
    const marker = `audit_date_${randomUUID().replaceAll("-", "")}`;
    const fixtures = [
      { actor: `${marker} Alpha`, action: `${marker}_change`, createdAt: "2026-03-31T23:59:59.999Z" },
      { actor: `${marker} Alpha`, action: `${marker}_change`, createdAt: "2026-04-01T00:00:00.000Z" },
      { actor: `${marker} Alpha`, action: `${marker}_change`, createdAt: "2026-04-02T23:59:59.999Z" },
      { actor: `${marker} Beta`, action: `${marker}_change`, createdAt: "2026-04-02T12:00:00.000Z" },
      { actor: `${marker} Alpha`, action: `${marker}_other`, createdAt: "2026-04-02T13:00:00.000Z" },
      { actor: `${marker} Alpha`, action: `${marker}_change`, createdAt: "2026-04-03T00:00:00.000Z" },
    ];
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (const fixture of fixtures) {
      const offset = parameters.length;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`);
      parameters.push(
        adminSession.userId,
        fixture.actor,
        fixture.action,
        `${marker}_target`,
        `${marker} target`,
        fixture.createdAt,
      );
    }

    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO irc_admin_audit_logs
       (actor_id, actor_display_name, action, target_id, target_label, created_at)
       VALUES ${values.join(", ")}
       RETURNING id`,
      parameters,
    );
    const fixtureIds = inserted.rows.map((row) => row.id);
    const query = `/admin/overview?activityLimit=1&activityActor=${encodeURIComponent(`${marker} alpha`)}&activityAction=${encodeURIComponent(`${marker}_change`)}&activityStartDate=2026-04-01&activityEndDate=2026-04-02`;

    try {
      const firstPageResponse = await apiRequest(adminSession, `${query}&activityOffset=0`);
      assert.equal(firstPageResponse.status, 200, JSON.stringify(firstPageResponse));
      const firstPage = firstPageResponse.body as {
        activity: Array<{ id: number; actor: string; action: string }>;
        activityPagination: { hasMore: boolean; nextOffset: number | null };
      };
      assert.deepEqual(firstPage.activity.map((entry) => entry.id), [fixtureIds[2]]);
      assert.equal(firstPage.activityPagination.hasMore, true);
      assert.equal(firstPage.activityPagination.nextOffset, 1);

      const secondPageResponse = await apiRequest(adminSession, `${query}&activityOffset=1`);
      assert.equal(secondPageResponse.status, 200, JSON.stringify(secondPageResponse));
      const secondPage = secondPageResponse.body as {
        activity: Array<{ id: number; actor: string; action: string }>;
        activityPagination: { hasMore: boolean; nextOffset: number | null };
      };
      assert.deepEqual(secondPage.activity.map((entry) => entry.id), [fixtureIds[1]]);
      assert.equal(secondPage.activityPagination.hasMore, false);
      assert.equal(secondPage.activityPagination.nextOffset, null);
      assert.ok([...firstPage.activity, ...secondPage.activity].every(
        (entry) => entry.actor === `${marker} Alpha` && entry.action === `${marker}_change`,
      ));

      for (const invalidPath of [
        "/admin/overview?activityStartDate=2026-02-30",
        "/admin/overview?activityStartDate=2026-04-03&activityEndDate=2026-04-01",
        "/admin/overview?activityStartDate=2026-04-01&activityStartDate=2026-04-02",
      ]) {
        const invalidResponse = await apiRequest(adminSession, invalidPath);
        assert.equal(invalidResponse.status, 400, JSON.stringify(invalidResponse));
      }
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

  test("loads newer activity in filtered cursor batches while keeping older pages separate", async () => {
    const marker = `activity_newer_${randomUUID().replaceAll("-", "")}`;
    const actor = `${marker} Manager`;
    const action = `${marker}_changed`;
    const entries = [
      ...Array.from({ length: 6 }, (_, index) => ({
        actor,
        action,
        createdAt: new Date(Date.UTC(2099, 0, 1, 0, 0, index)),
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        actor,
        action,
        createdAt: new Date(Date.UTC(2099, 0, 1, 0, 0, 10 + index)),
      })),
      {
        actor: `${marker} Other`,
        action,
        createdAt: new Date(Date.UTC(2099, 0, 1, 0, 0, 13)),
      },
      {
        actor,
        action: `${marker}_different`,
        createdAt: new Date(Date.UTC(2099, 0, 1, 0, 0, 14)),
      },
    ];
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (const [index, entry] of entries.entries()) {
      const parameterOffset = parameters.length;
      values.push(
        `($${parameterOffset + 1}, $${parameterOffset + 2}, $${parameterOffset + 3}, $${parameterOffset + 4}, $${parameterOffset + 5}, $${parameterOffset + 6}, $${parameterOffset + 7})`,
      );
      parameters.push(
        adminSession.userId,
        entry.actor,
        entry.action,
        `${marker}_target_${index}`,
        `${marker} label ${index}`,
        `Event ${index}`,
        entry.createdAt,
      );
    }

    await pool.query(
      `INSERT INTO irc_admin_audit_logs
       (actor_id, actor_display_name, action, target_id, target_label, details, created_at)
       VALUES ${values.join(", ")}`,
      parameters,
    );

    try {
      const filters = `activityActor=${encodeURIComponent(`${marker} Manager`)}&activityAction=${encodeURIComponent(action)}`;
      const firstResponse = await apiRequest(
        adminSession,
        `/admin/overview?activityLimit=3&${filters}`,
      );
      assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse));
      const firstPage = firstResponse.body as {
        activity: Array<{ id: number; action: string; actor: string; createdAt: string }>;
        activityPagination: {
          hasMore: boolean;
          nextCursor: string | null;
          newestCursor: string | null;
        };
      };
      assert.deepEqual(firstPage.activity.map((entry) => entry.action), [action, action, action]);
      assert.equal(firstPage.activity[0]?.createdAt, new Date(Date.UTC(2099, 0, 1, 0, 0, 5)).toISOString());
      assert.ok(firstPage.activityPagination.hasMore);
      assert.ok(firstPage.activityPagination.nextCursor);
      assert.ok(firstPage.activityPagination.newestCursor);

      const olderResponse = await apiRequest(
        adminSession,
        `/admin/overview?activityLimit=3&${filters}&activityCursor=${encodeURIComponent(firstPage.activityPagination.nextCursor)}`,
      );
      assert.equal(olderResponse.status, 200, JSON.stringify(olderResponse));
      const olderPage = olderResponse.body as typeof firstPage;
      assert.equal(olderPage.activity.length, 3);
      assert.equal(olderPage.activityPagination.hasMore, false);

      const newerResponse = await apiRequest(
        adminSession,
        `/admin/overview?activityLimit=2&${filters}&activityAfterCursor=${encodeURIComponent(firstPage.activityPagination.newestCursor)}`,
      );
      assert.equal(newerResponse.status, 200, JSON.stringify(newerResponse));
      const newerPage = newerResponse.body as typeof firstPage & {
        activityPagination: typeof firstPage.activityPagination & { newerHasMore: boolean };
      };
      assert.equal(newerPage.activity.length, 2);
      assert.deepEqual(
        newerPage.activity.map((entry) => entry.createdAt),
        [
          new Date(Date.UTC(2099, 0, 1, 0, 0, 11)).toISOString(),
          new Date(Date.UTC(2099, 0, 1, 0, 0, 10)).toISOString(),
        ],
      );
      assert.ok(newerPage.activity.every((entry) => entry.actor === actor && entry.action === action));
      assert.equal(newerPage.activityPagination.hasMore, false);
      assert.equal(newerPage.activityPagination.newerHasMore, true);
      assert.ok(newerPage.activityPagination.newestCursor);

      const newestResponse = await apiRequest(
        adminSession,
        `/admin/overview?activityLimit=2&${filters}&activityAfterCursor=${encodeURIComponent(newerPage.activityPagination.newestCursor!)}`,
      );
      assert.equal(newestResponse.status, 200, JSON.stringify(newestResponse));
      const newestPage = newestResponse.body as typeof newerPage;
      assert.equal(newestPage.activity.length, 1);
      assert.equal(newestPage.activity[0]?.createdAt, new Date(Date.UTC(2099, 0, 1, 0, 0, 12)).toISOString());
      assert.equal(newestPage.activityPagination.newerHasMore, false);

      const allLoaded = [
        ...newestPage.activity,
        ...newerPage.activity,
        ...firstPage.activity,
        ...olderPage.activity,
      ];
      assert.equal(new Set(allLoaded.map((entry) => entry.id)).size, allLoaded.length);
      assert.equal(allLoaded.length, 9);

      const conflictingCursors = await apiRequest(
        adminSession,
        `/admin/overview?activityCursor=${encodeURIComponent(firstPage.activityPagination.nextCursor!)}&activityAfterCursor=${encodeURIComponent(firstPage.activityPagination.newestCursor!)}`,
      );
      assert.equal(conflictingCursors.status, 400, JSON.stringify(conflictingCursors));
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

  test("preserves audit and moderation actor identities after account cleanup", async () => {
    const actorId = `moderation_actor_${randomUUID()}`;
    const username = `moderation_actor_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const displayName = "Former Moderator";
    let auditId: number | undefined;
    let moderationId: number | undefined;
    try {
      await pool.query(
        `INSERT INTO irc_users (clerk_id, username, display_name)
         VALUES ($1, $2, $3)`,
        [actorId, username, displayName],
      );
      const inserted = await pool.query<{ id: number; created_at: Date }>(
        `INSERT INTO irc_admin_audit_logs
           (actor_id, actor_display_name, action, target_id, target_label, details)
         VALUES ($1, $2, 'audit_actor_deleted', 'preserved-target', 'Preserved target', 'Preserved details')
         RETURNING id, created_at`,
        [actorId, displayName],
      );
      auditId = inserted.rows[0]?.id;
      assert.ok(auditId);

      const insertedModeration = await pool.query<{ id: number }>(
        `INSERT INTO irc_moderation_actions (actor_id, action, details)
         VALUES ($1, 'moderation_actor_deleted', 'Preserved moderation details')
         RETURNING id`,
        [actorId],
      );
      moderationId = insertedModeration.rows[0]?.id;
      assert.ok(moderationId);

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

      const preservedModeration = await pool.query(
        `SELECT actor_id, action, details
         FROM irc_moderation_actions
         WHERE id = $1`,
        [moderationId],
      );
      assert.deepEqual(preservedModeration.rows, [{
        actor_id: actorId,
        action: "moderation_actor_deleted",
        details: "Preserved moderation details",
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
        id: auditId,
        actorId,
        actor: displayName,
        action: "audit_actor_deleted",
        targetId: "preserved-target",
        targetLabel: "Preserved target",
        details: "Preserved details",
        createdAt: inserted.rows[0].created_at.toISOString(),
      });
    } finally {
      if (auditId !== undefined) {
        await pool.query("DELETE FROM irc_admin_audit_logs WHERE id = $1", [auditId]);
      }
      if (moderationId !== undefined) {
        await pool.query("DELETE FROM irc_moderation_actions WHERE id = $1", [moderationId]);
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

  test("accepts, declines, and revokes workspace invitations with onboarding audit events", async () => {
    const recipient = await createTestSession("workspace_invitation_flow", "verified");
    const workspaceIds: number[] = [];
    try {
      await apiRequest(recipient, "/me");
      const recipientUser = await clerkClient.users.getUser(recipient.userId);
      const recipientEmail = recipientUser.emailAddresses.find((address) => address.verification?.status === "verified")?.emailAddress;
      assert.ok(recipientEmail);

      const workspace = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ('Invitation Flow Workspace', $1, $2, 'paid_workspace', true)
         RETURNING id`,
        [`invitation-flow-${randomUUID()}`, adminSession.userId],
      );
      const communityId = workspace.rows[0]?.id;
      assert.ok(communityId);
      workspaceIds.push(communityId);
      const department = await pool.query<{ id: number }>(
        "INSERT INTO irc_departments (community_id, name) VALUES ($1, 'Operations') RETURNING id",
        [communityId],
      );
      const location = await pool.query<{ id: number }>(
        "INSERT INTO irc_locations (community_id, name) VALUES ($1, 'Main office') RETURNING id",
        [communityId],
      );
      const team = await pool.query<{ id: number }>(
        `INSERT INTO irc_teams (community_id, department_id, location_id, name)
         VALUES ($1, $2, $3, 'Field team') RETURNING id`,
        [communityId, department.rows[0]?.id, location.rows[0]?.id],
      );
      const departmentId = department.rows[0]?.id;
      const locationId = location.rows[0]?.id;
      const teamId = team.rows[0]?.id;
      assert.ok(departmentId && locationId && teamId);

      const createInvitation = async () => {
        const response = await apiRequest(adminSession, `/communities/${communityId}/invitations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: recipientEmail, role: "employee" }),
        });
        assert.equal(response.status, 201, JSON.stringify(response));
        return response.body as { id: number; invitationToken: string };
      };
      const created = await apiRequest(adminSession, `/communities/${communityId}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: recipientEmail,
          role: "employee",
          departmentId,
          locationId,
          teamId,
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      const invitation = created.body as { id: number; invitationToken: string };
      const accepted = await apiRequest(recipient, `/communities/${communityId}/invitations/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: invitation.invitationToken }),
      });
      assert.equal(accepted.status, 200, JSON.stringify(accepted));
      const [membership, profile, teamMembership, assignedRole, acceptedAudit] = await Promise.all([
        pool.query("SELECT 1 FROM irc_community_members WHERE community_id = $1 AND user_id = $2", [communityId, recipient.userId]),
        pool.query(
          `SELECT employment_status, department_id, location_id, invited_at, onboarding_started_at
           FROM irc_employee_profiles WHERE community_id = $1 AND user_id = $2`,
          [communityId, recipient.userId],
        ),
        pool.query("SELECT 1 FROM irc_team_members WHERE team_id = $1 AND user_id = $2", [teamId, recipient.userId]),
        pool.query(
          "SELECT role FROM irc_user_roles WHERE user_id = $1 AND scope_type = 'community' AND community_id = $2",
          [recipient.userId, communityId],
        ),
        pool.query(
          "SELECT action FROM irc_admin_audit_logs WHERE community_id = $1 AND actor_id = $2",
          [communityId, recipient.userId],
        ),
      ]);
      assert.equal(membership.rowCount, 1);
      const employeeProfile = profile.rows[0] as {
        employment_status: string;
        department_id: number;
        location_id: number;
        invited_at: Date | null;
        onboarding_started_at: Date | null;
      };
      assert.equal(employeeProfile.employment_status, "onboarding");
      assert.equal(employeeProfile.department_id, departmentId);
      assert.equal(employeeProfile.location_id, locationId);
      assert.ok(employeeProfile.invited_at instanceof Date);
      assert.ok(employeeProfile.onboarding_started_at instanceof Date);
      assert.equal(teamMembership.rowCount, 1);
      assert.ok(assignedRole.rows.some((row) => row.role === "employee"));
      assert.ok(acceptedAudit.rows.some((row) => row.action === "accepted_workspace_invitation"));
      assert.ok(acceptedAudit.rows.some((row) => row.action === "started_employee_onboarding"));

      const toDecline = await createInvitation();
      const declined = await apiRequest(recipient, `/communities/${communityId}/invitations/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: toDecline.invitationToken }),
      });
      assert.equal(declined.status, 200, JSON.stringify(declined));

      const toRevoke = await createInvitation();
      const revoke = await apiRequest(adminSession, `/communities/${communityId}/invitations/${toRevoke.id}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(revoke.status, 200, JSON.stringify(revoke));
      const revokedAcceptance = await apiRequest(recipient, `/communities/${communityId}/invitations/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: toRevoke.invitationToken }),
      });
      assert.equal(revokedAcceptance.status, 409, JSON.stringify(revokedAcceptance));

      const toExpire = await createInvitation();
      await pool.query("UPDATE irc_workspace_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [toExpire.id]);
      const expiredAcceptance = await apiRequest(recipient, `/communities/${communityId}/invitations/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: toExpire.invitationToken }),
      });
      assert.equal(expiredAcceptance.status, 410, JSON.stringify(expiredAcceptance));

      const invitationStatuses = await pool.query<{ id: number; status: string }>(
        "SELECT id, status FROM irc_workspace_invitations WHERE id = ANY($1::int[]) ORDER BY id",
        [[invitation.id, toDecline.id, toRevoke.id, toExpire.id]],
      );
      assert.deepEqual(invitationStatuses.rows.map((row) => row.status), ["accepted", "declined", "revoked", "expired"]);
    } finally {
      if (workspaceIds.length) {
        await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [workspaceIds]);
      }
    }
  });

  test("returns 404 without writing audit activity for unknown channel maintenance targets", async () => {
    const unknownChannelId = 2147483647;
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
               AND action IN ('updated_channel_topic', 'cleared_channel_history')
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

  test("broadcasts admin topic edits only to subscribers of that channel", async () => {
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      const createdChannels = await Promise.all([
        apiRequest(adminSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `live-topic-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            topic: "Original target topic",
          }),
        }),
        apiRequest(adminSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `live-other-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            topic: "Unrelated channel topic",
          }),
        }),
      ]);
      for (const created of createdChannels) {
        assert.equal(created.status, 201, JSON.stringify(created));
        assert.ok(created.body && typeof created.body === "object");
        const channelId = (created.body as { id?: unknown }).id;
        assert.equal(typeof channelId, "number");
        channelIds.push(channelId as number);
      }
      const [targetChannelId, unrelatedChannelId] = channelIds;

      const [targetSocket, unrelatedSocket] = await Promise.all([
        openWebSocket(adminSession),
        openWebSocket(adminSession),
      ]);
      sockets.push(targetSocket, unrelatedSocket);
      targetSocket.send(JSON.stringify({ type: "subscribe", channelId: targetChannelId }));
      unrelatedSocket.send(JSON.stringify({ type: "subscribe", channelId: unrelatedChannelId }));
      await Promise.all([
        waitForChannelSubscription(targetSocket, targetChannelId),
        waitForChannelSubscription(unrelatedSocket, unrelatedChannelId),
      ]);

      const liveTopicUpdate = waitForWebSocketEvent(
        targetSocket,
        (event) => {
          if (event.type !== "channel" || !event.channel || typeof event.channel !== "object") {
            return false;
          }
          const channel = event.channel as { id?: unknown };
          return channel.id === targetChannelId;
        },
      );
      const blockedUnrelatedUpdate = expectNoWebSocketEvent(
        unrelatedSocket,
        (event) => {
          if (event.type !== "channel" || !event.channel || typeof event.channel !== "object") {
            return false;
          }
          const channel = event.channel as { id?: unknown };
          return channel.id === targetChannelId;
        },
      );

      const topicUpdate = await apiRequest(
        adminSession,
        `/admin/channels/${targetChannelId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: "Admin updated live topic" }),
        },
      );
      assert.equal(topicUpdate.status, 200, JSON.stringify(topicUpdate));

      const event = await liveTopicUpdate;
      assert.ok(event.channel && typeof event.channel === "object");
      const updatedChannel = event.channel as { id?: unknown; topic?: unknown };
      assert.equal(updatedChannel.id, targetChannelId);
      assert.equal(updatedChannel.topic, "Admin updated live topic");
      await blockedUnrelatedUpdate;
      assert.equal(targetSocket.readyState, WebSocket.OPEN);
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [adminSession.userId]);
    }
  });

  test("uses the same missing-channel response across public and admin routes", async () => {
    const unknownChannelId = 2147483647;
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

  for (const operation of [
    {
      name: "change a user's role",
      path: () => `/admin/users/${adminSession.userId}/role`,
      method: "PATCH",
      body: () => ({ role: "member" }),
    },
    {
      name: "assign a scoped role",
      path: () => "/admin/role-assignments",
      method: "POST",
      body: () => ({
        userId: memberSession.userId,
        role: "platform_moderator",
        scopeType: "platform",
      }),
    },
    {
      name: "create a custom role",
      path: () => "/admin/custom-roles",
      method: "POST",
      body: () => ({
        label: "Unauthorized role",
        scopeType: "community",
        permissions: ["manage_community_members"],
      }),
    },
  ]) {
    test(`a non-admin cannot ${operation.name} or alter audit history`, async () => {
      const beforeAudit = await pool.query(
        "SELECT * FROM irc_admin_audit_logs ORDER BY id",
      );

      const response = await apiRequest(memberSession, operation.path(), {
        method: operation.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(operation.body()),
      });

      assert.equal(response.status, 403, JSON.stringify(response));
      assert.deepEqual(response.body, { error: "Admin access required." });
      const afterAudit = await pool.query(
        "SELECT * FROM irc_admin_audit_logs ORDER BY id",
      );
      assert.deepEqual(afterAudit.rows, beforeAudit.rows);
    });
  }

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

  test("records every committed concurrent demotion but not a rolled-back one", async () => {
    const [firstTarget, secondTarget, failedTarget] = await Promise.all([
      createTestSession("concurrent_demotion_first"),
      createTestSession("concurrent_demotion_second"),
      createTestSession("concurrent_demotion_rollback"),
    ]);
    const targets = [firstTarget, secondTarget, failedTarget];
    const targetIds = targets.map(({ userId }) => userId);
    const triggerName = `fail_demotion_audit_${randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;

    try {
      const profiles = await Promise.all(targets.map((target) => apiRequest(target, "/me")));
      for (const profile of profiles) {
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }
      await pool.query(
        "UPDATE irc_users SET role = 'moderator' WHERE clerk_id = ANY($1::text[])",
        [targetIds],
      );
      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action = 'demoted_user'
              AND NEW.target_id = '${failedTarget.userId}' THEN
             RAISE EXCEPTION 'forced concurrent demotion audit failure';
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

      const responses = await Promise.all(targets.map((target) =>
        apiRequest(adminSession, `/admin/users/${target.userId}/role`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "member" }),
        }),
      ));
      for (const [index, target] of targets.entries()) {
        const response = responses[index];
        assert.ok(response);
        assert.equal(response.status, index === 2 ? 500 : 200, JSON.stringify(response));
        assert.deepEqual(response.body, index === 2
          ? { error: "An unexpected error occurred while processing the admin request." }
          : { id: target.userId, role: "member" });
      }

      const roles = await pool.query<{ clerk_id: string; role: string }>(
        "SELECT clerk_id, role FROM irc_users WHERE clerk_id = ANY($1::text[])",
        [[...targetIds, adminSession.userId]],
      );
      assert.deepEqual(
        new Map(roles.rows.map(({ clerk_id, role }) => [clerk_id, role])),
        new Map([
          [firstTarget.userId, "member"],
          [secondTarget.userId, "member"],
          [failedTarget.userId, "moderator"],
          [adminSession.userId, "admin"],
        ]),
      );
      const audit = await pool.query(
        `SELECT actor_id, action, target_id, target_label, details
         FROM irc_admin_audit_logs
         WHERE target_id = ANY($1::text[])
           AND action IN ('demoted_user', 'promoted_user')
         ORDER BY target_id, id`,
        [targetIds],
      );
      assert.deepEqual(audit.rows, [firstTarget, secondTarget]
        .sort((a, b) => a.userId.localeCompare(b.userId))
        .map((target) => ({
          actor_id: adminSession.userId,
          action: "demoted_user",
          target_id: target.userId,
          target_label: target.userId,
          details: "Role changed to member",
        })));
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON irc_admin_audit_logs;
         DROP FUNCTION IF EXISTS "${functionName}"();`,
      );
      await pool.query(
        "UPDATE irc_users SET role = 'member' WHERE clerk_id = ANY($1::text[])",
        [targetIds],
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

  test("keeps private workspace lists and management flags consistent with individual permissions", async () => {
    const ownerSession = await createTestSession("visibility_owner");
    const scopedAdminSession = await createTestSession("visibility_scoped_admin");
    const memberSession = await createTestSession("visibility_member");
    const customViewSession = await createTestSession("visibility_custom_view");
    const customManagerSession = await createTestSession("visibility_custom_manager");
    const roleSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const customViewRole = `visibility_view_${roleSuffix}`;
    const customManageRole = `visibility_manage_${roleSuffix}`;
    const communityIds: number[] = [];
    const workspaceIds = new Map<string, number>();

    try {
      for (const session of [
        ownerSession,
        scopedAdminSession,
        memberSession,
        customViewSession,
        customManagerSession,
      ]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }
      const catalog = await apiRequest(adminSession, "/permissions/catalog");
      assert.equal(catalog.status, 200, JSON.stringify(catalog));

      const workspaceOwners = new Map<string, string>([
        ["owner", ownerSession.userId],
        ["owner_foreign", adminSession.userId],
        ["scoped_admin", adminSession.userId],
        ["scoped_admin_foreign", adminSession.userId],
        ["member_joined", adminSession.userId],
        ["member_unjoined", adminSession.userId],
        ["custom_view", adminSession.userId],
        ["custom_manage", adminSession.userId],
      ]);
      for (const [key, ownerId] of workspaceOwners) {
        const suffix = `${roleSuffix}-${key}`;
        const created = await pool.query<{ id: number }>(
          `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
           VALUES ($1, $2, $3, 'paid_workspace', true)
           RETURNING id`,
          [`Visibility ${suffix}`, `visibility-${suffix}`, ownerId],
        );
        const communityId = created.rows[0]?.id;
        assert.ok(communityId);
        communityIds.push(communityId);
        workspaceIds.set(key, communityId);
      }

      await pool.query(
        `INSERT INTO irc_custom_roles (key, label, scope_type, created_by)
         VALUES
           ($1, 'Can view a private workspace', 'community', $3),
           ($2, 'Can manage a private workspace', 'community', $3)`,
        [customViewRole, customManageRole, adminSession.userId],
      );
      for (const [role, permission] of [
        [customViewRole, "view_business"],
        [customManageRole, "manage_community"],
      ] as const) {
        const permissionResult = await pool.query(
          `INSERT INTO irc_role_permissions (role, permission_id)
           SELECT $1, id FROM irc_permission_definitions WHERE key = $2`,
          [role, permission],
        );
        assert.equal(permissionResult.rowCount, 1, `Expected ${permission} to exist in the permission catalog.`);
      }

      await pool.query(
        `INSERT INTO irc_user_roles (user_id, role, scope_type, community_id, granted_by)
         VALUES
           ($1, 'workspace_owner', 'community', $6, $7),
           ($2, 'workspace_admin', 'community', $8, $7),
           ($3, $4, 'community', $9, $7),
           ($5, $10, 'community', $11, $7)`,
        [
          ownerSession.userId,
          scopedAdminSession.userId,
          customViewSession.userId,
          customViewRole,
          customManagerSession.userId,
          workspaceIds.get("owner"),
          adminSession.userId,
          workspaceIds.get("scoped_admin"),
          workspaceIds.get("custom_view"),
          customManageRole,
          workspaceIds.get("custom_manage"),
        ],
      );
      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'member')`,
        [workspaceIds.get("member_joined"), memberSession.userId],
      );

      const assertListMatchesIndividualPermissions = async (
        session: TestSession,
        expectedWorkspaceKeys?: string[],
      ): Promise<void> => {
        const listed = await apiRequest(session, "/communities");
        assert.equal(listed.status, 200, JSON.stringify(listed));
        assert.ok(Array.isArray(listed.body));

        const allWorkspaces = await pool.query<{ id: number; is_private: boolean }>(
          `SELECT id, is_private FROM irc_communities
           WHERE plan = 'paid_workspace' ORDER BY id`,
        );
        const memberships = await pool.query<{ community_id: number }>(
          "SELECT community_id FROM irc_community_members WHERE user_id = $1",
          [session.userId],
        );
        const joinedIds = new Set(memberships.rows.map(({ community_id }) => community_id));
        const expected = [];
        for (const workspace of allWorkspaces.rows) {
          const [canView, canManage] = await Promise.all([
            hasPermission(session.userId, "view_business", { communityId: workspace.id }),
            hasPermission(session.userId, "manage_community", { communityId: workspace.id }),
          ]);
          const joined = joinedIds.has(workspace.id);
          if (!workspace.is_private || joined || canView || canManage) {
            expected.push({ id: workspace.id, joined, canManage });
          }
        }

        const actual = (listed.body as Array<{
          id: number;
          joined: boolean;
          canManage: boolean;
        }>).map(({ id, joined, canManage }) => ({ id, joined, canManage }))
          .sort((left, right) => left.id - right.id);
        expected.sort((left, right) => left.id - right.id);
        assert.deepEqual(actual, expected, "The batched workspace list must match individual authorization checks.");

        if (expectedWorkspaceKeys) {
          const expectedIds = expectedWorkspaceKeys
            .map((key) => workspaceIds.get(key))
            .sort((left, right) => (left ?? 0) - (right ?? 0));
          assert.deepEqual(actual.map(({ id }) => id), expectedIds);
        }
      };

      await assertListMatchesIndividualPermissions(ownerSession, ["owner"]);
      await assertListMatchesIndividualPermissions(scopedAdminSession, ["scoped_admin"]);
      await assertListMatchesIndividualPermissions(memberSession, ["member_joined"]);
      await assertListMatchesIndividualPermissions(customViewSession, ["custom_view"]);
      await assertListMatchesIndividualPermissions(customManagerSession, ["custom_manage"]);
      await assertListMatchesIndividualPermissions(adminSession);
    } finally {
      await pool.query(
        "DELETE FROM irc_user_roles WHERE role = ANY($1::text[])",
        [[customViewRole, customManageRole]],
      );
      await pool.query(
        "DELETE FROM irc_role_permissions WHERE role = ANY($1::text[])",
        [[customViewRole, customManageRole]],
      );
      await pool.query(
        "DELETE FROM irc_custom_roles WHERE key = ANY($1::text[])",
        [[customViewRole, customManageRole]],
      );
      if (communityIds.length) {
        await pool.query(
          "DELETE FROM irc_communities WHERE id = ANY($1::int[])",
          [communityIds],
        );
      }
    }
  });

  test("keeps private workspace list query counts bounded as communities and scoped roles grow", async (t) => {
    const session = await createTestSession("workspace_scale");
    const adminSession = await createTestSession("workspace_scale_admin");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const communityIds: number[] = [];
    const customRoles: string[] = [];
    const expected: Array<{ id: number; joined: boolean; canManage: boolean }> = [];

    try {
      assert.equal((await apiRequest(session, "/me")).status, 200);
      assert.equal((await apiRequest(adminSession, "/me")).status, 200);
      await pool.query("UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1", [adminSession.userId]);
      assert.equal((await apiRequest(adminSession, "/permissions/catalog")).status, 200);

      const growTo = async (size: number): Promise<void> => {
        while (communityIds.length < size) {
          const index = communityIds.length;
          // Repeat all access paths at each size, including inaccessible workspaces.
          const kind = index % 6;
          const { rows: [community] } = await pool.query<{ id: number }>(
            `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
             VALUES ($1, $2, $3, 'paid_workspace', true) RETURNING id`,
            [`Scale ${suffix} ${index}`, `scale-${suffix}-${index}`, adminSession.userId],
          );
          communityIds.push(community.id);
          if (kind === 1) {
            await pool.query(
              `INSERT INTO irc_community_members (community_id, user_id, status)
               VALUES ($1, $2, 'member')`,
              [community.id, session.userId],
            );
          } else if (kind >= 2) {
            let role = kind === 2 ? "workspace_owner" : "workspace_admin";
            if (kind >= 4) {
              // Distinct custom roles grow the permission join as well as assignments.
              role = `scale_${suffix}_${index}`;
              customRoles.push(role);
              await pool.query(
                `INSERT INTO irc_custom_roles (key, label, scope_type, created_by)
                 VALUES ($1, $1, 'community', $2)`,
                [role, adminSession.userId],
              );
              const inserted = await pool.query(
                `INSERT INTO irc_role_permissions (role, permission_id)
                 SELECT $1, id FROM irc_permission_definitions WHERE key = $2`,
                [role, kind === 4 ? "view_business" : "manage_community"],
              );
              assert.equal(inserted.rowCount, 1);
            }
            await pool.query(
              `INSERT INTO irc_user_roles (user_id, role, scope_type, community_id, granted_by)
               VALUES ($1, $2, 'community', $3, $4)`,
              [session.userId, role, community.id, adminSession.userId],
            );
          }
          if (kind !== 0) {
            expected.push({
              id: community.id,
              joined: kind === 1,
              canManage: kind === 2 || kind === 3 || kind === 5,
            });
          }
        }
      };

      const measureList = async (): Promise<number> => {
        // Call through to PostgreSQL; count only the request, never fixture SQL.
        const querySpy = mock.method(pool, "query");
        let listed: ApiResponse;
        let count: number;
        try {
          listed = await apiRequest(session, "/communities");
          count = querySpy.mock.callCount();
        } finally {
          querySpy.mock.restore();
        }
        assert.equal(listed.status, 200, JSON.stringify(listed));
        assert.ok(Array.isArray(listed.body));
        const actual = (listed.body as typeof expected)
          .filter(({ id }) => communityIds.includes(id))
          .map(({ id, joined, canManage }) => ({ id, joined, canManage }))
          .sort((a, b) => a.id - b.id);
        assert.deepEqual(actual, [...expected].sort((a, b) => a.id - b.id));
        assert.ok(count > 0, "The query counter must observe real database queries.");
        // Allows fixed authentication/profile overhead, but not even one query per workspace.
        assert.ok(count <= 12, `Workspace list exceeded its fixed query budget: ${count}`);
        return count;
      };

      await growTo(12);
      // Finish profile/auth bootstrap before either measured request.
      assert.equal((await apiRequest(session, "/communities")).status, 200);
      const smallCount = await measureList();
      await growTo(120);
      const largeCount = await measureList();
      assert.equal(largeCount, smallCount, "Ten times as many workspaces and scoped roles must not add queries.");
      t.diagnostic(`Workspace list queries: 12 workspaces=${smallCount}, 120 workspaces=${largeCount}`);
    } finally {
      await pool.query("DELETE FROM irc_user_roles WHERE user_id = $1", [session.userId]);
      await pool.query("DELETE FROM irc_role_permissions WHERE role = ANY($1::text[])", [customRoles]);
      await pool.query("DELETE FROM irc_custom_roles WHERE key = ANY($1::text[])", [customRoles]);
      await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [communityIds]);
    }
  });

  test("rolls back custom-role creation when audit logging fails", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const label = `Audit Failure ${suffix}`;
    const key = `custom_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)}`;
    const triggerName = `fail_custom_role_audit_${suffix}`;
    const functionName = `fail_custom_role_audit_fn_${suffix}`;

    try {
      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action = 'created_custom_role' AND NEW.target_id = '${key}' THEN
             RAISE EXCEPTION 'forced custom-role audit failure';
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

      const response = await apiRequest(adminSession, "/admin/custom-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label,
          description: "Role must roll back if its audit entry fails",
          scopeType: "community",
          permissions: ["view_business"],
        }),
      });
      assert.equal(response.status, 500, JSON.stringify(response));
      assert.deepEqual(response.body, {
        error: "An unexpected error occurred while processing the admin request.",
      });

      const [roles, permissionLinks, auditEntries] = await Promise.all([
        pool.query("SELECT key FROM irc_custom_roles WHERE key = $1", [key]),
        pool.query("SELECT role FROM irc_role_permissions WHERE role = $1", [key]),
        pool.query("SELECT target_id FROM irc_admin_audit_logs WHERE target_id = $1", [key]),
      ]);
      assert.deepEqual(roles.rows, []);
      assert.deepEqual(permissionLinks.rows, []);
      assert.deepEqual(auditEntries.rows, []);
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON irc_admin_audit_logs;
         DROP FUNCTION IF EXISTS "${functionName}"();`,
      );
      await pool.query("DELETE FROM irc_role_permissions WHERE role = $1", [key]);
      await pool.query("DELETE FROM irc_admin_audit_logs WHERE target_id = $1", [key]);
      await pool.query("DELETE FROM irc_custom_roles WHERE key = $1", [key]);
    }
  });

  test("creates, edits, assigns, and retires custom roles with scoped authority and audit history", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const communityIds: number[] = [];
    const roleKeys: string[] = [];
    const request = (path: string, method: string, body?: object) => apiRequest(adminSession, path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    try {
      const communities = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id)
         VALUES ($1, $2, $5), ($3, $4, $5) RETURNING id`,
        [`Role A ${suffix}`, `role-a-${suffix}`, `Role B ${suffix}`, `role-b-${suffix}`, adminSession.userId],
      );
      communityIds.push(...communities.rows.map(({ id }) => id));
      const departments = await pool.query<{ id: number; community_id: number }>(
        `INSERT INTO irc_departments (name, community_id)
         VALUES ($1, $3), ($2, $4) RETURNING id, community_id`,
        [`Department A ${suffix}`, `Department B ${suffix}`, ...communityIds],
      );
      const departmentA = departments.rows.find(({ community_id }) => community_id === communityIds[0])!.id;
      const departmentB = departments.rows.find(({ community_id }) => community_id === communityIds[1])!.id;
      const channel = await pool.query<{ id: number }>(
        `INSERT INTO irc_channels (name, owner_id, community_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [`role-channel-${suffix}`, adminSession.userId, communityIds[0]],
      );
      const roleBody = (scopeType: string, permissions: string[]) => ({
        label: `Role ${scopeType} ${suffix}`, description: "Scoped test role", scopeType, permissions,
      });
      const invalid = await request("/admin/custom-roles", "POST", roleBody("department", ["manage_roles"]));
      assert.equal(invalid.status, 400, JSON.stringify(invalid));
      const invalidAudit = await pool.query(
        `SELECT id FROM irc_admin_audit_logs WHERE action = 'created_custom_role'
         AND target_label = $1`, [`Role department ${suffix}`],
      );
      assert.equal(invalidAudit.rowCount, 0);

      for (const [scopeType, scopeId, permission] of [
        ["community", communityIds[0], "view_business"],
        ["department", departmentA, "create_announcement"],
        ["channel", channel.rows[0].id, "create_channel"],
      ] as const) {
        const created = await request("/admin/custom-roles", "POST", roleBody(scopeType, [permission]));
        assert.equal(created.status, 201, JSON.stringify(created));
        const key = (created.body as { key: string }).key;
        roleKeys.push(key);
        const assignment = {
          userId: memberSession.userId, role: key, scopeType,
          communityId: communityIds[0],
          ...(scopeType === "department" ? { departmentId: scopeId } : {}),
          ...(scopeType === "channel" ? { channelId: scopeId } : {}),
        };
        if (scopeType === "department") {
          const mismatch = await request("/admin/role-assignments", "POST", { ...assignment, departmentId: departmentB });
          assert.equal(mismatch.status, 400, JSON.stringify(mismatch));
        }
        const granted = await request("/admin/role-assignments", "POST", assignment);
        assert.equal(granted.status, 201, JSON.stringify(granted));
        const targetScope = scopeType === "community" ? { communityId: communityIds[0] }
          : scopeType === "department" ? { communityId: communityIds[0], departmentId: departmentA }
            : { communityId: communityIds[0], channelId: channel.rows[0].id };
        assert.equal(await hasPermission(memberSession.userId, permission, targetScope), true);
        assert.equal(await hasPermission(memberSession.userId, permission, { communityId: communityIds[1], departmentId: departmentB }), false);
        const edited = await request(`/admin/custom-roles/${key}`, "PATCH", roleBody(scopeType, ["view_business"]));
        assert.equal(edited.status, 200, JSON.stringify(edited));
        if (permission !== "view_business") assert.equal(await hasPermission(memberSession.userId, permission, targetScope), false);
        const retired = await request(`/admin/custom-roles/${key}`, "DELETE");
        assert.equal(retired.status, 200, JSON.stringify(retired));
        assert.equal(await hasPermission(memberSession.userId, "view_business", targetScope), false);
        assert.equal((await request("/admin/role-assignments", "POST", assignment)).status, 400);
        const audit = await pool.query<{ action: string }>(
          `SELECT action FROM irc_admin_audit_logs
           WHERE target_id = $1 AND action IN ('created_custom_role', 'updated_custom_role', 'retired_custom_role')
           ORDER BY id`, [key],
        );
        assert.deepEqual(audit.rows.map(({ action }) => action), [
          "created_custom_role", "updated_custom_role", "retired_custom_role",
        ]);
      }
    } finally {
      if (roleKeys.length) {
        await pool.query("DELETE FROM irc_user_roles WHERE role = ANY($1::text[])", [roleKeys]);
        await pool.query("DELETE FROM irc_role_permissions WHERE role = ANY($1::text[])", [roleKeys]);
        await pool.query("DELETE FROM irc_admin_audit_logs WHERE target_id = ANY($1::text[])", [roleKeys]);
        await pool.query("DELETE FROM irc_custom_roles WHERE key = ANY($1::text[])", [roleKeys]);
      }
      if (communityIds.length) await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [communityIds]);
    }
  });

  test("enforces every built-in workspace role boundary on community role changes", async () => {
    const ownerSession = await createTestSession("role_matrix_owner");
    const actorSession = await createTestSession("role_matrix_actor");
    const targetSession = await createTestSession("role_matrix_target");
    const communityIds: number[] = [];
    const assignableRoles = [
      "member", "moderator", "manager", "department_admin",
      "workspace_admin", "workspace_owner",
    ] as const;
    const actorCases: Array<{
      role: typeof assignableRoles[number];
      allowed: readonly (typeof assignableRoles[number])[];
    }> = [
      { role: "member", allowed: [] },
      { role: "moderator", allowed: [] },
      { role: "manager", allowed: ["member", "moderator"] },
      { role: "department_admin", allowed: ["member", "moderator", "manager"] },
      { role: "workspace_admin", allowed: ["member", "moderator", "manager", "department_admin"] },
      { role: "workspace_owner", allowed: ["member", "moderator", "manager", "department_admin", "workspace_admin"] },
    ];

    try {
      for (const session of [actorSession, targetSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }
      const created = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Role matrix ${randomUUID().slice(0, 8)}`, isPrivate: true }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const communityId = (created.body as { id?: number }).id;
      assert.ok(typeof communityId === "number");
      communityIds.push(communityId);
      const other = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [`Other role scope ${randomUUID()}`, `other-role-scope-${randomUUID()}`, ownerSession.userId],
      );
      communityIds.push(other.rows[0].id);
      for (const scopeId of communityIds) {
        await pool.query(
          `INSERT INTO irc_community_members (community_id, user_id, status)
           VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
          [scopeId, actorSession.userId, targetSession.userId],
        );
      }
      const otherCommunityId = other.rows[0].id;
      const changeRole = (session: TestSession, scopeId: number, role: string) =>
        apiRequest(session, `/communities/${scopeId}/members/${targetSession.userId}/role`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role }),
        });
      const assignedRole = async (scopeId: number) =>
        (await pool.query<{ role: string }>(
          `SELECT role FROM irc_user_roles
           WHERE user_id = $1 AND community_id = $2 AND scope_type = 'community'
           ORDER BY role`,
          [targetSession.userId, scopeId],
        )).rows.map(({ role }) => role);

      for (const { role: actorRole, allowed } of actorCases) {
        await pool.query(
          `DELETE FROM irc_user_roles WHERE user_id = $1 AND community_id = $2`,
          [actorSession.userId, communityId],
        );
        if (actorRole !== "member") {
          await pool.query(
            `INSERT INTO irc_user_roles (user_id, role, scope_type, community_id, granted_by)
             VALUES ($1, $2, 'community', $3, $4)`,
            [actorSession.userId, actorRole, communityId, ownerSession.userId],
          );
        }
        for (const targetRole of assignableRoles) {
          const before = await assignedRole(communityId);
          const response = await changeRole(actorSession, communityId, targetRole);
          const permitted = allowed.includes(targetRole);
          assert.equal(response.status, permitted ? 200 : 403,
            `${actorRole} -> ${targetRole}: ${JSON.stringify(response)}`);
          assert.deepEqual(await assignedRole(communityId),
            permitted ? (targetRole === "member" ? [] : [targetRole]) : before,
            `${actorRole} -> ${targetRole} must ${permitted ? "update" : "preserve"} the assignment`);
        }
      }

      // A high-ranking role in one workspace must not authorize changes in another.
      const beforeOther = await assignedRole(otherCommunityId);
      const crossWorkspace = await changeRole(actorSession, otherCommunityId, "manager");
      assert.equal(crossWorkspace.status, 403, JSON.stringify(crossWorkspace));
      assert.deepEqual(await assignedRole(otherCommunityId), beforeOther);

      // The platform administrator bypasses workspace rank, including owner.
      for (const targetRole of assignableRoles) {
        const response = await changeRole(adminSession, communityId, targetRole);
        assert.equal(response.status, 200, `platform admin -> ${targetRole}: ${JSON.stringify(response)}`);
        assert.deepEqual(await assignedRole(communityId),
          targetRole === "member" ? [] : [targetRole]);
      }
    } finally {
      for (const communityId of communityIds.reverse()) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
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
      assert.deepEqual(
        (await pool.query(
          `SELECT action
           FROM irc_admin_audit_logs
           WHERE actor_id = $1
             AND community_id = $2
             AND action = 'changed_community_role'`,
          [actorSession.userId, communityId],
        )).rows,
        [],
      );
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

  test("does not let revoked developer authority win a scoped-role assignment race", async () => {
    const revocation = await pool.connect();
    let assignmentId: number | null = null;
    try {
      await apiRequest(adminSession, "/me");
      await revocation.query("BEGIN");
      await revocation.query(
        "SELECT clerk_id FROM irc_users WHERE clerk_id = $1 FOR UPDATE",
        [adminSession.userId],
      );

      const assignment = apiRequest(adminSession, "/admin/role-assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: memberSession.userId,
          role: "platform_moderator",
          scopeType: "platform",
        }),
      });
      let blocked = false;
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
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "assignment should wait for the actor authorization lock");
      await revocation.query(
        "UPDATE irc_users SET role = 'member' WHERE clerk_id = $1",
        [adminSession.userId],
      );
      await revocation.query("COMMIT");

      const denied = await assignment;
      assert.equal(denied.status, 409, JSON.stringify(denied));
      assert.deepEqual(denied.body, {
        error: "Role or administrator access changed. Reload and try again.",
      });
      const assignments = await pool.query<{ id: number }>(
        `SELECT id FROM irc_user_roles
         WHERE user_id = $1 AND role = 'platform_moderator' AND scope_type = 'platform'`,
        [memberSession.userId],
      );
      assignmentId = assignments.rows[0]?.id ?? null;
      assert.deepEqual(assignments.rows, []);
      assert.deepEqual(
        (await pool.query(
          `SELECT action FROM irc_admin_audit_logs
           WHERE actor_id = $1 AND target_id = $2
             AND action = 'granted_scoped_role'
             AND details = 'platform_moderator on platform'`,
          [adminSession.userId, memberSession.userId],
        )).rows,
        [],
      );
    } finally {
      await revocation.query("ROLLBACK").catch(() => undefined);
      revocation.release();
      if (assignmentId !== null) {
        await pool.query("DELETE FROM irc_user_roles WHERE id = $1", [assignmentId]);
      }
      await pool.query(
        "UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1",
        [adminSession.userId],
      );
    }
  });

  test("admin grants and invitation acceptance cannot restore access during account deletion", async () => {
    // This test also runs alone with --test-name-pattern, without the earlier
    // provisioning test that normally assigns the shared admin session.
    const provisionedHere = !adminSession;
    if (provisionedHere) {
      adminSession = firstSession;
      await apiRequest(adminSession, "/me");
      await pool.query("UPDATE irc_users SET role = 'admin' WHERE clerk_id = $1", [adminSession.userId]);
    }
    const target = await createTestSession("deletion_grant_race", "verified");
    const email = (await clerkClient.users.getUser(target.userId)).emailAddresses
      .find((address) => address.verification?.status === "verified")?.emailAddress;
    assert.ok(email);
    await apiRequest(target, "/me");
    const workspace = await pool.query<{ id: number }>(
      "INSERT INTO irc_communities (name, slug, owner_id, plan) VALUES ('Deletion Race', $1, $2, 'paid_workspace') RETURNING id",
      [`deletion-race-${randomUUID()}`, adminSession.userId],
    );
    const communityId = workspace.rows[0].id;
    let channelId: number | null = null;
    const invitationResponse = await apiRequest(adminSession, `/communities/${communityId}/invitations`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role: "employee" }),
    });
    assert.equal(invitationResponse.status, 201, JSON.stringify(invitationResponse));
    const token = (invitationResponse.body as { invitationToken: string }).invitationToken;
    const waitForLock = async () => {
      for (let attempt = 0; attempt < 150; attempt++) {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
           AND state = 'active' AND wait_event_type = 'Lock' AND query ILIKE '%irc_users%'`,
        );
        if (waiting.rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Access request did not wait for the account lock");
    };
    const grant = () => apiRequest(adminSession, "/admin/role-assignments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: target.userId, role: "platform_moderator", scopeType: "platform" }),
    });
    const lock = await pool.connect();
    try {
      // Deletion wins: the admin grant must wait and reject without an audit row.
      await lock.query("BEGIN");
      await lock.query("UPDATE irc_users SET deletion_status = 'pending', account_status = 'suspended' WHERE clerk_id = $1", [target.userId]);
      const blockedGrant = grant();
      try {
        await waitForLock();
      } finally {
        await lock.query("COMMIT");
      }
      assert.equal((await blockedGrant).status, 409);
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM irc_user_roles WHERE user_id = $1", [target.userId],
      )).rows[0].count, 0);

      // Restore only the disposable fixture; a second pending transition races
      // the real invitation acceptance route (including its membership writes).
      await pool.query("UPDATE irc_users SET deletion_status = 'none', account_status = 'active' WHERE clerk_id = $1", [target.userId]);
      await lock.query("BEGIN");
      await lock.query("UPDATE irc_users SET deletion_status = 'pending', account_status = 'suspended' WHERE clerk_id = $1", [target.userId]);
      const acceptance = apiRequest(target, `/communities/${communityId}/invitations/accept`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      try {
        await waitForLock();
      } finally {
        await lock.query("COMMIT");
      }
      assert.equal((await acceptance).status, 409);
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM irc_community_members WHERE community_id = $1 AND user_id = $2",
        [communityId, target.userId],
      )).rows[0].count, 0);
      assert.equal((await pool.query(
        "SELECT status FROM irc_workspace_invitations WHERE community_id = $1", [communityId],
      )).rows[0].status, "pending");

      // Grant wins: deletion removes the committed grant, and no later grant
      // can reappear after the target is pending.
      await pool.query("UPDATE irc_users SET deletion_status = 'none', account_status = 'active' WHERE clerk_id = $1", [target.userId]);
      const granted = await grant();
      assert.equal(granted.status, 201, JSON.stringify(granted));
      await lock.query("BEGIN");
      await lock.query("UPDATE irc_users SET deletion_status = 'pending', account_status = 'suspended' WHERE clerk_id = $1", [target.userId]);
      await lock.query("DELETE FROM irc_user_roles WHERE user_id = $1", [target.userId]);
      await lock.query("COMMIT");
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM irc_user_roles WHERE user_id = $1", [target.userId],
      )).rows[0].count, 0);

      // Existing workspace members can still appear active to requests started
      // before deletion commits. Neither assignment path may write after it.
      await pool.query("UPDATE irc_users SET deletion_status = 'none', account_status = 'active' WHERE clerk_id = $1", [target.userId]);
      await pool.query(
        "INSERT INTO irc_community_members (community_id, user_id) VALUES ($1, $2)",
        [communityId, target.userId],
      );
      await pool.query(
        "INSERT INTO irc_employee_profiles (community_id, user_id, employment_status) VALUES ($1, $2, 'active')",
        [communityId, target.userId],
      );
      const team = await pool.query<{ id: number }>(
        "INSERT INTO irc_teams (community_id, name) VALUES ($1, 'Race team') RETURNING id",
        [communityId],
      );
      const channel = await pool.query<{ id: number }>(
        "INSERT INTO irc_channels (community_id, owner_id, name) VALUES ($1, $2, '#race-room') RETURNING id",
        [communityId, adminSession.userId],
      );
      channelId = channel.rows[0].id;
      await lock.query("BEGIN");
      await lock.query("UPDATE irc_users SET deletion_status = 'pending', account_status = 'suspended' WHERE clerk_id = $1", [target.userId]);
      const teamAssignment = apiRequest(adminSession, `/communities/${communityId}/teams/${team.rows[0].id}/members/${target.userId}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
      });
      const channelJoin = apiRequest(target, `/channels/${channelId}/join`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      try {
        await waitForLock();
      } finally {
        await lock.query("COMMIT");
      }
      assert.equal((await teamAssignment).status, 409);
      assert.equal((await channelJoin).status, 409);
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM irc_team_members WHERE team_id = $1 AND user_id = $2",
        [team.rows[0].id, target.userId],
      )).rows[0].count, 0);
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM irc_channel_members WHERE channel_id = $1 AND user_id = $2",
        [channelId, target.userId],
      )).rows[0].count, 0);
    } finally {
      await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
      if (channelId !== null) {
        await pool.query("DELETE FROM irc_channels WHERE id = $1", [channelId]);
      }
      await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      await pool.query("UPDATE irc_users SET deletion_status = 'none', account_status = 'active' WHERE clerk_id = $1", [target.userId]);
      if (provisionedHere) {
        await pool.query("UPDATE irc_users SET role = 'member' WHERE clerk_id = $1", [adminSession.userId]);
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

      const rejectedRead = await apiRequest(suspendedSession, "/me");
      assert.equal(rejectedRead.status, 403, JSON.stringify(rejectedRead));
      assert.deepEqual(rejectedRead.body, {
        error: "This account is suspended.",
      });

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

  test("broadcasts owner topic edits only to subscribers of that channel", async () => {
    const ownerSession = await createTestSession("owner_live_topic");
    const subscriberSession = await createTestSession("topic_subscriber");
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      const createdChannels = await Promise.all([
        apiRequest(ownerSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `owner-live-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            topic: "Original owner topic",
          }),
        }),
        apiRequest(ownerSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `owner-other-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            topic: "Unrelated owner topic",
          }),
        }),
      ]);
      for (const created of createdChannels) {
        assert.equal(created.status, 201, JSON.stringify(created));
        assert.ok(created.body && typeof created.body === "object");
        const channelId = (created.body as { id?: unknown }).id;
        assert.equal(typeof channelId, "number");
        channelIds.push(channelId as number);
      }
      const [targetChannelId, unrelatedChannelId] = channelIds;

      const joined = await Promise.all(channelIds.map((channelId) =>
        apiRequest(subscriberSession, `/channels/${channelId}/join`, { method: "POST" }),
      ));
      for (const response of joined) {
        assert.equal(response.status, 200, JSON.stringify(response));
      }

      const [targetSocket, unrelatedSocket] = await Promise.all([
        openWebSocket(subscriberSession),
        openWebSocket(subscriberSession),
      ]);
      sockets.push(targetSocket, unrelatedSocket);
      targetSocket.send(JSON.stringify({ type: "subscribe", channelId: targetChannelId }));
      unrelatedSocket.send(JSON.stringify({ type: "subscribe", channelId: unrelatedChannelId }));
      await Promise.all([
        waitForChannelSubscription(targetSocket, targetChannelId),
        waitForChannelSubscription(unrelatedSocket, unrelatedChannelId),
      ]);

      const liveTopicUpdate = waitForWebSocketEvent(
        targetSocket,
        (event) => {
          if (event.type !== "channel" || !event.channel || typeof event.channel !== "object") {
            return false;
          }
          const channel = event.channel as { id?: unknown };
          return channel.id === targetChannelId;
        },
      );
      const blockedUnrelatedUpdate = expectNoWebSocketEvent(
        unrelatedSocket,
        (event) => {
          if (event.type !== "channel" || !event.channel || typeof event.channel !== "object") {
            return false;
          }
          const channel = event.channel as { id?: unknown };
          return channel.id === targetChannelId;
        },
        1_000,
      );

      const topicUpdate = await apiRequest(ownerSession, `/channels/${targetChannelId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "Owner updated live topic" }),
      });
      assert.equal(topicUpdate.status, 200, JSON.stringify(topicUpdate));

      const event = await liveTopicUpdate;
      assert.ok(event.channel && typeof event.channel === "object");
      const updatedChannel = event.channel as { id?: unknown; topic?: unknown };
      assert.equal(updatedChannel.id, targetChannelId);
      assert.equal(updatedChannel.topic, "Owner updated live topic");
      await blockedUnrelatedUpdate;
      assert.equal(targetSocket.readyState, WebSocket.OPEN);
      assert.equal(unrelatedSocket.readyState, WebSocket.OPEN);
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [ownerSession.userId, subscriberSession.userId]);
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

  test("keeps community dashboard statistics accurate as workspace state changes", async () => {
    const ownerSession = await createTestSession("dashboard_owner");
    const workerSession = await createTestSession("dashboard_worker");
    let communityId: number | null = null;
    let otherCommunityId: number | null = null;
    const communityActivityMarker = `dashboard_activity_${randomUUID()}`;
    const otherActivityMarker = `dashboard_activity_other_${randomUUID()}`;

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

      const otherCommunity = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Other dashboard ${randomUUID().slice(0, 8)}`,
          isPrivate: true,
        }),
      });
      assert.equal(otherCommunity.status, 201, JSON.stringify(otherCommunity));
      otherCommunityId = (otherCommunity.body as { id?: unknown }).id as number;
      assert.equal(typeof otherCommunityId, "number");

      await pool.query(
        `UPDATE irc_users SET status = CASE
           WHEN clerk_id = $1 THEN 'online'
           WHEN clerk_id = $2 THEN 'online'
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
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      await pool.query(
        `INSERT INTO irc_workspace_tasks
           (community_id, title, status, due_date, created_by)
         VALUES
           ($1, 'Open without due date', 'todo', NULL, $2),
           ($1, 'Due near end of week', 'in_progress', $3, $2),
           ($1, 'Overdue', 'todo', $4, $2),
           ($1, 'Beyond this week', 'todo', $5, $2),
           ($1, 'Completed future task', 'completed', $3, $2),
           ($1, 'Cancelled overdue task', 'cancelled', $4, $2)`,
        [
          communityId,
          ownerSession.userId,
          new Date(now + weekMs - 5 * 60 * 1000),
          new Date(now - 5 * 60 * 1000),
          new Date(now + weekMs + 5 * 60 * 1000),
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
      await pool.query(
        `INSERT INTO irc_admin_audit_logs
           (actor_id, actor_display_name, community_id, action, details, created_at)
         VALUES
           ($1, 'Dashboard test', $2, 'dashboard_test_activity', $3, now()),
           ($1, 'Dashboard test', $4, 'dashboard_test_activity', $5, now() + interval '1 second')`,
        [
          ownerSession.userId,
          communityId,
          communityActivityMarker,
          otherCommunityId,
          otherActivityMarker,
        ],
      );

      const dashboard = await apiRequest(
        ownerSession,
        `/communities/${communityId}/dashboard`,
      );
      assert.equal(dashboard.status, 200, JSON.stringify(dashboard));
      assert.ok(dashboard.body && typeof dashboard.body === "object");
      const body = dashboard.body as {
        stats?: {
          employees?: number;
          online?: number;
          channels?: number;
          openTasks?: number;
          announcements?: number;
          pendingRequests?: number;
        };
        tasks?: { open?: number; dueThisWeek?: number; overdue?: number };
        recentActivity?: Array<{ details?: unknown }>;
      };
      assert.deepEqual(body.stats, {
        employees: 2,
        online: 2,
        channels: 3,
        openTasks: 4,
        announcements: 2,
        pendingRequests: 1,
      });
      assert.deepEqual(body.tasks, {
        open: 4,
        dueThisWeek: 1,
        overdue: 1,
      });
      assert.ok(Array.isArray(body.recentActivity));
      assert.ok(
        body.recentActivity.some(({ details }) => details === communityActivityMarker),
        "the dashboard includes activity from its own workspace",
      );
      assert.ok(
        body.recentActivity.every(({ details }) => details !== otherActivityMarker),
        "the dashboard excludes activity from another workspace",
      );

      await pool.query("UPDATE irc_users SET status = 'offline' WHERE clerk_id = $1", [
        workerSession.userId,
      ]);
      await pool.query(
        `UPDATE irc_workspace_tasks
         SET status = 'completed', completed_at = now()
         WHERE community_id = $1 AND title = 'Due near end of week'`,
        [communityId],
      );
      await pool.query(
        `UPDATE irc_workspace_tasks
         SET due_date = now() - interval '1 minute'
         WHERE community_id = $1 AND title = 'Open without due date'`,
        [communityId],
      );
      await pool.query(
        `UPDATE irc_server_announcements
         SET expires_at = now() - interval '1 minute'
         WHERE community_id = $1 AND body = 'Current scheduled'`,
        [communityId],
      );
      await pool.query(
        `UPDATE irc_channel_join_requests
         SET status = 'approved', reviewed_at = now(), reviewed_by = $3
         WHERE channel_id = $1 AND user_id = $2 AND status = 'pending'`,
        [channelIds[0], workerSession.userId, ownerSession.userId],
      );

      const updatedDashboard = await apiRequest(
        ownerSession,
        `/communities/${communityId}/dashboard`,
      );
      assert.equal(updatedDashboard.status, 200, JSON.stringify(updatedDashboard));
      assert.ok(updatedDashboard.body && typeof updatedDashboard.body === "object");
      const updatedBody = updatedDashboard.body as {
        stats?: unknown;
        tasks?: unknown;
      };
      assert.deepEqual(updatedBody.stats, {
        employees: 2,
        online: 1,
        channels: 3,
        openTasks: 3,
        announcements: 1,
        pendingRequests: 0,
      });
      assert.deepEqual(updatedBody.tasks, {
        open: 3,
        dueThisWeek: 0,
        overdue: 2,
      });
    } finally {
      await pool.query(
        "DELETE FROM irc_admin_audit_logs WHERE details = ANY($1::text[])",
        [[communityActivityMarker, otherActivityMarker]],
      );
      const communityIds = [communityId, otherCommunityId].filter(
        (id): id is number => id !== null,
      );
      if (communityIds.length) {
        await pool.query(
          `DELETE FROM irc_channel_join_requests
           WHERE channel_id IN (
             SELECT id FROM irc_channels WHERE community_id = ANY($1::int[])
           )`,
          [communityIds],
        );
        await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [
          communityIds,
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
        community_id: number;
        action_url: string;
      }>(
        `SELECT type, category, body, community_id, action_url
         FROM irc_notifications
         WHERE user_id = $1 AND entity_type = 'workspace_task' AND entity_id = $2
         ORDER BY id`,
        [workerSession.userId, String(taskId)],
      );
      assert.deepEqual(initialNotifications.rows, [{
        type: "task_assigned",
        category: "task_assigned",
        body: "You were assigned the task “Prepare onboarding”.",
        community_id: communityId,
        action_url: `/communities/${communityId}?taskId=${taskId}`,
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

      for (const [status, label] of [
        ["waiting", "Waiting"],
        ["completed", "Completed"],
        ["cancelled", "Cancelled"],
      ] as const) {
        const statusChange = await apiRequest(ownerSession, `/communities/${communityId}/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status }),
        });
        assert.equal(statusChange.status, 200, JSON.stringify(statusChange));
        const statusNotifications = await pool.query<{
          type: string;
          category: string;
          body: string;
          community_id: number;
          action_url: string;
        }>(
          `SELECT type, category, body, community_id, action_url
           FROM irc_notifications
           WHERE user_id = $1 AND entity_type = 'workspace_task' AND entity_id = $2
             AND body = $3
           ORDER BY id`,
          [workerSession.userId, String(taskId), `Task “Prepare onboarding” moved to ${label}.`],
        );
        assert.deepEqual(statusNotifications.rows, [{
          type: "task_updated",
          category: "task_updated",
          body: `Task “Prepare onboarding” moved to ${label}.`,
          community_id: communityId,
          action_url: `/communities/${communityId}?taskId=${taskId}`,
        }]);
        const actorStatusNotifications = await pool.query(
          `SELECT id FROM irc_notifications
           WHERE user_id = $1 AND entity_type = 'workspace_task' AND entity_id = $2
             AND body = $3`,
          [ownerSession.userId, String(taskId), `Task “Prepare onboarding” moved to ${label}.`],
        );
        assert.equal(actorStatusNotifications.rowCount, 0);
      }

      const waitingAudit = await pool.query(
        `SELECT id FROM irc_admin_audit_logs
         WHERE community_id = $1 AND actor_id = $2 AND action = 'updated_workspace_task'
           AND details = $3`,
        [communityId, ownerSession.userId, `${taskId} → waiting`],
      );
      assert.equal(waitingAudit.rowCount, 1);

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

      const ownTask = await apiRequest(ownerSession, `/communities/${communityId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Review own work",
          assignedTo: ownerSession.userId,
        }),
      });
      assert.equal(ownTask.status, 201, JSON.stringify(ownTask));
      const ownTaskId = (ownTask.body as { id: number }).id;
      const ownTaskUpdate = await apiRequest(ownerSession, `/communities/${communityId}/tasks/${ownTaskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "waiting", priority: "high" }),
      });
      assert.equal(ownTaskUpdate.status, 200, JSON.stringify(ownTaskUpdate));
      const ownTaskNotifications = await pool.query(
        `SELECT id FROM irc_notifications
         WHERE entity_type = 'workspace_task' AND entity_id = $1
           AND type IN ('task_assigned', 'task_updated')`,
        [String(ownTaskId)],
      );
      assert.deepEqual(ownTaskNotifications.rows, []);
      const ownTaskAuditNotifications = await pool.query(
        `SELECT id FROM irc_notifications
         WHERE user_id = $1 AND community_id = $2 AND type = 'administrative_action'
           AND body = ANY($3::text[])`,
        [
          ownerSession.userId,
          communityId,
          [
            "created workspace task: Review own work",
            `updated workspace task: ${ownTaskId} → waiting`,
          ],
        ],
      );
      assert.deepEqual(ownTaskAuditNotifications.rows, []);
    } finally {
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
    }
  });

  test("delivers each persisted task notification once to online assignees without replaying it", async () => {
    const ownerSession = await createTestSession("live_task_notification_owner");
    const workerSession = await createTestSession("live_task_notification_worker");
    const replacementSession = await createTestSession("live_task_notification_replacement");
    const sockets: WebSocket[] = [];
    let communityId: number | null = null;

    type LiveNotification = {
      id: number;
      userId: string;
      type: string;
      body: string;
      entityType: string;
      entityId: string;
    };
    const notificationFromEvent = (event: Record<string, unknown>): LiveNotification | null => {
      if (event.type !== "notification" || !event.notification || typeof event.notification !== "object") {
        return null;
      }
      const notification = event.notification as Partial<LiveNotification>;
      return typeof notification.id === "number"
        && typeof notification.userId === "string"
        && typeof notification.type === "string"
        && typeof notification.body === "string"
        && typeof notification.entityType === "string"
        && typeof notification.entityId === "string"
        ? notification as LiveNotification
        : null;
    };
    const taskEvents = (
      socket: WebSocket,
      body: string,
      durationMs = 500,
    ): Promise<Record<string, unknown>[]> => collectWebSocketEvents(
      socket,
      (event) => notificationFromEvent(event)?.body === body,
      durationMs,
    );
    const assertSingleLiveNotification = (
      events: Record<string, unknown>[],
      expected: Omit<LiveNotification, "id">,
    ): LiveNotification => {
      assert.equal(events.length, 1, `Expected exactly one live notification: ${expected.body}`);
      const notification = notificationFromEvent(events[0]);
      assert.ok(notification);
      assert.deepEqual(
        {
          userId: notification.userId,
          type: notification.type,
          body: notification.body,
          entityType: notification.entityType,
          entityId: notification.entityId,
        },
        expected,
      );
      return notification;
    };
    const inboxTaskIds = async (session: TestSession, taskId: number): Promise<number[]> => {
      const inbox = await apiRequest(session, "/notifications");
      assert.equal(inbox.status, 200, JSON.stringify(inbox));
      assert.ok(Array.isArray(inbox.body));
      return (inbox.body as Array<{ id?: unknown; entityType?: unknown; entityId?: unknown }>)
        .filter((notification) =>
          notification.entityType === "workspace_task"
          && notification.entityId === String(taskId)
        )
        .map(({ id }) => {
          assert.equal(typeof id, "number");
          return id as number;
        });
    };

    try {
      for (const session of [workerSession, replacementSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }
      const community = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `Live task notifications ${randomUUID().slice(0, 8)}`,
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

      const workerSocket = await openWebSocket(workerSession);
      const replacementSocket = await openWebSocket(replacementSession);
      sockets.push(workerSocket, replacementSocket);
      await Promise.all([
        waitForProfileStatus(workerSession.userId, "online"),
        waitForProfileStatus(replacementSession.userId, "online"),
      ]);

      const title = `Live task ${randomUUID().slice(0, 8)}`;
      const assignedBody = `You were assigned the task “${title}”.`;
      const initialLive = taskEvents(workerSocket, assignedBody);
      const created = await apiRequest(ownerSession, `/communities/${communityId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, assignedTo: workerSession.userId }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const taskId = (created.body as { id?: unknown }).id as number;
      assert.equal(typeof taskId, "number");
      const workerNotificationIds: number[] = [];
      const replacementNotificationIds: number[] = [];
      workerNotificationIds.push(assertSingleLiveNotification(await initialLive, {
        userId: workerSession.userId,
        type: "task_assigned",
        body: assignedBody,
        entityType: "workspace_task",
        entityId: String(taskId),
      }).id);
      assert.deepEqual(await inboxTaskIds(workerSession, taskId), workerNotificationIds);

      const removedBody = `You are no longer assigned the task “${title}”.`;
      const workerReassignmentLive = taskEvents(workerSocket, removedBody);
      const replacementReassignmentLive = taskEvents(replacementSocket, assignedBody);
      const reassigned = await apiRequest(
        ownerSession,
        `/communities/${communityId}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ assignedTo: replacementSession.userId }),
        },
      );
      assert.equal(reassigned.status, 200, JSON.stringify(reassigned));
      workerNotificationIds.push(assertSingleLiveNotification(await workerReassignmentLive, {
        userId: workerSession.userId,
        type: "task_updated",
        body: removedBody,
        entityType: "workspace_task",
        entityId: String(taskId),
      }).id);
      replacementNotificationIds.push(assertSingleLiveNotification(await replacementReassignmentLive, {
        userId: replacementSession.userId,
        type: "task_assigned",
        body: assignedBody,
        entityType: "workspace_task",
        entityId: String(taskId),
      }).id);

      for (const [status, label] of [
        ["waiting", "Waiting"],
        ["completed", "Completed"],
        ["cancelled", "Cancelled"],
      ] as const) {
        const body = `Task “${title}” moved to ${label}.`;
        const statusLive = taskEvents(replacementSocket, body);
        const changed = await apiRequest(
          ownerSession,
          `/communities/${communityId}/tasks/${taskId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status }),
          },
        );
        assert.equal(changed.status, 200, JSON.stringify(changed));
        replacementNotificationIds.push(assertSingleLiveNotification(await statusLive, {
          userId: replacementSession.userId,
          type: "task_updated",
          body,
          entityType: "workspace_task",
          entityId: String(taskId),
        }).id);
      }

      assert.equal(new Set(workerNotificationIds).size, workerNotificationIds.length);
      assert.equal(new Set(replacementNotificationIds).size, replacementNotificationIds.length);
      assert.deepEqual(
        [...await inboxTaskIds(workerSession, taskId)].sort((a, b) => a - b),
        [...workerNotificationIds].sort((a, b) => a - b),
      );
      assert.deepEqual(
        [...await inboxTaskIds(replacementSession, taskId)].sort((a, b) => a - b),
        [...replacementNotificationIds].sort((a, b) => a - b),
      );

      closeWebSocket(workerSocket);
      closeWebSocket(replacementSocket);
      const reconnectedWorkerSocket = await openWebSocket(workerSession);
      const reconnectedReplacementSocket = await openWebSocket(replacementSession);
      sockets.push(reconnectedWorkerSocket, reconnectedReplacementSocket);
      const knownIds = new Set([...workerNotificationIds, ...replacementNotificationIds]);
      const isReplayedTaskNotification = (event: Record<string, unknown>): boolean => {
        const notification = notificationFromEvent(event);
        return notification !== null && knownIds.has(notification.id);
      };
      const replayedWorkerEvents = collectWebSocketEvents(
        reconnectedWorkerSocket,
        isReplayedTaskNotification,
        750,
      );
      const replayedReplacementEvents = collectWebSocketEvents(
        reconnectedReplacementSocket,
        isReplayedTaskNotification,
        750,
      );
      for (const id of workerNotificationIds) {
        const read = await apiRequest(workerSession, `/notifications/${id}/read`, { method: "POST" });
        assert.equal(read.status, 200, JSON.stringify(read));
      }
      for (const id of replacementNotificationIds) {
        const read = await apiRequest(replacementSession, `/notifications/${id}/read`, { method: "POST" });
        assert.equal(read.status, 200, JSON.stringify(read));
      }
      for (let reload = 0; reload < 2; reload += 1) {
        assert.deepEqual(
          [...await inboxTaskIds(workerSession, taskId)].sort((a, b) => a - b),
          [...workerNotificationIds].sort((a, b) => a - b),
        );
        assert.deepEqual(
          [...await inboxTaskIds(replacementSession, taskId)].sort((a, b) => a - b),
          [...replacementNotificationIds].sort((a, b) => a - b),
        );
      }
      assert.deepEqual(await replayedWorkerEvents, []);
      assert.deepEqual(await replayedReplacementEvents, []);
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
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

  test("rejects valid resource IDs from another workspace on reads and writes", async () => {
    const workspaces: number[] = [];
    const foreignEmployee = await createTestSession("foreign_workspace_employee");
    const originalFetch = globalThis.fetch;
    const resources: Array<{
      task: number; attachment: number; document: number; version: number;
      department: number; location: number; team: number; invitation: number;
      category: number; announcement: number; announcementAttachment: number;
      folder: number; channel: number; policy: number;
    }> = [];
    const owner = adminSession.userId;
    const employee = memberSession.userId;
    const file = { objectPath: `/objects/uploads/${randomUUID()}`, fileName: "scope.txt", contentType: "text/plain", fileSize: 1 };
    const json = (body: object, method = "POST"): RequestInit => ({
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const insertId = async (sql: string, params: unknown[]): Promise<number> => {
      const result = await pool.query<{ id: number }>(sql, params);
      assert.equal(result.rowCount, 1);
      return result.rows[0].id;
    };

    try {
      assert.equal((await apiRequest(foreignEmployee, "/me")).status, 200);
      for (const label of ["home", "foreign"]) {
        const workspace = await insertId(
          `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
           VALUES ($1, $2, $3, 'paid_workspace', true) RETURNING id`,
          [`Isolation ${label}`, `isolation-${randomUUID()}`, owner],
        );
        workspaces.push(workspace);
        await pool.query(
          `INSERT INTO irc_community_members (community_id, user_id, status)
           VALUES ($1, $2, 'owner'), ($1, $3, 'member') ON CONFLICT DO NOTHING`,
          [workspace, owner, employee],
        );
        await pool.query(
          `INSERT INTO irc_employee_profiles (community_id, user_id)
           VALUES ($1, $2)`,
          [workspace, employee],
        );
        if (label === "foreign") {
          await pool.query(
            "INSERT INTO irc_community_members (community_id, user_id, status) VALUES ($1, $2, 'member')",
            [workspace, foreignEmployee.userId],
          );
          await pool.query(
            "INSERT INTO irc_employee_profiles (community_id, user_id) VALUES ($1, $2)",
            [workspace, foreignEmployee.userId],
          );
        }
        const department = await insertId(
          "INSERT INTO irc_departments (community_id, name) VALUES ($1, $2) RETURNING id",
          [workspace, `${label} department`],
        );
        const location = await insertId(
          "INSERT INTO irc_locations (community_id, name) VALUES ($1, $2) RETURNING id",
          [workspace, `${label} location`],
        );
        const team = await insertId(
          "INSERT INTO irc_teams (community_id, department_id, location_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
          [workspace, department, location, `${label} team`],
        );
        const category = await insertId(
          "INSERT INTO irc_categories (community_id, owner_id, name) VALUES ($1, $2, $3) RETURNING id",
          [workspace, owner, `${label}-${randomUUID()}`],
        );
        const channel = await insertId(
          "INSERT INTO irc_channels (community_id, category_id, owner_id, name) VALUES ($1, $2, $3, $4) RETURNING id",
          [workspace, category, owner, `#scope-${randomUUID().slice(0, 8)}`],
        );
        const folder = await insertId(
          "INSERT INTO irc_document_folders (community_id, name, created_by) VALUES ($1, $2, $3) RETURNING id",
          [workspace, `${label} folder`, owner],
        );
        const task = await insertId(
          "INSERT INTO irc_workspace_tasks (community_id, title, created_by) VALUES ($1, $2, $3) RETURNING id",
          [workspace, `${label} task`, owner],
        );
        const attachment = await insertId(
          `INSERT INTO irc_workspace_task_attachments
           (task_id, uploader_id, object_path, file_name, content_type, file_size)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [task, owner, file.objectPath, file.fileName, file.contentType, file.fileSize],
        );
        const document = await insertId(
          "INSERT INTO irc_business_documents (community_id, title, owner_id, requires_acknowledgement) VALUES ($1, $2, $3, true) RETURNING id",
          [workspace, `${label} document`, owner],
        );
        const version = await insertId(
          `INSERT INTO irc_document_versions
           (document_id, version, object_path, file_name, content_type, file_size, uploaded_by)
           VALUES ($1, 1, $2, $3, $4, $5, $6) RETURNING id`,
          [document, file.objectPath, file.fileName, file.contentType, file.fileSize, owner],
        );
        const invitation = await insertId(
          `INSERT INTO irc_workspace_invitations
           (community_id, email, invited_by, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '1 day') RETURNING id`,
          [workspace, `${randomUUID()}@example.test`, owner, createHash("sha256").update(randomUUID()).digest("hex")],
        );
        const announcement = await insertId(
          "INSERT INTO irc_server_announcements (community_id, author_id, title, body) VALUES ($1, $2, $3, 'Scope fixture') RETURNING id",
          [workspace, owner, `${label} announcement`],
        );
        const announcementAttachment = await insertId(
          `INSERT INTO irc_announcement_attachments
           (announcement_id, uploader_id, object_path, file_name, content_type, file_size)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [announcement, owner, file.objectPath, file.fileName, file.contentType, file.fileSize],
        );
        const policy = await insertId(
          "INSERT INTO irc_workspace_policies (community_id, title, body, created_by) VALUES ($1, $2, 'Scope fixture', $3) RETURNING id",
          [workspace, `${label} policy`, owner],
        );
        resources.push({
          task, attachment, document, version, department, location, team,
          invitation, category, announcement, announcementAttachment, folder, channel, policy,
        });
      }
      const [home, foreign] = workspaces;
      const [own, other] = resources;
      const homePath = `/communities/${home}`;

      // Signed downloads must prove that the authorized route reaches storage,
      // without relying on an external signer or following the redirect.
      globalThis.fetch = async (input, init) => {
        const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (requestUrl === "http://127.0.0.1:1106/object-storage/signed-object-url") {
          return new Response(JSON.stringify({ signed_url: "https://storage.example/scope" }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };

      // Both sides are real, readable resources, and this actor can manage both workspaces.
      for (const [workspace, data] of [[home, own], [foreign, other]] as const) {
        const detail = await apiRequest(adminSession, `/communities/${workspace}`);
        assert.equal(detail.status, 200, JSON.stringify(detail));
        const body = detail.body as Record<string, Array<{ id?: number; userId?: string }>>;
        for (const [key, id] of Object.entries({
          departments: data.department, locations: data.location, teams: data.team,
          invitations: data.invitation, categories: data.category,
          announcements: data.announcement, policies: data.policy, tasks: data.task,
        })) {
          assert.ok(body[key]?.some((row) => row.id === id), `${key} fixture must be visible in workspace ${workspace}`);
        }
        assert.ok(body.employees?.some((row) => row.userId === employee), "employee fixture must be visible");
        assert.ok(body.channels?.some((row) => row.id === data.channel));
        const task = await apiRequest(adminSession, `/communities/${workspace}/tasks/${data.task}`);
        assert.equal(task.status, 200, JSON.stringify(task));
        assert.ok((task.body as { attachments: Array<{ id: number }> }).attachments.some((a) => a.id === data.attachment));
        const documents = await apiRequest(adminSession, `/communities/${workspace}/documents`);
        assert.equal(documents.status, 200, JSON.stringify(documents));
        assert.ok((documents.body as { documents: Array<{ id: number }> }).documents.some((d) => d.id === data.document));
        for (const path of [
          `/communities/${workspace}/tasks/${data.task}/attachments/${data.attachment}`,
          `/communities/${workspace}/announcements/${data.announcement}/attachments/${data.announcementAttachment}`,
          `/communities/${workspace}/documents/${data.document}/download/${data.version}`,
        ]) {
          const download = await apiRequest(adminSession, path, { redirect: "manual" });
          assert.equal(download.status, 302, `${path}: ${JSON.stringify(download)}`);
        }
      }

      for (const [label, path, init, expected] of [
        ["task comment", `${homePath}/tasks/${own.task}/comments`, json({ body: "Home comment" }), 201],
        ["task attachment", `${homePath}/tasks/${own.task}/attachments`, json(file), 201],
        ["announcement read", `${homePath}/announcements/${own.announcement}/read`, { method: "POST" }, 200],
        ["announcement attachment", `${homePath}/announcements/${own.announcement}/attachments`, json(file), 201],
        ["document acknowledgement", `${homePath}/documents/${own.document}/acknowledge`, { method: "POST" }, 200],
        ["policy acknowledgement", `${homePath}/policies/${own.policy}/acknowledge`, { method: "POST" }, 200],
      ] as Array<[string, string, RequestInit, number]>) {
        const response = await apiRequest(adminSession, path, init);
        assert.equal(response.status, expected, `${label} positive control: ${JSON.stringify(response)}`);
      }

      const homeDetail = await apiRequest(adminSession, homePath);
      const homeBody = homeDetail.body as Record<string, Array<{ id?: number; userId?: string }>>;
      assert.ok(!homeBody.employees?.some((row) => row.userId === foreignEmployee.userId));
      for (const [key, id] of Object.entries({
        departments: other.department, locations: other.location, teams: other.team,
        invitations: other.invitation, categories: other.category,
        announcements: other.announcement, policies: other.policy, tasks: other.task,
      })) {
        assert.ok(!homeBody[key]?.some((row) => row.id === id), `${key} leaked into home workspace`);
      }
      const homeDocuments = await apiRequest(adminSession, `${homePath}/documents`);
      assert.ok(!(homeDocuments.body as { documents: Array<{ id: number }> }).documents.some((d) => d.id === other.document));
      assert.ok(!(homeDocuments.body as { folders: Array<{ id: number }> }).folders.some((f) => f.id === other.folder));

      const cases: Array<[string, string, RequestInit | undefined, number]> = [
        ["task read", `${homePath}/tasks/${other.task}`, undefined, 404],
        ["task write", `${homePath}/tasks/${other.task}`, json({ status: "in_progress" }, "PATCH"), 404],
        ["task comment", `${homePath}/tasks/${other.task}/comments`, json({ body: "Cross-workspace" }), 404],
        ["task attachment write", `${homePath}/tasks/${other.task}/attachments`, json(file), 404],
        ["task attachment read", `${homePath}/tasks/${other.task}/attachments/${other.attachment}`, undefined, 404],
        ["mismatched attachment", `${homePath}/tasks/${own.task}/attachments/${other.attachment}`, undefined, 404],
        ["document version read", `${homePath}/documents/${other.document}/download/${other.version}`, undefined, 404],
        ["mismatched document version", `${homePath}/documents/${own.document}/download/${other.version}`, undefined, 404],
        ["document version write", `${homePath}/documents/${other.document}/versions`, json(file), 404],
        ["document acknowledgement", `${homePath}/documents/${other.document}/acknowledge`, { method: "POST" }, 404],
        ["document permission", `${homePath}/documents/${other.document}/permissions`, json({ userId: employee, permission: "viewer" }), 400],
        ["foreign document folder", `${homePath}/documents`, json({ ...file, title: "Invalid folder", folderId: other.folder }), 400],
        ["employee update", `${homePath}/employees/${employee}/organization`, json({ departmentId: other.department }, "PATCH"), 400],
        ["foreign employee update", `${homePath}/employees/${foreignEmployee.userId}`, json({ jobTitle: "Wrong workspace" }, "PATCH"), 404],
        ["foreign employee assignment", `${homePath}/employees/${foreignEmployee.userId}/organization`, json({ departmentId: own.department }, "PATCH"), 404],
        ["foreign department manager", `${homePath}/departments/${other.department}/manager`, json({ managerId: employee }, "PATCH"), 404],
        ["foreign team manager", `${homePath}/teams/${other.team}/manager`, json({ managerId: employee }, "PATCH"), 404],
        ["foreign team member", `${homePath}/teams/${other.team}/members/${employee}`, json({ role: "member" }, "PUT"), 404],
        ["foreign department team", `${homePath}/teams`, json({ name: "Wrong department", departmentId: other.department }), 400],
        ["foreign location team", `${homePath}/teams`, json({ name: "Wrong location", locationId: other.location }), 400],
        ["foreign invitation", `${homePath}/invitations/${other.invitation}/revoke`, { method: "POST" }, 404],
        ["foreign invitation resend", `${homePath}/invitations/${other.invitation}/resend`, { method: "POST" }, 404],
        ["foreign category", `${homePath}/categories/${other.category}`, { method: "DELETE" }, 404],
        ["foreign category update", `${homePath}/categories/${other.category}`, json({ name: "wrong-workspace" }, "PATCH"), 404],
        ["foreign announcement read", `${homePath}/announcements/${other.announcement}/read`, { method: "POST" }, 404],
        ["foreign announcement delete", `${homePath}/announcements/${other.announcement}`, { method: "DELETE" }, 404],
        ["foreign announcement attachment", `${homePath}/announcements/${other.announcement}/attachments/${other.announcementAttachment}`, undefined, 404],
        ["mismatched announcement attachment", `${homePath}/announcements/${own.announcement}/attachments/${other.announcementAttachment}`, undefined, 404],
        ["foreign announcement attachment write", `${homePath}/announcements/${other.announcement}/attachments`, json(file), 404],
        ["foreign announcement audience", `${homePath}/announcements`, json({ body: "Wrong audience", audienceType: "team", teamId: other.team }), 400],
        ["foreign policy", `${homePath}/policies/${other.policy}/acknowledge`, { method: "POST" }, 404],
        ["foreign role category", "/admin/role-assignments", json({
          userId: employee, role: "department_admin", scopeType: "category",
          communityId: home, categoryId: other.category,
        }), 400],
        ["foreign role channel", "/admin/role-assignments", json({
          userId: employee, role: "moderator", scopeType: "channel",
          communityId: home, categoryId: own.category, channelId: other.channel,
        }), 400],
      ];
      for (const [label, path, init, expected] of cases) {
        const response = await apiRequest(adminSession, path, init);
        assert.equal(response.status, expected, `${label}: ${JSON.stringify(response)}`);
      }
      assert.deepEqual(
        (await pool.query("SELECT status FROM irc_workspace_tasks WHERE id = $1", [other.task])).rows,
        [{ status: "todo" }],
      );
      assert.deepEqual(
        (await pool.query("SELECT status FROM irc_workspace_invitations WHERE id = $1", [other.invitation])).rows,
        [{ status: "pending" }],
      );
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM irc_user_roles WHERE user_id = $1 AND community_id = $2 AND category_id = $3", [employee, home, other.category])).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM irc_document_versions WHERE document_id = $1", [other.document])).rows[0].count, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM irc_team_members WHERE team_id = $1", [other.team])).rows[0].count, 0);
      const validRole = await apiRequest(adminSession, "/admin/role-assignments", json({
        userId: employee, role: "moderator", scopeType: "channel",
        communityId: home, categoryId: own.category, channelId: own.channel,
      }));
      assert.equal(validRole.status, 201, `role-scope positive control: ${JSON.stringify(validRole)}`);
    } finally {
      globalThis.fetch = originalFetch;
      if (workspaces.length) {
        await pool.query("DELETE FROM irc_communities WHERE id = ANY($1::int[])", [workspaces]);
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
        await pool.query(
          `INSERT INTO irc_moderation_actions
             (actor_id, channel_id, action, details)
           VALUES ($1, $2, 'test_delete_history', $3)`,
          [ownerSession.userId, channelId, suffix],
        );
      }

      const ownerDeletedId = channelIds[0];
      const ownerDeleted = await apiRequest(ownerSession, `/channels/${channelIds[0]}`, {
        method: "DELETE",
      });
      assert.equal(ownerDeleted.status, 200, JSON.stringify(ownerDeleted));
      assert.equal(
        (await pool.query("SELECT 1 FROM irc_moderation_actions WHERE channel_id = $1", [ownerDeletedId])).rowCount,
        0,
      );
      channelIds.shift();

      const adminDeletedId = channelIds[0];
      const adminDeleted = await apiRequest(adminSession, `/channels/${channelIds[0]}`, {
        method: "DELETE",
      });
      assert.equal(adminDeleted.status, 200, JSON.stringify(adminDeleted));
      assert.equal(
        (await pool.query("SELECT 1 FROM irc_moderation_actions WHERE channel_id = $1", [adminDeletedId])).rowCount,
        0,
      );
      channelIds.shift();
    } finally {
      for (const channelId of channelIds) {
        await pool.query("DELETE FROM irc_channel_members WHERE channel_id = $1", [channelId]);
        await pool.query("DELETE FROM irc_channels WHERE id = $1", [channelId]);
      }
    }
  });

  test("deletes every categorized channel and its dependencies, but preserves everything on denial or transaction failure", async () => {
    const ownerSession = await createTestSession("category_delete_atomic");
    const workspaceName = `Atomic delete ${randomUUID().slice(0, 8)}`;
    let communityId: number | null = null;
    let triggerName: string | null = null;
    let functionName: string | null = null;
    let cleanupTriggerName: string | null = null;
    let cleanupFunctionName: string | null = null;
    const objectPaths: string[] = [];
    try {
      assert.equal((await apiRequest(ownerSession, "/me")).status, 200);
      assert.equal((await apiRequest(firstSession, "/me")).status, 200);
      assert.equal((await apiRequest(secondSession, "/me")).status, 200);
      const community = await apiRequest(ownerSession, "/communities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: workspaceName, isPrivate: true }),
      });
      assert.equal(community.status, 201, JSON.stringify(community));
      communityId = (community.body as { id: number }).id;

      const createCategoryWithChannels = async (label: string) => {
        const category = await apiRequest(ownerSession, `/communities/${communityId}/categories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: label }),
        });
        assert.equal(category.status, 201, JSON.stringify(category));
        const categoryId = (category.body as { id: number }).id;
        const categoryName = (category.body as { name: string }).name;
        const channelIds: number[] = [];
        const messageIds: string[] = [];
        const joinRequestIds: number[] = [];
        const paths: string[] = [];
        for (let index = 0; index < 2; index++) {
          const channel = await apiRequest(ownerSession, `/communities/${communityId}/channels`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: `${label}-${index}`, categoryId }),
          });
          assert.equal(channel.status, 201, JSON.stringify(channel));
          const channelId = (channel.body as { id: number }).id;
          channelIds.push(channelId);
          const path = `/objects/category-delete/${randomUUID()}`;
          paths.push(path);
          objectPaths.push(path);
          const message = await pool.query<{ id: string }>(
            "INSERT INTO irc_messages (channel_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id",
            [channelId, ownerSession.userId, `Message ${index}`],
          );
          const messageId = message.rows[0].id;
          messageIds.push(messageId);
          const request = await pool.query<{ id: number }>(
            "INSERT INTO irc_channel_join_requests (channel_id, user_id) VALUES ($1, $2) RETURNING id",
            [channelId, secondSession.userId],
          );
          joinRequestIds.push(request.rows[0].id);
          await pool.query(
            `INSERT INTO irc_channel_invites (channel_id, user_id, invited_by) VALUES ($1, $2, $3)`,
            [channelId, secondSession.userId, ownerSession.userId],
          );
          await pool.query(
            `INSERT INTO irc_message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')`,
            [messageId, secondSession.userId],
          );
          await pool.query(
            `INSERT INTO irc_message_attachments (message_id, uploader_id, object_path, file_name, content_type, file_size)
             VALUES ($1, $2, $3, 'test.txt', 'text/plain', 4)`,
            [messageId, ownerSession.userId, path],
          );
          await pool.query(
            `INSERT INTO irc_moderation_actions (actor_id, community_id, channel_id, action, details)
             VALUES ($1, $2, $3, 'test_history', $4)`,
            [ownerSession.userId, communityId, channelId, label],
          );
          await pool.query(
            `INSERT INTO irc_notifications (user_id, type, category, body, entity_type, entity_id)
             VALUES ($1, 'test', 'community', 'Channel notice', 'channel', $2),
                    ($1, 'test', 'community', 'Request notice', 'channel_join_request', $3)`,
            [secondSession.userId, String(channelId), String(request.rows[0].id)],
          );
        }
        return { categoryId, categoryName, channelIds, messageIds, joinRequestIds, paths };
      };

      type Fixture = Awaited<ReturnType<typeof createCategoryWithChannels>>;
      const snapshot = async (fixture: Fixture) => (await pool.query(
        `SELECT
           (SELECT count(*)::int FROM irc_categories WHERE id = $1) AS categories,
           (SELECT count(*)::int FROM irc_channels WHERE id = ANY($2::int[]) AND category_id = $1) AS channels,
           (SELECT count(*)::int FROM irc_messages WHERE id = ANY($3::uuid[])) AS messages,
           (SELECT count(*)::int FROM irc_channel_members WHERE channel_id = ANY($2::int[])) AS memberships,
           (SELECT count(*)::int FROM irc_channel_join_requests WHERE id = ANY($4::int[])) AS requests,
           (SELECT count(*)::int FROM irc_channel_invites WHERE channel_id = ANY($2::int[])) AS invitations,
           (SELECT count(*)::int FROM irc_message_reactions WHERE message_id = ANY($3::uuid[])) AS reactions,
           (SELECT count(*)::int FROM irc_message_attachments WHERE message_id = ANY($3::uuid[])) AS attachments,
           (SELECT count(*)::int FROM irc_moderation_actions WHERE channel_id = ANY($2::int[])) AS moderation,
           (SELECT count(*)::int FROM irc_notifications
             WHERE (entity_type = 'channel' AND entity_id = ANY($5::text[]))
                OR (entity_type = 'channel_join_request' AND entity_id = ANY($6::text[]))) AS notifications,
           (SELECT count(*)::int FROM irc_workspace_object_deletion_jobs WHERE object_path = ANY($7::text[])) AS jobs,
           (SELECT count(*)::int FROM irc_admin_audit_logs
             WHERE action = 'deleted_community_category_with_channels' AND target_id = $8) AS deletion_audits`,
        [
          fixture.categoryId, fixture.channelIds, fixture.messageIds, fixture.joinRequestIds,
          fixture.channelIds.map(String), fixture.joinRequestIds.map(String), fixture.paths, String(communityId),
        ],
      )).rows[0] as Record<string, number>;
      const deleteCategory = (session: TestSession, fixture: Fixture, confirmation: string) =>
        apiRequest(session, `/communities/${communityId}/categories/${fixture.categoryId}/with-channels`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation }),
        });
      const confirmationFor = (fixture: Fixture) =>
        `DELETE CATEGORY ${fixture.categoryName} AND CHANNELS FROM WORKSPACE ${workspaceName}`;

      const deletedFixture = await createCategoryWithChannels(`Delete ${randomUUID().slice(0, 8)}`);
      const beforeDeletion = await snapshot(deletedFixture);
      assert.deepEqual(beforeDeletion, {
        categories: 1, channels: 2, messages: 2, memberships: 2, requests: 2,
        invitations: 2, reactions: 2, attachments: 2, moderation: 2,
        notifications: 4, jobs: 0, deletion_audits: 0,
      });
      const wrongConfirmation = await deleteCategory(ownerSession, deletedFixture, "DELETE CATEGORY wrong");
      assert.equal(wrongConfirmation.status, 400, JSON.stringify(wrongConfirmation));
      assert.deepEqual(await snapshot(deletedFixture), beforeDeletion);
      const notOwner = await deleteCategory(firstSession, deletedFixture, confirmationFor(deletedFixture));
      assert.equal(notOwner.status, 403, JSON.stringify(notOwner));
      assert.deepEqual(await snapshot(deletedFixture), beforeDeletion);

      const deleted = await deleteCategory(ownerSession, deletedFixture, confirmationFor(deletedFixture));
      assert.equal(deleted.status, 200, JSON.stringify(deleted));
      assert.deepEqual(deleted.body, {
        ok: true, categoryId: deletedFixture.categoryId, deletedChannelCount: 2,
        cleanupPending: true, cleanupPendingCount: 2,
      });
      assert.deepEqual(await snapshot(deletedFixture), {
        categories: 0, channels: 0, messages: 0, memberships: 0, requests: 0,
        invitations: 0, reactions: 0, attachments: 0, moderation: 0,
        notifications: 0, jobs: 2, deletion_audits: 1,
      });
      const jobs = await pool.query<{ object_path: string; status: string; context: string }>(
        "SELECT object_path, status, context FROM irc_workspace_object_deletion_jobs WHERE object_path = ANY($1::text[]) ORDER BY object_path",
        [deletedFixture.paths],
      );
      assert.deepEqual(jobs.rows, deletedFixture.paths.sort().map((path) => ({
        object_path: path, status: "pending", context: `category:${deletedFixture.categoryId}`,
      })));

      const rollbackFixture = await createCategoryWithChannels(`Rollback ${randomUUID().slice(0, 8)}`);
      const beforeFailure = await snapshot(rollbackFixture);
      triggerName = `fail_destructive_audit_${randomUUID().replaceAll("-", "")}`;
      functionName = `${triggerName}_fn`;
      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action IN (
             'deleted_community_category_with_channels',
             'deleted_community_channel'
           ) THEN
             RAISE EXCEPTION 'forced destructive audit failure';
           END IF;
           RETURN NEW;
         END;
         $$;
         CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON irc_admin_audit_logs
         FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
      );
       const failed = await deleteCategory(ownerSession, rollbackFixture, confirmationFor(rollbackFixture));
      assert.equal(failed.status, 500, JSON.stringify(failed));
       assert.deepEqual(await snapshot(rollbackFixture), beforeFailure);
       await pool.query(
         `DROP TRIGGER "${triggerName}" ON irc_admin_audit_logs;
          DROP FUNCTION "${functionName}"();`,
       );
       triggerName = null;
       functionName = null;

       const cleanupFixture = await createCategoryWithChannels(`Cleanup ${randomUUID().slice(0, 8)}`);
       const beforeCleanupFailure = await snapshot(cleanupFixture);
       cleanupTriggerName = `fail_category_cleanup_${randomUUID().replaceAll("-", "")}`;
       cleanupFunctionName = `${cleanupTriggerName}_fn`;
       await pool.query(
         `CREATE FUNCTION "${cleanupFunctionName}"() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.context = 'category:${cleanupFixture.categoryId}' THEN
              RAISE EXCEPTION 'forced cleanup enqueue failure';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER "${cleanupTriggerName}"
          BEFORE INSERT ON irc_workspace_object_deletion_jobs
          FOR EACH ROW EXECUTE FUNCTION "${cleanupFunctionName}"();`,
       );
       const cleanupFailed = await deleteCategory(ownerSession, cleanupFixture, confirmationFor(cleanupFixture));
       assert.equal(cleanupFailed.status, 500, JSON.stringify(cleanupFailed));
       assert.deepEqual(await snapshot(cleanupFixture), beforeCleanupFailure);
    } finally {
      if (cleanupTriggerName && cleanupFunctionName) {
        await pool.query(
          `DROP TRIGGER IF EXISTS "${cleanupTriggerName}" ON irc_workspace_object_deletion_jobs;
           DROP FUNCTION IF EXISTS "${cleanupFunctionName}"();`,
        );
      }
      if (triggerName && functionName) {
        await pool.query(
          `DROP TRIGGER IF EXISTS "${triggerName}" ON irc_admin_audit_logs;
           DROP FUNCTION IF EXISTS "${functionName}"();`,
        );
      }
      if (communityId !== null) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
      if (objectPaths.length) {
        await pool.query("DELETE FROM irc_workspace_object_deletion_jobs WHERE object_path = ANY($1::text[])", [objectPaths]);
      }
    }
  });

  test("rolls back policy publication and notifications on database failures and retries cleanly", async () => {
    const owner = await createTestSession("policy_atomic");
    assert.equal((await apiRequest(owner, "/me")).status, 200);
    const created = await apiRequest(owner, "/communities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Policy atomicity", slug: `policy-${randomUUID().slice(0, 12)}` }),
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const communityId = (created.body as { id: number }).id;
    assert.ok(Number.isInteger(communityId));
    const publish = () => apiRequest(owner, `/communities/${communityId}/policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Safety policy", body: "Read and acknowledge." }),
    });
    const snapshot = async () => (await pool.query(
      `SELECT
        (SELECT count(*)::int FROM irc_workspace_policies WHERE community_id = $1) AS policies,
        (SELECT count(*)::int FROM irc_admin_audit_logs WHERE community_id = $1) AS audits,
        (SELECT count(*)::int FROM irc_notifications WHERE community_id = $1) AS notifications`,
      [communityId],
    )).rows[0];
    const before = await snapshot();
    const broadcasts = mock.method(wsHub, "broadcastUser", () => {});
    try {
      for (const [table, condition] of [
        ["irc_admin_audit_logs", "NEW.action = 'published_workspace_policy'"],
        ["irc_notifications", "NEW.type = 'document_acknowledgement'"],
        ["irc_notifications", "NEW.type = 'administrative_action'"],
      ]) {
        const trigger = `fail_policy_${randomUUID().replaceAll("-", "")}`;
        try {
          await pool.query(
            `CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.community_id = ${communityId} AND ${condition} THEN
                 RAISE EXCEPTION 'forced policy publication failure';
               END IF;
               RETURN NEW;
             END; $$;
             CREATE TRIGGER "${trigger}" BEFORE INSERT ON ${table}
             FOR EACH ROW EXECUTE FUNCTION "${trigger}"();`,
          );
          broadcasts.mock.resetCalls();
          assert.equal((await publish()).status, 500);
          assert.deepEqual(await snapshot(), before);
          assert.equal(broadcasts.mock.callCount(), 0, "uncommitted notifications must not be broadcast");
        } finally {
          await pool.query(`DROP TRIGGER IF EXISTS "${trigger}" ON ${table}; DROP FUNCTION IF EXISTS "${trigger}"();`);
        }
      }
      broadcasts.mock.resetCalls();
      const retry = await publish();
      assert.equal(retry.status, 201, JSON.stringify(retry));
      assert.equal((retry.body as { version: number }).version, 1);
      const after = await snapshot();
      assert.equal(after.policies, before.policies + 1);
      assert.equal(after.audits, before.audits + 1);
      const notices = (await pool.query(
        `SELECT id, type, entity_id FROM irc_notifications WHERE community_id = $1 AND
         (entity_type = 'workspace_policy' OR (type = 'administrative_action' AND body LIKE 'published workspace policy:%'))`,
        [communityId],
      )).rows;
      assert.equal(notices.filter((n) => n.type === "document_acknowledgement").length, 1);
      assert.equal(notices.filter((n) => n.type === "administrative_action").length, 1);
      assert.equal(after.notifications, before.notifications + notices.length);
      assert.equal(broadcasts.mock.callCount(), notices.length);
      for (const call of broadcasts.mock.calls) {
        const event = call.arguments[1] as { notification: { id: number } };
        assert.ok(notices.some((notice) => notice.id === event.notification.id));
      }
    } finally {
      broadcasts.mock.restore();
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
    const foreignManagerSession = await createTestSession("organization_foreign_manager");
    const communityIds: number[] = [];

    try {
      for (const session of [managerSession, employeeSession, foreignManagerSession]) {
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
        `INSERT INTO irc_community_members (community_id, user_id, status)
         VALUES ($1, $2, 'member')`,
        [foreignCommunityId, foreignManagerSession.userId],
      );
      await pool.query(
        `INSERT INTO irc_employee_profiles (community_id, user_id, employment_status)
         VALUES ($1, $2, 'active')`,
        [foreignCommunityId, foreignManagerSession.userId],
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
      const assignDepartmentManager = await apiRequest(managerSession, `/communities/${communityId}/departments/${departmentId}/manager`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerId: managerSession.userId }),
      });
      assert.equal(assignDepartmentManager.status, 200, JSON.stringify(assignDepartmentManager));
      assert.equal((assignDepartmentManager.body as { managerId?: string }).managerId, managerSession.userId);
      const assignTeamManager = await apiRequest(managerSession, `/communities/${communityId}/teams/${teamId}/manager`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerId: managerSession.userId }),
      });
      assert.equal(assignTeamManager.status, 200, JSON.stringify(assignTeamManager));
      assert.equal((assignTeamManager.body as { managerId?: string }).managerId, managerSession.userId);
      const crossWorkspaceUnitManager = await apiRequest(managerSession, `/communities/${communityId}/departments/${departmentId}/manager`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerId: foreignManagerSession.userId }),
      });
      assert.equal(crossWorkspaceUnitManager.status, 400, JSON.stringify(crossWorkspaceUnitManager));
      const unauthorizedUnitManager = await apiRequest(employeeSession, `/communities/${communityId}/teams/${teamId}/manager`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ managerId: employeeSession.userId }),
      });
      assert.equal(unauthorizedUnitManager.status, 403, JSON.stringify(unauthorizedUnitManager));
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
      const detailBody = detail.body as {
        employees?: Array<{ userId: string; teamIds: number[] }>;
        departments?: Array<{ id: number; managerId: string | null }>;
        teams?: Array<{ id: number; managerId: string | null }>;
      };
      const detailEmployee = detailBody.employees
        ?.find((employee) => employee.userId === employeeSession.userId);
      assert.deepEqual(detailEmployee?.teamIds, [teamId]);
      assert.equal(detailBody.departments?.find((department) => department.id === departmentId)?.managerId, managerSession.userId);
      assert.equal(detailBody.teams?.find((team) => team.id === teamId)?.managerId, managerSession.userId);

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
      const offboardManager = await apiRequest(ownerSession, `/communities/${communityId}/employees/${managerSession.userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employmentStatus: "terminated" }),
      });
      assert.equal(offboardManager.status, 200, JSON.stringify(offboardManager));
      const updatedDirectory = await apiRequest(ownerSession, `/communities/${communityId}`);
      assert.equal(updatedDirectory.status, 200, JSON.stringify(updatedDirectory));
      const updatedDirectoryBody = updatedDirectory.body as {
        employees?: Array<{ userId: string; managerId: string | null }>;
        departments?: Array<{ id: number; managerId: string | null }>;
        teams?: Array<{ id: number; managerId: string | null }>;
      };
      assert.equal(updatedDirectoryBody.departments?.find((department) => department.id === departmentId)?.managerId, null);
      assert.equal(updatedDirectoryBody.teams?.find((team) => team.id === teamId)?.managerId, null);
      assert.equal(updatedDirectoryBody.employees?.find((employee) => employee.userId === employeeSession.userId)?.managerId, null);
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
        code: "CHANNEL_ACCESS_REQUIRED",
      });

      const deniedMembers = await apiRequest(
        requesterSession,
        `/channels/${channelId}/members`,
      );
      assert.equal(deniedMembers.status, 403, JSON.stringify(deniedMembers));
      assert.deepEqual(deniedMembers.body, {
        error: "Join the private channel before viewing its members.",
        code: "CHANNEL_ACCESS_REQUIRED",
      });

      const deniedMessage = await apiRequest(requesterSession, `/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "Not authorized" }),
      });
      assert.equal(deniedMessage.status, 403, JSON.stringify(deniedMessage));
      assert.deepEqual(deniedMessage.body, {
        error: "Join the channel before sending messages.",
        code: "CHANNEL_ACCESS_REQUIRED",
      });

      const deniedFileMessage = await apiRequest(requesterSession, `/channels/${channelId}/file-messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(deniedFileMessage.status, 403, JSON.stringify(deniedFileMessage));
      assert.deepEqual(deniedFileMessage.body, {
        error: "Join the channel before sending messages.",
        code: "CHANNEL_ACCESS_REQUIRED",
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

      const assertReviewDenied = async () => {
        const deniedList = await apiRequest(
          reviewerSession,
          `/channels/${channelId}/join-requests`,
        );
        assert.equal(deniedList.status, 403, JSON.stringify(deniedList));
        assert.deepEqual(deniedList.body, {
          error: "Only channel operators can review join requests.",
        });
        for (const decision of ["approve", "reject"]) {
          const deniedDecision = await apiRequest(
            reviewerSession,
            `/channels/${channelId}/join-requests/${requestId}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ decision }),
            },
          );
          assert.equal(deniedDecision.status, 403, JSON.stringify(deniedDecision));
          assert.deepEqual(deniedDecision.body, {
            error: "Only channel operators can review join requests.",
          });
        }
      };

      await pool.query(
        `UPDATE irc_channel_members
         SET role = 'member'
         WHERE channel_id = $1 AND user_id = $2`,
        [channelId, reviewerSession.userId],
      );
      await assertReviewDenied();

      await pool.query(
        `UPDATE irc_channel_members
         SET role = 'moderator'
         WHERE channel_id = $1 AND user_id = $2`,
        [channelId, reviewerSession.userId],
      );
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

      await assertReviewDenied();

      const stillPending = await pool.query<{ status: string }>(
        `SELECT status
         FROM irc_channel_join_requests
         WHERE id = $1`,
        [requestId],
      );
      assert.deepEqual(stillPending.rows, [{ status: "pending" }]);
      const requesterMembership = await pool.query(
        `SELECT 1 FROM irc_channel_members WHERE channel_id = $1 AND user_id = $2`,
        [channelId, requesterSession.userId],
      );
      assert.equal(requesterMembership.rowCount, 0);

      const recovered = await apiRequest(
        ownerSession,
        `/channels/${channelId}/join-requests/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(recovered.status, 200, JSON.stringify(recovered));
      assert.deepEqual(recovered.body, { ok: true, status: "approved" });
      assert.deepEqual(
        (await pool.query(
          `SELECT role FROM irc_channel_members
           WHERE channel_id = $1 AND user_id = $2`,
          [channelId, requesterSession.userId],
        )).rows,
        [{ role: "member" }],
      );
    } finally {
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        reviewerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("serializes private-room request review with moderator membership revocation", async () => {
    const ownerSession = await createTestSession("moderator_race_owner");
    const reviewerSession = await createTestSession("moderator_race_reviewer");
    const requesterSession = await createTestSession("moderator_race_requester");
    const channelIds: number[] = [];
    const revocation = await pool.connect();

    try {
      const [reviewerProfile, requesterProfile] = await Promise.all([
        apiRequest(reviewerSession, "/me"),
        apiRequest(requesterSession, "/me"),
      ]);
      assert.equal(reviewerProfile.status, 200, JSON.stringify(reviewerProfile));
      assert.equal(requesterProfile.status, 200, JSON.stringify(requesterProfile));

      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `review-race-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
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
      await apiRequest(reviewerSession, "/me");

      const requests = await apiRequest(
        reviewerSession,
        `/channels/${channelId}/join-requests`,
      );
      assert.equal(requests.status, 200, JSON.stringify(requests));
      assert.ok(Array.isArray(requests.body));
      const requestId = (requests.body[0] as { id?: unknown })?.id;
      assert.equal(typeof requestId, "number");

      const waitForMembershipLock = async (): Promise<boolean> => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const waiting = await pool.query(
            `SELECT pid
             FROM pg_stat_activity
             WHERE pid <> pg_backend_pid()
               AND state = 'active'
               AND wait_event_type = 'Lock'
               AND query ILIKE '%irc_channel_members%'`,
          );
          if (waiting.rows.length > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      await revocation.query("BEGIN");
      await revocation.query(
        `SELECT user_id
         FROM irc_channel_members
         WHERE channel_id = $1 AND user_id = $2
         FOR UPDATE`,
        [channelId, reviewerSession.userId],
      );
      const listing = apiRequest(
        reviewerSession,
        `/channels/${channelId}/join-requests`,
      );
      assert.equal(
        await waitForMembershipLock(),
        true,
        "listing should wait for the moderator membership lock",
      );
      await revocation.query(
        `DELETE FROM irc_channel_members
         WHERE channel_id = $1 AND user_id = $2`,
        [channelId, reviewerSession.userId],
      );
      await revocation.query("COMMIT");
      const deniedList = await listing;
      assert.equal(deniedList.status, 403, JSON.stringify(deniedList));

      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'moderator')`,
        [channelId, reviewerSession.userId],
      );
      await revocation.query("BEGIN");
      await revocation.query(
        `SELECT user_id
         FROM irc_channel_members
         WHERE channel_id = $1 AND user_id = $2
         FOR UPDATE`,
        [channelId, reviewerSession.userId],
      );
      const approval = apiRequest(
        reviewerSession,
        `/channels/${channelId}/join-requests/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(
        await waitForMembershipLock(),
        true,
        "approval should wait for the moderator membership lock",
      );
      await revocation.query(
        `DELETE FROM irc_channel_members
         WHERE channel_id = $1 AND user_id = $2`,
        [channelId, reviewerSession.userId],
      );
      await revocation.query("COMMIT");
      const deniedApproval = await approval;
      assert.equal(deniedApproval.status, 403, JSON.stringify(deniedApproval));

      const stillPending = await pool.query<{ status: string }>(
        `SELECT status
         FROM irc_channel_join_requests
         WHERE id = $1`,
        [requestId],
      );
      assert.deepEqual(stillPending.rows, [{ status: "pending" }]);
      const requesterMembership = await pool.query(
        `SELECT 1 FROM irc_channel_members WHERE channel_id = $1 AND user_id = $2`,
        [channelId, requesterSession.userId],
      );
      assert.equal(requesterMembership.rowCount, 0);
    } finally {
      await revocation.query("ROLLBACK").catch(() => undefined);
      revocation.release();
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        reviewerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("rejects channel invites after moderator revocation and while revocation races", async () => {
    const owner = await createTestSession("invite_race_owner");
    const moderator = await createTestSession("invite_race_mod");
    const target = await createTestSession("invite_race_target");
    const channelIds: number[] = [];
    const revocation = await pool.connect();
    const broadcasts: unknown[] = [];
    const broadcast = mock.method(wsHub, "broadcastUser", (...args: unknown[]) => {
      broadcasts.push(args);
    });
    try {
      await apiRequest(moderator, "/me");
      const profile = await apiRequest(target, "/me");
      assert.equal(profile.status, 200, JSON.stringify(profile));
      const created = await apiRequest(owner, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `invite-race-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          isPrivate: true,
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      const channelId = (created.body as { id: number }).id;
      channelIds.push(channelId);
      const invite = (session = moderator) => apiRequest(session, `/channels/${channelId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: (profile.body as { username: string }).username }),
      });
      const grant = () => pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'moderator')
         ON CONFLICT (channel_id, user_id) DO UPDATE SET role = 'moderator'`,
        [channelId, moderator.userId],
      );
      const assertDenied = (response: ApiResponse) => {
        assert.equal(response.status, 403, JSON.stringify(response));
        assert.deepEqual(response.body, { error: "Only channel operators can invite users." });
      };
      for (const revoke of [
        `DELETE FROM irc_channel_members WHERE channel_id = $1 AND user_id = $2`,
        `UPDATE irc_channel_members SET role = 'member' WHERE channel_id = $1 AND user_id = $2`,
      ]) {
        await grant();
        await pool.query(revoke, [channelId, moderator.userId]);
        assertDenied(await invite());
        await grant();
        await revocation.query("BEGIN");
        await revocation.query(revoke, [channelId, moderator.userId]);
        const pendingInvite = invite();
        try {
          let blocked = false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const waiting = await revocation.query(
              `SELECT 1 FROM pg_stat_activity
               WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
                 AND query ILIKE '%irc_channel_members%'`,
            );
            if (waiting.rowCount) { blocked = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(blocked, true, "invite must wait for the actor's membership lock");
        } finally {
          await revocation.query("COMMIT");
          assertDenied(await pendingInvite);
        }
      }
      const saved = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM irc_channel_invites WHERE channel_id = $1) AS invites,
           (SELECT count(*)::int FROM irc_notifications
            WHERE user_id = $2 AND type = 'channel_invite' AND entity_id = $3) AS notifications`,
        [channelId, target.userId, String(channelId)],
      );
      assert.deepEqual(saved.rows, [{ invites: 0, notifications: 0 }]);
      assert.equal(broadcasts.length, 0);
      await grant();
      assert.equal((await invite()).status, 201);
      const successful = await pool.query(
        `SELECT invited_by FROM irc_channel_invites WHERE channel_id = $1 AND user_id = $2`,
        [channelId, target.userId],
      );
      assert.deepEqual(successful.rows, [{ invited_by: moderator.userId }]);
      assert.equal(broadcasts.length, 1);
    } finally {
      broadcast.mock.restore();
      await revocation.query("ROLLBACK").catch(() => undefined);
      revocation.release();
      await removeTestChannels(channelIds, [owner.userId, moderator.userId, target.userId]);
    }
  });

  for (const firstOperation of ["approval", "deletion"] as const) {
    test(`serializes private-room deletion with pending approval (${firstOperation} first)`, async () => {
      const ownerSession = await createTestSession("delete_approval_owner");
      const requesterSession = await createTestSession("delete_approval_requester");
      const channelIds: number[] = [];
      const inFlight: Promise<ApiResponse>[] = [];
      const blocker = await pool.connect();
      try {
        const created = await apiRequest(ownerSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `delete-approval-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            isPrivate: true,
          }),
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        const channelId = (created.body as { id: number }).id;
        assert.equal(typeof channelId, "number");
        channelIds.push(channelId);
        const pending = await apiRequest(requesterSession, `/channels/${channelId}/join`, { method: "POST" });
        assert.equal(pending.status, 202, JSON.stringify(pending));
        const requests = await pool.query<{ id: number; status: string }>(
          "SELECT id, status FROM irc_channel_join_requests WHERE channel_id = $1",
          [channelId],
        );
        assert.equal(requests.rows.length, 1);
        assert.equal(requests.rows[0].status, "pending");
        const requestId = requests.rows[0].id;
        const approve = () => apiRequest(ownerSession, `/channels/${channelId}/join-requests/${requestId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        });
        const remove = () => apiRequest(ownerSession, `/channels/${channelId}`, { method: "DELETE" });

        // Pause the first route AFTER it owns the channel row. The second route
        // must then wait on that exact backend, not merely some unrelated lock.
        await blocker.query("BEGIN");
        const { rows: [{ pid: blockerPid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        if (firstOperation === "approval") {
          await blocker.query("SELECT id FROM irc_channel_join_requests WHERE id = $1 FOR UPDATE", [requestId]);
        } else {
          await blocker.query(
            "SELECT user_id FROM irc_channel_members WHERE channel_id = $1 AND user_id = $2 FOR UPDATE",
            [channelId, ownerSession.userId],
          );
        }
        const waitForBlockedBackend = async (blockingPid: number, table: string): Promise<number> => {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const waiting = await pool.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
               WHERE $1::integer = ANY(pg_blocking_pids(pid))
                 AND wait_event_type = 'Lock' AND query ILIKE $2`,
              [blockingPid, `%${table}%`],
            );
            if (waiting.rows.length === 1) return waiting.rows[0].pid;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.fail(`Expected a ${table} query blocked by backend ${blockingPid}`);
        };
        const first = firstOperation === "approval" ? approve() : remove();
        inFlight.push(first);
        const firstPid = await waitForBlockedBackend(
          blockerPid,
          firstOperation === "approval" ? "irc_channel_join_requests" : "irc_channel_members",
        );
        const second = firstOperation === "approval" ? remove() : approve();
        inFlight.push(second);
        await waitForBlockedBackend(firstPid, "irc_channels");
        await blocker.query("COMMIT");
        const [firstResult, secondResult] = await Promise.all([first, second]);
        const approval = firstOperation === "approval" ? firstResult : secondResult;
        const deletion = firstOperation === "deletion" ? firstResult : secondResult;
        assert.equal(deletion.status, 200, JSON.stringify(deletion));
        assert.equal(approval.status, firstOperation === "approval" ? 200 : 404, JSON.stringify(approval));
        if (firstOperation === "approval") {
          assert.deepEqual(approval.body, { ok: true, status: "approved" });
        }
        const assertRoomGone = async () => {
          for (const table of ["irc_channels", "irc_channel_join_requests", "irc_channel_members"]) {
            const rows = await pool.query(
              `SELECT 1 FROM ${table} WHERE ${table === "irc_channels" ? "id" : "channel_id"} = $1`,
              [channelId],
            );
            assert.deepEqual(rows.rows, [], `${table} must be empty for the deleted room`);
          }
        };
        await assertRoomGone();
        const staleApproval = await approve();
        assert.equal(staleApproval.status, 400, JSON.stringify(staleApproval));
        const history = await apiRequest(requesterSession, `/channels/${channelId}/messages`);
        assert.equal(history.status, 404, JSON.stringify(history));
        await assertRoomGone();
      } finally {
        // Always release the barrier and drain HTTP work before deleting fixtures.
        await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.allSettled(inFlight);
        await removeTestChannels(channelIds, [ownerSession.userId, requesterSession.userId]);
      }
    });
  }

  test("removes pending private-room requests when the room is deleted", async () => {
    const ownerSession = await createTestSession("request_cleanup_owner");
    const requesterSession = await createTestSession("request_cleanup_requester");
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      const createPrivateChannel = async (label: string): Promise<number> => {
        const created = await apiRequest(ownerSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `${label}-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
            isPrivate: true,
          }),
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        assert.ok(created.body && typeof created.body === "object");
        const channelId = (created.body as { id?: unknown }).id;
        assert.equal(typeof channelId, "number");
        channelIds.push(channelId as number);
        return channelId as number;
      };
      const channelId = await createPrivateChannel("cleanup");
      const otherChannelId = await createPrivateChannel("cleanup-other");

      const pending = await apiRequest(
        requesterSession,
        `/channels/${channelId}/join`,
        { method: "POST" },
      );
      assert.equal(pending.status, 202, JSON.stringify(pending));
      const beforeDelete = await pool.query<{ id: number }>(
        "SELECT id FROM irc_channel_join_requests WHERE channel_id = $1",
        [channelId],
      );
      assert.equal(beforeDelete.rows.length, 1);
      const staleRequestId = beforeDelete.rows[0].id;

      const otherPending = await apiRequest(
        requesterSession,
        `/channels/${otherChannelId}/join`,
        { method: "POST" },
      );
      assert.equal(otherPending.status, 202, JSON.stringify(otherPending));
      const otherRequests = await apiRequest(
        ownerSession,
        `/channels/${otherChannelId}/join-requests`,
      );
      assert.equal(otherRequests.status, 200, JSON.stringify(otherRequests));
      assert.ok(Array.isArray(otherRequests.body));
      assert.equal(otherRequests.body.length, 1);
      const otherRequestId = (otherRequests.body[0] as { id?: unknown }).id;
      assert.equal(typeof otherRequestId, "number");

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

      const staleRequestApproval = await apiRequest(
        ownerSession,
        `/channels/${otherChannelId}/join-requests/${staleRequestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(staleRequestApproval.status, 404, JSON.stringify(staleRequestApproval));
      assert.deepEqual(staleRequestApproval.body, { error: "Join request not found." });

      const staleChannelApproval = await apiRequest(
        ownerSession,
        `/channels/${channelId}/join-requests/${otherRequestId as number}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(staleChannelApproval.status, 400, JSON.stringify(staleChannelApproval));
      const stillPending = await apiRequest(
        ownerSession,
        `/channels/${otherChannelId}/join-requests`,
      );
      assert.equal(stillPending.status, 200, JSON.stringify(stillPending));
      assert.ok(Array.isArray(stillPending.body));
      assert.deepEqual(
        stillPending.body.map((request) => ({
          id: (request as { id?: unknown }).id,
          status: (request as { status?: unknown }).status,
        })),
        [{ id: otherRequestId, status: "pending" }],
      );
      const requesterMembership = await pool.query(
        `SELECT 1 FROM irc_channel_members
         WHERE channel_id = $1 AND user_id = $2`,
        [otherChannelId, requesterSession.userId],
      );
      assert.deepEqual(requesterMembership.rows, []);

      const deletedHistory = await apiRequest(
        requesterSession,
        `/channels/${channelId}/messages`,
      );
      assert.equal(deletedHistory.status, 404, JSON.stringify(deletedHistory));

      const socket = await openWebSocket(requesterSession);
      sockets.push(socket);
      socket.send(JSON.stringify({ type: "subscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const blockedDeletedRoomSubscription = expectNoWebSocketEvent(
        socket,
        (event) => event.type === "message" && event.channelId === channelId,
      );
      wsHub.broadcastChannel(channelId, { type: "message", channelId });
      await blockedDeletedRoomSubscription;
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("keeps public channel history and live access after leaving", async () => {
    const ownerSession = await createTestSession("leave_public_owner");
    const memberSession = await createTestSession("leave_public_member");
    const channelIds: number[] = [];
    const sockets: WebSocket[] = [];

    try {
      const createChannel = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `leave-public-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          topic: "Public access after leaving",
        }),
      });
      assert.equal(createChannel.status, 201, JSON.stringify(createChannel));
      assert.ok(createChannel.body && typeof createChannel.body === "object");
      const channelId = (createChannel.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      const join = await apiRequest(memberSession, `/channels/${channelId}/join`, {
        method: "POST",
      });
      assert.equal(join.status, 200, JSON.stringify(join));
      assert.deepEqual(join.body, { ok: true, status: "member" });

      const initialMessage = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Public history remains available." }),
        },
      );
      assert.equal(initialMessage.status, 201, JSON.stringify(initialMessage));

      const existingSocket = await openWebSocket(memberSession);
      sockets.push(existingSocket);
      existingSocket.send(JSON.stringify({ type: "subscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const leave = await apiRequest(memberSession, `/channels/${channelId}/leave`, {
        method: "POST",
      });
      assert.equal(leave.status, 200, JSON.stringify(leave));
      assert.deepEqual(leave.body, { ok: true });

      const history = await apiRequest(memberSession, `/channels/${channelId}/messages`);
      assert.equal(history.status, 200, JSON.stringify(history));
      assert.ok(history.body && typeof history.body === "object");
      const messages = (history.body as { messages?: unknown }).messages;
      assert.ok(Array.isArray(messages));
      assert.deepEqual(
        messages.map((message) => (message as { body?: unknown }).body),
        ["Public history remains available."],
      );

      const postLeaveSocket = await openWebSocket(memberSession);
      sockets.push(postLeaveSocket);
      postLeaveSocket.send(JSON.stringify({ type: "subscribe", channelId }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const liveEvent = (event: Record<string, unknown>): boolean =>
        event.type === "message" &&
        Boolean(event.message) &&
        (event.message as { channelId?: unknown }).channelId === channelId;
      const existingSubscriptionEvent = waitForWebSocketEvent(existingSocket, liveEvent);
      const newSubscriptionEvent = waitForWebSocketEvent(postLeaveSocket, liveEvent);
      const liveMessage = await apiRequest(
        ownerSession,
        `/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Public live events remain available." }),
        },
      );
      assert.equal(liveMessage.status, 201, JSON.stringify(liveMessage));
      await Promise.all([existingSubscriptionEvent, newSubscriptionEvent]);
    } finally {
      for (const socket of sockets) closeWebSocket(socket);
      await removeTestChannels(channelIds, [ownerSession.userId, memberSession.userId]);
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
        code: "CHANNEL_ACCESS_REQUIRED",
      });

      const deniedMembers = await apiRequest(memberSession, `/channels/${channelId}/members`);
      assert.equal(deniedMembers.status, 403, JSON.stringify(deniedMembers));
      assert.deepEqual(deniedMembers.body, {
        error: "Join the private channel before viewing its members.",
        code: "CHANNEL_ACCESS_REQUIRED",
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

  test("keeps private rooms reviewable when their owner is kicked or banned", async () => {
    const actorSession = await createTestSession("moderation_handoff_operator");
    const ownerSession = await createTestSession("moderation_handoff_owner");
    const requesterSession = await createTestSession("moderation_handoff_requester");
    const channelIds: number[] = [];

    try {
      for (const session of [actorSession, ownerSession, requesterSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }

      for (const action of ["kick", "ban"] as const) {
        const created = await apiRequest(ownerSession, "/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `moderation-handoff-${action}-${randomUUID().replaceAll("-", "").slice(0, 10)}`,
            isPrivate: true,
          }),
        });
        assert.equal(created.status, 201, JSON.stringify(created));
        const channelId = (created.body as { id: number }).id;
        channelIds.push(channelId);
        await pool.query(
          `INSERT INTO irc_channel_members (channel_id, user_id, role)
           VALUES ($1, $2, 'moderator')`,
          [channelId, actorSession.userId],
        );

        const removal = await apiRequest(
          actorSession,
          `/channels/${channelId}/moderation`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, targetUserId: ownerSession.userId }),
          },
        );
        assert.equal(removal.status, 200, JSON.stringify(removal));
        assert.deepEqual(
          (await pool.query(
            `SELECT c.owner_id, m.role
             FROM irc_channels c
             JOIN irc_channel_members m ON m.channel_id = c.id AND m.user_id = $2
             WHERE c.id = $1`,
            [channelId, actorSession.userId],
          )).rows,
          [{ owner_id: actorSession.userId, role: "owner" }],
        );
        if (action === "ban") {
          assert.equal(
            (await pool.query(
              "SELECT 1 FROM irc_channel_bans WHERE channel_id = $1 AND user_id = $2",
              [channelId, ownerSession.userId],
            )).rowCount,
            1,
          );
        }

        const request = await apiRequest(
          requesterSession,
          `/channels/${channelId}/join`,
          { method: "POST" },
        );
        assert.equal(request.status, 202, JSON.stringify(request));
        const requests = await apiRequest(
          actorSession,
          `/channels/${channelId}/join-requests`,
        );
        assert.equal(requests.status, 200, JSON.stringify(requests));
        assert.ok(Array.isArray(requests.body));
        assert.equal(requests.body.length, 1);
        const requestId = (requests.body[0] as { id: number }).id;
        const approval = await apiRequest(
          actorSession,
          `/channels/${channelId}/join-requests/${requestId}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision: "approve" }),
          },
        );
        assert.equal(approval.status, 200, JSON.stringify(approval));
        assert.deepEqual(approval.body, { ok: true, status: "approved" });
      }
    } finally {
      await removeTestChannels(channelIds, [
        actorSession.userId,
        ownerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("refuses to kick or ban the final private-room reviewer", async () => {
    const moderatorSession = await createTestSession("last_reviewer_platform_moderator");
    const ownerSession = await createTestSession("last_reviewer_owner");
    const reviewerSession = await createTestSession("last_reviewer_channel_moderator");
    const requesterSession = await createTestSession("last_reviewer_requester");
    const channelIds: number[] = [];

    try {
      for (const session of [moderatorSession, ownerSession, reviewerSession, requesterSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }
      await pool.query(
        "UPDATE irc_users SET role = 'moderator' WHERE clerk_id = $1",
        [moderatorSession.userId],
      );

      const ownerRoom = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `last-owner-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          isPrivate: true,
        }),
      });
      assert.equal(ownerRoom.status, 201, JSON.stringify(ownerRoom));
      const ownerChannelId = (ownerRoom.body as { id: number }).id;
      channelIds.push(ownerChannelId);

      for (const action of ["kick", "ban"] as const) {
        const removal = await apiRequest(
          moderatorSession,
          `/channels/${ownerChannelId}/moderation`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, targetUserId: ownerSession.userId }),
          },
        );
        assert.equal(removal.status, 409, JSON.stringify(removal));
        assert.deepEqual(removal.body, {
          error: "A private channel must keep an owner or moderator. Promote another member before removing this operator.",
        });
      }

      const ownerRequest = await apiRequest(
        requesterSession,
        `/channels/${ownerChannelId}/join`,
        { method: "POST" },
      );
      assert.equal(ownerRequest.status, 202, JSON.stringify(ownerRequest));
      const ownerRequests = await apiRequest(
        ownerSession,
        `/channels/${ownerChannelId}/join-requests`,
      );
      assert.equal(ownerRequests.status, 200, JSON.stringify(ownerRequests));
      assert.ok(Array.isArray(ownerRequests.body));
      assert.equal(ownerRequests.body.length, 1);

      const moderatorRoom = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `last-moderator-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          isPrivate: true,
        }),
      });
      assert.equal(moderatorRoom.status, 201, JSON.stringify(moderatorRoom));
      const moderatorChannelId = (moderatorRoom.body as { id: number }).id;
      channelIds.push(moderatorChannelId);
      await pool.query(
        `INSERT INTO irc_channel_members (channel_id, user_id, role)
         VALUES ($1, $2, 'moderator')`,
        [moderatorChannelId, reviewerSession.userId],
      );
      await pool.query(
        `UPDATE irc_channel_members
         SET role = 'member'
         WHERE channel_id = $1 AND user_id = $2`,
        [moderatorChannelId, ownerSession.userId],
      );

      for (const action of ["kick", "ban"] as const) {
        const removal = await apiRequest(
          moderatorSession,
          `/channels/${moderatorChannelId}/moderation`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, targetUserId: reviewerSession.userId }),
          },
        );
        assert.equal(removal.status, 409, JSON.stringify(removal));
      }

      const moderatorRequest = await apiRequest(
        requesterSession,
        `/channels/${moderatorChannelId}/join`,
        { method: "POST" },
      );
      assert.equal(moderatorRequest.status, 202, JSON.stringify(moderatorRequest));
      const moderatorRequests = await apiRequest(
        reviewerSession,
        `/channels/${moderatorChannelId}/join-requests`,
      );
      assert.equal(moderatorRequests.status, 200, JSON.stringify(moderatorRequests));
      assert.ok(Array.isArray(moderatorRequests.body));
      assert.equal(moderatorRequests.body.length, 1);
      const requestId = (moderatorRequests.body[0] as { id: number }).id;
      const approval = await apiRequest(
        reviewerSession,
        `/channels/${moderatorChannelId}/join-requests/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(approval.status, 200, JSON.stringify(approval));
    } finally {
      await removeTestChannels(channelIds, [
        moderatorSession.userId,
        ownerSession.userId,
        reviewerSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("keeps a private room reviewable when its owner leaves", async () => {
    const ownerSession = await createTestSession("leave_handoff_owner");
    const moderatorSession = await createTestSession("leave_handoff_moderator");
    const requesterSession = await createTestSession("leave_handoff_requester");
    const channelIds: number[] = [];

    try {
      for (const session of [moderatorSession, requesterSession]) {
        const profile = await apiRequest(session, "/me");
        assert.equal(profile.status, 200, JSON.stringify(profile));
      }

      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `handoff-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
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
        [channelId, moderatorSession.userId],
      );

      const leave = await apiRequest(ownerSession, `/channels/${channelId}/leave`, {
        method: "POST",
      });
      assert.equal(leave.status, 200, JSON.stringify(leave));
      assert.deepEqual(leave.body, { ok: true });

      const ownership = await pool.query(
        `SELECT c.owner_id, m.role
         FROM irc_channels c
         JOIN irc_channel_members m ON m.channel_id = c.id AND m.user_id = $2
         WHERE c.id = $1`,
        [channelId, moderatorSession.userId],
      );
      assert.deepEqual(ownership.rows, [{
        owner_id: moderatorSession.userId,
        role: "owner",
      }]);

      const request = await apiRequest(requesterSession, `/channels/${channelId}/join`, {
        method: "POST",
      });
      assert.equal(request.status, 202, JSON.stringify(request));

      const requests = await apiRequest(moderatorSession, `/channels/${channelId}/join-requests`);
      assert.equal(requests.status, 200, JSON.stringify(requests));
      assert.ok(Array.isArray(requests.body));
      assert.equal(requests.body.length, 1);
      const requestId = (requests.body[0] as { id?: unknown }).id;
      assert.equal(typeof requestId, "number");

      const approval = await apiRequest(
        moderatorSession,
        `/channels/${channelId}/join-requests/${requestId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
      assert.equal(approval.status, 200, JSON.stringify(approval));
      assert.deepEqual(approval.body, { ok: true, status: "approved" });
    } finally {
      await removeTestChannels(channelIds, [
        ownerSession.userId,
        moderatorSession.userId,
        requesterSession.userId,
      ]);
    }
  });

  test("prevents the last private-room operator from leaving", async () => {
    const ownerSession = await createTestSession("last_operator_owner");
    const requesterSession = await createTestSession("last_operator_requester");
    const channelIds: number[] = [];

    try {
      const requesterProfile = await apiRequest(requesterSession, "/me");
      assert.equal(requesterProfile.status, 200, JSON.stringify(requesterProfile));

      const created = await apiRequest(ownerSession, "/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `last-operator-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          isPrivate: true,
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      assert.ok(created.body && typeof created.body === "object");
      const channelId = (created.body as { id?: unknown }).id;
      assert.equal(typeof channelId, "number");
      channelIds.push(channelId as number);

      const leave = await apiRequest(ownerSession, `/channels/${channelId}/leave`, {
        method: "POST",
      });
      assert.equal(leave.status, 409, JSON.stringify(leave));
      assert.deepEqual(leave.body, {
        error: "A private channel must keep an owner or moderator. Promote another member before leaving.",
      });

      const request = await apiRequest(requesterSession, `/channels/${channelId}/join`, {
        method: "POST",
      });
      assert.equal(request.status, 202, JSON.stringify(request));

      const requests = await apiRequest(ownerSession, `/channels/${channelId}/join-requests`);
      assert.equal(requests.status, 200, JSON.stringify(requests));
      assert.ok(Array.isArray(requests.body));
      assert.equal(requests.body.length, 1);
    } finally {
      await removeTestChannels(channelIds, [ownerSession.userId, requesterSession.userId]);
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
        code: "CHANNEL_ACCESS_REQUIRED",
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
    let failureTriggerInstalled = false;

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
      failureTriggerInstalled = true;

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

      assert.equal((channelMessage.body as { body?: unknown }).body, channelBody);
      assert.equal((directMessage.body as { body?: unknown }).body, directBody);
      assert.equal(
        JSON.stringify([channelMessage.body, directMessage.body]).includes("forced notification failure"),
        false,
        "notification failure details must not be returned to the sender",
      );

      const deliveryState = async () => pool.query<{
        id: string;
        notification_status: string;
        notification_attempts: number;
        notification_last_error: string | null;
        notification_recipient_ids: string[];
      }>(
        `SELECT id, notification_status, notification_attempts, notification_last_error,
                notification_recipient_ids
         FROM irc_messages
         WHERE id = ANY($1::uuid[])
         ORDER BY id`,
        [messageIds],
      );
      const notifications = async () => pool.query<{ entity_id: string; count: number }>(
        `SELECT entity_id, count(*)::int AS count
         FROM irc_notifications
         WHERE type IN ('mention', 'direct_message')
           AND entity_type = 'message'
           AND entity_id = ANY($1::text[])
         GROUP BY entity_id
         ORDER BY entity_id`,
        [messageIds],
      );

      const pending = await deliveryState();
      assert.equal(pending.rowCount, 2);
      assert.ok(pending.rows.every((row) => (
        row.notification_status === "pending"
        && row.notification_attempts === 0
        && row.notification_last_error === null
        && row.notification_recipient_ids.length === 1
        && row.notification_recipient_ids[0] === recipientSession.userId
      )));
      assert.equal((await notifications()).rowCount, 0);

      const failedPass = await processMessageNotificationDeliveries({ batchSize: 2 });
      assert.deepEqual(failedPass, { processed: 2, delivered: 0, skipped: 0, failed: 2 });
      const afterFailure = await deliveryState();
      assert.ok(afterFailure.rows.every((row) => (
        row.notification_status === "pending"
        && row.notification_attempts === 1
        && row.notification_last_error === "sqlstate:P0001"
      )));
      assert.equal((await notifications()).rowCount, 0, "a failed fanout must leave no partial notifications");

      await pool.query(`DROP TRIGGER "${triggerName}" ON irc_notifications`);
      failureTriggerInstalled = false;
      await pool.query(
        `UPDATE irc_messages
         SET notification_next_attempt_at = now()
         WHERE id = ANY($1::uuid[])`,
        [messageIds],
      );

      const concurrentPasses = await Promise.all([
        processMessageNotificationDeliveries({ batchSize: 1 }),
        processMessageNotificationDeliveries({ batchSize: 1 }),
      ]);
      assert.deepEqual(
        concurrentPasses.map(({ processed, delivered, skipped, failed }) => ({ processed, delivered, skipped, failed })),
        [
          { processed: 1, delivered: 1, skipped: 0, failed: 0 },
          { processed: 1, delivered: 1, skipped: 0, failed: 0 },
        ],
      );
      const delivered = await deliveryState();
      assert.ok(delivered.rows.every((row) => (
        row.notification_status === "delivered"
        && row.notification_attempts === 1
        && row.notification_last_error === null
      )));
      const deliveredNotifications = await notifications();
      assert.deepEqual(
        deliveredNotifications.rows,
        [...messageIds].sort().map((entity_id) => ({ entity_id, count: 1 })),
      );

      assert.deepEqual(
        await processMessageNotificationDeliveries({ batchSize: 2 }),
        { processed: 0, delivered: 0, skipped: 0, failed: 0 },
      );
      assert.deepEqual((await notifications()).rows, deliveredNotifications.rows);

      const [channelHistory, directHistory] = await Promise.all([
        apiRequest(senderSession, `/channels/${channelId}/messages`),
        apiRequest(senderSession, `/dm/${recipientSession.userId}/messages`),
      ]);
      assert.equal(channelHistory.status, 200, JSON.stringify(channelHistory));
      assert.equal(directHistory.status, 200, JSON.stringify(directHistory));
      assert.ok(channelHistory.body && typeof channelHistory.body === "object");
      assert.ok(directHistory.body && typeof directHistory.body === "object");
      assert.ok(
        (channelHistory.body as { messages: Array<{ id: string; body: string }> }).messages
          .some(({ id, body }) => id === (channelMessage.body as { id: string }).id && body === channelBody),
      );
      assert.ok(
        (directHistory.body as { messages: Array<{ id: string; body: string }> }).messages
          .some(({ id, body }) => id === (directMessage.body as { id: string }).id && body === directBody),
      );
    } finally {
      if (failureTriggerInstalled) {
        await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON irc_notifications`);
      }
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

  test("caps notification pages at 100 and orders equal timestamps by newest id", async () => {
    const session = await createTestSession("notification_pagination");
    assert.equal((await apiRequest(session, "/me")).status, 200);
    const createdAt = new Date("2099-01-01T00:00:00.000Z");
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO irc_notifications (user_id, type, category, body, created_at)
       SELECT $1, 'general', 'general', 'Pagination notification ' || series, $2
       FROM generate_series(1, 105) AS series
       RETURNING id`,
      [session.userId, createdAt],
    );
    const insertedIds = inserted.rows.map(({ id }) => id).sort((left, right) => right - left);
    try {
      const firstPage = await apiRequest(session, "/notifications?limit=100");
      assert.equal(firstPage.status, 200, JSON.stringify(firstPage));
      const firstRows = firstPage.body as Array<{ id: number; createdAt: string }>;
      assert.equal(firstRows.length, 100);
      assert.deepEqual(firstRows.map(({ id }) => id), insertedIds.slice(0, 100));
      assert.ok(firstRows.every(({ createdAt: value }) => new Date(value).getTime() === createdAt.getTime()));

      const secondPage = await apiRequest(session, "/notifications?limit=100&offset=100");
      assert.equal(secondPage.status, 200, JSON.stringify(secondPage));
      assert.deepEqual(
        (secondPage.body as Array<{ id: number }>).map(({ id }) => id),
        insertedIds.slice(100),
      );

      const oversizedPage = await apiRequest(session, "/notifications?limit=1000");
      assert.equal(oversizedPage.status, 200, JSON.stringify(oversizedPage));
      assert.equal((oversizedPage.body as Array<unknown>).length, 100);
    } finally {
      await pool.query("DELETE FROM irc_notifications WHERE id = ANY($1::int[])", [inserted.rows.map(({ id }) => id)]);
    }
  });

  test("rolls back a document version and timestamp when its audit insert fails", async () => {
    assert.ok(
      process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL,
      "Audit rollback tests require only a dedicated TEST_DATABASE_URL, not the development database.",
    );
    const owner = await createTestSession("document_version_audit_owner");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const triggerName = `fail_document_version_audit_${suffix}`;
    const functionName = `fail_document_version_audit_fn_${suffix}`;
    let communityId: number | undefined;
    let triggerCreated = false;
    let functionCreated = false;
    try {
      assert.equal((await apiRequest(owner, "/me")).status, 200);
      const community = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ($1, $2, $3, 'paid_workspace', true) RETURNING id`,
        ["Document audit rollback", `document-audit-${suffix}`, owner.userId],
      );
      communityId = community.rows[0].id;
      await pool.query(
        "INSERT INTO irc_community_members (community_id, user_id, status) VALUES ($1, $2, 'owner')",
        [communityId, owner.userId],
      );
      await pool.query(
        `INSERT INTO irc_user_roles (user_id, role, scope_type, community_id, granted_by)
         VALUES ($1, 'workspace_owner', 'community', $2, $1)`,
        [owner.userId, communityId],
      );
      const initialTimestamp = new Date("2024-01-01T00:00:00.000Z");
      const document = await pool.query<{ id: number; updated_at: Date }>(
        `INSERT INTO irc_business_documents
           (community_id, title, description, category, visibility, owner_id, updated_at)
         VALUES ($1, 'Audit rollback fixture', '', 'company', 'company', $2, $3)
         RETURNING id, updated_at`,
        [communityId, owner.userId, initialTimestamp],
      );
      const documentId = document.rows[0].id;
      await pool.query(
        `INSERT INTO irc_document_versions
           (document_id, version, object_path, file_name, content_type, file_size, uploaded_by)
         VALUES ($1, 1, $2, 'initial.txt', 'text/plain', 1, $3)`,
        [documentId, `/objects/uploads/${randomUUID()}`, owner.userId],
      );
      await pool.query(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action = 'uploaded_document_version' AND NEW.community_id = ${communityId} THEN
             RAISE EXCEPTION 'forced document version audit failure';
           END IF;
           RETURN NEW;
         END;
         $$;`,
      );
      functionCreated = true;
      await pool.query(
        `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON irc_admin_audit_logs
         FOR EACH ROW EXECUTE FUNCTION "${functionName}"();`,
      );
      triggerCreated = true;

      const response = await apiRequest(owner, `/communities/${communityId}/documents/${documentId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectPath: `/objects/uploads/${randomUUID()}`,
          fileName: "retry.txt",
          contentType: "text/plain",
          fileSize: 1,
        }),
      });
      assert.equal(response.status, 500, JSON.stringify(response));
      const [versions, unchangedDocument, audits] = await Promise.all([
        pool.query<{ version: number }>(
          "SELECT version FROM irc_document_versions WHERE document_id = $1 ORDER BY version", [documentId],
        ),
        pool.query<{ updated_at: Date }>(
          "SELECT updated_at FROM irc_business_documents WHERE id = $1", [documentId],
        ),
        pool.query(
          `SELECT id FROM irc_admin_audit_logs
           WHERE community_id = $1 AND action = 'uploaded_document_version'`, [communityId],
        ),
      ]);
      assert.deepEqual(versions.rows.map(({ version }) => version), [1]);
      assert.equal(unchangedDocument.rows[0].updated_at.getTime(), initialTimestamp.getTime());
      assert.deepEqual(audits.rows, []);
    } finally {
      try {
        if (triggerCreated) {
          await pool.query(`DROP TRIGGER "${triggerName}" ON irc_admin_audit_logs`);
        }
        if (functionCreated) {
          await pool.query(`DROP FUNCTION "${functionName}"()`);
        }
      } finally {
        if (communityId !== undefined) {
          await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
        }
      }
    }
  });

  test("allocates distinct sequential document versions for simultaneous uploads", async () => {
    assert.ok(
      process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL,
      "Concurrent upload tests require only a dedicated TEST_DATABASE_URL, not the development database.",
    );
    const owner = await createTestSession("concurrent_document_owner");
    let communityId: number | undefined;
    try {
      assert.equal((await apiRequest(owner, "/me")).status, 200);
      const community = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ($1, $2, $3, 'paid_workspace', true) RETURNING id`,
        ["Concurrent document versions", `concurrent-versions-${randomUUID()}`, owner.userId],
      );
      communityId = community.rows[0].id;
      await pool.query(
        "INSERT INTO irc_community_members (community_id, user_id, status) VALUES ($1, $2, 'owner')",
        [communityId, owner.userId],
      );
      await pool.query(
        `INSERT INTO irc_user_roles (user_id, role, scope_type, community_id, granted_by)
         VALUES ($1, 'workspace_owner', 'community', $2, $1)`,
        [owner.userId, communityId],
      );

      const file = (name: string) => ({
        objectPath: `/objects/uploads/${randomUUID()}`,
        fileName: name,
        contentType: "text/plain",
        fileSize: 1,
      });
      const upload = (path: string, body: object) => apiRequest(owner, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const created = await upload(`/communities/${communityId}/documents`, {
        ...file("initial.txt"), title: "Concurrent upload fixture",
      });
      assert.equal(created.status, 201, JSON.stringify(created));
      const documentId = (created.body as { id: number }).id;
      const path = `/communities/${communityId}/documents/${documentId}/versions`;
      const responses = await Promise.all([
        upload(path, file("second.txt")),
        upload(path, file("third.txt")),
      ]);
      for (const response of responses) {
        assert.equal(response.status, 201, JSON.stringify(response));
      }
      const uploaded = responses.map(({ body }) => body as {
        id: number; documentId: number; version: number; fileName: string;
      });
      assert.ok(uploaded.every((version) => version.documentId === documentId));
      assert.deepEqual(uploaded.map(({ version }) => version).sort((a, b) => a - b), [2, 3]);
      assert.deepEqual(uploaded.map(({ fileName }) => fileName).sort(), ["second.txt", "third.txt"]);

      const stored = await pool.query<{ id: number; version: number; file_name: string }>(
        `SELECT id, version, file_name FROM irc_document_versions
         WHERE document_id = $1 ORDER BY version`,
        [documentId],
      );
      assert.deepEqual(stored.rows.map(({ version }) => version), [1, 2, 3]);
      assert.deepEqual(
        stored.rows.slice(1).map(({ id }) => id).sort((a, b) => a - b),
        uploaded.map(({ id }) => id).sort((a, b) => a - b),
      );
      assert.deepEqual(stored.rows.slice(1).map(({ file_name }) => file_name).sort(), ["second.txt", "third.txt"]);
      const duplicates = await pool.query(
        `SELECT document_id, version FROM irc_document_versions
         WHERE document_id = $1 GROUP BY document_id, version HAVING count(*) > 1`,
        [documentId],
      );
      assert.deepEqual(duplicates.rows, []);
    } finally {
      if (communityId !== undefined) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
    }
  });

  test("filters business documents before applying the capped page size", async () => {
    const owner = await createTestSession("document_pagination_owner");
    assert.equal((await apiRequest(owner, "/me")).status, 200);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    let communityId: number | undefined;
    try {
      const community = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ($1, $2, $3, 'paid_workspace', false)
         RETURNING id`,
        [`Document pagination ${suffix}`, `document-pagination-${suffix}`, owner.userId],
      );
      communityId = community.rows[0]?.id;
      assert.ok(communityId);

      // Put many non-matching rows ahead of the matching rows by updated_at. A
      // search page must filter first, rather than consuming those rows.
      const insertedDocuments = await pool.query<{ id: number; title: string }>(
        `INSERT INTO irc_business_documents
           (community_id, title, description, category, visibility, owner_id, created_at, updated_at)
         SELECT $1, 'Noise document ' || series, '', 'company', 'company', $2,
                now() - interval '1 minute', now() - interval '1 minute'
         FROM generate_series(1, 150) AS series
         UNION ALL
         SELECT $1, 'Needle document ' || series, '', 'company', 'company', $2,
                now() - interval '2 hours', now() - interval '2 hours'
         FROM generate_series(1, 101) AS series
         RETURNING id, title`,
        [communityId, owner.userId],
      );
      const expectedIds = insertedDocuments.rows.filter((row) => row.title.startsWith("Needle document"))
        .map((row) => row.id).sort((left, right) => right - left);

      const firstPage = await apiRequest(
        owner,
        `/communities/${communityId}/documents?q=needle&documentsLimit=100`,
      );
      assert.equal(firstPage.status, 200, JSON.stringify(firstPage));
      const firstBody = firstPage.body as {
        documents: Array<{ id: number; title: string }>;
        pagination: { limit: number; offset: number; hasMore: boolean };
      };
      assert.equal(firstBody.pagination.limit, 100);
      assert.equal(firstBody.pagination.offset, 0);
      assert.equal(firstBody.pagination.hasMore, true);
      assert.equal(firstBody.documents.length, 100);
      assert.ok(firstBody.documents.every(({ title }) => title.startsWith("Needle document")));
      assert.deepEqual(firstBody.documents.map(({ id }) => id), expectedIds.slice(0, 100));

      const secondPage = await apiRequest(
        owner,
        `/communities/${communityId}/documents?q=needle&documentsLimit=100&documentsOffset=100`,
      );
      assert.equal(secondPage.status, 200, JSON.stringify(secondPage));
      const secondBody = secondPage.body as {
        documents: Array<{ id: number; title: string }>;
        pagination: { limit: number; offset: number; hasMore: boolean };
      };
      assert.equal(secondBody.documents.length, 1);
      assert.deepEqual(secondBody.documents.map(({ id }) => id), expectedIds.slice(100));
      assert.equal(secondBody.pagination.hasMore, false);
    } finally {
      if (communityId !== undefined) {
        await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      }
    }
  });

  test("paginates workspace detail collections and logs with stable tie ordering", async () => {
    const owner = await createTestSession("workspace_collection_pagination_owner");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const createdAt = new Date("2024-02-01T00:00:00.000Z");
    let communityId: number | undefined;
    let generatedUserIds: string[] = [];
    try {
      const ownerProfile = await apiRequest(owner, "/me");
      assert.equal(ownerProfile.status, 200, JSON.stringify(ownerProfile));
      const community = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ($1, $2, $3, 'paid_workspace', false) RETURNING id`,
        [`Collection pagination ${suffix}`, `collection-pagination-${suffix}`, owner.userId],
      );
      communityId = community.rows[0]?.id;
      assert.ok(communityId);
      await pool.query(
        `INSERT INTO irc_user_roles (user_id, role, scope_type, community_id, granted_by)
         VALUES ($1, 'workspace_owner', 'community', $2, $1)`,
        [owner.userId, communityId],
      );
      const users = await pool.query<{ clerk_id: string }>(
        `INSERT INTO irc_users (clerk_id, username, display_name, created_at)
         SELECT 'pagination-${suffix}-' || series, 'pagination_${suffix}_' || series,
                'Employee ' || lpad(series::text, 3, '0'), $1
         FROM generate_series(1, 101) AS series
         RETURNING clerk_id`,
        [createdAt],
      );
      generatedUserIds = users.rows.map(({ clerk_id }) => clerk_id);
      await pool.query(
        `INSERT INTO irc_community_members (community_id, user_id, status, joined_at)
         SELECT $1, clerk_id, 'member', $2 FROM irc_users
         WHERE clerk_id = ANY($3::text[])`,
        [communityId, createdAt, generatedUserIds],
      );
      await pool.query(
        `INSERT INTO irc_employee_profiles (community_id, user_id, employee_number)
         SELECT $1, clerk_id, clerk_id FROM irc_users
         WHERE clerk_id = ANY($2::text[])`,
        [communityId, generatedUserIds],
      );
      await pool.query(
        `INSERT INTO irc_workspace_invitations
           (community_id, email, invited_by, token_hash, expires_at, created_at)
         SELECT $1, 'invite-' || series || '@example.test', $2,
                'token-${suffix}-' || series, now() + interval '1 day', $3
         FROM generate_series(1, 101) AS series`,
        [communityId, owner.userId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_workspace_tasks
           (community_id, title, created_by, created_at, updated_at)
         SELECT $1, 'Task ' || series, $2, $3, $3
         FROM generate_series(1, 101) AS series`,
        [communityId, owner.userId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_admin_audit_logs
           (actor_id, community_id, action, target_label, created_at)
         SELECT $1, $2, 'pagination_audit', 'audit-' || series, $3
         FROM generate_series(1, 101) AS series`,
        [owner.userId, communityId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_moderation_actions
           (actor_id, community_id, action, details, created_at)
         SELECT $1, $2, 'pagination_moderation', 'moderation-' || series, $3
         FROM generate_series(1, 101) AS series`,
        [owner.userId, communityId, createdAt],
      );
      const announcement = await pool.query<{ id: number }>(
        `INSERT INTO irc_server_announcements
           (author_id, community_id, title, body, created_at)
         VALUES ($1, $2, 'Receipt counts', 'Many receipts', $3)
         RETURNING id`,
        [owner.userId, communityId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_announcement_read_receipts (announcement_id, user_id)
         SELECT $1, unnest($2::text[])`,
        [announcement.rows[0]?.id, generatedUserIds],
      );
      await pool.query(
        `INSERT INTO irc_announcement_acknowledgements (announcement_id, user_id)
         SELECT $1, unnest($2::text[])`,
        [announcement.rows[0]?.id, generatedUserIds.slice(0, 73)],
      );

      const detail = await apiRequest(
        owner,
        `/communities/${communityId}?employeesLimit=100&invitationsLimit=100&tasksLimit=100`,
      );
      assert.equal(detail.status, 200, JSON.stringify(detail));
      const detailBody = detail.body as {
        employees: Array<{ displayName: string }>;
        invitations: Array<{ id: number }>;
        tasks: Array<{ id: number }>;
        pagination: {
          employees: { limit: number; offset: number; hasMore: boolean };
          invitations: { limit: number; offset: number; hasMore: boolean };
          tasks: { limit: number; offset: number; hasMore: boolean };
        };
        announcements: Array<{ title: string; readCount: number; acknowledgementCount: number }>;
      };
      assert.equal(detailBody.employees.length, 100);
      assert.equal(detailBody.invitations.length, 100);
      assert.equal(detailBody.tasks.length, 100);
      assert.equal(detailBody.employees[0]?.displayName, "Employee 001");
      assert.equal(detailBody.employees[99]?.displayName, "Employee 100");
      assert.ok(detailBody.invitations[0].id > detailBody.invitations[99].id);
      assert.ok(detailBody.tasks[0].id > detailBody.tasks[99].id);
      for (const collection of ["employees", "invitations", "tasks"] as const) {
        assert.deepEqual(detailBody.pagination[collection], { limit: 100, offset: 0, hasMore: true });
      }
      assert.equal(detailBody.announcements[0]?.readCount, 101);
      assert.equal(detailBody.announcements[0]?.acknowledgementCount, 73);
      const oversizedDetail = await apiRequest(
        owner,
        `/communities/${communityId}?employeesLimit=999&invitationsLimit=999&tasksLimit=999`,
      );
      assert.equal(oversizedDetail.status, 200);
      const oversizedBody = oversizedDetail.body as { employees: unknown[]; invitations: unknown[]; tasks: unknown[] };
      assert.equal(oversizedBody.employees.length, 100);
      assert.equal(oversizedBody.invitations.length, 100);
      assert.equal(oversizedBody.tasks.length, 100);

      const detailSecondPage = await apiRequest(
        owner,
        `/communities/${communityId}?employeesLimit=100&employeesOffset=100&invitationsLimit=100&invitationsOffset=100&tasksLimit=100&tasksOffset=100`,
      );
      assert.equal(detailSecondPage.status, 200, JSON.stringify(detailSecondPage));
      const secondBody = detailSecondPage.body as {
        employees: Array<{ displayName: string }>;
        invitations: Array<{ id: number }>;
        tasks: Array<{ id: number }>;
        pagination: { employees: { hasMore: boolean }; invitations: { hasMore: boolean }; tasks: { hasMore: boolean } };
      };
      assert.equal(secondBody.employees.length, 1);
      assert.equal(secondBody.invitations.length, 1);
      assert.equal(secondBody.tasks.length, 1);
      assert.equal(secondBody.employees[0]?.displayName, "Employee 101");
      assert.ok(secondBody.invitations[0].id < detailBody.invitations[99].id);
      assert.ok(secondBody.tasks[0].id < detailBody.tasks[99].id);
      assert.equal(secondBody.pagination.employees.hasMore, false);
      assert.equal(secondBody.pagination.invitations.hasMore, false);
      assert.equal(secondBody.pagination.tasks.hasMore, false);

      const activity = await apiRequest(owner, `/communities/${communityId}/activity?action=pagination_audit&auditLimit=100`);
      assert.equal(activity.status, 200, JSON.stringify(activity));
      const activityBody = activity.body as { entries: Array<{ id: number }>; pagination: { hasMore: boolean } };
      assert.equal(activityBody.entries.length, 100);
      assert.ok(activityBody.entries[0].id > activityBody.entries[99].id);
      assert.equal(activityBody.pagination.hasMore, true);
      const oversizedActivity = await apiRequest(owner, `/communities/${communityId}/activity?action=pagination_audit&auditLimit=999`);
      assert.equal((oversizedActivity.body as { entries: unknown[] }).entries.length, 100);
      const activitySecond = await apiRequest(owner, `/communities/${communityId}/activity?action=pagination_audit&auditLimit=100&auditOffset=100`);
      const activitySecondBody = activitySecond.body as { entries: Array<{ id: number }>; pagination: { hasMore: boolean } };
      assert.equal(activitySecondBody.entries.length, 1);
      assert.ok(activitySecondBody.entries[0].id < activityBody.entries[99].id);
      assert.equal(activitySecondBody.pagination.hasMore, false);

      const moderation = await apiRequest(owner, `/communities/${communityId}/moderation-logs?moderationLimit=100`);
      assert.equal(moderation.status, 200, JSON.stringify(moderation));
      const moderationBody = moderation.body as Array<{ id: number }>;
      assert.equal(moderationBody.length, 100);
      assert.ok(moderationBody[0].id > moderationBody[99].id);
      const oversizedModeration = await apiRequest(owner, `/communities/${communityId}/moderation-logs?limit=999`);
      assert.equal((oversizedModeration.body as unknown[]).length, 100);
      const moderationSecond = await apiRequest(owner, `/communities/${communityId}/moderation-logs?moderationLimit=100&moderationOffset=100`);
      const moderationSecondBody = moderationSecond.body as Array<{ id: number }>;
      assert.equal(moderationSecondBody.length, 1);
      assert.ok(moderationSecondBody[0].id < moderationBody[99].id);
    } finally {
      if (communityId !== undefined) {
        await pool.query(
          "DELETE FROM irc_admin_audit_logs WHERE community_id = $1 AND action = 'pagination_audit'",
          [communityId],
        );
      }
      if (communityId !== undefined) await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
      if (generatedUserIds.length) await pool.query("DELETE FROM irc_users WHERE clerk_id = ANY($1::text[])", [generatedUserIds]);
    }
  });

  test("caps and paginates workspace reference collections", async () => {
    const owner = await createTestSession("workspace_reference_pagination_owner");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const createdAt = new Date("2024-03-01T00:00:00.000Z");
    let communityId: number | undefined;
    try {
      const ownerProfile = await apiRequest(owner, "/me");
      assert.equal(ownerProfile.status, 200, JSON.stringify(ownerProfile));
      const community = await pool.query<{ id: number }>(
        `INSERT INTO irc_communities (name, slug, owner_id, plan, is_private)
         VALUES ($1, $2, $3, 'paid_workspace', false) RETURNING id`,
        [`Reference pagination ${suffix}`, `reference-pagination-${suffix}`, owner.userId],
      );
      communityId = community.rows[0]?.id;
      assert.ok(communityId);
      await pool.query(
        `INSERT INTO irc_categories (name, owner_id, community_id, created_at)
         SELECT 'Category ' || lpad(series::text, 3, '0'), $2, $1, $3
         FROM generate_series(1, 101) AS series`,
        [communityId, owner.userId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_channels (name, owner_id, community_id, created_at)
         SELECT 'Channel ' || lpad(series::text, 3, '0'), $2, $1, $3
         FROM generate_series(1, 101) AS series`,
        [communityId, owner.userId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_departments (name, community_id, created_at)
         SELECT 'Department ' || lpad(series::text, 3, '0'), $1, $2
         FROM generate_series(1, 101) AS series`,
        [communityId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_locations (name, community_id, created_at)
         SELECT 'Location ' || lpad(series::text, 3, '0'), $1, $2
         FROM generate_series(1, 101) AS series`,
        [communityId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_teams (name, community_id, created_at)
         SELECT 'Team ' || lpad(series::text, 3, '0'), $1, $2
         FROM generate_series(1, 101) AS series`,
        [communityId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_workspace_policies (title, body, community_id, created_by, created_at)
         SELECT 'Policy ' || lpad(series::text, 3, '0'), 'Policy body', $1, $2, $3
         FROM generate_series(1, 101) AS series`,
        [communityId, owner.userId, createdAt],
      );
      await pool.query(
        `INSERT INTO irc_document_folders (community_id, name, created_by, created_at)
         SELECT $1, 'Folder ' || lpad(series::text, 3, '0'), $2, $3
         FROM generate_series(1, 101) AS series`,
        [communityId, owner.userId, createdAt],
      );

      const detail = await apiRequest(
        owner,
        `/communities/${communityId}?channelsLimit=1000&categoriesLimit=1000&departmentsLimit=1000&locationsLimit=1000&teamsLimit=1000&policiesLimit=1000`,
      );
      assert.equal(detail.status, 200, JSON.stringify(detail));
      const body = detail.body as {
        channels: Array<{ name: string }>;
        categories: Array<{ name: string }>;
        departments: Array<{ name: string }>;
        locations: Array<{ name: string }>;
        teams: Array<{ name: string }>;
        policies: Array<{ title: string }>;
        pagination: Record<string, { limit: number; offset: number; hasMore: boolean }>;
      };
      for (const [key, rows, first, last] of [
        ["channels", body.channels, "Channel 001", "Channel 100"],
        ["categories", body.categories, "Category 001", "Category 100"],
        ["departments", body.departments, "Department 001", "Department 100"],
        ["locations", body.locations, "Location 001", "Location 100"],
        ["teams", body.teams, "Team 001", "Team 100"],
      ] as const) {
        assert.equal(rows.length, 100, `${key} should be capped`);
        assert.equal((rows[0] as { name?: string }).name, first);
        assert.equal((rows[99] as { name?: string }).name, last);
        assert.deepEqual(body.pagination[key], { limit: 100, offset: 0, hasMore: true });
      }
      assert.equal(body.policies.length, 100);
      // Policies intentionally sort newest first; equal timestamps use id desc.
      assert.ok(body.policies[0].title > body.policies[99].title);
      assert.deepEqual(body.pagination.policies, { limit: 100, offset: 0, hasMore: true });

      const second = await apiRequest(
        owner,
        `/communities/${communityId}?channelsLimit=100&channelsOffset=100&categoriesLimit=100&categoriesOffset=100&departmentsLimit=100&departmentsOffset=100&locationsLimit=100&locationsOffset=100&teamsLimit=100&teamsOffset=100&policiesLimit=100&policiesOffset=100`,
      );
      assert.equal(second.status, 200, JSON.stringify(second));
      const secondBody = second.body as {
        channels: Array<{ name: string }>;
        categories: Array<{ name: string }>;
        departments: Array<{ name: string }>;
        locations: Array<{ name: string }>;
        teams: Array<{ name: string }>;
        policies: Array<{ title: string }>;
        pagination: Record<string, { limit: number; offset: number; hasMore: boolean }>;
      };
      for (const [key, rows, expected] of [
        ["channels", secondBody.channels, "Channel 101"],
        ["categories", secondBody.categories, "Category 101"],
        ["departments", secondBody.departments, "Department 101"],
        ["locations", secondBody.locations, "Location 101"],
        ["teams", secondBody.teams, "Team 101"],
      ] as const) {
        assert.equal(rows.length, 1, `${key} second page`);
        assert.equal((rows[0] as { name?: string }).name, expected);
        assert.deepEqual(secondBody.pagination[key], { limit: 100, offset: 100, hasMore: false });
      }
      assert.equal(secondBody.policies.length, 1);
      assert.equal(secondBody.policies[0]?.title, "Policy 001");
      assert.deepEqual(secondBody.pagination.policies, { limit: 100, offset: 100, hasMore: false });

      const folders = await apiRequest(
        owner,
        `/communities/${communityId}/documents?foldersLimit=1000`,
      );
      assert.equal(folders.status, 200, JSON.stringify(folders));
      const folderBody = folders.body as {
        folders: Array<{ name: string }>;
        foldersPagination: { limit: number; offset: number; hasMore: boolean };
      };
      assert.equal(folderBody.folders.length, 100);
      assert.equal(folderBody.folders[0]?.name, "Folder 001");
      assert.equal(folderBody.folders[99]?.name, "Folder 100");
      assert.deepEqual(folderBody.foldersPagination, { limit: 100, offset: 0, hasMore: true });
      const foldersSecond = await apiRequest(
        owner,
        `/communities/${communityId}/documents?foldersLimit=100&foldersOffset=100`,
      );
      assert.equal(foldersSecond.status, 200, JSON.stringify(foldersSecond));
      const foldersSecondBody = foldersSecond.body as {
        folders: Array<{ name: string }>;
        foldersPagination: { limit: number; offset: number; hasMore: boolean };
      };
      assert.equal(foldersSecondBody.folders.length, 1);
      assert.equal(foldersSecondBody.folders[0]?.name, "Folder 101");
      assert.deepEqual(foldersSecondBody.foldersPagination, { limit: 100, offset: 100, hasMore: false });
    } finally {
      if (communityId !== undefined) await pool.query("DELETE FROM irc_communities WHERE id = $1", [communityId]);
    }
  });
});
