# Database migrations and rollback

## Migration model

Relay uses two related schema workflows:

- `lib/db/src/schema/` is the Drizzle model used for development and disposable
  test databases.
- `lib/db/migrations/` is the reviewed, forward-only SQL history for installed
  environments.

Every production schema change must update the Drizzle schema and add the next
zero-padded SQL migration. Applied migration files are immutable: do not edit,
rename, reorder, or delete a migration that may already have been applied.

## Authoring a migration

1. Inspect the current production schema and data shape before writing SQL.
2. Add the schema change to `lib/db/src/schema/`.
3. Add the next migration under `lib/db/migrations/`.
4. Make the migration safe to retry where PostgreSQL permits it, using
   `IF NOT EXISTS` or equivalent guarded operations.
5. Before adding a foreign key, unique constraint, or `NOT NULL` constraint,
   include an explicit preflight query or fail with a diagnostic that identifies
   the conflicting data.
6. Keep related DDL in one transaction unless PostgreSQL requires a
   transaction-free operation such as `CREATE INDEX CONCURRENTLY`.
7. Add or update disposable-database tests for the failure and no-op paths.

Index-only migrations should use additive `CREATE INDEX IF NOT EXISTS` statements
and must be paired with the corresponding Drizzle index declaration. Avoid
removing an existing index in the same release unless query plans and write
impact have been reviewed.

## Verification before release

Run the shared typecheck and database validation:

```sh
pnpm run typecheck:libs
pnpm --filter @workspace/db run test
```

For a disposable PostgreSQL server, run the complete isolated database/API
validation:

```sh
CI_TEST_DATABASE_ADMIN_URL='postgresql://...' \
pnpm --filter @workspace/db run test:ci
```

That runner creates a uniquely named database, applies the test schema, checks
that a second strict push is a no-op, runs the authenticated API suite, and
drops the database on success or failure. Never point it at a development or
production database.

Before applying a migration to production, verify:

- a current backup or provider snapshot exists and its restore path is known;
- the migration has been exercised against a production-shaped disposable
  schema;
- the no-op schema check passes after the migration;
- the expected indexes, constraints, and columns are present;
- application code is compatible with both the pre-migration and
  post-migration shape when a rolling deployment is possible.

## Rollback policy

Migrations are forward-only. A failed or incorrect migration is corrected with
a new migration that restores the intended schema or data behavior. Do not
write automatic down migrations that guess how to recover user data.

Use a database snapshot or backup restore only when a forward correction cannot
reliably recover the affected state. A restore requires a documented decision
covering the recovery point, data loss window, application compatibility,
workspace isolation, and reconciliation of external objects such as uploaded
files.

Every rollback or corrective migration must record:

- the incident and affected migration;
- the decision owner and approval;
- the recovery point or corrective migration used;
- validation results after recovery;
- any data or object-storage reconciliation still required.
