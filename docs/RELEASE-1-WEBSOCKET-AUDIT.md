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

## Confirmed issues fixed

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

Ending an approved community subscription persisted the requester's notification
but did not broadcast it to their open sessions. The end route now returns the
persisted notification from its transaction and, after commit and subscription
revocation, sends it to the requester only. Failed or unauthorized end attempts
do not send a notice.

## Event delivery boundaries

| Event family | Delivery scope reviewed |
| --- | --- |
| Channel messages, typing, presence, reactions, moderation, message deletion, and channel metadata | Sent through channel subscriptions; access depends on fresh authorization at subscription time and explicit revocation paths. |
| Direct messages, notifications and notification-state changes, join/invitation notices, and community-upgrade notices | Sent to explicit user IDs through the user-scoped broadcaster. |
| Channel-list invalidation | Re-checks each connected user’s channel authorization before sending. |
| Channel removal and membership revocation | Remove affected subscriptions before subsequent channel broadcasts; user-facing removal events carry the affected channel IDs. |
| Ticket/session lifecycle | Tickets are short-lived and bound to the authenticated session; session revalidation closes the associated sockets. |

No other cross-workspace delivery leak was confirmed in this review.

## Focused live-socket evidence

`artifacts/api-server/src/admin.test.ts` now checks authenticated sockets for:

- Moderation on a private workspace channel: the owner and two authorized
  member sessions receive the event; a connected user in another workspace who
  attempts to subscribe does not.
- Direct messages: the sender and both recipient sessions receive the message;
  the unrelated connected user does not.
- Notification read, archive, restore, read-all, individual delete, and clear:
  both owner sessions receive state changes; the workspace peer and unrelated
  user do not. An unrelated user's read request does not alter the notification
  or emit the owner's read event.
- Community-upgrade request, approval, and end: the admin receives only the
  request notice, the requester receives the approval and end notices, and the
  unrelated user receives none. A denied end attempt emits no end notice.
- A replacement socket starts without its predecessor's channel subscriptions:
  a channel broadcast before re-subscription does not arrive, while one after
  re-subscription does.

The existing web-client regression in `artifacts/web-irc/src/App.test.tsx`
asserts that reconnect requests a fresh socket ticket and re-subscribes to the
active channel. The contract is a new `ready` frame with no subscription
snapshot; the client must explicitly re-subscribe. The focused API checks run
against a disposable test database, not development or production data.

These checks cover the named delivery families, not every outbound event class
or every authorization race. The broader storage, abuse-control, and
accessibility reviews remain separate audit areas.