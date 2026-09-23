---
name: Migration baseline safety
description: Data-safety rule for introducing Relay's first versioned database migration chain.
---

Relay currently has schema-push history but no verified versioned migration baseline. Do not generate and apply the first baseline from a development database or assume production exactly matches the current Drizzle schema. Inspect the production schema and orphan relationships first, then baseline that verified state before applying later migrations.

**Why:** Adding the requested foreign keys or changing audit-log actor deletion behavior can fail on existing orphan rows or silently change deletion semantics. A baseline derived from the wrong database can produce destructive drift.

**How to apply:** Before database-integrity work, compare the production catalog with the Drizzle schema using read-only queries, run orphan and cross-workspace checks, inspect generated SQL, and rehearse baseline plus forward migrations on a disposable database. Never use schema push as the production migration procedure.