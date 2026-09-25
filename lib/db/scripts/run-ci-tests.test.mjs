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
import { runCiTests } from "./run-ci-tests.mjs";
import { compatibilityFailureSummary } from "./summarize-compatibility-tests.mjs";

const { Client } = pg;
const adminUrl = process.env.CI_TEST_DATABASE_ADMIN_URL;
const postgresVersion = process.env.CI_TEST_DATABASE_VERSION ?? "unspecified";
const runnerPath = fileURLToPath(
  new URL("./run-ci-tests.mjs", import.meta.url),
);
const diagnosticAdminUrl =
  "postgresql://ci_runner:fake_password_482@127.0.0.1:5432/postgres";
const diagnosticCredential = "fake_diagnostic_credential_482";
const diagnosticMessage = `postgresql://ci_runner:fake_password_482@127.0.0.1:5432/postgres CI_TEST_DIAGNOSTIC_SECRET=${diagnosticCredential}`;

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
  process.env.CI_FAILURE_MODE === "migration" &&
  args.includes("rehearse:migrations")
) {
  process.exitCode = 28;
} else if (
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

test("compatibility summary identifies the matrix version and failing runner tests without copying diagnostics", () => {
  const output = [
    `not ok 4 - drops the generated database when schema setup fails (PostgreSQL 15)`,
    `not ok 5 - preserves provisioning diagnostics when connect fails (PostgreSQL 15)`,
    `not ok 6 - preserves cleanup diagnostics after failed API tests (PostgreSQL 15)`,
    "  error: postgresql://runner:secret@127.0.0.1:5432/postgres",
    "not ok 7 - unrelated test exposing a credential=secret",
    "not ok 8 - drops the generated database when API tests fail (PostgreSQL 14)",
  ].join("\n");
  const summary = compatibilityFailureSummary(output, "15");
  assert.match(summary, /## PostgreSQL runner compatibility tests/);
  assert.match(summary, /PostgreSQL: 15/);
  assert.match(summary, /drops the generated database when schema setup fails/);
  assert.match(summary, /preserves provisioning diagnostics when connect fails/);
  assert.match(summary, /preserves cleanup diagnostics after failed API tests/);
  assert.doesNotMatch(summary, /when API tests fail|secret|postgresql:\/\//);
  assert.doesNotMatch(summary, /authenticated API tests/);
});

test("compatibility summary reports setup failures without copying test output or untrusted version labels", () => {
  const summary = compatibilityFailureSummary(
    "Error: postgresql://runner:secret@127.0.0.1:5432/postgres",
    "15\n- password: secret",
  );
  assert.match(summary, /PostgreSQL: unspecified/);
  assert.match(summary, /No failing runner test was reported/);
  assert.doesNotMatch(summary, /secret|postgresql:\/\//);
});

test("isolates migration rehearsal from fresh schema and API commands", async () => {
  const queries = [];
  const invocations = [];
  let ended = false;
  const adminClient = {
    async connect() {},
    async query(query, parameters) {
      queries.push({ query, parameters });
      return { rows: [] };
    },
    async end() {
      ended = true;
    },
  };

  await runCiTests({
    adminUrl: diagnosticAdminUrl,
    clientFactory: () => adminClient,
    runCommandImpl: async (_command, args, { TEST_DATABASE_URL }) => {
      invocations.push({ args, url: TEST_DATABASE_URL });
    },
  });

  assert.equal(invocations.length, 4);
  const rehearsalUrl = invocations[0].url;
  const currentSchemaUrl = invocations[1].url;
  assert.notEqual(rehearsalUrl, currentSchemaUrl);
  assert.ok(
    invocations.slice(1).every(({ url }) => url === currentSchemaUrl),
    "fresh schema setup, no-op check, and API tests must share one database",
  );

  const createdDatabaseNames = queries
    .filter(({ query }) => query.startsWith("CREATE DATABASE"))
    .map(({ query }) => query.match(/^CREATE DATABASE "([^"]+)"$/)?.[1]);
  assert.deepEqual(
    new Set(createdDatabaseNames),
    new Set([
      new URL(currentSchemaUrl).pathname.slice(1),
      new URL(rehearsalUrl).pathname.slice(1),
    ]),
  );
  assert.deepEqual(
    queries
      .filter(({ query }) => query.startsWith("SELECT pg_terminate_backend"))
      .map(({ parameters }) => parameters[0]),
    createdDatabaseNames,
    "cleanup must attempt both disposable databases",
  );
  assert.equal(
    queries.filter(({ query }) => query.startsWith("DROP DATABASE")).length,
    2,
  );
  assert.equal(ended, true);
});

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
          "--filter @workspace/db run rehearse:migrations",
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
      assert.notEqual(
        invocations[0].url,
        invocations[1].url,
        "migration rehearsal must use a different database from fresh schema tests",
      );
      assert.ok(
        invocations.slice(1).every(({ url }) => url === invocations[1].url),
        "schema, no-op, and API tests must share the fresh current-schema database",
      );
      await Promise.all(
        [...new Set(invocations.map(({ url }) => url))].map(
          assertDatabaseDroppedFromUrl,
        ),
      );
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
  `rehearses real migrations and validates the current schema (PostgreSQL ${postgresVersion})`,
  { skip: !adminUrl && "CI_TEST_DATABASE_ADMIN_URL is not configured" },
  async () => {
    const databaseUrls = new Set();
    const verifiedCommands = [];
    try {
      await runCiTests({
        adminUrl,
        runCommandImpl: async (command, args, { TEST_DATABASE_URL }) => {
          const script = args.at(-1);
          databaseUrls.add(TEST_DATABASE_URL);
          if (args.includes("@workspace/api-server")) {
            // Compatibility coverage must not call Clerk. Authenticated API
            // tests run in the primary database CI job.
            verifiedCommands.push("api-stub");
            return;
          }

          await runRealDatabaseCommand(command, args, TEST_DATABASE_URL);
          if (script === "push:test") {
            await assertSchemaExists(TEST_DATABASE_URL);
          }
          verifiedCommands.push(script);
        },
      });
      assert.deepEqual(
        verifiedCommands,
        ["rehearse:migrations", "push:test", "check:noop", "api-stub"],
        `real migration, schema, and no-op checks must run on PostgreSQL ${postgresVersion}`,
      );
      assert.equal(
        databaseUrls.size,
        2,
        `migration rehearsal and current-schema checks must use separate databases on PostgreSQL ${postgresVersion}`,
      );
    } catch (error) {
      assert.match(
        error.message,
        new RegExp(`PostgreSQL ${postgresVersion}`),
        "real compatibility failures must identify the PostgreSQL version",
      );
      throw error;
    } finally {
      await Promise.all([...databaseUrls].map(assertDatabaseDroppedFromUrl));
    }
  },
);

test(
  `drops the generated database when migration rehearsal fails (PostgreSQL ${postgresVersion})`,
  { skip: !adminUrl && "CI_TEST_DATABASE_ADMIN_URL is not configured" },
  async () => {
    await assertFailureCleansDatabase("migration");
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

for (const failurePoint of ["connect", "create"]) {
  test(
    `preserves provisioning diagnostics when ${failurePoint} fails (PostgreSQL ${postgresVersion})`,
    async () => {
      await withDiagnosticSummary(async (summaryFile) => {
        const queries = [];
        let ended = false;
        let commands = 0;
        const adminClient = {
          async connect() {
            if (failurePoint === "connect") {
              throw new Error(`connection refused: ${diagnosticMessage}`);
            }
          },
          async query(query) {
            queries.push(query);
            if (failurePoint === "create" && query.startsWith("CREATE DATABASE")) {
              throw new Error(`permission denied to create database: ${diagnosticMessage}`);
            }
            return { rows: [] };
          },
          async end() {
            ended = true;
          },
        };

        await assert.rejects(
          () =>
            runCiTests({
              adminUrl: diagnosticAdminUrl,
              clientFactory: () => adminClient,
              runCommandImpl: async () => {
                commands++;
              },
            }),
          /Test database provisioning failed/,
        );

        assert.equal(commands, 0, "commands must not run without a test database");
        assert.equal(ended, failurePoint === "create");
        assert.deepEqual(
          queries.map((query) => query.split(" ")[0]),
          failurePoint === "connect"
            ? []
            : ["CREATE", "SELECT", "DROP", "SELECT", "DROP"],
        );
        const summary = await readFile(summaryFile, "utf8");
        assert.match(summary, /Status: failed/);
        assert.match(summary, /Failing stage: database provisioning/);
        assert.match(
          summary,
          new RegExp(`Cleanup: ${failurePoint === "connect" ? "not attempted" : "succeeded"}`),
        );
        assert.match(
          summary,
          /Runner diagnostic: Test database provisioning failed \(PostgreSQL .*?\): (?:connection refused|permission denied to create database): .*\[redacted\].*\[redacted-setting\]/,
        );
        assert.doesNotMatch(summary, /Cleanup diagnostic:/);
        assertDiagnosticRedacted(summary);
      });
    },
  );
}

for (const apiFails of [false, true]) {
  test(
    `preserves cleanup diagnostics after ${apiFails ? "failed API tests" : "successful tests"} (PostgreSQL ${postgresVersion})`,
    async () => {
      await withDiagnosticSummary(async (summaryFile) => {
        const commands = [];
        const queries = [];
        let ended = false;
        const adminClient = {
          async connect() {},
          async query(query) {
            queries.push(query);
            if (query.startsWith("DROP DATABASE")) {
              throw new Error(`permission denied to drop database: ${diagnosticMessage}`);
            }
            return { rows: [] };
          },
          async end() {
            ended = true;
          },
        };
        const runCommandImpl = async (_command, args) => {
          commands.push(args.join(" "));
          if (apiFails && args.includes("@workspace/api-server")) {
            throw new Error(`API checks failed: ${diagnosticMessage}`);
          }
        };

        if (apiFails) {
          await assert.rejects(
            () => runCiTests({ adminUrl: diagnosticAdminUrl, clientFactory: () => adminClient, runCommandImpl }),
            (error) => {
              assert.ok(error instanceof AggregateError);
              assert.equal(error.errors.length, 2);
              assert.match(error.errors[0].message, /Authenticated admin API tests failed/);
              assert.match(error.errors[1].message, /Test database cleanup failed/);
              return true;
            },
          );
        } else {
          await assert.rejects(
            () => runCiTests({ adminUrl: diagnosticAdminUrl, clientFactory: () => adminClient, runCommandImpl }),
            /Test database cleanup failed/,
          );
        }

        assert.equal(commands.length, 4);
        assert.deepEqual(
          queries.map((query) => query.split(" ")[0]),
          [
            "CREATE",
            "CREATE",
            "CREATE",
            "SELECT",
            "DROP",
            "SELECT",
            "DROP",
          ],
        );
        assert.equal(ended, true, "the admin connection must close even if DROP fails");
        const summary = await readFile(summaryFile, "utf8");
        assert.match(summary, /Status: failed/);
        assert.match(summary, apiFails ? /Failing stage: authenticated API tests/ : /Failing stage: cleanup/);
        assert.match(summary, /Cleanup: failed/);
        assert.match(
          summary,
          /Cleanup diagnostic: Test database cleanup failed \(PostgreSQL .*?\): permission denied to drop database: .*\[redacted\].*\[redacted-setting\]/,
        );
        if (apiFails) {
          assert.match(
            summary,
            /Runner diagnostic: Authenticated admin API tests failed \(PostgreSQL .*?\): API checks failed: .*\[redacted\].*\[redacted-setting\]/,
          );
        } else {
          assert.doesNotMatch(summary, /Runner diagnostic:/);
        }
        assertDiagnosticRedacted(summary);
      });
    },
  );
}

async function withDiagnosticSummary(check) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "web-irc-ci-diagnostics-"));
  const summaryFile = join(tempDirectory, "summary.md");
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  const previousSecret = process.env.CI_TEST_DIAGNOSTIC_SECRET;
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  process.env.CI_TEST_DIAGNOSTIC_SECRET = diagnosticCredential;
  try {
    await check(summaryFile);
  } finally {
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
    if (previousSecret === undefined) delete process.env.CI_TEST_DIAGNOSTIC_SECRET;
    else process.env.CI_TEST_DIAGNOSTIC_SECRET = previousSecret;
    await removeTempDirectory(tempDirectory);
  }
}

function assertDiagnosticRedacted(summary) {
  assert.doesNotMatch(summary, /postgres(?:ql)?:\/\//i);
  assert.ok(!summary.includes(diagnosticAdminUrl));
  assert.ok(!summary.includes("fake_password_482"));
  assert.ok(!summary.includes(diagnosticCredential));
  assert.doesNotMatch(summary, /CI_TEST_DIAGNOSTIC_SECRET=/);
}

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
            : failureMode === "migration"
              ? "Reviewed migration rehearsal failed"
              : failureMode === "noop"
                ? "Test database schema no-op check failed"
                : "Authenticated admin API tests failed",
      ),
    );
    assert.match(
      result.output,
      new RegExp(`PostgreSQL ${postgresVersion}`),
      "schema and command failures must identify the PostgreSQL version",
    );

    const invocations = await readInvocations(databaseUrlFile);
    assert.notEqual(
      invocations[0]?.url,
      undefined,
      `the ${failureMode} child command should receive a database for PostgreSQL ${postgresVersion}`,
    );
    await Promise.all(
      [...new Set(invocations.map(({ url }) => url))].map(
        assertDatabaseDroppedFromUrl,
      ),
    );
    const summary = await readFile(summaryFile, "utf8");
    assert.match(summary, /Status: failed/);
    assert.match(
      summary,
      new RegExp(
        failureMode === "schema"
          ? "Failing stage: schema setup"
            : failureMode === "migration"
              ? "Failing stage: reviewed migration rehearsal"
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

function runRealDatabaseCommand(command, args, testDatabaseUrl) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, NODE_ENV: "test", TEST_DATABASE_URL: testDatabaseUrl };
    delete environment.DATABASE_URL;
    delete environment.CI_TEST_DATABASE_ADMIN_URL;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(
        `real database command ${signal ? `terminated by ${signal}` : `exited with code ${code}`}:\n${output}`,
      ));
    });
  });
}

async function assertSchemaExists(testDatabaseUrl) {
  const client = new Client({ connectionString: testDatabaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT
        to_regclass('public.irc_users') IS NOT NULL AS users,
        to_regclass('public.irc_channels') IS NOT NULL AS channels,
        to_regclass('public.irc_messages') IS NOT NULL AS messages,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.irc_channel_members')
            AND contype = 'p'
        ) AS membership_key,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('public.irc_messages')
            AND contype = 'f'
        ) AS message_foreign_key
    `);
    for (const [item, present] of Object.entries(rows[0] ?? {})) {
      assert.equal(
        present,
        true,
        `${item} must exist after real schema push on PostgreSQL ${postgresVersion}`,
      );
    }
    assert.equal(Object.keys(rows[0] ?? {}).length, 5);
  } finally {
    await client.end();
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
