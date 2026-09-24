---
name: Filtered pnpm test globs
description: Why CI glob expansion must happen inside the filtered package directory.
---

Shell globs in a command invoking `pnpm --filter ... exec` expand in the caller's directory before pnpm switches to the selected workspace. If the repository root later gains matching files, a previously working package test command can start selecting unrelated root files.

**Why:** The database compatibility matrix failed on every PostgreSQL version when a root-level test matched its unquoted glob; pnpm then tried to execute that root file from the database package. This was independent of PostgreSQL version.

**How to apply:** Run package-local globs in a shell started inside the filtered package, or use its package script. Keep explicit TAP output where a CI failure summarizer parses TAP results.