import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

export async function runCiTests({
  adminUrl = process.env.CI_TEST_DATABASE_ADMIN_URL,
  runCommandImpl = runCommand,
} = {}) {
  if (!adminUrl) {
    const error = new Error(
      "CI_TEST_DATABASE_ADMIN_URL must be set to a PostgreSQL admin connection string.",
    );
    await writeCiSummary({
      databaseVersion: process.env.CI_TEST_DATABASE_VERSION,
      stage: "input validation",
      testError: error,
      cleanupStatus: "not attempted",
    });
    throw error;
  }

  const databaseName = createDatabaseName();
  let adminConnectionString;
  try {
    adminConnectionString = validatePostgresUrl(adminUrl);
  } catch (error) {
    await writeCiSummary({
      databaseVersion: process.env.CI_TEST_DATABASE_VERSION,
      stage: "input validation",
      testError: error,
      cleanupStatus: "not attempted",
    });
    throw error;
  }
  const testConnectionString = setDatabaseName(
    adminConnectionString,
    databaseName,
  );

  const adminClient = new Client({ connectionString: adminConnectionString });
  let adminConnected = false;
  let testError;
  let stage = "database provisioning";

  try {
    try {
      await adminClient.connect();
      adminConnected = true;
      await adminClient.query(
        `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
      );
    } catch (error) {
      throw createStageError("Test database provisioning failed", error);
    }

    stage = "schema setup";
    try {
      await runCommandImpl(
        "pnpm",
        ["--filter", "@workspace/db", "run", "push:test"],
        {
          TEST_DATABASE_URL: testConnectionString,
        },
      );
    } catch (error) {
      throw createStageError("Test database schema setup failed", error);
    }

    stage = "schema no-op check";
    try {
      await runCommandImpl(
        "pnpm",
        ["--filter", "@workspace/db", "run", "check:noop"],
        {
          TEST_DATABASE_URL: testConnectionString,
        },
      );
    } catch (error) {
      throw createStageError("Test database schema no-op check failed", error);
    }

    stage = "authenticated API tests";
    try {
      await runCommandImpl(
        "pnpm",
        ["--filter", "@workspace/api-server", "run", "test"],
        {
          TEST_DATABASE_URL: testConnectionString,
        },
      );
    } catch (error) {
      throw createStageError("Authenticated admin API tests failed", error);
    }
  } catch (error) {
    testError = error;
  }

  let cleanupError;
  let cleanupStatus = adminConnected ? "in progress" : "not attempted";
  try {
    await dropDatabase({ adminClient, adminConnected, databaseName });
    cleanupStatus = adminConnected ? "succeeded" : "not attempted";
  } catch (error) {
    cleanupError = createStageError("Test database cleanup failed", error);
    cleanupStatus = "failed";
  }

  await writeCiSummary({
    databaseVersion: process.env.CI_TEST_DATABASE_VERSION,
    stage: testError ? stage : cleanupError ? "cleanup" : "none",
    testError,
    cleanupError,
    cleanupStatus,
  });

  if (testError && cleanupError) {
    throw new AggregateError(
      [testError, cleanupError],
      `${testError.message}; ${cleanupError.message}`,
    );
  }
  if (cleanupError) {
    throw cleanupError;
  }
  if (testError) {
    throw testError;
  }
}

function createDatabaseName() {
  const runId = [
    process.env.CI_RUN_ID,
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT,
    process.env.CI_JOB_ID,
  ]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .toLowerCase();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
  const prefix = `web_irc_ci_${runId || "run"}`;
  const availablePrefixLength = 63 - suffix.length - 1;
  return `${prefix.slice(0, availablePrefixLength)}_${suffix}`;
}

function validatePostgresUrl(connectionString) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(
      "CI_TEST_DATABASE_ADMIN_URL must use the postgres:// or postgresql:// protocol.",
    );
  }
  return url.toString();
}

function setDatabaseName(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function createStageError(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  const databaseVersion = process.env.CI_TEST_DATABASE_VERSION;
  const versionLabel = databaseVersion
    ? ` (PostgreSQL ${databaseVersion})`
    : "";
  return new Error(`${stage}${versionLabel}: ${message}`, { cause: error });
}

async function writeCiSummary({
  databaseVersion,
  stage,
  testError,
  cleanupError,
  cleanupStatus,
}) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  const status = testError || cleanupError ? "failed" : "passed";
  const lines = [
    "## Disposable database runner",
    `- PostgreSQL: ${databaseVersion || "unspecified"}`,
    `- Status: ${status}`,
    `- Failing stage: ${stage}`,
    `- Cleanup: ${cleanupStatus}`,
  ];

  if (testError) {
    lines.push(`- Runner diagnostic: ${formatDiagnostic(testError)}`);
  }
  if (cleanupError) {
    lines.push(`- Cleanup diagnostic: ${formatDiagnostic(cleanupError)}`);
  }

  try {
    await appendFile(summaryPath, `${lines.join("\n")}\n\n`, "utf8");
  } catch (error) {
    console.error(
      `Unable to write the disposable database runner summary: ${formatDiagnostic(error)}`,
    );
  }
}

function formatDiagnostic(error) {
  const message = error instanceof Error ? error.message : String(error);
  let safeMessage = message
    .replace(
      /\b(?:postgres(?:ql)?):\/\/[^\s/]+(?:\/[^\s]*)?/gi,
      "postgresql://[redacted]",
    )
    .replace(
      /\b[A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|WEBHOOK|DATABASE_URL)[A-Z0-9_]*\s*=\s*[^\s,;]+/gi,
      "[redacted-setting]",
    )
    .replace(/\s+/g, " ")
    .trim();

  for (const value of Object.values(process.env)) {
    if (value && value.length >= 4) {
      safeMessage = safeMessage.split(value).join("[redacted]");
    }
  }

  return safeMessage || "No diagnostic message was provided.";
}

function commandEnvironment(testDatabaseUrl) {
  const environment = { ...process.env, NODE_ENV: "test" };
  delete environment.DATABASE_URL;
  delete environment.CI_TEST_DATABASE_ADMIN_URL;
  delete environment.TEST_DATABASE_URL;
  environment.TEST_DATABASE_URL = testDatabaseUrl;
  return environment;
}

function runCommand(command, args, { TEST_DATABASE_URL }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: commandEnvironment(TEST_DATABASE_URL),
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} ${
            signal ? `was terminated by ${signal}` : `exited with code ${code}`
          }`,
        ),
      );
    });
  });
}

async function dropDatabase({ adminClient, adminConnected, databaseName }) {
  if (!adminConnected) {
    return;
  }

  try {
    await adminClient.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await adminClient.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
    );
  } finally {
    await adminClient.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await runCiTests();
}
