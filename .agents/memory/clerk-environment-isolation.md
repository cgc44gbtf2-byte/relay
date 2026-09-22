---
name: Clerk environment isolation
description: Keep CI concurrency scoped to the external Clerk environment each job can mutate.
---

CI jobs that use different disposable Clerk environments should use different concurrency groups; sharing a lock is only needed when jobs can mutate the same Clerk tenant.

**Why:** A shared lock unnecessarily delays scheduled cleanup behind authenticated regression tests, while separate test tenants are already isolated from each other.

**How to apply:** When adding a Clerk-using CI job, identify its GitHub secret pair and external tenant first, then share a concurrency group only with jobs using that same tenant. Keep cancellation disabled for maintenance safety.