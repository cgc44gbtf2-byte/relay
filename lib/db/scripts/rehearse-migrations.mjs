import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { MIGRATION_TABLE, MIGRATIONS_DIR, runMigrations, validateMigrationFiles } from "./apply-migrations.mjs";

const { Client } = pg;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const rehearsalSchemaPath = resolve(
  scriptDirectory,
  "fixtures/pre-migration-schema.ts",
);

function migrationEnvironment() {
  return {
    NODE_ENV: "test",
    RELEASE_MIGRATION_TARGET: "production",
    RELEASE_MIGRATION_BACKUP_CONFIRMED: "true",
    RELEASE_MIGRATION_BACKUP_REFERENCE: "ci-disposable-migration-rehearsal",
    RELEASE_MIGRATION_DESTRUCTIVE_APPROVED: "true",
    RELEASE_MIGRATION_DESTRUCTIVE_REFERENCE: "ci-reviewed-migration-rehearsal",
  };
}

function commandEnvironment(testDatabaseUrl) {
  const environment = { ...process.env, NODE_ENV: "test" };
  delete environment.DATABASE_URL;
  delete environment.CI_TEST_DATABASE_ADMIN_URL;
  delete environment.TEST_DATABASE_URL;
  environment.TEST_DATABASE_URL = testDatabaseUrl;
  return environment;
}

function runCommand(command, args, testDatabaseUrl) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: packageDirectory,
      env: commandEnvironment(testDatabaseUrl),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
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

async function writeRehearsalConfig(directory) {
  await writeFile(
    join(directory, "drizzle.config.ts"),
    `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ${JSON.stringify(rehearsalSchemaPath)},
  dialect: "postgresql",
  dbCredentials: { url: process.env.TEST_DATABASE_URL },
});
`,
    "utf8",
  );
  await symlink(join(packageDirectory, "node_modules"), join(directory, "node_modules"));
}

async function createEmptyLedger(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(`
      CREATE TABLE "${MIGRATION_TABLE}" (
        "filename" text PRIMARY KEY NOT NULL,
        "checksum" text NOT NULL,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  } finally {
    await client.end();
  }
}

async function copyReviewedMigrations(directory) {
  const filenames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name);
  const fixture = rollbackFixture(filenames);
  await Promise.all(
    filenames.map((filename) => copyFile(join(MIGRATIONS_DIR, filename), join(directory, filename))),
  );
  return fixture;
}

export function rollbackFixture(filenames) {
  const files = [...filenames].sort().map((filename) => ({ filename }));
  validateMigrationFiles(files);
  if (files.length >= 9999) throw new Error("No four-digit migration number remains for the rollback rehearsal.");
  return {
    filename: `${String(files.length + 1).padStart(4, "0")}_rehearsal_failure.sql`,
    expectedLedgerCount: files.length,
  };
}

async function assertRollback(databaseUrl, migrationDirectory, fixture) {
  let failure;
  try {
    await runMigrations({
      databaseUrl,
      environment: migrationEnvironment(),
      migrationDirectory,
    });
  } catch (error) {
    failure = error;
  }
  if (!failure || !failure.message.startsWith(`Migration ${fixture.filename} failed and was rolled back:`)) {
    throw new Error(
      `The forced migration failure did not produce the expected rollback diagnostic: ${failure?.message ?? "no failure"}`,
      { cause: failure },
    );
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const ledger = await client.query(
      `SELECT count(*)::int AS count FROM "${MIGRATION_TABLE}"`,
    );
    const failedTable = await client.query(
      "SELECT to_regclass('public.irc_migration_rehearsal_failure') AS relation",
    );
    if (ledger.rows[0]?.count !== fixture.expectedLedgerCount || failedTable.rows[0]?.relation !== null) {
      throw new Error(
        `Rollback left unexpected database state: ${ledger.rows[0]?.count ?? "unknown"} ledger rows, failed table ${failedTable.rows[0]?.relation ?? "absent"}.`,
      );
    }
  } finally {
    await client.end();
  }
}

export async function rehearseMigrations({
  databaseUrl = process.env.TEST_DATABASE_URL,
} = {}) {
  if (process.env.DATABASE_URL || process.env.CI_TEST_DATABASE_ADMIN_URL) {
    throw new Error(
      "The migration rehearsal refuses to run when a persistent database environment is present.",
    );
  }
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL must identify the disposable rehearsal database.");
  }

  const temporaryDirectory = await mkdtemp("/tmp/relay-migration-rehearsal-");
  const failureDirectory = await mkdtemp("/tmp/relay-migration-failure-");
  try {
    await writeRehearsalConfig(temporaryDirectory);
    await runCommand(
      resolve(packageDirectory, "node_modules/.bin/drizzle-kit"),
      ["push", "--config", join(temporaryDirectory, "drizzle.config.ts")],
      databaseUrl,
    );
    await createEmptyLedger(databaseUrl);

    await runMigrations({
      databaseUrl,
      environment: migrationEnvironment(),
    });
    await runMigrations({
      databaseUrl,
      environment: migrationEnvironment(),
      mode: "check",
    });

    const fixture = await copyReviewedMigrations(failureDirectory);
    await writeFile(
      join(failureDirectory, fixture.filename),
      'CREATE TABLE "irc_migration_rehearsal_failure" ("id" integer);\nSELECT 1 / 0;\n',
      "utf8",
    );
    await assertRollback(databaseUrl, failureDirectory, fixture);
    console.log("Disposable PostgreSQL migration rehearsal passed.");
  } finally {
    await Promise.all([
      rm(temporaryDirectory, { recursive: true, force: true }),
      rm(failureDirectory, { recursive: true, force: true }),
    ]);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    await rehearseMigrations();
  } catch (error) {
    console.error(`Disposable migration rehearsal failed: ${error.message}`);
    process.exitCode = 1;
  }
}