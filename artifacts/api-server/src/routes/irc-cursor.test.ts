import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_DATABASE_URL ??= "postgresql://unit-test.invalid/irc_cursor_unit";
const {
  cursorContext,
  cursorListRequest,
  cursorVisibleListPage,
} = require("./irc") as typeof import("./irc");

const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function responseMock() {
  type MockResponse = {
    statusCode: number;
    body: unknown;
    status: (code: number) => MockResponse;
    json: (value: unknown) => MockResponse;
  };
  const response: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  return response;
}

function encodedCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("cursor pages keep an immutable id boundary across rename, delete, and insert", async () => {
  let records = [
    { id: 1, name: "one" },
    { id: 2, name: "two" },
    { id: 3, name: "three" },
    { id: 4, name: "four" },
    { id: 5, name: "five" },
  ];
  const fetch = async (after: number | null, ceiling: number, size: number) =>
    records.filter((row) => (after === null || row.id > after) && row.id <= ceiling)
      .sort((a, b) => a.id - b.id).slice(0, size);
  const visible = async (rows: typeof records) => rows;
  const first = await cursorVisibleListPage(
    null,
    null,
    2,
    async () => Math.max(...records.map((row) => row.id)),
    fetch,
    (row) => row.id,
    visible,
  );
  assert.deepEqual(first.rows.map((row) => row.id), [1, 2]);
  assert.equal(first.hasMore, true);
  assert.equal(first.ceiling, 5);

  records = records.filter((row) => row.id !== 3);
  records.find((row) => row.id === 4)!.name = "renamed";
  records.push({ id: 6, name: "later insert" });
  const second = await cursorVisibleListPage(
    first.nextAfter,
    first.ceiling,
    2,
    async () => {
      throw new Error("Continuation must retain its original ceiling.");
    },
    fetch,
    (row) => row.id,
    visible,
  );
  assert.deepEqual(second.rows.map((row) => row.id), [4, 5]);
  assert.equal(second.hasMore, false);
});

test("cursor tokens reject malformed data and cannot cross route, search, or user context", () => {
  const context = cursorContext("/users/search", "user-a", "project");
  const parse = (raw: string, expectedContext = context) => {
    const response = responseMock();
    const result = cursorListRequest(
      { query: { cursor: raw } } as never,
      response as never,
      expectedContext,
      positiveId,
      positiveId,
      (after, ceiling) => typeof after === "number" && typeof ceiling === "number" && after <= ceiling,
    );
    return { result, response };
  };

  assert.equal(parse("not base64!").response.statusCode, 400);
  assert.equal(parse(encodedCursor({ after: 2, ceiling: 1, context })).response.statusCode, 400);
  const otherUserContext = cursorContext("/users/search", "user-b", "project");
  assert.equal(parse(encodedCursor({ after: 1, ceiling: 2, context: otherUserContext })).response.statusCode, 400);
  const otherSearchContext = cursorContext("/users/search", "user-a", "another search");
  assert.equal(parse(encodedCursor({ after: 1, ceiling: 2, context: otherSearchContext })).response.statusCode, 400);
  assert.equal(parse(encodedCursor({ after: 1, ceiling: 2, context })).result?.cursor?.after, 1);
  assert.equal(parse("start").result?.cursor?.ceiling, null);
});