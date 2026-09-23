import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export async function assertNoopPush({
  testDatabaseUrl = process.env.TEST_DATABASE_URL,
  databaseUrl = process.env.DATABASE_URL,
  nodeEnv = process.env.NODE_ENV,
  spawnImpl = spawn,
  verifyReadOnlyImpl = verifyReadOnly,
} = {}) {
  let databaseName;
  let url;
  try {
    url = new URL(testDatabaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      throw new Error("Invalid database protocol");
    }
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("A disposable TEST_DATABASE_URL is required.");
  }
  if (
    nodeEnv !== "test" ||
    databaseUrl ||
    !/^web_irc_ci_[a-z0-9_]+$/.test(databaseName)
  ) {
    throw new Error(
      "Refusing to run outside an isolated CI test database with DATABASE_URL unset.",
    );
  }
  if (url.searchParams.has("options")) {
    throw new Error("Refusing to override existing PostgreSQL connection options.");
  }
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  await verifyReadOnlyImpl(url.toString());

  const output = await new Promise((done, fail) => {
    const child = spawnImpl(
      "pnpm",
      [
        "--filter",
        "@workspace/db",
        "exec",
        "drizzle-kit",
        "push",
        "--config",
        "./drizzle.config.ts",
        "--strict",
        "--verbose",
      ],
      {
        cwd: resolve(fileURLToPath(new URL("../../../", import.meta.url))),
        env: {
          ...process.env,
          NODE_ENV: "test",
          TEST_DATABASE_URL: url.toString(),
          DATABASE_URL: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
    });
    child.stderr.on("data", (chunk) => {
      text += chunk;
    });
    child.once("error", fail);
    child.once("close", (code, signal) => done({ text, code, signal }));
    // If Drizzle prompts despite --strict, never consent to a schema change.
    child.stdin.end("n\n");
  });

  const plainOutput = output.text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "\n");
  if (output.code !== 0 || !/^(?:\[i\]\s*)?No changes detected\s*$/m.test(plainOutput)) {
    throw new Error(
      `Expected "No changes detected" from strict schema push; exit code ${output.code ?? output.signal ?? "unknown"}. Inspect the dry-run plan against the disposable database.`,
    );
  }
  process.stdout.write("No-op schema push confirmed on disposable database.\n");
}

async function verifyReadOnly(connectionString) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(
      "SELECT current_setting('default_transaction_read_only') AS read_only",
    );
    if (result.rows[0]?.read_only !== "on") {
      throw new Error("The disposable schema-check connection is not read-only.");
    }
  } finally {
    await client.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await assertNoopPush();
}