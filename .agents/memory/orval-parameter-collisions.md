---
name: Orval parameter export collisions
description: Generated parameter validators can collide with exports or reference constants before initialization.
---

Orval can emit validators and types with the same name for path-and-query parameters. It can also emit a regular-expression constant after a schema that uses it. A successful generator run does not guarantee that its output will typecheck or initialize safely.

**Why:** Pagination contracts caused generated declarations to conflict at the package boundary; date-filter parameters later caused a forward reference to a block-scoped regular expression. Regeneration can restore either failure.

**How to apply:** When adding parameter contracts, run codegen followed by library typechecking and inspect initialization order of generated validators. Prefer an upstream generator/configuration fix over hand-editing generated output; a local correction to generated code must be rechecked after regeneration.