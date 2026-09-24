---
name: PostgreSQL race observation
description: Avoid stale activity snapshots when checking database lock contention in integration tests.
---

Clear the PostgreSQL statistics snapshot before each activity poll made through a long-running blocker transaction.

**Why:** `pg_stat_activity` can retain the transaction's first observed state. A request that subsequently reaches the expected authorization lock may remain invisible to the poll, producing intermittent failures despite correct locking.

**How to apply:** Call `pg_stat_clear_snapshot()` before reading activity, and identify waiting requests using `pg_blocking_pids` tied to the blocker connection rather than unrelated waiting queries.