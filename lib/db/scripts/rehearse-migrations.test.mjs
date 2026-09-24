import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertRehearsalSchemaChecksum,
  rollbackFixture,
} from "./rehearse-migrations.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const rehearsalFixturePath = join(
  scriptDirectory,
  "fixtures/pre-migration-schema.ts",
);
const rehearsalChecksumPath = join(
  scriptDirectory,
  "fixtures/pre-migration-schema.sha256",
);

test("reviewed pre-migration schema fixture matches its pinned checksum", async () => {
  const [schema, checksum] = await Promise.all([
    readFile(rehearsalFixturePath),
    readFile(rehearsalChecksumPath, "utf8"),
  ]);
  assert.doesNotThrow(() => assertRehearsalSchemaChecksum(schema, checksum));
});

test("migration rehearsal detects schema fixture drift", async () => {
  const [schema, checksum] = await Promise.all([
    readFile(rehearsalFixturePath),
    readFile(rehearsalChecksumPath, "utf8"),
  ]);
  const editedSchema = Buffer.concat([schema, Buffer.from("\n")]);
  assert.throws(
    () => assertRehearsalSchemaChecksum(editedSchema, checksum),
    /fixture has drifted/,
  );
});

for (const count of [12, 14, 15]) {
  test(`rollback rehearsal follows all ${count} reviewed migrations`, () => {
    const names = Array.from({ length: count }, (_, index) =>
      `${String(index + 1).padStart(4, "0")}_reviewed.sql`);
    const fixture = rollbackFixture(names.reverse());
    assert.equal(fixture.filename, `${String(count + 1).padStart(4, "0")}_rehearsal_failure.sql`);
    assert.equal(fixture.expectedLedgerCount, count);
    assert.ok(!names.includes(fixture.filename));
  });
}

test("rollback rehearsal refuses invalid reviewed sequences", () => {
  assert.throws(() => rollbackFixture([]), /No reviewed SQL migrations/);
  assert.throws(() => rollbackFixture(["0001_a.sql", "0003_b.sql"]), /not contiguous/);
  assert.throws(() => rollbackFixture(["0001_a.sql", "0001_b.sql"]), /Duplicate migration/);
});