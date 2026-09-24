import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const scriptPath = fileURLToPath(
  new URL("./validate-scheduled-cleanup-workflow.mjs", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("./fixtures/scheduled-cleanup-wrong-command.yml", import.meta.url),
);
const schemaIsolationFixturePath = fileURLToPath(
  new URL(
    "./fixtures/scheduled-cleanup-schema-without-database-isolation.yml",
    import.meta.url,
  ),
);

test("scheduled cleanup package script invokes cleanup in apply mode", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

  assert.equal(
    packageJson.scripts["cleanup:test-users:scheduled"],
    "NODE_ENV=test pnpm run cleanup:test-users --apply",
    "scheduled cleanup must invoke the intended cleanup entry point with --apply",
  );
});

test("rejects a scheduled cleanup job that invokes the wrong command", async () => {
  const result = await runValidator(fixturePath);

  assert.notEqual(result.code, 0, result.output);
  assert.match(
    result.output,
    /must unset DATABASE_URL and invoke the scheduled cleanup command/,
  );
});

test("rejects schema setup that does not unset DATABASE_URL", async () => {
  const result = await runValidator(schemaIsolationFixturePath);

  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /must unset DATABASE_URL for schema setup/);
});

const unrelatedStepFixturePath = fileURLToPath(
  new URL("./fixtures/scheduled-cleanup-unrelated-step.yml", import.meta.url),
);
const ciWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
);

test("accepts the existing scheduled cleanup workflow", async () => {
  const result = await runValidator(ciWorkflowPath);
  assert.equal(result.code, 0, result.output);
});

test("rejects an unrelated step in the cleanup job", async () => {
  const result = await runValidator(unrelatedStepFixturePath);
  assert.notEqual(result.code, 0, result.output);
  assert.match(
    result.output,
    /unapproved credential-bearing step: - name: Unrelated diagnostics/,
  );
});

test("rejects unrelated commands disguised with an approved step name", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cleanup-workflow-"));
  try {
    const source = await readFile(unrelatedStepFixturePath, "utf8");
    const workflowPath = path.join(directory, "ci.yml");
    await writeFile(
      workflowPath,
      source.replace("name: Unrelated diagnostics", "name: Install dependencies"),
    );
    const result = await runValidator(workflowPath);
    assert.notEqual(result.code, 0, result.output);
    assert.match(
      result.output,
      /unapproved credential-bearing step: - name: Install dependencies/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects blank lines that split the folded cleanup command", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cleanup-workflow-"));
  try {
    const source = await readFile(ciWorkflowPath, "utf8");
    const workflowPath = path.join(directory, "ci.yml");
    const mutated = source.replace(
      "          env -u DATABASE_URL\n          pnpm --filter @workspace/api-server run cleanup:test-users:scheduled",
      "          env -u DATABASE_URL\n\n          pnpm --filter @workspace/api-server run cleanup:test-users:scheduled",
    );
    assert.notEqual(mutated, source, "fixture must split the cleanup command");
    await writeFile(workflowPath, mutated);
    const result = await runValidator(workflowPath);
    assert.notEqual(result.code, 0, result.output);
    assert.match(
      result.output,
      /unapproved credential-bearing step: - name: Remove abandoned test users/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const cleanupCredentials = [
  ["CLERK_SECRET_KEY", "CLERK_TEST_SECRET_KEY"],
  ["CLERK_PUBLISHABLE_KEY", "CLERK_TEST_PUBLISHABLE_KEY"],
  ["TEAM_NOTIFICATION_WEBHOOK_URL", "TEAM_NOTIFICATION_WEBHOOK_URL"],
];
const setupStepNames = [
  "Check out repository",
  "Set up pnpm",
  "Set up Node.js",
  "Install dependencies",
  "Create disposable test schema",
];

for (const [key, secret] of cleanupCredentials) {
  const entry = `${key}: \${{ secrets.${secret} }}`;

  test(`rejects ${key} exposed at job scope`, async () => {
    await assertRejectedMutation(
      (job) => job.replace(/^    env:\n/m, `    env:\n      ${entry}\n`),
      /job-level env must contain only the disposable database/,
    );
  });

  for (const stepName of setupStepNames) {
    test(`rejects ${key} exposed to ${stepName}`, async () => {
      await assertRejectedMutation(
        (job) => job.replace(
          `      - name: ${stepName}\n`,
          `      - name: ${stepName}\n        env:\n          ${entry}\n`,
        ),
        /unapproved credential-bearing step/,
      );
    });
  }

  test(`requires ${key} on the cleanup command itself`, async () => {
    await assertRejectedMutation(
      (job) => job.replace(`          ${entry}\n`, ""),
      /unapproved credential-bearing step: - name: Remove abandoned test users/,
    );
  });

  test(`requires the approved secret binding for ${key}`, async () => {
    await assertRejectedMutation(
      (job) => job.replace(entry, `${key}: incorrect-value`),
      /unapproved credential-bearing step: - name: Remove abandoned test users/,
    );
  });
}

test("rejects arbitrary secrets aliased into job env", async () => {
  await assertRejectedMutation(
    (job) => job.replace(
      /^    env:\n/m,
      "    env:\n      OTHER_TOKEN: ${{ secrets.OTHER_TOKEN }}\n",
    ),
    /job-level env must contain only the disposable database/,
  );
});

async function assertRejectedMutation(mutate, expectedError) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cleanup-workflow-"));
  try {
    const source = await readFile(ciWorkflowPath, "utf8");
    const header = "  cleanup-abandoned-test-users:";
    const jobStart = source.indexOf(header);
    assert.notEqual(jobStart, -1);
    const job = source.slice(jobStart);
    const mutated = mutate(job);
    assert.notEqual(mutated, job, "mutation must change the cleanup job");
    const workflowPath = path.join(directory, "ci.yml");
    await writeFile(workflowPath, source.slice(0, jobStart) + mutated);
    const result = await runValidator(workflowPath);
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, expectedError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runValidator(workflowPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, workflowPath], {
      cwd: path.resolve(path.dirname(scriptPath), "../.."),
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
      resolve({ code: code ?? 1, signal, output });
    });
  });
}
