---
name: Realtime history reconciliation
description: Rules for merging bounded history refreshes with realtime and paginated chat state.
---

When a bounded history refresh races with realtime updates, overlay only messages changed after that refresh began. Never merge the entire pre-refresh client list over the server response, because it can restore stale fields and defeat the server window bound.

**Why:** Reconnect refreshes can overlap new frames, room switches, and older-page requests. Unscoped merging retained stale messages, grew busy-room history, and allowed previous-room state to leak into a newly selected DM.

**How to apply:** Track post-start changes, keep refreshed overlapping fields authoritative, enforce the channel history bound, and scope refresh/pagination results plus loading cleanup to a stable room key. Preserve older paginated DM history only within the same room.