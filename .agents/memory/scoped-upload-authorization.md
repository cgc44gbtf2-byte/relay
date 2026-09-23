---
name: Scoped upload authorization
description: Security rule for issuing upload URLs that include workspace and resource context.
---

Treat workspace, resource type, and resource ID in an upload request as authorization claims. Validate the complete context and the caller's access to that exact resource before issuing a signed URL.

**Why:** Path-safe IDs prevent traversal but do not prevent a user from naming another tenant's workspace or resource. Signing must fail before storage is contacted when the caller lacks access.

**How to apply:** Keep unscoped uploads limited to flows whose final write performs its own authorization. For workspace-qualified uploads, reject partial contexts and verify both tenant ownership and resource scope.