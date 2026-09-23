---
name: Admin UI maintainability
description: Durable guidance for evolving the Relay platform operations console safely.
---

Keep major platform-admin sections in focused components rather than one large JSX return block.

**Why:** Dense operations surfaces change frequently, and large inline JSX blocks make small layout edits difficult to review and easy to damage.

**How to apply:** When adding an admin control, prefer a dedicated panel or dialog component with a narrow prop contract, then keep the route component responsible for data loading and mutation orchestration.

Platform account controls should suspend and restore accounts rather than delete them from the admin console.

**Why:** Suspension is reversible, preserves audit and message history, and can be enforced centrally for every authenticated API request.

**How to apply:** Treat account suspension as an access-state mutation with an audit event; do not add destructive account deletion to routine admin controls without a separate retention decision.

Admin controls must call an endpoint whose authorization model matches the actor shown the control.

**Why:** Platform-wide visibility does not imply exact workspace ownership. Showing an action that invokes an owner-only route creates predictable 403 failures and misleading destructive UI.

**How to apply:** Prefer a manager/admin-capable endpoint for controls intentionally available to platform operators. Otherwise expose the required ownership fact and render an explicit owner-only state.