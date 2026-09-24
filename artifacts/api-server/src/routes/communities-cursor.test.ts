import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_DATABASE_URL ??= "postgresql://unit-test.invalid/communities_cursor_unit";
const {
  communityCursorPage,
  communityCursorRequest,
  communityCursorToken,
} = require("./communities") as typeof import("./communities");

test("community cursor pages retain initial ids across rename, deletion, and insertion", async () => {
  let records = [
    { id: 1, name: "one" },
    { id: 2, name: "two" },
    { id: 3, name: "three" },
    { id: 4, name: "four" },
    { id: 5, name: "five" },
  ];
  const fetchBatch = async (after: number | null, ceiling: number, limit: number) =>
    records.filter((row) => (after === null || row.id > after) && row.id <= ceiling)
      .sort((a, b) => a.id - b.id).slice(0, limit);
  const first = await communityCursorPage(
    null,
    null,
    2,
    async () => Math.max(...records.map((row) => row.id)),
    fetchBatch,
    (row) => row.id,
  );
  assert.deepEqual(first.rows.map((row) => row.id), [1, 2]);
  assert.equal(first.hasMore, true);
  assert.equal(first.ceiling, 5);

  const context = "communities:user-a";
  const continuation = communityCursorToken(first.nextAfter!, first.ceiling!, context);
  const parsed = communityCursorRequest(
    { query: { cursor: continuation } } as never,
    ["cursor"],
    context,
    "number",
  );
  assert.ok(parsed);
  assert.equal(parsed.after, 2);
  assert.equal(parsed.ceiling, 5);

  records = records.filter((row) => row.id !== 3);
  records.find((row) => row.id === 4)!.name = "renamed";
  records.push({ id: 6, name: "later insert" });
  const second = await communityCursorPage(
    parsed.after as number,
    parsed.ceiling as number,
    2,
    async () => {
      throw new Error("A continuation must use the initial ceiling.");
    },
    fetchBatch,
    (row) => row.id,
  );
  assert.deepEqual(second.rows.map((row) => row.id), [4, 5]);
  assert.equal(second.hasMore, false);
  assert.deepEqual(
    [...first.rows, ...second.rows].map((row) => row.id),
    [1, 2, 4, 5],
  );
});

test("community cursor tokens reject malformed data and context reuse", () => {
  const context = "workspace-detail:42:user-a:tasks";
  const parse = (token: string, expectedContext = context) => communityCursorRequest(
    { query: { tasksCursor: token } } as never,
    ["tasksCursor"],
    expectedContext,
    "number",
  );

  assert.equal(parse("not base64!"), null);
  assert.equal(parse(Buffer.from(JSON.stringify({ after: 2, ceiling: 1, context })).toString("base64url")), null);
  assert.equal(parse(Buffer.from(JSON.stringify({ after: 1, ceiling: 2 })).toString("base64url")), null);
  const token = communityCursorToken(1, 2, context);
  assert.equal(parse(token, "workspace-detail:43:user-a:tasks"), null);
  assert.equal(parse(token, "workspace-detail:42:user-b:tasks"), null);
  assert.equal(parse(token)?.after, 1);
  assert.equal(parse("start")?.after, null);
});