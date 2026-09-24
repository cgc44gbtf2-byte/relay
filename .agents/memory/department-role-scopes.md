---
name: Department role scopes
description: Distinguish business departments from IRC channel categories when implementing scoped authorization.
---

A business department is not a channel category. A category grant governs rooms grouped under that category; a department grant must name the business department and be checked only against operations targeting that department.

**Why:** The existing scoped-role UI previously described category grants as department grants, but business departments are separate organization records. Such a label would suggest a privilege that the authorization system could not actually enforce.

**How to apply:** For new department-level operations, pass the validated department and workspace together into permission checks. Keep category-scoped room operations separate, and avoid treating a department grant as a workspace-wide grant.