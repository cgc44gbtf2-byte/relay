---
name: Deletion race tests
description: What makes a lifecycle concurrency test strong enough to detect access restoration.
---

For account-deletion race coverage, exercise the actual invitation, administrator grant, and worker entry paths as well as the shared lock/eligibility guard. Check both the deletion-first and grant-first outcomes where applicable.

**Why:** A helper-level PostgreSQL test passed while an independent admin grant route still lacked the target-user lock. It proved the guard worked, but could not detect callers that never used it.

**How to apply:** Keep destructive fixtures in an isolated TEST_DATABASE_URL database; use route-level requests for access writers and observe the persisted membership or role after each transaction order. For external deletion, inject a failing-then-successful client into the worker entry point and inspect intermediate and final durable states.