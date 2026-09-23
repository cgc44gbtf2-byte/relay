---
name: Clerk test identity limits
description: How authenticated integration tests and abandoned-user cleanup should behave under Clerk management API rate limits.
---

Authenticated integration tests that create many Clerk users, sessions, and tokens must treat management API rate limiting as normal operating behavior. Cache session tokens during a run, retry setup calls using Clerk's reported retry delay with a bounded attempt count, and avoid concurrent bulk teardown.

**Why:** Live session validation per request and concurrent identity cleanup both exhausted the development tenant's management API quota. Immediate retries caused cascades, interrupted the suite, and left abandoned test users.

**How to apply:** Keep test identity setup bounded and retry-aware. Let fast teardown make best-effort sequential deletions, then rely on the strict-pattern cleanup job for leftovers; that cleanup must process users sequentially and honor rate-limit retry delays until it succeeds or reaches its bounded limit.