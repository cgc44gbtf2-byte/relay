import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertSafeCleanupEnvironment,
  listMatchingUsers,
  listUserSessions,
  main,
  runCleanup,
  type CleanupClerkClient,
  type CleanupDatabase,
  type CleanupDependencies,
} from "./cleanup-admin-test-users";
import {
  TEST_EMAIL_DOMAIN,
  TEST_USERNAME_PREFIX,
  isAdminRegressionTestUser,
} from "./admin-test-identity";

function createUser(
  id: string,
  username: string | null,
  emailAddresses: string[],
) {
  return {
    id,
    username,
    emailAddresses: emailAddresses.map((emailAddress) => ({ emailAddress })),
  };
}

function createDatabase(
  query: CleanupDatabase["query"] = async () => undefined,
): CleanupDatabase {
  return { query };
}

function createClerk(
  overrides: Partial<{
    getUserList: CleanupClerkClient["users"]["getUserList"];
    deleteUser: CleanupClerkClient["users"]["deleteUser"];
    getSessionList: CleanupClerkClient["sessions"]["getSessionList"];
    revokeSession: CleanupClerkClient["sessions"]["revokeSession"];
  }> = {},
): CleanupClerkClient {
  return {
    users: {
      getUserList:
        overrides.getUserList ??
        (async () => ({ data: [] })),
      deleteUser: overrides.deleteUser ?? (async () => undefined),
    },
    sessions: {
      getSessionList:
        overrides.getSessionList ??
        (async () => ({ data: [] })),
      revokeSession: overrides.revokeSession ?? (async () => undefined),
    },
  };
}

async function withSafeCleanupEnvironment<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
  };

  process.env.NODE_ENV = "test";
  process.env.CLERK_SECRET_KEY = "sk_test_cleanup";
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_cleanup";
  process.env.TEST_DATABASE_URL = "postgres://test-only.invalid/web_irc_test";
  delete process.env.DATABASE_URL;

  try {
    return await callback();
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.secretKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = previous.secretKey;
    if (previous.publishableKey === undefined) {
      delete process.env.CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.CLERK_PUBLISHABLE_KEY = previous.publishableKey;
    }
    if (previous.testDatabaseUrl === undefined) {
      delete process.env.TEST_DATABASE_URL;
    } else {
      process.env.TEST_DATABASE_URL = previous.testDatabaseUrl;
    }
    if (previous.databaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous.databaseUrl;
    }
  }
}

describe("admin test-user cleanup safeguards", () => {
  test("rejects missing Clerk credentials", async () => {
    await withSafeCleanupEnvironment(() => {
      delete process.env.CLERK_SECRET_KEY;
      delete process.env.CLERK_PUBLISHABLE_KEY;

      assert.throws(
        () => assertSafeCleanupEnvironment(),
        /CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required/,
      );
    });
  });

  test("rejects live Clerk keys", async () => {
    await withSafeCleanupEnvironment(() => {
      process.env.CLERK_SECRET_KEY = "sk_live_not_for_cleanup";
      process.env.CLERK_PUBLISHABLE_KEY = "pk_live_not_for_cleanup";

      assert.throws(
        () => assertSafeCleanupEnvironment(),
        /without sk_test_ and pk_test_ keys/,
      );
    });
  });

  test("requires a disposable test database", async () => {
    await withSafeCleanupEnvironment(() => {
      delete process.env.TEST_DATABASE_URL;

      assert.throws(
        () => assertSafeCleanupEnvironment(),
        /TEST_DATABASE_URL is required/,
      );
    });
  });

  test("rejects a shared database configuration", async () => {
    await withSafeCleanupEnvironment(() => {
      process.env.DATABASE_URL = "";

      assert.throws(
        () => assertSafeCleanupEnvironment(),
        /while DATABASE_URL is set/,
      );
    });
  });

  test("requires the exact test username and email pairing", () => {
    const username = `${TEST_USERNAME_PREFIX}exact`;
    const matchingUser = createUser("matching", username, [
      `${username}@${TEST_EMAIL_DOMAIN}`,
    ]);

    assert.equal(isAdminRegressionTestUser(matchingUser), true);
    assert.equal(
      isAdminRegressionTestUser(
        createUser("wrong-email", username, [`${username}@not-example.com`]),
      ),
      false,
    );
    assert.equal(
      isAdminRegressionTestUser(
        createUser("wrong-username", `${username}-other`, [
          `${username}@${TEST_EMAIL_DOMAIN}`,
        ]),
      ),
      false,
    );
  });

  test("paginates through users and sessions", async () => {
    const userPageCalls: number[] = [];
    const sessionPageCalls: number[] = [];
    const matchingUser = createUser(
      "matching",
      `${TEST_USERNAME_PREFIX}page`,
      [`${TEST_USERNAME_PREFIX}page@${TEST_EMAIL_DOMAIN}`],
    );
    const clerk = createClerk({
      getUserList: async ({ offset }) => {
        userPageCalls.push(offset);
        if (offset === 0) {
          return {
            data: Array.from({ length: 100 }, (_, index) =>
              index === 0
                ? matchingUser
                : createUser(`non-matching-${index}`, "ordinary-user", []),
            ),
          };
        }
        return { data: [matchingUser] };
      },
      getSessionList: async ({ offset }) => {
        sessionPageCalls.push(offset);
        if (offset === 0) {
          return {
            data: Array.from({ length: 100 }, (_, index) => ({
              id: `session-${index}`,
              status: "revoked",
            })),
          };
        }
        return { data: [{ id: "session-final", status: "active" }] };
      },
    });

    const users = await listMatchingUsers(clerk);
    const sessions = await listUserSessions(matchingUser.id, clerk);

    assert.deepEqual(userPageCalls, [0, 100]);
    assert.equal(users.length, 2);
    assert.deepEqual(sessionPageCalls, [0, 100]);
    assert.equal(sessions.length, 101);
  });

  test("dry-run does not delete users or revoke sessions", async () => {
    let deleteCalls = 0;
    let revokeCalls = 0;
    let databaseCalls = 0;
    const username = `${TEST_USERNAME_PREFIX}dryrun`;
    const clerk = createClerk({
      getUserList: async () => ({
        data: [
          createUser("dry-run-user", username, [
            `${username}@${TEST_EMAIL_DOMAIN}`,
          ]),
        ],
      }),
      getSessionList: async () => ({
        data: [
          { id: "active-session", status: "active" },
          { id: "revoked-session", status: "revoked" },
        ],
      }),
      deleteUser: async () => {
        deleteCalls += 1;
      },
      revokeSession: async () => {
        revokeCalls += 1;
      },
    });
    const dependencies: CleanupDependencies = {
      clerk,
      database: createDatabase(async () => {
        databaseCalls += 1;
      }),
    };

    await withSafeCleanupEnvironment(() =>
      main(["--dry-run"], dependencies),
    );

    assert.equal(deleteCalls, 0);
    assert.equal(revokeCalls, 0);
    assert.equal(databaseCalls, 0);
  });

  test("returns a non-zero result when cleanup fails", async () => {
    const username = `${TEST_USERNAME_PREFIX}failure`;
    const clerk = createClerk({
      getUserList: async () => ({
        data: [
          createUser("failed-user", username, [
            `${username}@${TEST_EMAIL_DOMAIN}`,
          ]),
        ],
      }),
      deleteUser: async () => {
        throw new Error("delete failed");
      },
    });
    const dependencies: CleanupDependencies = {
      clerk,
      database: createDatabase(),
    };

    const result = await withSafeCleanupEnvironment(() =>
      runCleanup(["--apply"], dependencies),
    );

    assert.equal(result, 1);
  });
});