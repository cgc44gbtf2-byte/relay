---
name: API test database
description: The environment requirement that gates the API server's integration test runner.
---

The API integration test runner intentionally refuses to start without a dedicated disposable `TEST_DATABASE_URL`.

**Why:** Admin access tests create and remove external Clerk users and database profiles, so running them against an unspecified or shared database would risk contaminating persistent data.

**How to apply:** This Replit project cannot provision or expose the required disposable database, so treat the full stateful API integration suite as unavailable here. Continue using type checking, builds, test compilation, and the web test suite; do not make the unavailable database a prerequisite for progress.

When provisioning PostgreSQL locally in this environment, pass an explicit temporary socket directory because `/run/postgresql` may not exist.

The local PostgreSQL binaries may use the container user as the bootstrap role rather than `postgres`, and this `initdb` version does not accept `--no-password`; use an explicit role with trust authentication when creating a disposable cluster.