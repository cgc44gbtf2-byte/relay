---
name: Prettier external-file probes
description: A CLI testing caveat for temporary files outside the current repository.
---

Prettier CLI can silently skip a file passed from outside the current working directory and report that all matched files pass. Use an in-repository temporary fixture when testing parser failures and diagnostic locations.

**Why:** An invalid YAML probe under `/tmp` was ignored, while an equivalent in-repository probe correctly failed with the path and line/column.

**How to apply:** When testing a Prettier parser command, create malformed fixtures under the repository root (and remove them with a shell trap), not under `/tmp`.