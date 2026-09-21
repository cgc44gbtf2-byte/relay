---
name: App Storage sidecar integration
description: Presigned App Storage URLs can be used without adding Google Cloud client packages to the workspace.
---

Use the Replit object-storage sidecar for presigned upload and download URLs when the monorepo package installer cannot add storage SDK dependencies to the workspace root. Keep normalized `/objects/...` paths in PostgreSQL and authorize attachment downloads through the message access check before signing a GET URL.

**Why:** The workspace package installer targets the pnpm root and rejects package additions that are not explicitly root-scoped; direct SDK installation would add unrelated root dependencies.

**How to apply:** Read `PRIVATE_OBJECT_DIR` through the environment-secrets workflow, sign PUT/GET requests through the local object-storage sidecar, and never make private object paths public or trust an attachment ID without checking its parent message.