import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { clerkClient } from "@clerk/express";
import { pool } from "@workspace/db";
import app from "./app";
import {
  TEST_EMAIL_DOMAIN,
  TEST_USERNAME_PREFIX,
} from "./admin-test-identity";

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

async function removeTestDatabaseRows(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await pool.query(
    "DELETE FROM irc_users WHERE clerk_id = ANY($1::text[])",
    [userIds],
  );
}

before(async () => {
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      "CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required for authenticated API tests.",
    );
  }

  server = createServer(app);
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