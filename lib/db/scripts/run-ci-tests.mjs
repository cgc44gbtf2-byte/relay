import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";

const { Client } = pg;

const adminUrl = process.env.CI_TEST_DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error(
    "CI_TEST_DATABASE_ADMIN_URL must be set to a PostgreSQL admin connection string.",
  );
}

const databaseName = createDatabaseName();
const adminConnectionString = validatePostgresUrl(adminUrl);
const testConnectionString = setDatabaseName(
  adminConnectionString,
  databaseName,
);

const adminClient = new Client({ connectionString: adminConnectionString });
let adminConnected = false;

try {
  await adminClient.connect();
  adminConnected = true;
  await adminClient.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  await runCommand("pnpm", ["--filter", "@workspace/db", "run", "push:test"], {
    TEST_DATABASE_URL: testConnectionString,
  });
  await runCommand(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "test"],
    {
      TEST_DATABASE_URL: testConnectionString,
    },
  );
} finally {
  await dropDatabase();
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

async function dropDatabase() {
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
