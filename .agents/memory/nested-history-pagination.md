---
name: Nested history pagination
description: Compatibility rule for paging nested histories in workspace detail responses.
---

When introducing pagination for nested histories, keep the unpaged detail response complete for existing callers. Let clients opt into independently paged child collections and provide explicit continuation for each child.

**Why:** Existing consumers rely on complete nested arrays; a silent limit makes older history and permissions disappear even though the parent record remains visible.

**How to apply:** Use opt-in child page parameters and stable ordering. A UI that opts in must show separate load-more controls and avoid treating partially loaded memberships as definitive assignment state.