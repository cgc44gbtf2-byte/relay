---
name: Drizzle schema prerequisites
description: Fresh PostgreSQL schema bootstrap and strict no-op comparison pitfalls.
---

When a migration installs a PostgreSQL extension that supports indexes in the current Drizzle schema, a disposable current-schema push must provision the extension separately. The ordered migration rehearsal already supplies it, but a fresh push does not run historical migrations.

**Why:** Without the extension, the initial push may partially create tables before failing on an operator class, and the following no-op check can misleadingly show a large index diff. SQL-expression index definitions can also cause Drizzle Kit to plan drop/recreate for an unchanged operator-class index; use the column's operator-class API when the index is column-based.

**How to apply:** Provision required extensions only in isolated schema-test databases before push, keep real migration files immutable, and inspect a read-only strict second push rather than assuming successful bootstrap implies a no-op. When an empty typed array produces a phantom default ALTER, inspect the PostgreSQL introspector rather than other database dialects: its array-literal parser can misread the empty-array expression. Preserve the exact expression and prove the fix against all three supported versions.