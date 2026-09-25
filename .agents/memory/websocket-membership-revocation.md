---
name: WebSocket membership revocation
description: How membership changes must invalidate already-open channel subscriptions without affecting other workspaces.
---

Channel broadcasts use in-memory subscriptions rather than re-checking database authorization for every frame. A membership-changing transaction must commit before the affected user’s subscriptions are revoked; revoke only the channels belonging to the workspace that changed.

**Why:** A subscribe already in flight can pass an access check against the pre-commit membership state. Post-commit revocation closes that race, while exact workspace channel IDs preserve the same user’s subscriptions in unrelated workspaces.

**How to apply:** Collect affected channel IDs in the membership transaction, then revoke them after commit and send a user-scoped membership event. Test multiple tabs and an unaffected subscription in a different workspace.