import { pool } from "@workspace/db";
import { runCleanup } from "./cleanup-admin-test-users";

async function run(): Promise<void> {
  let exitCode = 1;
  try {
    exitCode = await runCleanup();
  } finally {
    await pool.end();
  }
  process.exitCode = exitCode;
}

void run();