import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { assertNoopPush } from "./assert-noop-push.mjs";

const options = {
  testDatabaseUrl: "postgresql://postgres@127.0.0.1/web_irc_ci_run_123",
  databaseUrl: "",
  nodeEnv: "test",
  verifyReadOnlyImpl: async () => {},
};

function fakeSpawn({ text, code = 0 }) {
  let invocation;
  const spawnImpl = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = {
      end: (answer) => {
        invocation = { command, args, spawnOptions, answer };
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(text));
          child.emit("close", code, null);
        });
      },
    };
    return child;
  };
  return { spawnImpl, getInvocation: () => invocation };
}

test("passes only for an unchanged strict push using a read-only connection", async () => {
  const fake = fakeSpawn({ text: "Using 'pg' driver\n[i] No changes detected\n" });
  let verifiedUrl;
  await assertNoopPush({
    ...options,
    spawnImpl: fake.spawnImpl,
    verifyReadOnlyImpl: async (url) => { verifiedUrl = url; },
  });
  const { command, args, spawnOptions, answer } = fake.getInvocation();
  assert.equal(command, "pnpm");
  assert.deepEqual(args.slice(-3), ["./drizzle.config.ts", "--strict", "--verbose"]);
  assert.equal(answer, "n\n");
  assert.equal(spawnOptions.env.NODE_ENV, "test");
  assert.equal(spawnOptions.env.DATABASE_URL, "");
  assert.equal(spawnOptions.env.TEST_DATABASE_URL, verifiedUrl);
  assert.equal(
    new URL(verifiedUrl).searchParams.get("options"),
    "-c default_transaction_read_only=on",
  );
});

test("fails if a schema rewrite is proposed, even when the CLI exits successfully", async () => {
  const fake = fakeSpawn({ text: "ALTER TABLE ... DROP CONSTRAINT ...\n", code: 0 });
  await assert.rejects(
    assertNoopPush({ ...options, spawnImpl: fake.spawnImpl }),
    /Expected "No changes detected"/,
  );
  assert.equal(fake.getInvocation().answer, "n\n");
});

test("fails when the CLI reports no changes but exits with an error", async () => {
  const fake = fakeSpawn({ text: "No changes detected\nError\n", code: 1 });
  await assert.rejects(
    assertNoopPush({ ...options, spawnImpl: fake.spawnImpl }),
    /exit code 1/,
  );
});

test("refuses non-disposable targets and production database configuration", async () => {
  const cases = [
    { ...options, testDatabaseUrl: "postgresql://localhost/production" },
    { ...options, databaseUrl: "postgresql://localhost/production" },
    { ...options, nodeEnv: "production" },
    { ...options, testDatabaseUrl: "" },
    { ...options, testDatabaseUrl: `${options.testDatabaseUrl}?options=-c+default_transaction_read_only%3Doff` },
  ];
  for (const input of cases) {
    await assert.rejects(assertNoopPush(input), /disposable|Refusing/);
  }
});

test("does not launch Drizzle if read-only verification fails", async () => {
  await assert.rejects(
    assertNoopPush({
      ...options,
      verifyReadOnlyImpl: async () => {
        throw new Error("The connection is not read-only.");
      },
      spawnImpl: () => {
        throw new Error("Drizzle must not run");
      },
    }),
    /not read-only/,
  );
});