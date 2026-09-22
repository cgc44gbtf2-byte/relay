import { defineConfig } from "drizzle-kit";
import path from "path";

const databaseUrl =
  process.env.NODE_ENV === "test"
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    process.env.NODE_ENV === "test"
      ? "TEST_DATABASE_URL must be set for test schema setup."
      : "DATABASE_URL, ensure the database is provisioned",
  );
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
