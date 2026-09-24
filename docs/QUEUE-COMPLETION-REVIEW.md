# Queue completion review — 2026-09-24

Reviewed all 56 active/ready/draft items. Ten are verified complete against the main workspace and recorded prior test runs. Task states were NOT changed: available task controls allow description edits, but not removal/archive of arbitrary existing tasks. Ten completed-task descriptions now contain verification notes. Other task descriptions were left untouched.

No application code, production data, or isolated task-agent work was changed. No new tests were run for this review; recorded successful executions and current regression code were inspected.

## Verified complete — removal candidates

- #23 — Catch type and build regressions before merges
- #138 — Keep chat connected through network interruptions
- #159 — Catch role revocation races before a privileged assignment commits
- #160 — Make fresh CI database setup run without an interactive prompt
- #170 — Keep deleted-room recovery usable when the room list cannot refresh
- #174 — Restore broken administrator routes before they cause data loss
- #176 — Show a clear error when a username is already taken
- #179 — Keep existing chat regression checks reliable
- #182 — Restore administrator controls blocked by broken API routes
- #187 — Keep release history restricted to developer accounts

## Full review

### #23 — Catch type and build regressions before merges

COMPLETE. `.github/workflows/ci.yml:13-35` release-validation uses Node 24 and `pnpm install --frozen-lockfile`; `package.json:8,13,20` covers repo typecheck/build plus API/web checks, with no development/preview DB dependency. API job independently typechecks/builds at `.github/workflows/ci.yml:109-116`. Verified API build and CI checks passed.

### #124 — Notify managers when business reports are ready

OPEN. `artifacts/api-server/src/lib/notifications.ts` and `notification-center.tsx` only define/render the Reports category; no report creation/completion/failure producer or report-history action URL exists. Manager targeting, sanitized failure text, and workspace-isolation report tests are unmet.

### #126 — Keep busy chat rooms responsive as history grows

PARTIAL. Message history is bounded server-side (`artifacts/api-server/src/routes/irc.ts:1054,1090`) and web tests cover room recovery (`artifacts/web-irc/src/App.test.tsx:813-841`), but loaded history is still rendered directly in `App.tsx`; no virtualization/bounded rendering while switching rooms or repeatable large-history performance check. Realtime visibility/older-history behavior is not enough for COMPLETE.

### #133 — Preserve third-party notices in release artifacts

PARTIAL. Inventory/compliance docs and license validation exist (`docs/DEPENDENCY-INVENTORY.md`, `docs/LICENSE-COMPLIANCE.md`, `scripts/check-third-party-licenses.mjs`), and MPL-2.0 is recognized, but no generated production-dependency notice bundle, preserved Lightning CSS source-availability text, release-doc bundle link, or CI artifact verification is present.

### #136 — Prevent shared images from appearing twice after upload

PARTIAL. Reconciliation implementation/tests exist (`artifacts/web-irc/src/message-state.ts`, `message-state.test.ts`) and full web suite passed, but no App-level regression demonstrates both realtime-before-upload and realtime-after-upload ordering for image messages, one visible message, and attachment update rather than append. Existing upload tests (`App.test.tsx:1009-1025`) cover failure/no placeholder, not this acceptance matrix.

### #137 — Keep notification clicks inside the signed-in workspace

PARTIAL. App regression `keeps notification navigation inside the signed-in workspace` (`artifacts/web-irc/src/App.test.tsx:956-978`) covers read/navigation and `notification-center.tsx:76-105,157` uses in-app navigation. Missing explicit test for preserving signed-in session/chat state after navigation and explicit no-action-URL click staying put; therefore not all stated criteria are proven.

### #138 — Keep chat connected through network interruptions

COMPLETE. Fresh ticket/reconnect/bounded-backoff/resubscribe tests are in `App.test.tsx:899-954`, active-room history refresh/replacement at `:813-841`, DM refresh/dedup at `:847-897`, typing throttling at `:757-801`, and API oversized/malformed realtime frame coverage in `artifacts/api-server/src/admin.test.ts:4885-4960`. Full web 50/50 and API 120/120 passed. All four criteria are covered.

### #139 — Prevent failed uploads from leaving blank chat messages

PARTIAL. `App.tsx` cleanup path exists and full web suite passed; `App.test.tsx:1009-1025` covers a failed upload with no misleading placeholder. It does not separately exercise storage URL failure, failed PUT, and failed attachment registration while asserting deletion of an already-created placeholder plus original error visibility, so the explicit three-failure-path acceptance is unmet.

### #141 — Keep the newest message visible in every DM thread

PARTIAL. Latest-per-thread query and peer filtering are implemented (`artifacts/api-server/src/routes/irc.ts:1730-1764`), and API suite passed, but no focused test evidence covers all four requested cases together: once-per-conversation newest preview, inaccessible peer omission, and empty/malformed keys. Existing DM coverage is not equivalent to this exact regression contract.

### #142 — Keep unread notifications current across open sessions

PARTIAL. Authenticated broadcasts/dedup helper exist (`artifacts/api-server/src/lib/notifications.ts:52-100`); web test `applies notification read updates received from another session` is `App.test.tsx:980-1007`, and API suite passed. Missing focused proof of newly-created immediate delivery, other-user exclusion, reconnect/HTTP-refresh deduplication, and unread indicator change without reopening panel.

### #143 — Keep development CI checks aligned with the current code

OPEN. Acceptance concerns GitHub development-branch transport synchronization and post-update CI. No evidence in the current repository proves development workflow matches local workflow or development CI succeeded; local CI YAML alone cannot satisfy those branch/remote requirements.

### #144 — Preserve audit history without risking existing data

PARTIAL. Audit preservation is implemented/tested (`artifacts/api-server/src/admin.test.ts:2552+`; migration docs `docs/DATABASE-MIGRATIONS.md:35-64`), and supplied fresh PG16 plus PG14/15 real-schema checks passed. Still unmet: the task explicitly requires production catalog/orphan inspection and a verified production migration baseline, which repository tests/fixture rehearsal cannot establish.

### #145 — Prove one workspace can never use another workspace's resource IDs

OPEN. Existing authorization tests do not constitute the requested comprehensive negative authenticated API matrix for tasks, documents, attachments, employees, organization resources, invitations, categories, announcements, policies, and role scopes across two valid workspaces, including reads and writes.

### #146 — Keep large business workspaces responsive as records grow

PARTIAL. Several endpoints have bounded limits and schema query-path indexes (`artifacts/api-server/src/routes/*.ts`, `lib/db/migrations/0012_query_path_indexes.sql`), and real-schema checks passed. Acceptance still lacks bounded pagination/stable ordering/max-page-size verification across every listed notifications/employees/tasks/documents/invitations/moderation/audit endpoint and frontend behavior proof.

### #147 — Prove owner deletions stay safe during simultaneous admin changes

PARTIAL. Concurrency/lifecycle coverage exists (`artifacts/api-server/src/lib/destructive-lifecycle.integration.test.ts:72+`) and object cleanup retry logic is tested by the API suite; supplied PG16 integration execution passed. No complete evidence covers every stated race (ownership transfer, invitation acceptance, worker retry), Clerk failure/retry completion ordering, and cleanup retry in one acceptance suite.

### #148 — Confirm test accounts can always return to the owner on mobile

PARTIAL. Return-context implementation and unit tests exist (`artifacts/web-irc/src/test-account-switch.ts`, `.test.ts`, `artifacts/api-server/src/routes/test-accounts.ts:141-147`), but no browser-level forced single-session mobile fallback + reload proves exact owner/workspace restoration, nor complete missing/expired/mismatched browser scenarios.

### #149 — Prove category deletion cannot leave half-deleted channels

PARTIAL. Transactional category/channel deletion and moderation rollback are tested, but the full requested relation-cleanup matrix (messages, memberships, requests, invitations, reactions and attachment jobs) is not established by the new test. Keep queued.

### #150 — Prove simultaneous document uploads always get distinct version numbers

PARTIAL. Schema uniqueness and version behavior are covered (`artifacts/api-server/src/lib/destructive-lifecycle.integration.test.ts:198-224`; `lib/db/src/schema/irc.ts`), with PG16/14/15 real-schema checks passing. Missing the required two concurrent authenticated version-upload requests and explicit sequential distinct-result/no-partial-write assertions.

### #151 — Keep channel delete controls aligned with actual permissions

PARTIAL. Permission-aware channel/category controls are present in `artifacts/web-irc/src/App.tsx`, and full web suite passed, but no clearly focused App tests proving endpoint selection, exact-owner-only bulk visibility, and explanatory non-owner administrator state. Implementation alone does not satisfy the requested owner/non-owner regression coverage.

### #152 — Let subscribers own more than one public community

PARTIAL. Upgrade request/approval and paid-slot enforcement exist in `artifacts/api-server/src/routes/community-upgrades.ts:55-234`; free-owner partial unique index remains in `lib/db/src/schema/irc.ts:68`. Unmet: actual billing-provider subscription/entitlement integration (UI explicitly says payment is external/manual at `artifacts/web-irc/src/App.tsx:3494`), safe downgrade behavior, and demonstrated entitlement-based multi-community/destination-selector acceptance.

### #156 — Start the deployed API only after migrations succeed

OPEN. `package.json:19` has guarded `release:start`, but `.replit` has no deployment run command wired to it and no documented release confirmation variables in deployment configuration. Unmet production deployment invocation; dev/test preservation is present but insufficient.

### #157 — Confirm release migrations work on every supported PostgreSQL version

PARTIAL. PostgreSQL 14.18 and 15.13 passed 30/30 database script checks, but the real-schema compatibility test deliberately skips migration rehearsal/no-op commands. Full reviewed SQL chain, second-run no-op and forced rollback on both versions remain outstanding.

### #158 — Remove the migration rehearsal's dependency on repository history

PARTIAL. Explicit checked-in rehearsal fixture is implemented and no Git history is needed at runtime. The requested documented fixture update process and intended-baseline drift detection are not established; retain until those criteria are verified.

### #159 — Catch role revocation races before a privileged assignment commits

COMPLETE. `artifacts/api-server/src/routes/communities.ts` locks authorization rows; `artifacts/api-server/src/admin.test.ts` includes `test("does not let revoked developer authority win a scoped-role assignment race")` (around 4617) and concurrent demotion/audit coverage around 3775. Verified API suite passed.

### #160 — Make fresh CI database setup run without an interactive prompt

COMPLETE. `lib/db/scripts/run-ci-tests.mjs:83-106` explicitly runs isolated schema setup/no-op stages; verified fresh PG16 `test:ci` rehearsal/bootstrap/no-op is green, with failure cleanup behavior covered by the DB scripts/tests.

### #161 — Keep moderation records from blocking administrator cleanup

OPEN. `lib/db/src/schema/irc.ts:652-664` still has required `moderationActionsTable.actorId` FK without `onDelete: "set null"`; no migration proving retained actor identity/administrator cleanup, and no requested regression test.

### #162 — Keep live channel views in sync with administrator topic edits

PARTIAL. `artifacts/api-server/src/routes/admin.ts:930` broadcasts updated channel state and `artifacts/api-server/src/admin.test.ts:891-994,5134-5177` covers topic update/rollback. Unmet test/confirmed behavior for a connected client receiving the update while unrelated channel subscribers are excluded.

### #163 — Confirm denied role changes stay out of admin activity history

PARTIAL. Role endpoints return 403 and broad denied-admin audit checks exist in `artifacts/api-server/src/admin.test.ts`; unmet complete before/after audit-row comparison covering all three requested operations: member role change, scoped-role assignment, custom-role creation.

### #164 — Prevent custom roles from being created without an audit record

PARTIAL. Custom role creation/auditing exists (`artifacts/api-server/src/routes/admin.ts`, `admin.test.ts:4162`), and forced role-audit failure coverage appears around `admin.test.ts:2440`. Unmet/uncertain: that failure test is role assignment rather than custom-role creation with permission links; no demonstrated custom-role+links atomic rollback and generic-error assertion.

### #165 — Reduce repeated session checks when users open multiple chat tabs

OPEN. `artifacts/api-server/src/lib/ws.ts:268-270` still creates a `setInterval` per client/socket. No per-Clerk-session scheduler or request-count/per-session isolation test in `artifacts/api-server/src/lib/ws.test.ts`.

### #166 — Show new admin activity without losing a manager’s place

PARTIAL. Cursor/actor/action filtering exists in `artifacts/api-server/src/routes/admin.ts:289-320` and App activity UI. Unmet newer-than-first-entry incremental fetch/merge that preserves loaded older pages; refresh still resets to newest page.

### #167 — Prevent scheduled cleanup credentials from reaching unrelated steps

PARTIAL. Existing validator/tests/fixtures (`artifacts/api-server/scripts/validate-scheduled-cleanup-workflow.mjs/.test.mjs`, `scripts/fixtures`, `.github/workflows/ci.yml`) validate approved env/commands. Unmet specific guard/fixture rejecting an unrelated step added to the credential-bearing job.

### #168 — Let administrators find activity from a specific time period

OPEN. `routes/admin.ts` supports actor/action/cursor only; no start/end query validation/predicates, App has no date controls, and no period integration test. (App copy mentions date-filtered history at `App.tsx:153`, but implementation is absent.)

### #169 — Catch invalid CI YAML before its workflow can load

OPEN. YAML validation is only inside `ci.yml` (`.github/workflows/ci.yml:53-54`, `package.json:11`); no independent `.github/workflows/validate-ci-workflow.yml`, so it cannot run if `ci.yml` is unparsable.

### #170 — Keep deleted-room recovery usable when the room list cannot refresh

COMPLETE. `artifacts/web-irc/src/App.tsx` has missing-room recovery, retry/error and empty/fallback rendering (around 1318); `App.test.tsx:384` deleted-room recovery suite and related unavailable-room tests cover actionable recovery. Verified full web 50/50.

### #171 — Confirm room membership recovers after a live connection drops

PARTIAL. `App.tsx:715-727` refreshes members on presence updates with current-room guard, and reconnect refreshes messages/channels (`App.tsx:832-838`). Unmet explicit reconnect-selected-room member refresh and a test simulating missed presence plus delayed stale response; existing reconnect tests focus messages.

### #172 — Give users a clear path when room access cannot be restored

PARTIAL. Recovery UI exposes retry/fallback (`App.tsx` room-empty/error rendering around 1318) and API join denial exists in `routes/irc.ts`; however no clear evidence/test that an automatic recovery join denial is surfaced or causes another accessible-room selection. `App.test.tsx` has unavailable-room tests but not the requested denied-join case.

### #174 — Restore broken administrator routes before they cause data loss

COMPLETE. Current `artifacts/api-server/src/routes/admin.ts` is syntactically/build valid; role assignment no longer uses clear-history/message deletion logic; clear-history requires confirmation, audits, and returns deleted count. `artifacts/api-server/src/admin.test.ts:5134-5229` covers topic/clear-history audit rollback and the verified API build/test suite passed.

### #175 — Prevent failed policy publishing from leaving notifications without an audit record

OPEN. `artifacts/api-server/src/routes/communities.ts:2249-2279` still inserts policy, creates notifications, then writes audit as separate operations; no transaction, post-commit event gating, or failure/clean-retry regression. Full API pass does not satisfy this absent test.

### #176 — Show a clear error when a username is already taken

COMPLETE. `irc.ts:388-417` catches unique violation and returns 409 `{error:"That username is already taken.",code:"USERNAME_TAKEN"}`; failed update cannot mutate other fields. `admin.test.ts:1160-1184`, test `returns a stable conflict when PATCH /me claims an existing username`, verifies 409/body and unchanged profile. Web conflict UI is covered at `App.test.tsx:695-710`.

### #177 — Prevent revoked channel moderators from sending stale invites

OPEN. `irc.ts:904-933` checks `isChannelOwnerOrModerator` before invite and notification writes, but does not lock/recheck authority in the same invite transaction. No test for already-revoked moderator or revocation racing invite creation.

### #178 — Confirm room deletion stays safe during a join approval

PARTIAL. Deletion transaction removes requests/membership at `irc.ts:2924-3012`; `admin.test.ts:7418+` (`removes pending private-room requests when the room is deleted`) verifies cleanup and stale approvals, and `7266+` verifies serialized approval vs membership revocation. Missing stated deterministic overlap specifically between pending approval and private-channel deletion, including proving no resulting membership from that overlap.

### #179 — Keep existing chat regression checks reliable

COMPLETE. Full verified web execution is 50/50 and includes all `artifacts/web-irc/src/App.test.tsx`; therefore the full App.test.tsx suite passes without external services. (Earlier claim that 50 checks was not equivalent was incorrect.)

### #180 — Confirm users stay online when overlapping tabs close out of order

OPEN. Existing `ws.test.ts:225` only checks in-memory client membership; `admin.test.ts:1290-1380` covers ordinary presence/revocation, but no delayed/reordered DB persistence race test with final stored online then offline state. Current uncommitted `ws.test.ts` additions are channel-list invalidation tests, not presence.

### #181 — Prevent private-room requests from getting stuck when the last reviewer is removed

OPEN. `irc.ts:1655-1662` kick/ban directly delete membership (ban also inserts ban), with no last-owner/moderator handoff or atomic restriction. No test that kicking/banning the final reviewer preserves future request reviewability.

### #182 — Restore administrator controls blocked by broken API routes

COMPLETE. Current MAIN route is syntactically repaired (`artifacts/api-server/src/routes/admin.ts`), and verified API 120/120 includes typecheck/build and affected integration coverage. Fresh PG16 rehearsal/bootstrap/no-op and PG14/15 real-schema script checks (30/30) also pass. No stated criterion remains unmet.

### #184 — Confirm employees see task updates without reloading

PARTIAL. `communities.ts:1200-1240` persists task notifications and `admin.test.ts:5800` (`notifies employees when workspace tasks are assigned or changed`) verifies assignment/status/reassignment rows. Missing live online delivery assertion, exactly-once inbox behavior, matching task-link navigation, and reconnect/reload deduplication.

### #185 — Email workspace invitations directly to new employees

OPEN. `communities.ts:1805-1891` only persists invitation and returns in-app `invitationToken`; no configured transactional-provider send, safe delivery-failure response, or email path. `App.tsx` provides in-app link fallback only.

### #186 — Keep organization changes current for every manager viewing the directory

OPEN. No bounded workspace-scoped organization-change broadcast/refresh or cross-session workspace-isolation test found in `communities.ts`, `ws.ts`, `App.tsx`, or `App.test.tsx`.

### #187 — Keep release history restricted to developer accounts

COMPLETE. `developer.ts` enforces developer access; `admin.test.ts:1643-1686` (`denies every release endpoint to the actor's current non-developer role without side effects`) covers regular signed-in denial, while `1688+` retains successful owner/developer coverage.

### #188 — Keep workspace lists fast for large organizations

PARTIAL. Batching/visibility correctness exists (`admin.test.ts:3992`, `keeps private workspace lists and management flags consistent with individual permissions`; implementation in `permissions.ts`/community routes). Missing repeatable large mixed-role scale fixture, bounded query-count assertion as workspace count grows, and scaled response verification.

### #189 — Let managers export saved reports for offline review

OPEN (PROPOSED). No saved-report download/export endpoint or OpenAPI/UI export control found in the relevant files; all export requirements unmet.

### #190 — Deliver message alerts after temporary notification failures

OPEN. `admin.test.ts:8452` (`keeps channel and direct messages committed when notifications fail`) only proves sends do not fail. No durable notification intent/delivery-state schema, safe retry/idempotency mechanism, or operator-visible permanent-failure path.

### #191 — Resolve unclassified dependency licenses blocking release approval

OPEN. `scripts/check-third-party-licenses.mjs:1-52` still rejects `Unknown`; inventory path (`scripts/generate-dependency-inventory.mjs:221-223,265+`) still reports unknown/unverified records. No authoritative evidence/classification for the four named packages, attribution-preserving approval, or passing license validation is present.

### #192 — Close remaining cross-workspace access verification gaps

PARTIAL. Extensive current negative/scoping coverage includes task organization refs (`admin.test.ts:6015`), categories/channels (`6090-6346`), assignments (`6605+`), private access (`6902+`), and invitation-related route checks. The requested exhaustive endpoint-by-endpoint reconciliation still lacks clearly identified negative read/write coverage for all document/version, invitation, policy/announcement, and organization relationship paths; audit status document is evidence inventory, not proof every resource class is closed.

### #193 — Keep large workspace lists bounded without hiding records

OPEN. Existing pagination test coverage is for admin activity (`admin.test.ts:2134+`), not broad workspace-detail collections. No bounded stable pagination/load-more implementation and large-collection ordering/completeness tests for the requested workspace lists; unmet criteria remain.
