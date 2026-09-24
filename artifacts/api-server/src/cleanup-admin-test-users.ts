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
const CLEANUP_EVENT = "admin_test_user_cleanup";
const CLEANUP_WEBHOOK_MAX_ATTEMPTS = 3;
const CLEANUP_WEBHOOK_RETRY_DELAY_MS = 250;
const CLERK_RATE_LIMIT_MAX_ATTEMPTS = 5;

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
  notifyFailure?: CleanupFailureNotifier;
};

export type CleanupFailureNotification = {
  affectedUserCount: number;
  affectedUsers: Array<{
    id: string;
    username: string | null;
  }>;
};

export type CleanupNotificationDelivery =
  | { status: "not_attempted"; attempts: 0 }
  | { status: "delivered"; attempts: number }
  | {
      status: "failed";
      attempts: number;
      failure: "network_error" | "http_error" | "delivery_error";
      httpStatus?: number;
    };

export type CleanupFailureNotifier = (
  notification: CleanupFailureNotification,
) =>
  | CleanupNotificationDelivery
  | void
  | Promise<CleanupNotificationDelivery | void>;

const defaultDependencies: CleanupDependencies = {
  clerk: clerkClient as unknown as CleanupClerkClient,
  database: pool,
};

async function clerkRequestWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;
      if (status !== 429 || attempt >= CLERK_RATE_LIMIT_MAX_ATTEMPTS) throw error;
      const retryAfter = typeof error === "object" && error !== null && "retryAfter" in error
        ? (error as { retryAfter?: unknown }).retryAfter
        : undefined;
      const delayMs = (typeof retryAfter === "number" ? retryAfter : 1) * 1_000 + 100;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

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

  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL is required for test-user cleanup.",
    );
  }

  if (Object.hasOwn(process.env, "DATABASE_URL")) {
    throw new Error(
      "Refusing to clean up test users while DATABASE_URL is set. Use only TEST_DATABASE_URL.",
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
    const page = await clerkRequestWithRetry(() => clerk.users.getUserList({
      query: TEST_USERNAME_PREFIX,
      limit: PAGE_SIZE,
      offset,
    }));
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
    const page = await clerkRequestWithRetry(() => clerk.sessions.getSessionList({
      userId,
      limit: PAGE_SIZE,
      offset,
    }));
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
            await clerkRequestWithRetry(
              () => dependencies.clerk.sessions.revokeSession(id),
            );
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
      await clerkRequestWithRetry(
        () => dependencies.clerk.users.deleteUser(user.id),
      );
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
  const message = error instanceof Error ? error.message : String(error);
  return redactClerkCredentials(message);
}

function redactClerkCredentials(message: string): string {
  const clerkKeyPattern = /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9_-]+/g;
  let redacted = message.replace(clerkKeyPattern, "[REDACTED_CLERK_KEY]");

  for (const key of [
    process.env.CLERK_SECRET_KEY,
    process.env.CLERK_PUBLISHABLE_KEY,
  ]) {
    if (key) {
      redacted = redacted.split(key).join("[REDACTED_CLERK_KEY]");
    }
  }

  return redacted;
}

function summarizeUsers(users: CleanupUser[]): Array<{
  id: string;
  username: string | null;
}> {
  return users.map(({ id, username }) => ({ id, username }));
}

function createFailureNotification(
  users: CleanupUser[],
): CleanupFailureNotification {
  return {
    affectedUserCount: users.length,
    affectedUsers: summarizeUsers(users),
  };
}

function formatFailureNotification(
  notification: CleanupFailureNotification,
): string {
  const users = notification.affectedUsers
    .map(({ id, username }) => (username ? `${username} (${id})` : id))
    .join(", ");
  const userLabel = notification.affectedUserCount === 1 ? "user" : "users";

  return redactClerkCredentials(
    `Scheduled admin test-user cleanup failed for ${notification.affectedUserCount} affected ${userLabel}: ${
      users || "none found"
    }.`,
  );
}

function escapeGitHubActionsCommandData(message: string): string {
  return message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function isTransientWebhookStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForWebhookRetry(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, CLEANUP_WEBHOOK_RETRY_DELAY_MS);
  });
}

async function notifyCleanupFailure(
  notification: CleanupFailureNotification,
): Promise<CleanupNotificationDelivery> {
  const message = formatFailureNotification(notification);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(
      `::error title=Abandoned test-user cleanup failed::${escapeGitHubActionsCommandData(
        message,
      )}`,
    );
  } else {
    console.error(`ALERT: ${message}`);
  }

  const webhookUrl = process.env.TEAM_NOTIFICATION_WEBHOOK_URL;
  if (process.env.GITHUB_ACTIONS !== "true" || !webhookUrl) {
    return { status: "not_attempted", attempts: 0 };
  }

  let lastFailure: {
    failure: "network_error" | "http_error";
    httpStatus?: number;
  } = { failure: "network_error" };
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= CLEANUP_WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
      if (response.ok) {
        return { status: "delivered", attempts: attemptsMade };
      }

      lastFailure = { failure: "http_error", httpStatus: response.status };
      const failureSummary = `HTTP ${response.status}`;
      const shouldRetry =
        isTransientWebhookStatus(response.status) &&
        attempt < CLEANUP_WEBHOOK_MAX_ATTEMPTS;
      if (!shouldRetry) {
        break;
      }

      console.error(
        `Cleanup failure notification delivery failed (${failureSummary}); retrying attempt ${
          attempt + 1
        }/${CLEANUP_WEBHOOK_MAX_ATTEMPTS} in ${
          CLEANUP_WEBHOOK_RETRY_DELAY_MS
        }ms.`,
      );
    } catch {
      lastFailure = { failure: "network_error" };
      const shouldRetry = attempt < CLEANUP_WEBHOOK_MAX_ATTEMPTS;
      if (!shouldRetry) {
        break;
      }

      console.error(
        `Cleanup failure notification delivery failed (network error); retrying attempt ${
          attempt + 1
        }/${CLEANUP_WEBHOOK_MAX_ATTEMPTS} in ${
          CLEANUP_WEBHOOK_RETRY_DELAY_MS
        }ms.`,
      );
    }

    await waitForWebhookRetry();
  }

  if (lastFailure.failure === "network_error") {
    console.error(
      `Failed to deliver cleanup failure notification after ${attemptsMade} attempts.`,
    );
  } else {
    console.error(
      `Failed to deliver cleanup failure notification after ${attemptsMade} attempts (HTTP ${lastFailure.httpStatus}).`,
    );
  }
  return {
    status: "failed",
    attempts: attemptsMade,
    ...lastFailure,
  };
}

function logCleanupEvent(
  status: "dry_run" | "started" | "succeeded" | "failed",
  users: CleanupUser[],
  error?: unknown,
  notificationDelivery: CleanupNotificationDelivery = {
    status: "not_attempted",
    attempts: 0,
  },
): void {
  console.log(
    JSON.stringify({
      event: CLEANUP_EVENT,
      status,
      notificationDelivery,
      foundUsers: summarizeUsers(users),
      ...(error ? { error: formatError(error) } : {}),
    }),
  );
}

async function notifyFailureWithoutMaskingCleanupError(
  notifier: CleanupFailureNotifier,
  notification: CleanupFailureNotification,
): Promise<CleanupNotificationDelivery> {
  try {
    const delivery = await notifier(notification);
    return delivery ?? { status: "delivered", attempts: 1 };
  } catch {
    console.error(
      "Failed to deliver cleanup failure notification; preserving the cleanup error.",
    );
    return {
      status: "failed",
      attempts: 1,
      failure: "delivery_error",
    };
  }
}

export async function main(
  args: string[] = process.argv.slice(2),
  dependencies: CleanupDependencies = defaultDependencies,
): Promise<void> {
  assertSupportedArguments(args);
  assertSafeCleanupEnvironment();

  const apply = args.includes(APPLY_FLAG);
  let users: CleanupUser[] = [];
  try {
    users = await listMatchingUsers(dependencies.clerk);
  } catch (error) {
    if (apply) {
      const notification = createFailureNotification(users);
      const notificationDelivery = await notifyFailureWithoutMaskingCleanupError(
        dependencies.notifyFailure ?? notifyCleanupFailure,
        notification,
      );
      logCleanupEvent("failed", users, error, notificationDelivery);
    }
    throw error;
  }

  console.log(
    `Found ${users.length} admin regression test user(s) matching ${TEST_USERNAME_PREFIX}.`,
  );

  if (!apply) {
    logCleanupEvent("dry_run", users);
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

  logCleanupEvent("started", users);
  try {
    await cleanupUsers(users, dependencies);
  } catch (error) {
    const notification = createFailureNotification(users);
    const notificationDelivery = await notifyFailureWithoutMaskingCleanupError(
      dependencies.notifyFailure ?? notifyCleanupFailure,
      notification,
    );
    logCleanupEvent("failed", users, error, notificationDelivery);
    throw error;
  }
  logCleanupEvent("succeeded", users);
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
