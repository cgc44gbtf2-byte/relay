---
name: API cleanup bundling
description: The build constraint for the API server's cleanup command and its importable test module.
---

The cleanup implementation should stay importable for unit tests, with a separate CLI entry point used by the esbuild bundle. Keep the cleanup build on an output directory rather than forcing a single outfile or shared entry name.

**Why:** The API build uses a pino esbuild plugin that emits companion files. Single-file output and forced entry names can collide with those generated files.

**How to apply:** When changing the cleanup command, preserve the separate CLI wrapper and let esbuild generate its companion outputs in `dist-cleanup`.