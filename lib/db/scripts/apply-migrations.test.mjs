import assert from "node:assert/strict";
import test from "node:test";
import {
  migrationChecksum,
  migrationHasDestructiveSql,
  removeMigrationTransactionWrappers,
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