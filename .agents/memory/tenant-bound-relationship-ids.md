---
name: Tenant-bound relationship IDs
description: Isolation rule for persisted department, location, team, category, and similar workspace-owned IDs.
---

Whenever persisted data carries IDs for workspace-owned relationships, validate every referenced row against the same workspace inside the transaction that consumes those IDs.

**Why:** Validating only at creation is insufficient because legacy, imported, administrative, or previously corrupted rows may contain IDs from another tenant.

**How to apply:** Scope relational lookups by both resource ID and workspace ID before any mutation. Fail atomically rather than silently applying only the valid subset.

When one row stores both a parent ID and a child/dependent ID, independent foreign keys only prove that each exists. Add a composite relationship constraint when the dependent must belong to that exact parent.

For composite self-references such as `(parent_id, workspace_id)`, do not use a generic `ON DELETE SET NULL` when the workspace column is non-null: PostgreSQL will try to null every referencing column. Use restrictive deletion unless a safe, explicitly modeled replacement behavior exists.