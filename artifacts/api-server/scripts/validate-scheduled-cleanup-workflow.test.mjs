import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./validate-scheduled-cleanup-workflow.mjs", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("./fixtures/scheduled-cleanup-wrong-command.yml", import.meta.url),
);

test("rejects a scheduled cleanup job that invokes the wrong command", async () => {
  const result = await runValidator(fixturePath);

  assert.notEqual(result.code, 0, result.output);
  assert.match(
    result.output,
    /must unset DATABASE_URL and invoke the scheduled cleanup command/,
  );
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
