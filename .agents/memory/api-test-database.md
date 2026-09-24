---
name: API test database
description: The environment requirement that gates the API server's integration test runner.
---

The API integration test runner intentionally refuses to start without a dedicated disposable `TEST_DATABASE_URL`.

**Why:** Admin access tests create and remove external Clerk users and database profiles, so running them against an unspecified or shared database would risk contaminating persistent data.

**How to apply:** A truly isolated local PostgreSQL cluster under `/tmp` can satisfy the test-database requirement without touching the app database. Keep it running in a background shell task: a server started inside a one-off shell command stops when that command ends. Use its own socket directory because the system socket directory may not exist, and bootstrap it with the container user rather than assuming a `postgres` role. Run tests with the app's database URL absent and verify the test connection points to the disposable database before schema setup or destructive tests. Stop the cluster afterward and confirm test profiles were removed.

On a fresh local cluster, schema push can try to create composite foreign keys before their referenced composite unique indexes. Bootstrap those indexes in the disposable database first, then retry schema push. Do not apply this workaround to a shared or production database.

Fresh current-schema setup also requires the `pg_trgm` extension for document search indexes. Start local PostgreSQL with an explicit socket directory because `/run/postgresql` may not exist in the container.

When the push encounters multiple composite-FK ordering failures in succession, another safe option is to clone only the development database's schema (no data) into a fresh disposable test database. The dump must be read-only on development; remove the empty target database's default `public` schema before restoring a schema-only dump that creates it. This verifies route behavior against the current development shape, but does not prove Drizzle can bootstrap a fresh schema.

Keep migration rehearsal and current-schema bootstrap on separate disposable databases.

**Why:** Rehearsal leaves its migration ledger and historical schema in its target. Reusing that target for a current-schema push can trigger interactive rename decisions, even though a genuinely empty database bootstraps correctly.

**How to apply:** Preserve the strict read-only no-op gate and clean up both databases on success and failure. Derive the forced-failure rehearsal migration number and expected ledger size from the reviewed sequence, rather than hardcoding them as migrations grow.

Cached Clerk test-session JWTs must be refreshed before their expiration.

**Why:** Longer authenticated suites can outlive short-lived tokens; indefinite caching produced late-suite 401 failures unrelated to the endpoint being tested.

**How to apply:** Check the cached token's expiry with a small safety margin before ordinary authenticated test requests. Keep explicit expired-token and revocation tests separate; never relax production verification.