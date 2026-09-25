# Release 1 query and index justification

Reviewed: 2026-09-24.

This reconciles the high-value index candidates in section 4 of
`attached_assets/relay-technical-product-audit-2026-09-23.md` with the current
Drizzle schema, migration history, and observed API query shapes. It is a
structural review, not a measured performance report: no production data or
production query plans were inspected.

| Candidate | Current support and observed query | Decision |
| --- | --- | --- |
| Team membership by user | `irc_team_members_user_idx`; account cleanup deletes team memberships by `user_id`. | Keep. The primary key begins with `team_id`, so the reverse index serves a distinct lookup. |
| Employee profile user, department, location, and manager lookups | Primary key `(community_id, user_id)`, indexes on `(community_id, department_id)`, `(community_id, location_id)`, and `manager_id`. | Keep. Tenant-scoped user lookups use the primary key; assignment and manager updates have matching indexes. |
| Policy and document acknowledgements/downloads by user | `irc_policy_acknowledgements_user_idx`, `irc_document_acknowledgements_user_idx`, and `irc_document_downloads_user_idx` support member-removal queries constrained by user and resource IDs. The policy index existed in migration `0012` but was missing from the Drizzle declaration; the declaration is now restored. | Keep and keep schema/migration definitions paired. |
| Announcement read receipts and acknowledgements by user | Both tables use primary key `(announcement_id, user_id)`. The workspace-detail response filters by both fields. Member removal does not scan these tables by user, and account deletion retains the user row and its history. | Do not add a user-leading index without a new query that needs it; it would add write and storage cost without matching a current lookup. |
| Reverse block lookup | `irc_blocks_blocked_idx` supports `blocked_id` lookups; the primary key covers the other direction. | Keep. |
| Channel join requests by channel and status | `irc_channel_join_requests_channel_status_idx` covers moderation queues; the existing user/status index serves user-scoped checks. | Keep. |
| Notification feed and unread state | The feed filters by user, deletion state, and active/archive state, then orders by creation time and ID. Partial active and archived page indexes match those predicates. Read state is not a SQL filter in the feed route. | Keep the partial page indexes. Do not add a `read_at` index until the server query filters by it and a representative plan supports the change. |
| Moderation history by community, channel, or actor | Community/date/ID, channel/date, and actor/date indexes match the observed history reads. | Keep. Avoid extra combined indexes without a distinct query and plan evidence; this append-only table pays index cost on every insert. |
| Global and filtered admin activity | `(created_at, id)` supports the global cursor. Community/action/date and community/actor/date indexes support scoped reads. Actor/action text filters use leading-wildcard `ILIKE`, which these btree indexes do not accelerate. | Keep the ordering and scoped indexes. Defer a trigram or other search index until representative search plans justify its write and storage cost. |
| Global recent messages | The admin overview orders all messages by `created_at` and returns the newest 12. Channel-, sender-, and recipient-leading indexes cannot provide that global order. | Add `irc_messages_created_idx` on `created_at` in migration `0028`; this gives the high-growth message table a direct path for its fixed global recent-message snapshot. |
| Assigned task deadlines | `irc_workspace_tasks_assignee_status_due_idx` matches the assignee, status, and due-date scan. | Keep. |
| Invitation status and expiry | Current reads use the unique token hash, community/email/status for deduplication, or community/created-time for listing; no pending-expiry scan was found. | Do not add a status/expiry index without an actual cleanup or query path and plan evidence. |
| Developer release status/date | The archive orders by creation time and status changes use the primary key. No status-filtered list query was found, and collection volume has not been measured. | Defer a status/date index; evaluate a creation-time page index if representative plans show the bounded archive read needs it. |

Migration `0018` intentionally drops the older broad notification visibility
index from `0012` and replaces it with separate active and archived partial page
indexes. That historical index is not a missing Drizzle declaration.

The only new index is the global recent-message index for the observed admin
overview query. Revisit deferred candidates when their SQL query shapes change
or representative data is available for `EXPLAIN (ANALYZE, BUFFERS)`.