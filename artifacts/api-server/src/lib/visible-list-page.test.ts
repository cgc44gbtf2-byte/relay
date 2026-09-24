import assert from "node:assert/strict";
import test from "node:test";
import { parseCollectionPage, visibleListPage } from "./visible-list-page";

test("validates page limits and offsets rather than silently truncating", () => {
  assert.deepEqual(parseCollectionPage({}, 100), { limit: 100, offset: 0 });
  assert.deepEqual(parseCollectionPage({ limit: "5", offset: "101" }, 100), { limit: 5, offset: 101 });
  for (const query of [
    { limit: "0" }, { limit: "101" }, { limit: "3.5" }, { limit: ["3"] },
    { offset: "-1" }, { offset: "1.5" }, { offset: "9007199254740992" }, { offset: ["1"] },
  ]) assert.equal(parseCollectionPage(query, 100), null);
});

test("pages visible records without leaking hidden rows or ending early at a hidden boundary", async () => {
  const candidates = Array.from({ length: 27 }, (_, index) => ({ id: index + 1, name: String(index + 1) }));
  const fetch = async (after: (typeof candidates)[number] | null) =>
    candidates.filter((row) => after === null || row.id > after.id).slice(0, 4);
  const visible = async (rows: typeof candidates) => rows.filter((row) => row.id % 3 === 0);
  const first = await visibleListPage({ limit: 3, offset: 0 }, 4, fetch, visible);
  const second = await visibleListPage({ limit: 3, offset: 3 }, 4, fetch, visible);
  const third = await visibleListPage({ limit: 3, offset: 6 }, 4, fetch, visible);
  assert.deepEqual(first.rows.map((row) => row.id), [3, 6, 9]);
  assert.deepEqual(second.rows.map((row) => row.id), [12, 15, 18]);
  assert.deepEqual(third.rows.map((row) => row.id), [21, 24, 27]);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  assert.equal(third.hasMore, false);
});