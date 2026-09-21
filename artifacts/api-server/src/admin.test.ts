import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { clerkClient } from "@clerk/express";
import { pool } from "@workspace/db";
import app from "./app";

const TEST_USERNAME_PREFIX = "admin_access_test_";
const TEST_EMAIL_DOMAIN = "example.com";

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
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token.jwt}`,
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

  const existingAdmins = await pool.query(
    "SELECT clerk_id FROM irc_users WHERE role = 'admin' LIMIT 1",
  );
  assert.equal(
    existingAdmins.rowCount,
    0,
    "Authenticated admin tests require a database with no existing admin account.",
  );

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