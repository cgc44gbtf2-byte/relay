---
name: Pagination test prerequisites
description: Focused authenticated test selections must include and follow shared role initialization.
---

When selecting a subset of authenticated admin integration tests, verify both
which setup tests are selected and their source order.

**Why:** The suite historically initializes shared administrator sessions inside
a test rather than its global setup. Selecting that prerequisite is insufficient
if a newly inserted dependent test appears earlier; it fails before exercising
the route and can look like a pagination regression.

**How to apply:** Put dependent tests after their prerequisite and include it in
focused test-name patterns, or deliberately isolate fixtures when restructuring
the suite. Do not interpret a selected test count as evidence that its endpoint
assertions ran.