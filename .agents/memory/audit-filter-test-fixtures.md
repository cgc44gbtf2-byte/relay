---
name: Audit filter test fixtures
description: Keep workspace audit-filter integration fixtures aligned with automatic audit events and PostgreSQL parameter typing.
---

Workspace creation emits its own audit entry, so activity-filter tests must include that event when asserting the action-options list. Keep integer workspace IDs and text audit target IDs as separate SQL parameters; PostgreSQL will not infer one placeholder as both types.

**Why:** A focused audit-filter test initially failed because the fixture omitted the automatic creation event and reused one placeholder across integer and text columns.

**How to apply:** When adding workspace activity tests, seed only the extra rows needed, assert actor-filtered entries separately from the full action-options list, and use distinct placeholders for differently typed columns.