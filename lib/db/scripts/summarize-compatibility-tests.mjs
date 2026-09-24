import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Never copy arbitrary TAP output into the summary: it can contain assertion
// values, environment variables, and database connection strings.
const runnerTestNames = new Set([
  "provisions and cleans up a database after schema and API commands",
  "drops the generated database when migration rehearsal fails",
  "drops the generated database when schema setup fails",
  "drops the generated database when the no-op check fails",
  "drops the generated database when API tests fail",
  "preserves provisioning diagnostics when connect fails",
  "preserves provisioning diagnostics when create fails",
  "preserves cleanup diagnostics after failed API tests",
  "preserves cleanup diagnostics after successful tests",
]);

export function compatibilityFailureSummary(tapOutput, version) {
  const safeVersion = /^\d+$/.test(version ?? "") ? version : "unspecified";
  const expectedSuffix = ` (PostgreSQL ${safeVersion})`;
  const failedTests = new Set();

  for (const line of tapOutput.split(/\r?\n/)) {
    const match = /^not ok \d+ - (.+)$/.exec(line);
    if (!match || !match[1].endsWith(expectedSuffix)) continue;
    const name = match[1].slice(0, -expectedSuffix.length);
    if (runnerTestNames.has(name)) failedTests.add(name);
  }

  const lines = [
    "## PostgreSQL runner compatibility tests",
    `- PostgreSQL: ${safeVersion}`,
    "- Status: failed",
  ];
  if (failedTests.size) {
    lines.push("- Failing runner tests:");
    for (const name of failedTests) lines.push(`  - ${name}`);
  } else {
    lines.push(
      "- No failing runner test was reported; check the job log for setup or other database test failures.",
    );
  }
  return `${lines.join("\n")}\n\n`;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const [tapPath] = process.argv.slice(2);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!tapPath || !summaryPath) {
    throw new Error(
      "The TAP output path and GITHUB_STEP_SUMMARY are required.",
    );
  }
  const tapOutput = await readFile(tapPath, "utf8");
  await appendFile(
    summaryPath,
    compatibilityFailureSummary(
      tapOutput,
      process.env.CI_TEST_DATABASE_VERSION,
    ),
    "utf8",
  );
}