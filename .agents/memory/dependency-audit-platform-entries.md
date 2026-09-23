---
name: Dependency audit platform entries
description: Distinguishes optional packages present in the pnpm graph from packages actually installed on the current platform.
---

Dependency audits must report optional platform packages that appear in the
pnpm graph but are absent from the current `node_modules` separately from
installed packages. They are versioned graph entries, not evidence that the
current build installed or distributed them.

**Why:** pnpm’s recursive dependency graph includes platform-specific optional
packages such as macOS native modules and WASI variants even when Linux skips
their installation. Treating them as installed creates false license blockers
and inaccurate inventory counts.

**How to apply:** Check each package path on disk before using local
`package.json` or license-file evidence. Keep absent optional entries in the
inventory with a graph-only status and require license review before a future
platform selects them.