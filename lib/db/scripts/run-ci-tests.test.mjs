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
const runnerPath = fileURLToPath(
  new URL("./run-ci-tests.mjs", import.meta.url),
);

const fakePnpmSource = `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const args = process.argv.slice(2).join(" ");
await appendFile(
  process.env.CI_TEST_DATABASE_URL_FILE,
  process.env.TEST_DATABASE_URL + "\\n",
);

if (
  process.env.CI_FAILURE_MODE === "schema" &&
  args.includes("push:test")
) {
  process.exitCode = 23;
} else if (
  process.env.CI_FAILURE_MODE === "api" &&
  args.includes("@workspace/api-server") &&
  args.includes("run test")
) {
  process.exitCode = 24;
}
`;

test(
  "drops the generated database when schema setup fails",
  { skip: !adminUrl && "CI_TEST_DATABASE_ADMIN_URL is not configured" },
  async () => {
    await assertDatabaseDropped("schema");
  },
);

test(
  "drops the generated database when API tests fail",
  { skip: !adminUrl && "CI_TEST_DATABASE_ADMIN_URL is not configured" },
  async () => {
    await assertDatabaseDropped("api");
  },
);

async function assertDatabaseDropped(failureMode) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "web-irc-ci-test-"));
  const fakeBinDirectory = join(tempDirectory, "bin");
  const fakePnpmPath = join(fakeBinDirectory, "pnpm");
  const databaseUrlFile = join(tempDirectory, "database-url");

  try {
    await mkdir(fakeBinDirectory);
    await writeFile(fakePnpmPath, fakePnpmSource, "utf8");
    await chmod(fakePnpmPath, 0o755);

    const result = await runRunner({
      fakeBinDirectory,
      databaseUrlFile,
      failureMode,
    });
    assert.notEqual(
      result.code,
      0,
      `the ${failureMode} child command should fail\n${result.output}`,
    );

    let testDatabaseUrl;
    try {
      testDatabaseUrl = (await readFile(databaseUrlFile, "utf8")).trim();
    } catch (error) {
      throw new Error(
        `the ${failureMode} child command did not run\n${result.output}`,
        { cause: error },
      );
    }
    assert.notEqual(testDatabaseUrl, "", "the runner should create a database");
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
        `temporary database ${databaseName} should be removed`,
      );
    } finally {
      await adminClient.end();
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function runRunner({ fakeBinDirectory, databaseUrlFile, failureMode }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI_TEST_DATABASE_ADMIN_URL: adminUrl,
        CI_TEST_DATABASE_URL_FILE: databaseUrlFile,
        CI_FAILURE_MODE: failureMode,
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
