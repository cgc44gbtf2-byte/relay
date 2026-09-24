---
name: Organization freshness tradeoff
description: Why directory freshness uses a page-local mechanism rather than the chat socket.
---

Keep organization-directory freshness independent of the chat page's socket lifecycle.

**Why:** Managers can remain in the standalone workspace console without opening chat. Visible-page bounded polling was chosen over coupling this console to chat realtime state; local mutations still need immediate refresh.

**How to apply:** If replacing polling with realtime, establish an independent console subscription and reconnect recovery. Preserve unsaved settings and loaded pagination when applying remote organization changes.