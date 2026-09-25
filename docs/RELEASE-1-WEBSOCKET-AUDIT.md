# Release 1 WebSocket event review

## Scope

Reviewed outbound WebSocket event emitters, channel subscription and session
revocation paths, and the web client’s event handling in:

- `artifacts/api-server/src/lib/ws.ts`
- `artifacts/api-server/src/routes/communities.ts`
- `artifacts/api-server/src/routes/irc.ts`
- `artifacts/api-server/src/routes/community-upgrades.ts`
- `artifacts/api-server/src/routes/admin.ts`
- `artifacts/web-irc/src/App.tsx`

This is a code-level authorization review with focused live-socket regression
coverage. It is not a claim that every event has an end-to-end recipient test.

## Confirmed issue fixed

Terminating an employee removed their channel memberships and workspace
membership in the database, but did not revoke existing WebSocket subscriptions.
`broadcastChannel` sends to its in-memory subscriber set and does not re-check
database access for every frame, so an already-subscribed employee could
continue receiving private-channel events.

The status route now collects the workspace channel IDs in its transaction and,
only after commit, revokes that employee’s subscriptions for those channels.
It sends a workspace-removal event to the employee’s sessions and broadcasts a
presence-leave event to remaining channel subscribers. The event includes both
channel IDs and the workspace ID; the web client removes the affected channels,
clears affected categories, and recovers from an active removed room. The normal
workspace-member removal route uses the same event shape.

The authenticated regression test verifies two employee tabs lose the affected
workspace subscription, a remaining workspace member receives the presence
change, and the employee remains subscribed to a private channel in a different
workspace.

## Event delivery boundaries

| Event family | Delivery scope reviewed |
| --- | --- |
| Channel messages, typing, presence, reactions, moderation, message deletion, and channel metadata | Sent through channel subscriptions; access depends on fresh authorization at subscription time and explicit revocation paths. |
| Direct messages, notifications and notification-state changes, join/invitation notices, and community-upgrade notices | Sent to explicit user IDs through the user-scoped broadcaster. |
| Channel-list invalidation | Re-checks each connected user’s channel authorization before sending. |
| Channel removal and membership revocation | Remove affected subscriptions before subsequent channel broadcasts; user-facing removal events carry the affected channel IDs. |
| Ticket/session lifecycle | Tickets are short-lived and bound to the authenticated session; session revalidation closes the associated sockets. |

No other cross-workspace delivery leak was confirmed in this review.

## Remaining test coverage

These are test gaps, not confirmed authorization defects:

- Add explicit recipient/non-recipient live-socket assertions for moderation,
  direct messages, notification-state changes, and community-upgrade notices.
- Specify and test reconnect behavior. The server sends `ready` without a
  subscription snapshot; the client’s re-subscription behavior should be
  asserted as the contract.

The broader storage, abuse-control, and accessibility reviews remain separate
audit areas.