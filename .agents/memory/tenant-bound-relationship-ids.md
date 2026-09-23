---
name: Tenant-bound relationship IDs
description: Isolation rule for persisted department, location, team, category, and similar workspace-owned IDs.
---

Whenever persisted data carries IDs for workspace-owned relationships, validate every referenced row against the same workspace inside the transaction that consumes those IDs.

**Why:** Validating only at creation is insufficient because legacy, imported, administrative, or previously corrupted rows may contain IDs from another tenant.

**How to apply:** Scope relational lookups by both resource ID and workspace ID before any mutation. Fail atomically rather than silently applying only the valid subset.

When one row stores both a parent ID and a child/dependent ID, independent foreign keys only prove that each exists. Add a composite relationship constraint when the dependent must belong to that exact parent.

For composite tenant references such as `(parent_id, workspace_id)`, do not use a generic `ON DELETE SET NULL` when the workspace column is non-null: PostgreSQL will try to null every referencing column. A scalar FK can own `SET NULL` while a composite `NO ACTION` FK enforces tenant pairing.

Treat channel organization as reassignment to a category within the channel's existing workspace, not as moving a channel between workspaces.

**Why:** Reorganizing a channel should preserve its identity, membership, messages, and authorization boundary; moving the workspace itself would change all of those semantics.

**How to apply:** Support assigning an existing channel to a same-workspace category or unassigning it. Keep cross-workspace channel movement as a separate, explicitly designed feature.