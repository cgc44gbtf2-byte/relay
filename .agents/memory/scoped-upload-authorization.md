---
name: Scoped upload authorization
description: Security rule for issuing upload URLs that include workspace and resource context.
---

Treat workspace, resource type, and resource ID in an upload request as authorization claims. Validate the complete context and the caller's access to that exact resource before issuing a signed URL.

**Why:** Path-safe IDs prevent traversal but do not prevent a user from naming another tenant's workspace or resource. Signing must fail before storage is contacted when the caller lacks access.

**How to apply:** Keep unscoped uploads limited to flows whose final write performs its own authorization. For workspace-qualified uploads, reject partial contexts and verify both tenant ownership and resource scope.

Do not use the presence of a current attachment row as proof that an unscoped path is safe to attach elsewhere. Reject legacy paths without independent issuance provenance on new writes, even when their old reference is gone.

**Why:** Parent deletion can cascade the reference before asynchronous object cleanup removes the stored bytes. A lookup that blocks reuse while the row exists becomes permissive at exactly the point when the orphaned object is still retrievable.

**How to apply:** When changing upload formats or reference validation, distinguish readable historical references from newly registrable paths. Require user-bound issuance proof for new unscoped references, and test the deletion-to-cleanup interval, not only the live-reference case.