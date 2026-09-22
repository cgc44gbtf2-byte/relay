---
name: Artifact build environment
description: Environment variables required when validating Vite artifact builds directly.
---

Direct Vite builds for workspace artifacts require both `PORT` and `BASE_PATH`; managed workflows provide them automatically, but standalone validation does not.

**Why:** The Vite configurations reject missing values instead of selecting defaults, so a workspace build can fail before compiling application code.

**How to apply:** Set the artifact's preview base path along with a valid port when running a direct build outside its workflow.