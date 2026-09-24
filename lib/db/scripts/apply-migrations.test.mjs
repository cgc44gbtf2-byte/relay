import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  migrationChecksum,
  migrationHasDestructiveSql,
  removeMigrationTransactionWrappers,
  runMigrations,
  validateLedgerRows,
  validateMigrationFiles,
} from "./apply-migrations.mjs";

function file(filename, sql = `-- ${filename}`) {
  return { filename, sql, checksum: migrationChecksum(sql) };
}

test("accepts a contiguous ordered migration set", () => {
  assert.doesNotThrow(() =>
    validateMigrationFiles([
      file("0001_first.sql"),
      file("0002_second.sql"),
    ]),
  );
});

test("rejects gaps and malformed migration names", () => {
  assert.throws(
    () => validateMigrationFiles([file("0001_first.sql"), file("0003_third.sql")]),
    /not contiguous/,
  );
  assert.throws(
    () => validateMigrationFiles([file("first.sql")]),
    /Invalid migration filename/,
  );
});

test("detects changed, missing, and out-of-order ledger history", () => {
  const files = [file("0001_first.sql"), file("0002_second.sql")];
  assert.doesNotThrow(() =>
    validateLedgerRows(files, [{ filename: files[0].filename, checksum: files[0].checksum }]),
  );
  assert.throws(
    () => validateLedgerRows(files, [{ filename: files[0].filename, checksum: "changed" }]),
    /was changed after it was applied/,
  );
  assert.throws(
    () => validateLedgerRows(files, [{ filename: files[1].filename, checksum: files[1].checksum }]),
    /ordered prefix/,
  );
  assert.throws(
    () => validateLedgerRows(files, [{ filename: "0003_unknown.sql", checksum: "x" }]),
    /reviewed file is missing/,
  );
});

test("normalizes reviewed transaction wrappers before the runner's transaction", () => {
  const sql = "BEGIN;\nCREATE TABLE example (id integer);\nCOMMIT;\n";
  assert.equal(
    removeMigrationTransactionWrappers(sql),
    "CREATE TABLE example (id integer);\n",
  );
});

test("requires explicit review for data-destructive SQL", () => {
  assert.equal(migrationHasDestructiveSql("DROP TABLE example;"), true);
  assert.equal(migrationHasDestructiveSql("DROP INDEX example_idx;"), false);
  assert.equal(migrationHasDestructiveSql("CREATE INDEX example_idx ON example (id);"), false);
});

class FakeClient {
  constructor({ applicationTableExists = false, failOn = null } = {}) {
    this.applicationTableExists = applicationTableExists;
    this.failOn = failOn;
    this.ledger = [];
    this.queries = [];
    this.transactionLedger = null;
  }

  async connect() {}

  async end() {}

  async query(sql, parameters = []) {
    this.queries.push(sql);
    if (sql.includes("pg_advisory")) return { rows: [] };
    if (sql.includes("to_regclass")) {
      return {
        rows: [{
          relation: parameters[0].endsWith("irc_users") && this.applicationTableExists
            ? "irc_users"
            : parameters[0].endsWith("irc_schema_migrations") && this.ledgerTableExists
              ? "irc_schema_migrations"
              : null,
        }],
      };
    }
    if (sql.includes("CREATE TABLE IF NOT EXISTS")) {
      this.ledgerTableExists = true;
      return { rows: [] };
    }
    if (sql.includes('SELECT "filename", "checksum"')) {
      return { rows: this.ledger.map((row) => ({ ...row })) };
    }
    if (sql === "BEGIN") {
      this.transactionLedger = this.ledger.map((row) => ({ ...row }));
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      this.ledger = this.transactionLedger ?? this.ledger;
      this.transactionLedger = null;
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      this.transactionLedger = null;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO "irc_schema_migrations"')) {
      this.ledger.push({ filename: parameters[0], checksum: parameters[1] });
      return { rows: [] };
    }
    if (this.failOn && sql.includes(this.failOn)) {
      throw new Error("simulated migration failure");
    }
    return { rows: [] };
  }
}

async function withMigrationDirectory(callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "relay-migrations-"));
  try {
    await writeFile(
      resolve(directory, "0001_create_example.sql"),
      "BEGIN;\nCREATE TABLE example (id integer);\nCOMMIT;\n",
    );
    await writeFile(
      resolve(directory, "0002_add_example_index.sql"),
      "CREATE INDEX example_id_idx ON example (id);\n",
    );
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("applies reviewed migrations in order and verifies a second run is a no-op", async () => {
  await withMigrationDirectory(async (migrationDirectory) => {
    const client = new FakeClient();
    const environment = {
      DATABASE_URL: "postgresql://release.example/relay",
      RELEASE_MIGRATION_TARGET: "production",
      RELEASE_MIGRATION_BACKUP_CONFIRMED: "true",
      RELEASE_MIGRATION_BACKUP_REFERENCE: "snapshot-1",
    };
    const first = await runMigrations({
      environment,
      migrationDirectory,
      clientFactory: () => client,
    });
    const appliedQueryCount = client.queries.length;
    const second = await runMigrations({
      environment,
      migrationDirectory,
      clientFactory: () => client,
    });

    assert.equal(first.applied.length, 2);
    assert.equal(second.applied.length, 2);
    assert.deepEqual(client.ledger.map((row) => row.filename), [
      "0001_create_example.sql",
      "0002_add_example_index.sql",
    ]);
    assert.equal(
      client.queries.filter((query) => query.includes("CREATE TABLE example")).length,
      1,
    );
    assert.ok(client.queries.length > appliedQueryCount);
  });
});

test("rolls back the ledger when a reviewed migration fails", async () => {
  await withMigrationDirectory(async (migrationDirectory) => {
    const client = new FakeClient({ failOn: "CREATE INDEX" });
    await assert.rejects(
      runMigrations({
        environment: {
          DATABASE_URL: "postgresql://release.example/relay",
          RELEASE_MIGRATION_TARGET: "production",
          RELEASE_MIGRATION_BACKUP_CONFIRMED: "true",
          RELEASE_MIGRATION_BACKUP_REFERENCE: "snapshot-1",
        },
        migrationDirectory,
        clientFactory: () => client,
      }),
      /Migration 0002_add_example_index\.sql failed and was rolled back/,
    );
    assert.deepEqual(client.ledger.map((row) => row.filename), [
      "0001_create_example.sql",
    ]);
    assert.ok(client.queries.includes("ROLLBACK"));
  });
});

test("refuses to guess an existing database's migration history", async () => {
  await withMigrationDirectory(async (migrationDirectory) => {
    const client = new FakeClient({ applicationTableExists: true });
    await assert.rejects(
      runMigrations({
        environment: {
          DATABASE_URL: "postgresql://release.example/relay",
          RELEASE_MIGRATION_TARGET: "production",
          RELEASE_MIGRATION_BACKUP_CONFIRMED: "true",
          RELEASE_MIGRATION_BACKUP_REFERENCE: "snapshot-1",
        },
        migrationDirectory,
        clientFactory: () => client,
      }),
      /has Relay tables but no irc_schema_migrations ledger/,
    );
    assert.equal(client.queries.some((query) => query.includes("CREATE TABLE example")), false);
  });
});
