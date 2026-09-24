---
name: Completion rebase verification
description: Passing checks can be invalidated by automatic concurrent-task rebases during completion.
---

If completion reports errors that contradict the just-passed checks, inspect the reflog and compare the pre-completion snapshot with the current tree before changing application logic.

**Why:** Automatic integration of concurrent task changes has corrupted repeated test blocks while leaving runtime changes intact. Pre-integration test results did not describe the reviewed tree.

**How to apply:** Preserve other tasks' changes, repair only the integration damage, and rerun typechecking and the affected suite on the resulting tree.