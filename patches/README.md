# Drizzle Kit PostgreSQL introspection patch

`drizzle-kit@0.31.10.patch` fixes two false differences during `drizzle-kit push`:

- PostgreSQL truncates generated foreign-key names to 63 bytes. The schema snapshot now uses the stored name for this project's ASCII constraint names.
- Composite foreign-key columns must be read as *paired, ordered* columns. Joining `conkey` and `confkey` independently created a Cartesian product, making intact constraints appear different on every push.

Both PostgreSQL introspection paths in the bundled CLI are patched. This patch changes schema comparison only; it does not drop or re-create constraints. When upgrading Drizzle Kit, check whether the upstream version fixes both issues before removing this patch. A dry run with `pnpm --filter @workspace/db exec drizzle-kit push --config ./drizzle.config.ts --strict --verbose` against an already-synced development database should report **No changes detected**. Do not run a live schema push merely to check for differences.

The API test CI job checks this automatically: it pushes the schema to a freshly provisioned, disposable database, then runs `pnpm --filter @workspace/db run check:noop` before the authenticated tests. The check requires that CI test database, verifies a database-enforced read-only connection, and fails if Drizzle does not report `No changes detected`. It never uses the development or production database.