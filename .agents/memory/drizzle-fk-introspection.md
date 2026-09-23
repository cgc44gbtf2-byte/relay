---
name: Drizzle foreign-key introspection
description: Why a successful PostgreSQL schema push may still plan the same foreign-key rewrites on its next run.
---

A successful Drizzle Kit push is not proof that the next push is a no-op. Check the next plan without applying it, especially for composite foreign keys.

**Why:** The version used here paired composite foreign-key columns incorrectly when introspecting PostgreSQL, and compared generated names against PostgreSQL's 63-byte truncated names. That made valid unchanged keys appear to need DROP/ADD on every push, causing needless locking and risk. A narrowly scoped dependency patch fixes the comparison until an upstream release handles both cases.

**How to apply:** Before removing or upgrading the patch, rehearse against a disposable database and verify a dry-run schema push on an already-synced development database reports no changes. Do not fix this by removing foreign-key declarations or repeatedly re-creating valid constraints.