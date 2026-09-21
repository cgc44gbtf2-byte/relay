import { clerkClient } from "@clerk/express";
import { pool } from "@workspace/db";
import {
  isAdminRegressionTestUser,
  TEST_USERNAME_PREFIX,
} from "./admin-test-identity";

const PAGE_SIZE = 100;
const APPLY_FLAG = "--apply";
const DRY_RUN_FLAG = "--dry-run";
const TEST_SECRET_KEY_PREFIX = "sk_test_";
const TEST_PUBLISHABLE_KEY_PREFIX = "pk_test_";

type CleanupUser = {
  id: string;
  username: string | null;
  emailAddresses: Array<{ emailAddress: string }>;
};

type CleanupSession = {
  id: string;
  status: string;
};

type CleanupPage<T> = {
  data: T[];
};

export type CleanupClerkClient = {
  users: {
    getUserList(args: {
      query: string;
      limit: number;
      offset: number;
    }): Promise<CleanupPage<CleanupUser>>;
    deleteUser(userId: string): Promise<unknown>;
  };
  sessions: {
    getSessionList(args: {
      userId: string;
      limit: number;
      offset: number;
    }): Promise<CleanupPage<CleanupSession>>;
    revokeSession(sessionId: string): Promise<unknown>;
  };
};

export type CleanupDatabase = {
  query(text: string, values?: unknown[]): Promise<unknown>;
};

export type CleanupDependencies = {
  clerk: CleanupClerkClient;
  database: CleanupDatabase;
};

const defaultDependencies: CleanupDependencies = {
  clerk: clerkClient as unknown as CleanupClerkClient,
  database: pool,
};

export function assertSafeCleanupEnvironment(): void {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;

  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Refusing to clean up Clerk users unless NODE_ENV=test is set.",
    );
  }

  if (!secretKey || !publishableKey) {
    throw new Error(
      "CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY are required for test-user cleanup.",
    );
  }

  if (
    !secretKey.startsWith(TEST_SECRET_KEY_PREFIX) ||
    !publishableKey.startsWith(TEST_PUBLISHABLE_KEY_PREFIX)
  ) {
    throw new Error(
      "Refusing to clean up Clerk users without sk_test_ and pk_test_ keys.",
    );
  }
}

function assertSupportedArguments(args: string[]): void {
  const unsupportedArgs = args.filter(
    (arg) => arg !== APPLY_FLAG && arg !== DRY_RUN_FLAG,
  );
  if (unsupportedArgs.length > 0) {
    throw new Error(
      `Unsupported argument(s): ${unsupportedArgs.join(
        ", ",
      )}. Use --dry-run or --apply.`,
    );
  }
}

export async function listMatchingUsers(
  clerk: CleanupClerkClient = defaultDependencies.clerk,
): Promise<CleanupUser[]> {
  const matchingUsers: CleanupUser[] = [];
  let offset = 0;

  while (true) {
    const page = await clerk.users.getUserList({
      query: TEST_USERNAME_PREFIX,
      limit: PAGE_SIZE,
      offset,
    });
    matchingUsers.push(
      ...page.data.filter(isAdminRegressionTestUser).map((user) => ({
        id: user.id,
        username: user.username,
        emailAddresses: user.emailAddresses.map(({ emailAddress }) => ({
          emailAddress,
        })),
      })),
    );

    if (page.data.length < PAGE_SIZE) {
      return matchingUsers;
    }
    offset += page.data.length;
  }
}

export async function listUserSessions(
  userId: string,
  clerk: CleanupClerkClient = defaultDependencies.clerk,
): Promise<CleanupSession[]> {
  const sessions: CleanupSession[] = [];
  let offset = 0;

  while (true) {
    const page = await clerk.sessions.getSessionList({
      userId,
      limit: PAGE_SIZE,
      offset,
    });
    sessions.push(
      ...page.data.map(({ id, status }) => ({
        id,
        status,
      })),
    );

    if (page.data.length < PAGE_SIZE) {
      return sessions;
    }
    offset += page.data.length;
  }
}

async function removeDatabaseRows(
  userIds: string[],
  database: CleanupDatabase,
): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  await database.query(
    "DELETE FROM irc_users WHERE clerk_id = ANY($1::text[])",
    [userIds],
  );
}

export async function cleanupUsers(
  users: CleanupUser[],
  dependencies: CleanupDependencies = defaultDependencies,
): Promise<void> {
  const failures: string[] = [];
  await removeDatabaseRows(
    users.map(({ id }) => id),
    dependencies.database,
  );

  for (const user of users) {
    let sessions: CleanupSession[] = [];
    try {
      sessions = await listUserSessions(user.id, dependencies.clerk);
      const activeSessions = sessions.filter(
        ({ status }) => status === "active",
      );
      await Promise.all(
        activeSessions.map(async ({ id }) => {
          try {
            await dependencies.clerk.sessions.revokeSession(id);
          } catch (error) {
            failures.push(
              `session ${id} for ${user.username ?? user.id}: ${formatError(
                error,
              )}`,
            );
          }
        }),
      );
    } catch (error) {
      failures.push(
        `sessions for ${user.username ?? user.id}: ${formatError(error)}`,
      );
    }

    try {
      await dependencies.clerk.users.deleteUser(user.id);
      console.log(
        `Deleted ${user.username ?? user.id} and revoked ${
          sessions.filter(({ status }) => status === "active").length
        } active session(s).`,
      );
    } catch (error) {
      failures.push(
        `user ${user.username ?? user.id}: ${formatError(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`Cleanup completed with errors:\n- ${failures.join("\n- ")}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(
  args: string[] = process.argv.slice(2),
  dependencies: CleanupDependencies = defaultDependencies,
): Promise<void> {
  assertSupportedArguments(args);
  assertSafeCleanupEnvironment();

  const users = await listMatchingUsers(dependencies.clerk);
  const apply = args.includes(APPLY_FLAG);

  console.log(
    `Found ${users.length} admin regression test user(s) matching ${TEST_USERNAME_PREFIX}.`,
  );

  if (!apply) {
    for (const user of users) {
      const sessions = await listUserSessions(user.id, dependencies.clerk);
      console.log(
        `Would delete ${user.username ?? user.id} and revoke ${
          sessions.filter(({ status }) => status === "active").length
        } active session(s).`,
      );
    }
    console.log("Dry run only. Re-run with --apply to delete these users.");
    return;
  }

  await cleanupUsers(users, dependencies);
  console.log("Admin regression test-user cleanup completed.");
}

export async function runCleanup(
  args: string[] = process.argv.slice(2),
  dependencies: CleanupDependencies = defaultDependencies,
): Promise<number> {
  try {
    await main(args, dependencies);
    return 0;
  } catch (error: unknown) {
    console.error(formatError(error));
    return 1;
  }
}
