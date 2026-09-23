---
name: Audit actor deletion
description: Data-integrity rule for retaining administrative audit records after account removal.
---

Administrative audit rows must survive actor deletion. Null the actor foreign key and retain immutable actor display snapshots and event metadata.

**Why:** Cascading account deletion destroys security history and makes administrative actions untraceable.

**How to apply:** New audit writes should still include the live actor ID and display snapshot. Reads must tolerate a null actor ID and fall back to the stored snapshot.