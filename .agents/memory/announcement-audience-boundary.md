---
name: Announcement audience boundary
description: Authorization for targeted announcements extends beyond the workspace detail collection.
---

Treat an announcement's audience as an authorization boundary across feeds, attachments, read receipts, acknowledgements, and delayed delivery.

**Why:** Workspace membership alone can expose targeted announcement content through a secondary feed or attachment route and can notify the wrong people when a scheduled item activates.

**How to apply:** For any new announcement endpoint or notification producer, compare its access decision with the workspace detail audience decision, including schedule and expiry, and add a non-recipient member to negative tests.