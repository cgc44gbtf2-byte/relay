---
name: Admin UI maintainability
description: Durable guidance for evolving the Relay platform operations console safely.
---

Keep major platform-admin sections in focused components rather than one large JSX return block.

**Why:** Dense operations surfaces change frequently, and large inline JSX blocks make small layout edits difficult to review and easy to damage.

**How to apply:** When adding an admin control, prefer a dedicated panel or dialog component with a narrow prop contract, then keep the route component responsible for data loading and mutation orchestration.