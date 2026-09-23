---
name: Drizzle referenced unique indexes
description: Why composite unique parent keys used by PostgreSQL foreign keys must be modeled as named unique constraints for schema push.
---

Model composite parent keys referenced by foreign keys as named unique constraints rather than standalone unique indexes in this project's Drizzle schema.

**Why:** The installed Drizzle Kit PostgreSQL introspector treats any index with a `pg_constraint.conindid` match as constraint-generated. That includes standalone unique indexes referenced by foreign keys, so it misses them during schema push and repeatedly attempts to create identically named indexes. Attaching the existing index as a unique constraint via PostgreSQL's `UNIQUE USING INDEX` preserves its name, uniqueness, and dependent foreign keys without rebuilding it.

**How to apply:** For new foreign keys referencing composite parent columns, define the matching parent key with Drizzle's `unique(...)` and verify a schema-push dry run on an existing database. Never resolve this by dropping an index used by a foreign key.