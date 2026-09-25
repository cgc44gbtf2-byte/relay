# Release 1 audit status

Reviewed: 2026-09-24. This is a reconciliation of the original audit-fix
checklist, not a production-readiness sign-off.

## Verification evidence

- Collection-pagination verification: 83/83 frontend tests, 42/42 API unit tests,
  regenerated-library and both app typechecks passed. Seven selected authenticated
  tests passed on a disposable PostgreSQL 16 database, covering large workspace
  collections, admin directory/release pages, invalid inputs and tied ordering.
  Temporary database profiles and newly created Clerk users were confirmed cleaned
  up. This was a focused run, not a rerun of the full authenticated suite.
- PostgreSQL 16: the most recent complete authenticated CI run passed 120/120
  integration tests, migration rehearsal, fresh-schema bootstrap, strict no-op
  validation, and scheduled test-user cleanup.
- PostgreSQL 14.18, 15.13 and 16.10: each passed all 30 database-script
  compatibility tests with no skips. The matrix now executes the reviewed
  migration chain, migration no-op check, forced-failure rollback, fresh-schema
  bootstrap, strict schema no-op check, isolation and cleanup on each version.
  Authenticated API execution is deliberately stubbed in this compatibility job.
- The subsequent scoped WebSocket invalidation change passed API typechecking
  and 32/32 API unit tests. The full authenticated suite was not rerun for that
  change.
- Most recent frontend verification: 50/50 tests, typecheck, and production build
  passed. A large JavaScript chunk warning remains.
- CI YAML, concurrency/version-policy tests, and scheduled-cleanup configuration
  checks passed locally. Local checks do not establish a green hosted CI run.
- Temporary test databases and regression users were cleaned up. No production
  data was modified or production migrations applied.
- Query/index justification is recorded in
  `docs/RELEASE-1-QUERY-INDEX-JUSTIFICATION.md`. The review found that the
  policy-acknowledgement user index from migration 0012 lacked its matching
  Drizzle declaration; that declaration is restored. An additive message
  creation-time index now supports the global recent-message overview query.
  Speculative indexes remain deferred until an observed query and representative
  plan justify their cost.
- After these changes, library/API typechecks and database migration tests
  passed; both disposable PostgreSQL 16 runs passed migration rehearsal, fresh
  schema setup, and the strict no-op check. The authenticated API suite was not
  consistently green: the first run had one notification-delivery assertion
  failure (171/172), and the second had separate email-verification and
  WebSocket-handshake failures (170/172). No production database was used.
- Local tenant-access reconciliation used an isolated PostgreSQL 16 database:
  the two-workspace read/write substitution test and the targeted/scheduled
  announcement test passed. The full `admin.test.ts` run passed 107/114 tests
  before the final attachment audience guard was added; its focused regression
  was rerun and passed after the guard. Seven other tests failed (upgrade
  alerts, subscription status, two activity
  pagination assertions, private workspace list setup, private-room naming,
  and document pagination fixture). This is **not** a green full-suite result.
  API typechecking passed.
- After review, a second focused regression on the disposable database passed
  for inactive team membership and removed workspace membership, including
  activation through both announcement routes; API typechecking passed again.

## Implemented safeguards and evidence locations

| Area | Evidence | Remaining qualification |
| --- | --- | --- |
| Tenant authorization | Endpoint/access-chain matrix in `docs/RELEASE-1-TENANT-ACCESS-MATRIX.md`; two-workspace positive/negative integration matrix and same-workspace announcement audience regression in `artifacts/api-server/src/admin.test.ts`; scoped channel helper in `src/lib/channel-access.ts` | Does not establish exhaustive realtime event-class or storage-provider isolation. |
| WebSocket event privacy | `src/lib/ws.ts`, `src/lib/ws.test.ts`: subscriber-only deletion; access-checked channel-list invalidation; bounded, per-user authorization checks | Complete event-class and real multi-workspace delivery matrix is not yet established. Invalidation unit tests inject access decisions. |
| Roles and destructive operations | Integration tests for revocation races, denied-operation audit absence, moderation records, and forced audit-write rollback | Does not prove every mutation and failure path. |
| Database integrity and migrations | `lib/db/migrations`, `docs/DATABASE-MIGRATIONS.md`, rehearsal/bootstrap tests | Production baseline/application and recovery remain an operational verification step. |
| Audit preservation | Actor snapshot/preservation migrations and integration tests | No blanket sign-off on every audit producer. |
| Storage | `src/routes/storage.ts`, storage unit tests, authenticated attachment/document tests | Exhaustive object-ID substitution and provider-level size/type enforcement remain to be reviewed. |
| Abuse protection | Fixed-window limiter and ticket-cleanup tests; route-specific limits | Full route inventory and multi-instance behavior remain unverified. |
| Data retention | `docs/DATA-RETENTION.md` | Strategy documented; no destructive retention job added. |
| Frontend recovery | `artifacts/web-irc/src/App.test.tsx`: room retry, reconnect, DM preservation, username conflicts, developer denial | Comprehensive keyboard/focus/accessibility and error-state review is still outstanding. |
| WebSocket event delivery | All current event emitters, subscription/session revocation, channel-list invalidation, and client handling; see `RELEASE-1-WEBSOCKET-AUDIT.md` | The employee-offboarding subscription leak is fixed; targeted delivery tests remain for moderation, DMs, notification-state changes, upgrade notices, and reconnect behavior. |
| Collection pagination | Workspace detail/list, IRC directories/search, admin collections and release archive now use bounded pages with deterministic ID tie-break ordering; frontend consumers traverse pages or offer workspace load-more | Offset traversal is not a database snapshot: concurrent insertion, removal or renaming can shift page boundaries. Nested resource details retain their existing contract. |

API source paths in the table are relative to `artifacts/api-server`.

## Outstanding audit scope

1. Tenant HTTP resource inventory and negative read/write matrix are recorded
   in `RELEASE-1-TENANT-ACCESS-MATRIX.md`. ID-only lookups were evaluated with
   their downstream checks; a same-workspace announcement audience gap was
   fixed in the global feed, announcement read/acknowledgement/attachment
   routes, and scheduled notification path.
2. Collection pagination inventory is recorded below. Continue to distinguish
   navigable collections from intentionally recent dashboard snapshots when
   adding endpoints; do not introduce a cap without a continuation path.
3. The WebSocket event review and confirmed offboarding fix are recorded in
   `RELEASE-1-WEBSOCKET-AUDIT.md`; add the remaining event-delivery tests listed
   there. Storage enforcement, abuse-control inventory, and accessibility
   verification are still open.
4. Run/document the available security/static-analysis checks and reconcile
   their findings; do not equate license checking with security analysis.
5. Resolve the separately queued unclassified dependency-license review.
6. Produce the original checklist's final per-fix report and confirm hosted CI
   and production migration readiness before release approval.

## Collection-read inventory

All paths below are relative to `/api`. Existing array/object shapes are retained.
Collection ordering includes a unique tie-breaker. Newly paged collection reads
validate limits/offsets and bound database page sizes to at most 100 rows.

| Collection | Pagination and frontend behavior |
| --- | --- |
| `/communities` | Stable name/ID candidate pages; `X-Has-More` and `X-Next-Offset` advance through private/inaccessible candidates as well as visible rows. Workspace picker follows headers, including empty visible pages. |
| `/communities/:id` | Independently paged employees, invitations, tasks, channels, categories, assignments, departments, locations, teams, policies and announcements. Named limits/offsets and per-collection metadata drive the existing load-more control. Announcements retain a 20-row initial default but now have continuation. Visibility is applied before announcement/channel page boundaries. |
| Workspace documents/folders, activity, moderation logs | Existing bounded pages and load-more behavior retained. Related records are restricted to returned resource IDs. |
| `/channels`, `/categories` | Bounded database scans with existing permission checks; visible-row offsets and continuation headers. Chat bootstrap and refresh traverse all pages. |
| Channel members/join requests | Existing bounded pages and continuation-header consumers retained. |
| Channel public-space destinations | Eligible owner-managed destinations are filtered before bounded name/ID pages; the move selector follows continuation headers. |
| `/dm/threads`, `/announcements`, `/users/search`, `/search/messages` | Bounded, deterministically ordered pages with continuation headers. Existing in-app search callers follow pages rather than treating the first cap as the complete result. |
| `/notifications` | Existing header pagination and notification load-more retained; notification behavior is tracked separately. |
| `/admin/overview` channels/categories | Separate bounded offsets and `collectionPagination`; both overview consumers traverse remaining pages. Activity retains its existing filtered pagination. |
| `/admin/users`, `/admin/role-assignments` | Validated limit/offset pages; account and role-management consumers fetch batches until exhausted. |
| `/admin/scope-options`, `/admin/custom-roles` | Bounded selectable-resource/role pages; selectors assemble all pages. Role permission links are restricted to selected roles; the fixed permission catalog is not paginated. |
| `/developer/releases` | Bounded release archive with created-time/ID ordering; both studio consumers fetch all batches. |

Intentional snapshots are unchanged: admin overview's newest 50 accounts and 12
messages, workspace dashboard's recent items, onboarding state, and fixed
permission catalogs. The full account directory remains separately navigable.
Chat message history/rendering is separate active work and was not changed here.
Nested single-resource data (task comments/attachments, document versions and
permissions, team memberships) retains existing response semantics, rather than
silently truncating children. Workspace summary mode already omits task child
payloads in favor of task detail reads.

Regression evidence is in `src/admin.test.ts`,
`src/lib/visible-list-page.test.ts` (API) and `src/App.test.tsx` (web):
large collections, ordering across boundaries, invalid page inputs,
permission-filtered scans, independent workspace offsets, and explicit failure
instead of a partial result when a later request fails.

No Release 2 feature work is included.
