---
name: Message notification intent
description: Why message alert intent is stored with the message rather than inserted separately.
---

Keep message alert intent in the same durable write as the message, and snapshot recipient identities at send time.

**Why:** The send must survive notification-table failures without losing its alert intent. A separate post-response enqueue leaves a crash gap; resolving usernames on retry can notify different people after edits or renames.

**How to apply:** Preserve this boundary when extending message delivery or introducing another queue. Delivery workers may recheck access, but must not derive a new recipient list from edited message text.