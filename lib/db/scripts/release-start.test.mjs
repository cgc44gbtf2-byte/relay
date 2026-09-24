import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("API production service runs the guarded release command", async () => {
  const artifact = await readFile(
    join(workspaceRoot, "artifacts/api-server/.replit-artifact/artifact.toml"),
    "utf8",
  );
  const productionRun = artifact
    .split(/^\[services\.production\.run\]\s*$/m)[1]
    ?.split(/^\[/m)[0];
  assert.ok(productionRun, "API artifact must define a production run service");
  const args = productionRun.match(/^\s*args\s*=\s*(\[[^\n]*\])\s*$/m);
  assert.ok(args, "production run must specify command arguments");
  assert.deepEqual(JSON.parse(args[1]), ["pnpm", "run", "release:start"]);
});

test("release startup never starts the API when migrations fail", async () => {
  const { scripts } = JSON.parse(
    await readFile(join(workspaceRoot, "package.json"), "utf8"),
  );
  assert.equal(typeof scripts["release:start"], "string");

  const directory = await mkdtemp(join(tmpdir(), "relay-release-start-"));
  const logPath = join(directory, "calls.log");
  const shim = join(directory, "pnpm");
  try {
    await writeFile(
      shim,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RELEASE_TEST_LOG"\n' +
        'if [ "$*" = "run db:migrate:release" ]; then\n' +
        '  exit "$RELEASE_TEST_MIGRATION_EXIT"\n' +
        "fi\n",
    );
    await chmod(shim, 0o755);

    for (const [migrationExit, expectedCalls] of [
      [42, ["run db:migrate:release"]],
      [
        0,
        ["run db:migrate:release", "--filter @workspace/api-server run start"],
      ],
    ]) {
      await writeFile(logPath, "");
      const result = spawnSync("/bin/sh", ["-c", scripts["release:start"]], {
        cwd: workspaceRoot,
        env: {
          PATH: directory,
          RELEASE_TEST_LOG: logPath,
          RELEASE_TEST_MIGRATION_EXIT: String(migrationExit),
        },
        encoding: "utf8",
      });
      assert.ifError(result.error);
      assert.equal(result.status, migrationExit);
      assert.deepEqual(
        (await readFile(logPath, "utf8")).trim().split("\n"),
        expectedCalls,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
