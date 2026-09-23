import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

const { Client } = pg;
const adminUrl = process.env.CI_TEST_DATABASE_ADMIN_URL;
const postgresVersion = process.env.CI_TEST_DATABASE_VERSION ?? "unspecified";
const runnerPath = fileURLToPath(
  new URL("./run-ci-tests.mjs", import.meta.url),
);

const fakePnpmSource = `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const args = process.argv.slice(2).join(" ");
const leakedEnvironment = ["DATABASE_URL", "CI_TEST_DATABASE_ADMIN_URL"].filter(
  (name) => process.env[name],
);
if (leakedEnvironment.length > 0) {
  console.error(
    \`PostgreSQL \${process.env.CI_TEST_DATABASE_VERSION ?? "unspecified"}: database environment leaked into child command: \${leakedEnvironment.join(", ")}\`,
  );
  process.exitCode = 25;
} else if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL was not provided to the child command");
  process.exitCode = 26;
}

await appendFile(
  process.env.CI_TEST_DATABASE_URL_FILE,
  JSON.stringify({
    command: args,
    url: process.env.TEST_DATABASE_URL,
    version: process.env.CI_TEST_DATABASE_VERSION ?? "unspecified",
  }) + "\\n",
);

if (
  process.exitCode === undefined &&
  process.env.CI_FAILURE_MODE === "schema" &&
  args.includes("push:test")
) {
  process.exitCode = 23;
} else if (
  process.exitCode === undefined &&
  process.env.CI_FAILURE_MODE === "noop" &&
  args.includes("check:noop")
) {
  process.exitCode = 27;
} else if (
  process.exitCode === undefined &&
  process.env.CI_FAILURE_MODE === "api" &&
  args.includes("@workspace/api-server") &&
  args.includes("run test")
) {
  process.exitCode = 24;
}
`;

test(
  `provisions and cleans up a database after schema and API commands (PostgreSQL ${postgresVersion})`,
  { skip: !adminUrl && "CI_TEST_DATABASE_ADMIN_URL is not configured" },
  async () => {
    const { databaseUrlFile, summaryFile, tempDirectory, result } =
      await runRunnerWithTempDirectory("success");
    try {
      assert.equal(
        result.code,
        0,
        `the successful child commands should pass for PostgreSQL ${postgresVersion}\n${result.output}`,
      );

      const invocations = await readInvocations(databaseUrlFile);
      assert.deepEqual(
        invocations.map(({ command }) => command),
        [
          "--filter @workspace/db run push:test",
          "--filter @workspace/db run check:noop",
          "--filter @workspace/api-server run test",
        ],
        `schema and API commands should run for PostgreSQL ${postgresVersion}`,
      );
      assert.ok(
        invocations.every(({ url, version }) => {
          return url && version === postgresVersion;
        }),
        `child commands should receive only the disposable PostgreSQL ${postgresVersion} URL`,
      );
      await assertDatabaseDroppedFromUrl(invocations[0].url);
      const summary = await readFile(summaryFile, "utf8");
      assert.match(summary, /Status: passed/);
      assert.match(summary, /Failing stage: none/);
      assert.match(summary, /Cleanup: succeeded/);
      assert.doesNotMatch(summary, /postgresql:\/\//);
    } finally {
      await removeTempDirectory(tempDirectory);
    }
  },
);

test(
  `drops the generated database when schema setup fails (PostgreSQL ${postgresVersion})`,
  { skip: !adminUrl && "CI_TEST_DATABASE_ADMIN_URL is not configured" },
  async () => {
    await assertFailureCleansDatabase("schema");
  },
);

test(
  `drops the generated database when the no-op check fails (PostgreSQL ${postgresVersion})`,
  { skip: !adminUrl && "CI_TEST_DATABASE_ADMIN_URL is not configured" },
  async () => {
    await assertFailureCleansDatabase("noop");
  },
);

test(
  `drops the generated database when API tests fail (PostgreSQL ${postgresVersion})`,
  { skip: !adminUrl && "CI_TEST_DATABASE_ADMIN_URL is not configured" },
  async () => {
    await assertFailureCleansDatabase("api");
  },
);

async function assertFailureCleansDatabase(failureMode) {
  const { databaseUrlFile, summaryFile, tempDirectory, result } =
    await runRunnerWithTempDirectory(failureMode);
  try {
    assert.notEqual(
      result.code,
      0,
      `the ${failureMode} child command should fail for PostgreSQL ${postgresVersion}\n${result.output}`,
    );
    assert.match(
      result.output,
      new RegExp(
        failureMode === "schema"
          ? "Test database schema setup failed"
          : failureMode === "noop"
            ? "Test database schema no-op check failed"
          : "Authenticated admin API tests failed",
      ),
    );

    const invocations = await readInvocations(databaseUrlFile);
    assert.notEqual(
      invocations[0]?.url,
      undefined,
      `the ${failureMode} child command should receive a database for PostgreSQL ${postgresVersion}`,
    );
    await assertDatabaseDroppedFromUrl(invocations[0].url);
    const summary = await readFile(summaryFile, "utf8");
    assert.match(summary, /Status: failed/);
    assert.match(
      summary,
      new RegExp(
        failureMode === "schema"
          ? "Failing stage: schema setup"
          : failureMode === "noop"
            ? "Failing stage: schema no-op check"
          : "Failing stage: authenticated API tests",
      ),
    );
    assert.match(summary, /Cleanup: succeeded/);
    assert.doesNotMatch(summary, /postgresql:\/\//);
    assert.doesNotMatch(summary, /postgres:postgres/);
  } finally {
    await removeTempDirectory(tempDirectory);
  }
}

async function runRunnerWithTempDirectory(failureMode) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "web-irc-ci-test-"));
  const fakeBinDirectory = join(tempDirectory, "bin");
  const fakePnpmPath = join(fakeBinDirectory, "pnpm");
  const databaseUrlFile = join(tempDirectory, "database-url");
  const summaryFile = join(tempDirectory, "summary.md");

  try {
    await mkdir(fakeBinDirectory);
    await writeFile(fakePnpmPath, fakePnpmSource, "utf8");
    await chmod(fakePnpmPath, 0o755);

    const result = await runRunner({
      fakeBinDirectory,
      databaseUrlFile,
      summaryFile,
      failureMode,
    });
    return { databaseUrlFile, summaryFile, tempDirectory, result };
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function readInvocations(databaseUrlFile) {
  let contents;
  try {
    contents = await readFile(databaseUrlFile, "utf8");
  } catch (error) {
    throw new Error(
      `the child command did not run for PostgreSQL ${postgresVersion}`,
      { cause: error },
    );
  }

  const invocations = contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.notEqual(
    invocations.length,
    0,
    `the runner should create a database for PostgreSQL ${postgresVersion}`,
  );
  return invocations;
}

async function assertDatabaseDroppedFromUrl(testDatabaseUrl) {
  assert.ok(
    testDatabaseUrl,
    `the runner should provide a database URL for PostgreSQL ${postgresVersion}`,
  );
  const databaseName = new URL(testDatabaseUrl).pathname.slice(1);

  const adminClient = new Client({ connectionString: adminUrl });
  try {
    await adminClient.connect();
    const result = await adminClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    assert.equal(
      result.rowCount,
      0,
      `temporary database ${databaseName} should be removed on PostgreSQL ${postgresVersion}`,
    );
  } finally {
    await adminClient.end();
  }
}

async function removeTempDirectory(tempDirectory) {
  await rm(tempDirectory, { recursive: true, force: true });
}

function runRunner({
  fakeBinDirectory,
  databaseUrlFile,
  summaryFile,
  failureMode,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI_TEST_DATABASE_ADMIN_URL: adminUrl,
        CI_TEST_DATABASE_URL_FILE: databaseUrlFile,
        CI_FAILURE_MODE: failureMode,
        GITHUB_STEP_SUMMARY: summaryFile,
        DATABASE_URL: "postgresql://persistent.example/web_irc",
        TEST_DATABASE_URL: "postgresql://stale.example/web_irc_test",
        PATH: `${fakeBinDirectory}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
        output,
      });
    });
  });
}
