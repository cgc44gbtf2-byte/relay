import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
const rehearsalSchemaChecksumPath = resolve(
  scriptDirectory,
  "fixtures/pre-migration-schema.sha256",
);

export function assertRehearsalSchemaChecksum(schema, expectedChecksum) {
  const expected = expectedChecksum.trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(
      "The migration rehearsal schema checksum must be a SHA-256 hex digest.",
    );
  }

  const actual = createHash("sha256").update(schema).digest("hex");
  if (actual !== expected) {
    throw new Error(
      "The migration rehearsal schema fixture has drifted from its reviewed checksum. " +
        "See docs/DATABASE-MIGRATIONS.md before updating the fixture.",
    );
  }
}

async function verifyRehearsalSchemaFixture() {
  const [schema, checksum] = await Promise.all([
    readFile(rehearsalSchemaPath),
    readFile(rehearsalSchemaChecksumPath, "utf8"),
  ]);
  assertRehearsalSchemaChecksum(schema, checksum);
}

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

async function assertCommunitySubscriptionShape(databaseUrl, migrated) {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT
        to_regclass('public.irc_community_upgrade_requests') IS NOT NULL AS "requestsExist",
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'irc_community_upgrade_requests'
            AND column_name = 'expires_at'
        ) AS "hasExpiry",
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'irc_community_upgrade_requests'
            AND column_name = 'reminder_sent_at'
        ) AS "hasReminder",
        to_regclass('public.irc_community_upgrade_active_idx') IS NOT NULL AS "hasActiveIndex"
    `);
    const shape = rows[0];
    if (!shape.requestsExist || shape.hasExpiry !== migrated ||
        shape.hasReminder !== migrated || shape.hasActiveIndex !== migrated) {
      throw new Error(
        `Community subscription ${migrated ? "migration" : "baseline"} shape is incorrect: ${JSON.stringify(shape)}`,
      );
    }
  } finally {
    await client.end();
  }
}

async function createAuditFixture(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "irc_users" ("clerk_id", "username", "display_name")
       VALUES ($1, $2, $3)`,
      ["rehearsal-audit-actor", "rehearsal_audit_actor", "Audit Actor"],
    );
    const result = await client.query(
      `INSERT INTO "irc_admin_audit_logs"
       ("actor_id", "actor_display_name", "action", "details")
       VALUES ($1, $2, $3, $4)
       RETURNING "id", "actor_id", "actor_display_name", "action", "details", "created_at"`,
      ["rehearsal-audit-actor", "Audit Actor", "rehearsal_action", "Existing event"],
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function assertAuditFixture(databaseUrl, original) {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const read = async () => {
      const result = await client.query(
        `SELECT "id", "actor_id", "actor_display_name", "action", "details", "created_at"
         FROM "irc_admin_audit_logs" WHERE "id" = $1`,
        [original.id],
      );
      if (result.rowCount !== 1 || JSON.stringify(result.rows[0]) !== JSON.stringify(original)) {
        throw new Error("Migration rehearsal changed or removed an existing audit event.");
      }
    };
    await read();
    await client.query(`DELETE FROM "irc_users" WHERE "clerk_id" = $1`, [original.actor_id]);
    await read();
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

  await verifyRehearsalSchemaFixture();

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
    await assertCommunitySubscriptionShape(databaseUrl, false);
    const existingAuditEvent = await createAuditFixture(databaseUrl);

    await runMigrations({
      databaseUrl,
      environment: migrationEnvironment(),
    });
    await assertCommunitySubscriptionShape(databaseUrl, true);
    await runMigrations({
      databaseUrl,
      environment: migrationEnvironment(),
      mode: "check",
    });
    await assertAuditFixture(databaseUrl, existingAuditEvent);

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