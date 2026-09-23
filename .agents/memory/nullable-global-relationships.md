---
name: Nullable global relationships
description: Integrity limits for relationships that support both global and workspace-scoped rows.
---

When both sides of a relationship allow a null workspace ID, add safe existence enforcement independently but retain explicit same-workspace checks in the API.

**Why:** PostgreSQL composite foreign keys use `MATCH SIMPLE` by default, so any null workspace component bypasses the tenant comparison. A composite FK alone would not enforce the intended global/workspace policy.

**How to apply:** Use a plain foreign key to prevent dangling IDs when its deletion semantics are safe. Do not claim database-level tenant enforcement until the global-row policy is defined and represented with NULL-aware constraints or triggers.