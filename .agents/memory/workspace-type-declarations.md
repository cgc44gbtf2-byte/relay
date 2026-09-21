---
name: Workspace type declarations
description: Shared TypeScript package declaration refreshes needed after schema edits
---

When a shared workspace package changes, rebuild its referenced declarations before typechecking dependent packages.

**Why:** The API compiler can otherwise resolve stale declarations from the shared package output and report errors that do not match the current source.

**How to apply:** Run the workspace library build/typecheck before the dependent artifact typecheck after changing shared database schemas or exports.