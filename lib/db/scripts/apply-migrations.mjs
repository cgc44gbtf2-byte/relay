import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

export const MIGRATION_TABLE = "irc_schema_migrations";
export const MIGRATION_LOCK_KEY = 481726391;
export const MIGRATION_FILENAME_PATTERN = /^(\d{4})_[a-z0-9-]+\.sql$/;
export const MIGRATIONS_DIR = resolve(
  fileURLToPath(new URL("../migrations", import.meta.url)),
);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function redactConnectionString(message, connectionString) {
  return connectionString ? message.split(connectionString).join("[redacted]") : message;
}

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

export function validateMigrationFiles(files) {
  if (files.length === 0) {
    throw new Error("No reviewed SQL migrations were found.");
  }

  let expectedNumber = 1;
  const numbers = new Set();
  for (const file of files) {
    const match = MIGRATION_FILENAME_PATTERN.exec(file.filename);
    if (!match) {
      throw new Error(
        `Invalid migration filename "${file.filename}". Use four-digit ordered names such as 0013_add_example.sql.`,
      );
    }
    const number = Number(match[1]);
    if (numbers.has(number)) {
      throw new Error(`Duplicate migration number ${match[1]} was found.`);
    }
    numbers.add(number);
    if (number !== expectedNumber) {
      throw new Error(
        `Migration sequence is not contiguous: expected ${String(expectedNumber).padStart(4, "0")} but found ${match[1]}.`,
      );
    }
    expectedNumber += 1;
  }
}

export function migrationHasDestructiveSql(sql) {
  return /\b(?:drop\s+table|drop\s+column|truncate(?:\s+table)?|delete\s+from|drop\s+not\s+null)\b/i.test(
    sql,
  );
}

export function removeMigrationTransactionWrappers(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*(?:begin|commit)[ \t]*;[ \t]*$/i.test(line))
    .join("\n");
}

export function validateLedgerRows(files, rows) {
  const expectedByFilename = new Map(files.map((file) => [file.filename, file]));
  const seen = new Set();

  for (const row of rows) {
    const file = expectedByFilename.get(row.filename);
    if (!file) {
      throw new Error(
        `Database records migration "${row.filename}", but that reviewed file is missing from the release.`,
      );
    }
    if (row.checksum !== file.checksum) {
      throw new Error(
        `Migration "${row.filename}" was changed after it was applied. Restore the original file or add a corrective migration; do not edit applied migrations.`,
      );
    }
    if (seen.has(row.filename)) {
      throw new Error(`Database migration ledger contains "${row.filename}" more than once.`);
    }
    seen.add(row.filename);
  }

  const expectedApplied = files.slice(0, rows.length);
  for (let index = 0; index < expectedApplied.length; index += 1) {
    if (rows[index]?.filename !== expectedApplied[index]?.filename) {
      throw new Error(
        "Database migration history is not an ordered prefix. Resolve the ledger before applying another migration.",
      );
    }
  }
}

async function readMigrationFiles(directory = MIGRATIONS_DIR) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map(async (entry) => {
        const sql = await readFile(resolve(directory, entry.name), "utf8");
        return {
          filename: entry.name,
          sql,
          checksum: migrationChecksum(sql),
        };
      }),
  );
  files.sort((left, right) => left.filename.localeCompare(right.filename));
  validateMigrationFiles(files);
  return files;
}

function requireReleaseConfirmation(environment) {
  if (environment.RELEASE_MIGRATION_TARGET !== "production") {
    throw new Error(
      'Refusing to apply release migrations without RELEASE_MIGRATION_TARGET=production.',
    );
  }
  if (!environment.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set by the release environment.");
  }
  if (environment.RELEASE_MIGRATION_BACKUP_CONFIRMED !== "true") {
    throw new Error(
      "Refusing to apply release migrations until RELEASE_MIGRATION_BACKUP_CONFIRMED=true confirms a current backup or provider snapshot.",
    );
  }
  if (!environment.RELEASE_MIGRATION_BACKUP_REFERENCE?.trim()) {
    throw new Error(
      "RELEASE_MIGRATION_BACKUP_REFERENCE must identify the confirmed backup or provider snapshot without containing credentials.",
    );
  }
}

function requireDestructiveApproval(environment, file) {
  if (!migrationHasDestructiveSql(file.sql)) return;
  if (environment.RELEASE_MIGRATION_DESTRUCTIVE_APPROVED !== "true") {
    throw new Error(
      `Migration ${file.filename} contains a destructive SQL operation. Inspect it and set RELEASE_MIGRATION_DESTRUCTIVE_APPROVED=true with RELEASE_MIGRATION_DESTRUCTIVE_REFERENCE before applying it.`,
    );
  }
  if (!environment.RELEASE_MIGRATION_DESTRUCTIVE_REFERENCE?.trim()) {
    throw new Error(
      `Migration ${file.filename} requires RELEASE_MIGRATION_DESTRUCTIVE_REFERENCE after explicit review.`,
    );
  }
}

async function tableExists(client, tableName) {
  const result = await client.query("SELECT to_regclass($1) AS relation", [
    `public.${tableName}`,
  ]);
  return result.rows[0]?.relation !== null;
}

async function createLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${MIGRATION_TABLE}" (
      "filename" text PRIMARY KEY NOT NULL,
      "checksum" text NOT NULL,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readLedger(client) {
  const result = await client.query(
    `SELECT "filename", "checksum" FROM "${MIGRATION_TABLE}" ORDER BY "filename"`,
  );
  return result.rows;
}

async function verifyLedger(client, files) {
  const rows = await readLedger(client);
  validateLedgerRows(files, rows);
  return rows;
}

async function markBaseline(client, files, baselineFilename) {
  const baselineIndex = files.findIndex((file) => file.filename === baselineFilename);
  if (baselineIndex < 0) {
    throw new Error(
      `RELEASE_MIGRATION_BASELINE must name one of the reviewed migration files; received "${baselineFilename}".`,
    );
  }
  const existingRows = await readLedger(client);
  if (existingRows.length > 0) {
    throw new Error("A migration ledger already exists; refusing to overwrite its history.");
  }

  for (const file of files.slice(0, baselineIndex + 1)) {
    await client.query(
      `INSERT INTO "${MIGRATION_TABLE}" ("filename", "checksum") VALUES ($1, $2)`,
      [file.filename, file.checksum],
    );
  }
  await verifyLedger(client, files);
  console.log(
    `Migration ledger baselined through ${baselineFilename}. No SQL was applied; verify the existing schema before using this command.`,
  );
}

export async function runMigrations({
  environment = process.env,
  mode = process.argv.includes("--check")
    ? "check"
    : process.argv.includes("--baseline")
      ? "baseline"
      : process.argv.includes("--validate")
        ? "validate"
        : "apply",
  migrationDirectory = MIGRATIONS_DIR,
  clientFactory = (connectionString) => new Client({ connectionString }),
} = {}) {
  const files = await readMigrationFiles(migrationDirectory);
  if (mode === "validate") {
    console.log(`Validated ${files.length} ordered reviewed SQL migrations.`);
    return { mode, files };
  }

  requireReleaseConfirmation(environment);
  if (mode === "baseline") {
    if (!environment.RELEASE_MIGRATION_BASELINE_CONFIRMED) {
      throw new Error(
        "Refusing to baseline an existing database until RELEASE_MIGRATION_BASELINE_CONFIRMED=true confirms the current schema was inspected.",
      );
    }
    if (!environment.RELEASE_MIGRATION_BASELINE?.trim()) {
      throw new Error(
        "RELEASE_MIGRATION_BASELINE must name the last already-applied reviewed migration.",
      );
    }
  }

  const client = clientFactory(environment.DATABASE_URL);
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    const ledgerExists = await tableExists(client, MIGRATION_TABLE);
    const applicationTableExists = await tableExists(client, "irc_users");
    if (!ledgerExists && applicationTableExists && mode !== "baseline") {
      throw new Error(
        `The existing database has Relay tables but no ${MIGRATION_TABLE} ledger. Refusing to guess which migrations were applied; inspect the schema, then run the explicit baseline procedure documented in docs/DATABASE-MIGRATIONS.md.`,
      );
    }
    if (mode === "check" && !ledgerExists) {
      throw new Error(
        `No ${MIGRATION_TABLE} ledger exists. Run the documented baseline procedure before a release no-op check.`,
      );
    }
    await createLedger(client);

    if (mode === "baseline") {
      await markBaseline(client, files, environment.RELEASE_MIGRATION_BASELINE);
      return { mode, files };
    }

    const rows = await verifyLedger(client, files);
    const pending = files.slice(rows.length);
    if (mode === "check") {
      if (pending.length > 0) {
        throw new Error(
          `Migration no-op check found ${pending.length} unapplied migration(s), beginning with ${pending[0].filename}. Apply them with pnpm run db:migrate:release.`,
        );
      }
      console.log("Migration no-op check confirmed; all reviewed migrations are applied.");
      return { mode, files, applied: rows };
    }

    for (const file of pending) {
      requireDestructiveApproval(environment, file);
      await client.query("BEGIN");
      try {
        await client.query(removeMigrationTransactionWrappers(file.sql));
        await client.query(
          `INSERT INTO "${MIGRATION_TABLE}" ("filename", "checksum") VALUES ($1, $2)`,
          [file.filename, file.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(
          `Migration ${file.filename} failed and was rolled back: ${redactConnectionString(errorMessage(error), environment.DATABASE_URL)}`,
        );
      }
      console.log(`Applied ${file.filename}.`);
    }

    const applied = await verifyLedger(client, files);
    console.log(
      pending.length === 0
        ? "No pending migrations; migration no-op verification confirmed."
        : `Applied ${pending.length} migration(s); migration ledger verification confirmed.`,
    );
    return { mode, files, applied };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    await runMigrations();
  } catch (error) {
    console.error(`Release migration stopped: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}