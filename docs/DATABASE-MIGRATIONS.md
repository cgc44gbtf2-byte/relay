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

The release runner records applied files in `irc_schema_migrations`. It verifies
the filename sequence and SHA-256 checksum, takes a PostgreSQL advisory lock so
two releases cannot migrate concurrently, applies each file in order, and
exits non-zero on any failure. The application must be started only after the
migration command succeeds:

```sh
RELEASE_MIGRATION_TARGET=production \
RELEASE_MIGRATION_BACKUP_CONFIRMED=true \
RELEASE_MIGRATION_BACKUP_REFERENCE='<current-backup-or-snapshot-label>' \
pnpm run release:start
```

The backup reference is an operator-supplied label, not a credential. The
runner never prints `DATABASE_URL` or any other secret. A second run with no
pending files performs a ledger and checksum no-op verification. A changed
applied file, missing file, gap in the sequence, or partial history stops the
release with an actionable diagnostic.

The API artifact's production run command is configured to invoke
`pnpm run release:start`; it sets `RELEASE_MIGRATION_TARGET=production`.
Before each production release, configure these non-secret confirmation values
in the deployment environment after verifying a current backup or provider
snapshot:

- `RELEASE_MIGRATION_BACKUP_CONFIRMED=true`
- `RELEASE_MIGRATION_BACKUP_REFERENCE=<current-backup-or-snapshot-label>`

Do not hard-code a backup reference that may no longer describe the current
release. The startup command applies migrations first and starts the API only
when that command exits successfully. Development and test startup commands
remain separate and do not use this production release gate.

For an existing installation that predates the migration ledger, do not run
the migration files again. First inspect the production catalog and data,
confirm which reviewed migrations are already present, and take a current
backup. Then run the explicit baseline command with the last verified file:

```sh
RELEASE_MIGRATION_TARGET=production \
RELEASE_MIGRATION_BACKUP_CONFIRMED=true \
RELEASE_MIGRATION_BACKUP_REFERENCE='<current-backup-or-snapshot-label>' \
RELEASE_MIGRATION_BASELINE_CONFIRMED=true \
RELEASE_MIGRATION_BASELINE=0012_query_path_indexes.sql \
pnpm run db:migrate:release:baseline
```

Baselining records history only; it applies no SQL. Never use it to skip an
unverified migration. After baselining, run the read-only
`pnpm run db:migrate:release:check` command and use `pnpm run release:start` for
future deployments.

CI can validate the reviewed migration set without a database:

```sh
pnpm run db:check:migrations
```

The API database CI job also runs `pnpm run db:rehearse:migrations` against a
uniquely provisioned disposable PostgreSQL database. It loads the checked-in
schema fixture from immediately before the first reviewed migration, applies
every reviewed file, performs a real ledger no-op check, and runs a synthetic
failing migration to confirm PostgreSQL rollback leaves both the schema and
ledger consistent.
The fixture is `lib/db/scripts/fixtures/pre-migration-schema.ts`; its pinned
SHA-256 digest is stored beside it and verified before the rehearsal changes the
database. The rehearsal's CI checkout is intentionally shallow, so this check
also ensures it cannot rely on an ancestor commit being available.
The upgrade-request table was already defined in the application schema before
the `0001` fixture was recorded (see the earlier community-upgrade schema
change in repository history). It belongs in that starting fixture, with its
original columns and indexes, but without `expires_at` or `reminder_sent_at`.
Those columns are added by reviewed migrations `0019` and `0023`. The rehearsal
checks this before/after shape explicitly; do not alter those applied migration
files to compensate for a missing fixture table. If baselining an existing
installation, inspect its actual catalog first rather than treating the fixture
as evidence that every installed database has the same shape.
The child process receives only `TEST_DATABASE_URL`; persistent
`DATABASE_URL` and admin connection variables are removed before it starts.
The separate current-schema test database installs `pg_trgm` before pushing
the Drizzle schema, matching the extension prerequisite supplied by reviewed
migration `0017` in the rehearsal database.
The pinned Drizzle Kit patch also preserves PostgreSQL's `ARRAY[]::text[]`
default during introspection: the unpatched PostgreSQL parser mistakes that
empty expression for a nonempty array and repeatedly proposes an ALTER on an
unchanged `notification_recipient_ids` column. The strict read-only no-op
check remains enabled across all three supported PostgreSQL versions.

### Updating the rehearsal starting schema

The checked-in schema is a frozen input representing the database immediately
before migration `0001`. Its checksum catches unreviewed or accidental fixture
changes; it is not permission to replace the historical baseline with the
current Drizzle schema.

Only update it when an authoritative, reviewed pre-migration schema source
shows that the intended starting point should change. Edit the fixture, then
regenerate `lib/db/scripts/fixtures/pre-migration-schema.sha256` from its exact
bytes with:

```sh
sha256sum lib/db/scripts/fixtures/pre-migration-schema.ts \
  | cut -d ' ' -f 1 \
  > lib/db/scripts/fixtures/pre-migration-schema.sha256
```

Review both files together. Do not derive the fixture by pushing the current
Drizzle schema, since that would already include later changes and could hide
migration errors. Run
`pnpm --filter @workspace/db run test` and the disposable PostgreSQL migration
rehearsal after updating it.

The release command treats an explicitly reviewed destructive operation
(`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM`, or dropping `NOT NULL`)
as a stop condition. After inspecting the SQL and its backup impact, an
operator must additionally provide `RELEASE_MIGRATION_DESTRUCTIVE_APPROVED=true`
and a non-secret `RELEASE_MIGRATION_DESTRUCTIVE_REFERENCE`.

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
