---
name: GitHub push transport
description: Authentication and history constraints when pushing the development branch
---

The configured GitHub SSH remote may reject access with `Permission denied (publickey)`. An authenticated HTTPS transport can push the existing local `development` history without replacing it.

**Why:** The local branch contained unpublished commits whose parent was the remote branch. A GitHub API snapshot commit would have discarded that commit history and diverged the local branch; a non-force HTTPS push preserved all commits.

**How to apply:** Compare the remote tip to the local branch first and push only when the update is fast-forward. Never print or embed credentials in a remote URL or logs.