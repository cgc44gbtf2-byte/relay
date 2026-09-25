# Release 1 abuse-control inventory

Reviewed: 2026-09-25. Paths are relative to `/api`. This inventories the
highest-risk mutation and costly-read families, not a claim that every request
has a distributed quota. Authentication and resource permissions still apply
where noted. Rejected attempts can count against a budget; rate-limit responses
include `429` and `Retry-After`.

| Route family | Controls and bounds | Explicit exclusion or limitation |
| --- | --- | --- |
| `GET /ws-ticket`, WebSocket `/ws` | Authenticated session; 10 ticket requests per user/minute. Random tickets expire after 60 seconds, are removed on first attempted use, and the Clerk session is checked again before upgrade. Unused tickets are swept in bounded batches. WebSocket frames are limited to 4 KB; typing frames have a per-connection throttle. | Tickets, counters, connected clients, and broadcasts exist only in the issuing API process. A ticket issued on another process cannot be consumed here. |
| `POST /storage/uploads/request-url` | Authenticated; 10 URL requests per user/minute; exact workspace/resource authorization when scoped; declared metadata limited to 25 MB, or 10 MB for task, announcement, and workspace-channel contexts. | The signed direct PUT has **no established provider-enforced byte or MIME limit**. See `RELEASE-1-STORAGE-AUDIT.md`. A valid URL can be retried until expiry. |
| `POST /communities/:id/invitations` and `.../invitations/:invitationId/resend` | Manager permission; **shared** budget of 20 attempts per actor and workspace/minute before any invitation mutation or external email. Address, role, and organization assignments are validated. | No per-recipient or cross-workspace email budget; multiple actors can each use their allowance. Concurrent duplicate invitations are tracked separately. |
| `POST /communities/:id/invitations/accept`, `/decline`, `/:id/revoke`; `POST /channels/:id/invites` and join | Invitation token/recipient or manager access; channel invites have 30 attempts per user+IP/minute; joins have 20 per user+IP/minute. Acceptance uses transactional authorization and token state. | Workspace accept/decline/revoke have no separate request-rate limit: recipient/manager authorization and token state are the gate. Invalid-token attempts still cost application work. |
| `POST /channels/:id/messages`, `/file-messages`, `/dm/:userId/messages`, `/messages/:id/attachments` | Authenticated; shared budget of 60 attempts per sender/minute across these routes; membership, mute/block, sender, and attachment checks remain. Text messages have a 500-character maximum; file references validate metadata. | The budget spans a user's workspaces and does not rate-limit reactions, reads, or WebSocket subscriptions. It does not stop abuse through many accounts. |
| `GET /users/search`, `/search/messages` | Authenticated; 60 requests per user+IP/minute for each search family, query length at most 200 characters, limited visible-page results. | Each API process has its own counter; changing IPs gives another user+IP key. Authorized wildcard searches can still be expensive. |
| `GET /admin/users?q=...`, `/admin/activity/export` | Admin-only. Nonempty wildcard user queries have 60 requests per admin/minute and bounded pages. Valid activity exports have 3 requests per admin/5 minutes, validated filters, and 500-row streaming batches. | Unfiltered admin directory paging is intentionally excluded so legitimate large-directory traversal can finish. Export has no total-row cap; consistency and disconnect handling are tracked separately. |
| `POST /communities/:id/test-accounts/provision`, `/login`, `/return` | Test accounts are unavailable in production and require a development Clerk tenant. Provision attempts are limited to 3 per actor and workspace/5 minutes before calling Clerk; only the owner can provision fixed roles. Login and return each have 10 requests per user+IP/minute; issued Clerk sign-in tokens expire after 60 seconds. | Ticket redemption and replay semantics are delegated to Clerk; this application does not maintain a cross-process redemption ledger. Provisioning is not a production user-signup route. |
| Other workspace/admin/developer writes and account/profile creation | Authentication, ownership/scoped permissions, per-field validation, and for destructive operations confirmation/audit transactions; onboarding is idempotent. `/admin/claim` cannot self-grant access. | No generic write quota: limiting routine management or large onboarding batches uniformly would block legitimate work. Revisit specific endpoints if measured usage or incidents identify a costly path. |
| Paginated workspace, channel, DM and activity reads | Authentication/visibility checks and bounded collection pages or fixed recent snapshots; CSV export is listed above. | Fan-out workspace detail and sparse visibility scans are not independently rate-limited. Repeated authorized requests can still consume database capacity. |
| `POST /webhooks/resend` | Raw body capped at 64 KB; rejects missing/invalid signed webhook requests before processing; delivery event handling is idempotent. | External provider delivery, not a browser route. No IP-based throttle; signature verification remains the trust boundary. |

## Deployment boundary

The current API startup runs one Node server and keeps fixed-window counters
and WebSocket ticket/client maps in memory. There is no published deployment
configuration to inspect yet. Replit's [deployment-types
documentation](https://docs.replit.com/features/publishing/deployment-types)
states that Autoscale can add/remove instances and does not guarantee local
memory persistence or sticky routing. **These controls must not be described as
global rate limits or multi-instance WebSocket support.** Release 1 must either
run exactly one continuously available API process (including WebSocket
upgrades), or add shared ticket, rate-limit, and real-time delivery state and
verify multi-instance behavior before choosing an autoscaling topology. A
restart resets counters and drops outstanding tickets even with one process.
The limiter also caps tracked keys at 10,000 per process; at that cap, a new
actor's requests may be denied until a window expires.

## Focused evidence

- `src/lib/fixed-window-limiter.test.ts` checks threshold, retry interval,
  expiration, hard key cap, and actor/workspace isolation.
- `src/lib/ws.test.ts` checks one-time ticket consumption, expiry boundary, and
  bounded expired-ticket cleanup.
- `src/admin.test.ts` sends only invalid invitations, nonexistent-resource
  provisioning/message attempts, and ticket requests against a disposable
  database and test identities. It checks shared invitation-route budget,
  message-route budget, `429`/`Retry-After`, distinct tickets, and unaffected
  actors/workspaces. No invitation emails, real test-account provisioning, or
  storage objects are created by that regression.

These are application-level checks, not a load test or a test of multiple API
replicas, provider email limits, or provider upload limits.