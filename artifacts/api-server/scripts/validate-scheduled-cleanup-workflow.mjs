import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workflowPathArgument = process.argv
  .slice(2)
  .find((argument) => argument !== "--");
const workflowPath =
  workflowPathArgument ??
  path.resolve(packageDir, "../../.github/workflows/ci.yml");

const workflow = await readFile(workflowPath, "utf8");
const job = extractJob(workflow, "cleanup-abandoned-test-users");
const jobEnv = extractJobEnv(job);
const envEntries = parseEnvEntries(jobEnv);

const expectedEnv = new Map([
  [
    "TEST_DATABASE_URL",
    "postgresql://postgres@127.0.0.1:5432/web_irc_cleanup",
  ],
  ["CLERK_SECRET_KEY", "${{ secrets.CLERK_TEST_SECRET_KEY }}"],
  ["CLERK_PUBLISHABLE_KEY", "${{ secrets.CLERK_TEST_PUBLISHABLE_KEY }}"],
  [
    "TEAM_NOTIFICATION_WEBHOOK_URL",
    "${{ secrets.TEAM_NOTIFICATION_WEBHOOK_URL }}",
  ],
]);

assert.match(
  job,
  /^\s*if:\s*github\.event_name\s*==\s*['"]schedule['"]\s*$/m,
  "scheduled cleanup must only run for scheduled workflow events",
);
assert.deepEqual(
  envEntries,
  expectedEnv,
  "scheduled cleanup must use only the disposable database and test Clerk secrets",
);
assert.match(
  job,
  /^\s{8}run:\s+env -u DATABASE_URL pnpm --filter @workspace\/db run push:test\s*$/m,
  "scheduled cleanup must unset DATABASE_URL for schema setup",
);
assert.match(
  job,
  /^\s{10}env -u DATABASE_URL\s*\n\s{10}pnpm --filter @workspace\/api-server run cleanup:test-users:scheduled\s*$/m,
  "scheduled cleanup must unset DATABASE_URL and invoke the scheduled cleanup command",
);

for (const secretName of job.matchAll(
  /\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g,
)) {
  assert.ok(
    secretName[1] === "CLERK_TEST_SECRET_KEY" ||
      secretName[1] === "CLERK_TEST_PUBLISHABLE_KEY" ||
      secretName[1] === "TEAM_NOTIFICATION_WEBHOOK_URL",
    `scheduled cleanup references an unapproved secret: ${secretName[1]}`,
  );
}

assert.doesNotMatch(
  job,
  /^\s*DATABASE_URL\s*:/m,
  "scheduled cleanup must not define DATABASE_URL",
);
assert.doesNotMatch(
  job,
  /\b(?:sk|pk)_live_[A-Za-z0-9_-]+/,
  "scheduled cleanup must not contain live Clerk key values",
);

validateCleanupSteps(job);

console.log(`Validated scheduled cleanup environment in ${workflowPath}`);

function validateCleanupSteps(job) {
  // Job-scoped credentials reach every step. Fail closed on additions or
  // changes to executable content, not just on unfamiliar display names.
  const approvedSteps = [
    `- name: Check out repository
  uses: actions/checkout@v4`,
    `- name: Set up pnpm
  uses: pnpm/action-setup@v4
  with:
    version: 10.26.1`,
    `- name: Set up Node.js
  uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: pnpm`,
    `- name: Install dependencies
  run: pnpm install --frozen-lockfile`,
    `- name: Create disposable test schema
  run: env -u DATABASE_URL pnpm --filter @workspace/db run push:test`,
    `- name: Remove abandoned test users
  run: >-
    env -u DATABASE_URL
    pnpm --filter @workspace/api-server run cleanup:test-users:scheduled`,
  ];
  const lines = job.split("\n");
  const start = lines.indexOf("    steps:");
  assert.notEqual(start, -1, "scheduled cleanup is missing its steps block");
  const steps = [];
  for (const line of lines.slice(start + 1)) {
    // Blank lines inside folded YAML commands change spaces into newlines.
    // Preserve them; only spacing between complete steps may be discarded.
    if (!line.trim()) {
      if (steps.length) steps.at(-1).push("");
      continue;
    }
    if (/^    \S/.test(line)) break;
    if (/^      - /.test(line)) steps.push([]);
    assert.ok(
      steps.length && /^ {6,}\S/.test(line),
      `scheduled cleanup contains an unsupported step definition: ${line}`,
    );
    steps.at(-1).push(line.slice(6).trimEnd());
  }
  const definitions = steps.map((lines) => lines.join("\n").trimEnd());
  for (const definition of definitions) {
    assert.ok(
      approvedSteps.includes(definition),
      `scheduled cleanup contains an unapproved credential-bearing step: ${definition.split("\n")[0]}; only the approved setup and cleanup step definitions are allowed`,
    );
  }
  assert.deepEqual(
    definitions,
    approvedSteps,
    "scheduled cleanup must contain exactly the approved setup and cleanup steps in order",
  );
}

function extractJob(source, jobName) {
  const lines = source.split(/\r?\n/);
  const jobHeader = `  ${jobName}:`;
  const start = lines.indexOf(jobHeader);
  assert.notEqual(start, -1, `workflow is missing the ${jobName} job`);

  const end = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z0-9_-]+:/.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

function extractJobEnv(job) {
  const lines = job.split("\n");
  const envIndex = lines.findIndex((line) => line === "    env:");
  assert.notEqual(
    envIndex,
    -1,
    "scheduled cleanup is missing a job-level env block",
  );

  const envLines = [];
  for (const line of lines.slice(envIndex + 1)) {
    if (line && !/^\s{6,}\S/.test(line)) break;
    if (line.trim()) envLines.push(line);
  }
  assert.ok(
    envLines.length > 0,
    "scheduled cleanup job-level env block is empty",
  );
  return envLines.join("\n");
}

function parseEnvEntries(envBlock) {
  const entries = new Map();
  for (const line of envBlock.split("\n")) {
    const match = line.match(/^\s{6}([A-Z][A-Z0-9_]*)\s*:\s*(\S.*)?$/);
    assert.ok(
      match,
      `scheduled cleanup contains an invalid env entry: ${line}`,
    );
    entries.set(match[1], match[2] ?? "");
  }
  return entries;
}
