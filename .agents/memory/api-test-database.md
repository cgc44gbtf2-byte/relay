---
name: API test database
description: The environment requirement that gates the API server's integration test runner.
---

The API integration test runner intentionally refuses to start without a dedicated disposable `TEST_DATABASE_URL`.

**Why:** Admin access tests create and remove external Clerk users and database profiles, so running them against an unspecified or shared database would risk contaminating persistent data.

**How to apply:** Before relying on the API package's full validation command, provision or expose a disposable test database through `TEST_DATABASE_URL`; type checking and test compilation can still run without it.