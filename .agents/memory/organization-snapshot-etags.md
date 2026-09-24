---
name: Organization snapshot validators
description: Why directory freshness uses content-derived validators instead of audit-derived revision IDs.
---

Directory freshness validators must reflect the actual authorized snapshot, not just workspace audit activity.

**Why:** Presence changes and invitation delivery outcomes can change the directory without a matching workspace audit event. An audit-only revision would silently hide those changes from other sessions.

**How to apply:** If replacing content-derived validators with a cheaper version check, account for every writer of directory-visible fields, including asynchronous delivery and presence, before returning an unchanged response.