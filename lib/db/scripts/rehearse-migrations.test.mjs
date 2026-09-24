import assert from "node:assert/strict";
import test from "node:test";
import { rollbackFixture } from "./rehearse-migrations.mjs";

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