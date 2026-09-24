---
name: Authorization locking
description: Concurrency rule for privileged writes whose authority can be revoked while the request is in flight.
---

Privileged writes that race with role or membership revocation must lock every database row that grants the actor authority, then perform the protected write in the same transaction. Serializable isolation alone is insufficient because PostgreSQL may legally order the privileged action before a concurrent revocation.

**Why:** A transaction can read an older authorization snapshot and still commit after the revocation commits when no serialization cycle exists. Row locks force revocation and the privileged action to contend directly.

**How to apply:** For role-changing or similarly sensitive operations, lock membership rows in a deterministic order plus the actor's primary-role, scoped-assignment, and custom-permission rows before re-evaluating permission and writing. For create/approve/delete operations on the same resource, lock the parent row first and keep related state and notification lifecycle changes inside that serialization boundary. When an assignment references a person who can be offboarded, lock that person's profile and membership before the organization row, matching the offboarding path. Keep lock order consistent across every path.