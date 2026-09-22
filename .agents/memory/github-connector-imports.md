---
name: GitHub connector imports
description: Constraints encountered when importing a local repository through the connected GitHub API.
---

Initialize a completely empty GitHub repository through the Contents API before using Git-data endpoints. Treat `.github/workflows/*` as requiring separate workflow-write authorization, even when normal repository contents can be committed.

**Why:** Git-data blob creation can fail while a repository has no first commit, and branch-aware commits that include workflow files can be rejected even when the same authorization can commit ordinary files.

**How to apply:** Bootstrap one harmless file first. Scan the intended snapshot before upload, commit normal content in size-bounded batches, verify the recursive tree, and handle workflow files separately when the connection lacks workflow permission.