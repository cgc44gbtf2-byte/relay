import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
