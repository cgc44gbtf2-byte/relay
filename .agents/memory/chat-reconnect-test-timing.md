---
name: Chat reconnect test timing
description: How to keep reconnect assertions distinct from initial room bootstrap sockets.
---

When testing socket retries, settle the initial chat and room bootstrap microtasks before recording the active socket or ticket count. An initial room selection can open another socket even without a network drop.

**Why:** Assertions that counted tickets immediately after the first heading appeared sometimes mistook an in-flight bootstrap connection for a reconnect, making otherwise sound retry tests order-dependent.

**How to apply:** Await the initial room render and pending microtasks before taking socket and ticket snapshots; then close that socket and advance the retry timer.