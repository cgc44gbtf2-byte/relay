---
name: API test database
description: The environment requirement that gates the API server's integration test runner.
---

The API integration test runner intentionally refuses to start without a dedicated disposable `TEST_DATABASE_URL`.

**Why:** Admin access tests create and remove external Clerk users and database profiles, so running them against an unspecified or shared database would risk contaminating persistent data.

**How to apply:** A truly isolated local PostgreSQL cluster under `/tmp` can satisfy the test-database requirement without touching the app database. Keep it running in a background shell task: a server started inside a one-off shell command stops when that command ends. Use its own socket directory because the system socket directory may not exist, and bootstrap it with the container user rather than assuming a `postgres` role. Run tests with the app's database URL absent and verify the test connection points to the disposable database before schema setup or destructive tests. Stop the cluster afterward and confirm test profiles were removed.

On a fresh local cluster, schema push can try to create composite foreign keys before their referenced composite unique indexes. Bootstrap those indexes in the disposable database first, then retry schema push. Do not apply this workaround to a shared or production database.