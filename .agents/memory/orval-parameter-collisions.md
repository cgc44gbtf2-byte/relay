---
name: Orval parameter export collisions
description: Generated path-and-query parameter validators can collide with generated type exports.
---

Orval can emit validators and types with the same name for path-and-query parameters. A successful generator run does not guarantee its downstream export surface will typecheck.

**Why:** Pagination contracts caused generated declarations to conflict at the package boundary; regeneration can restore conflicting exports.

**How to apply:** When adding path-and-query contracts, run codegen followed by library typechecking and resolve name collisions at the export boundary without editing generated files.