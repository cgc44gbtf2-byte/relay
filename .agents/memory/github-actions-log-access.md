---
name: GitHub Actions log access
description: Distinguish readable CI run metadata from permission-gated job logs
---

GitHub's run and job metadata may be available through a connected account or public job page while the job-log download endpoint still rejects access for lack of repository admin rights. Public annotations may identify only a failing step and exit code, not the underlying error.

**Why:** The connected GitHub API and unauthenticated API both refused job-log downloads; public check-step log fragments were also unavailable. Treating a job's failed step as its root cause would overstate the evidence.

**How to apply:** Use job metadata for scope, reproduce against the failed revision when feasible, and distinguish proven reproductions from plausible causes. Do not claim a hosted fix until a run of the current revision passes; seek admin-authorized logs only when exact output is necessary.