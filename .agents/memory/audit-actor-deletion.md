---
name: Audit actor deletion
description: Data-integrity rule for retaining administrative audit records after account removal.
---

Administrative audit rows must survive actor deletion with the recorded actor ID, display snapshot, and event metadata unchanged. Audit actor IDs are historical snapshots, not live user references.

**Why:** Account deletion must not rewrite the identity recorded on past actions or make administrative actions untraceable.

**How to apply:** New audit writes should include the actor ID and display snapshot. Do not add a user foreign key to the audit actor ID; reads return the stored values after account removal.