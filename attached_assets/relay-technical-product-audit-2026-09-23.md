# Relay Complete Technical and Product Audit

**Audit date:** September 23, 2026  
**Mode:** Read-only information gathering  
**Application changes:** None

## Method and limitations

This audit inspected the current repository structure, React application, Express routes, WebSocket implementation, Drizzle schema, package manifests, CI configuration, tests, and configured workflows. It also ran Replit dependency, static-analysis, and privacy/dataflow scanners. No database mutations, code edits, refactors, optimizations, or destructive tests were performed.

The current environment cannot provide a disposable TEST_DATABASE_URL, so database-backed integration tests were not rerun. Web typecheck, 28 web tests, production build, workflow restart, logs, and preview had passed immediately before this audit. Claims requiring a live production deployment, production database, or real multi-user load are marked unverified.

Status vocabulary:
- **IMPLEMENTED:** Direct code evidence exists.
- **PARTIALLY IMPLEMENTED:** A usable implementation exists but important workflow, scale, safety, or UX pieces are incomplete.
- **DOCUMENTED BUT NOT VERIFIED:** Documentation or configuration claims it, but this audit could not prove it at runtime.
- **MISSING:** No meaningful implementation was found.

# 1. Executive Summary

Relay is an implemented operations-aware business communication platform, not a prototype and not merely an IRC client. The codebase combines realtime channels and direct messages with workspace membership, employee and organization structure, tasks, documents, policies, announcements, notifications, audit activity, scoped roles, platform administration, and a developer release surface.

The strongest foundations are:
- Real Clerk-authenticated React and Express applications.
- A substantial PostgreSQL/Drizzle domain model.
- Server-authoritative message, reaction, moderation, and notification writes.
- Private-channel checks and short-lived single-use WebSocket tickets.
- Broad workspace operations functionality in one product.
- Recent client reliability coverage for reconnects, stale rooms, delayed responses, typing traffic, searches, pagination, joins, uploads, and creation failures.

The principal Release 1 risks are:
1. **HIGH:** Channel-deletion WebSocket events are broadcast to every connected user, leaking channel IDs and deletion timing across authorization boundaries.
2. **HIGH:** Several channel and workspace queries load global/all-row datasets and filter authorization in application memory, creating isolation and growth risk.
3. **HIGH:** Tenant integrity is not consistently enforced by foreign keys or composite tenant relationships.
4. **HIGH:** WebSocket tickets, clients, subscriptions, and broadcasts are process-local; horizontal scaling is not supported.
5. **HIGH:** Release safety lacks versioned database migrations and complete CI gates for the frontend/root build.
6. **HIGH:** Credentialed CORS reflects origins broadly and should be restricted before production exposure.
7. **HIGH:** Large append-only datasets lack a documented retention, archive, or partition strategy.
8. **MEDIUM:** The frontend is concentrated in a roughly 3,000-line App.tsx with eager routes and inconsistent error/accessibility patterns.

Automated scanners found **0 critical, 0 high, 0 moderate, 0 low** dependency vulnerabilities, no SAST findings, and no HoundDog privacy/dataflow findings. These are positive signals, but they do not negate manual architectural or authorization findings.

**Overall Release 1 assessment:** Not release-ready for broad business deployment without addressing the high-priority isolation, realtime, CORS, migration, and release-gate issues. Suitable for continued controlled development and small pilot environments after explicit risk acceptance.

# 2. Verified Feature Inventory

| Capability | Status | Evidence / qualification |
|---|---|---|
| Business workspaces | IMPLEMENTED | Community/workspace schema and routes; workspace list, creation, dashboard, activity, ownership and management UI. |
| Employee directory | IMPLEMENTED | Employee profiles and organization routes/UI. Scale and lifecycle depth remain limited. |
| Departments | IMPLEMENTED | Schema, create/update organization APIs, UI. |
| Locations | IMPLEMENTED | Schema, create/update organization APIs, UI. |
| Teams | IMPLEMENTED | Schema, membership APIs, UI. Manager assignment workflow remains incomplete. |
| Employee invitations | PARTIALLY IMPLEMENTED | Create, accept, resend, token hash and expiry exist. A comprehensive invitation lifecycle/status screen is not evident. |
| Employee status/offboarding | PARTIALLY IMPLEMENTED | Employee/account status mutations exist; lifecycle UX and reporting are incomplete. |
| Manager relationships | PARTIALLY IMPLEMENTED | Manager fields exist on employees/teams/departments/locations, but complete manager assignment and governance UX is incomplete. |
| Workspace roles | IMPLEMENTED | Built-in/scoped assignments and enforcement helpers exist. |
| Custom permissions | PARTIALLY IMPLEMENTED | Permission catalog, custom roles, and scoped assignments exist; management UX and scope-integrity guarantees need hardening. |
| Channels | IMPLEMENTED | Public/private/invite/password channels, joins, requests, moderation, history, reactions and attachments. |
| Direct messaging | IMPLEMENTED | Threads, history, pagination, sending and blocks. |
| Realtime WebSockets | IMPLEMENTED | Authenticated subscriptions and events. Process-local scaling and some fanout/scoping issues remain. |
| Tasks | PARTIALLY IMPLEMENTED | CRUD, comments, attachments, assignments and dashboard counts exist. Pagination, dedicated detail workflows, notification depth and large-workspace UX are incomplete. |
| Announcements | IMPLEMENTED | Workspace and platform announcements, targeting, receipts/acknowledgments and attachments. |
| Policies | PARTIALLY IMPLEMENTED | Policy creation and acknowledgment exist; full policy lifecycle/version/current-policy UX is limited. |
| Documents | IMPLEMENTED | Folders, versions, permissions, acknowledgments, downloads and storage integration. Tenant integrity and large-list UX need hardening. |
| Notifications | IMPLEMENTED | Persistent list, read status and realtime fanout. Retention/unread indexing and fanout scale need work. |
| Business dashboard | IMPLEMENTED | Aggregate operational dashboard exists. Query cost at scale is a concern. |
| Audit/activity center | IMPLEMENTED | Activity views, filters and pagination exist. Audit retention and indexes need hardening. |
| Reports/analytics | MISSING | Dashboard summaries are not a generalized report builder, analytics system, or export surface. |
| Search | PARTIALLY IMPLEMENTED | User, message and document searches exist separately. No generalized workspace-wide search. |
| File management | IMPLEMENTED | App Storage upload URLs and attachment/document records exist. Resource-bound upload authorization needs review. |
| Moderation | PARTIALLY IMPLEMENTED | Channel moderation and logs exist; business-wide review/appeal/flag workflow is not evident. |
| Workspace management | PARTIALLY IMPLEMENTED | Creation, org CRUD, invitations, roles and ownership transfer exist; comprehensive settings and lifecycle UX are incomplete. |
| Platform administration | IMPLEMENTED | Status, health, users, roles, channels, audit and announcement tools exist. |
| Developer Studio | IMPLEMENTED | Settings and release workflow UI/API exist. Production delivery semantics were not runtime-verified. |
| PostgreSQL persistence | IMPLEMENTED | Drizzle PostgreSQL schema and query usage are extensive. |
| Object storage | IMPLEMENTED | Signed upload and object-path flows exist. Runtime production configuration was not verified. |

# 3. Architecture

## Repository and applications

Relay is a pnpm monorepo discovered through pnpm-workspace.yaml:
- artifacts/api-server — Express API and WebSocket server.
- artifacts/web-irc — React 19, TypeScript, Vite, Tailwind web application.
- artifacts/mockup-sandbox — isolated component preview artifact.
- lib/db — Drizzle database client and schema.
- lib/api-spec — OpenAPI source.
- lib/api-zod — generated validation types.
- lib/api-client-react — generated React client.
- scripts — dependency, license, CI and maintenance scripts.

Primary entry points:
- API: artifacts/api-server/src/index.ts creates HTTP server and attaches WebSocket hub.
- API middleware/routes: artifacts/api-server/src/app.ts.
- Frontend: artifacts/web-irc/src/main.tsx and App.tsx.
- Database: lib/db/src/index.ts and lib/db/src/schema/irc.ts.

## Authentication architecture

Clerk middleware runs globally. Protected routes use requireAuth, map the Clerk subject to users.clerkId, reject locally suspended accounts, and create a local profile when needed. The current Clerk instance is Replit-managed. Development and production Clerk user stores are separate; the development-key warning seen in preview is expected.

## REST request flow

User → React native fetch wrapper → /api route → Clerk middleware → requireAuth → role/workspace/channel authorization helper → Drizzle/PostgreSQL → response → local React state.

Validation is largely manual and route-specific rather than consistently generated/shared Zod parsing, despite generated API Zod packages existing.

## WebSocket flow

User → GET /api/ws-ticket with Clerk session → single-use 60-second ticket → /ws upgrade → Clerk user/session/account revalidation → in-memory connection/subscription maps → authorized channel subscribe → server-authoritative events from HTTP mutations → subscribed clients.

## Storage flow

Authenticated client → signed upload URL request → App Storage upload → application endpoint records object path and metadata. File bytes are not stored in PostgreSQL.

## Configuration and environment names

Observed names include DATABASE_URL, TEST_DATABASE_URL, CI_TEST_DATABASE_ADMIN_URL, CI_TEST_DATABASE_URL_FILE, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, VITE_CLERK_PUBLISHABLE_KEY, PORT, BASE_PATH, REPL_ID, PRIVATE_OBJECT_DIR, LOG_LEVEL, and TEAM_NOTIFICATION_WEBHOOK_URL. Values were not accessed. README mentions SESSION_SECRET, but no runtime use was found.

## Build/deployment

The root build performs typechecks and recursive builds. API uses an esbuild script; web uses Vite. Replit managed workflows serve the API, web app, and preview sandbox. No Dockerfile or versioned database migration directory was found. Database changes use Drizzle push rather than a migration history.

## Architecture debt

- App.tsx is about 3,000 lines and contains many product surfaces.
- Generated contract packages exist, but route validation remains substantially ad hoc.
- WebSocket state is process-local.
- No versioned migration/rollback chain.
- Frontend tests/build are not clearly enforced by the current GitHub CI workflow.
- CORS uses broad reflected origins with credentials.
- Documentation and environment names are not fully synchronized.

# 4. Database Audit

## Entity inventory

The Drizzle schema contains 31 entities in lib/db/src/schema/irc.ts:

1. users — Clerk ID primary key; unique username; partial unique platform admin.
2. communities — serial key; owner FK; unique slug; partial unique free owner.
3. permissionDefinitions — serial key; unique permission key.
4. customRoles — text key; creator FK.
5. rolePermissions — composite role/permission key; role is not FK-bound to customRoles.
6. userRoles — scoped assignment with nullable community/category/channel references and a composite uniqueness constraint.
7. communityMembers — composite community/user key.
8. departments — community and optional manager.
9. locations — community and optional manager.
10. teams — community, optional department/location/manager.
11. teamMembers — composite team/user key.
12. employeeProfiles — composite community/user key with department/location/manager.
13. workspaceInvitations — token hash, expiry, status and optional org assignments.
14. workspacePolicies — community policy records.
15. policyAcknowledgements — composite policy/user key.
16. documentFolders — community folders; parentId lacks a self-FK.
17. businessDocuments — community/folder/owner/visibility metadata.
18. documentVersions — document versions; document/version is indexed but not unique.
19. documentPermissions — composite document/user permission.
20. documentAcknowledgements — composite document/user acknowledgment.
21. documentDownloads — append-only download records.
22. workspaceTasks — assignments, status, due dates and org targeting.
23. taskComments — append-only task comments.
24. taskAttachments — task attachment metadata.
25. channels — optional community/category, owner, privacy/invite/password metadata.
26. categories — owner/community grouping.
27. channelMembers — composite channel/user membership.
28. channelBans — composite channel/user ban.
29. channelJoinRequests — status and uniqueness by channel/user.
30. channelInvites — composite channel/user invitation.
31. messages, plus related messageAttachments, reactions, blocks, notifications, announcements, announcement receipts/acks/attachments, moderationActions, adminAuditLogs, developerSettings and developerReleases. These are separately declared tables; the domain contains more physical tables than the 31 high-level entities counted by the schema review.

## Critical relationship findings

- userRoles.categoryId has no FK.
- channels.categoryId has no FK.
- documentFolders.parentId has no self-FK.
- messages.replyToId has no FK.
- rolePermissions.role has no FK to customRoles or a constrained built-in role set.
- Several relationships use globally unique integer IDs without composite community ownership constraints.
- PostgreSQL NULL uniqueness semantics can allow duplicate global/category-null channel names.
- documentVersions does not enforce unique version numbers per document.
- Deletion behavior mixes CASCADE, SET NULL and default RESTRICT without one coherent retention policy.
- adminAuditLogs.actorId cascades on account deletion, which can erase historical accountability.

## Missing or weak indexes

High-value candidates based on actual query patterns:
- teamMembers.userId.
- employeeProfiles user/department/location lookup paths.
- policy/document/announcement receipt user IDs.
- blocks.blockedId.
- channelJoinRequests channelId + status.
- notifications unread pattern such as userId + readAt + createdAt.
- moderationActions community/channel/actor/date.
- adminAuditLogs global createdAt and actor/action search strategy.
- tasks assignedTo + status + dueAt.
- invitation status + expiry.
- developer release status/date.

## Growth risk

Very high growth: messages, notifications, audit logs, moderation actions, document downloads, reactions, task comments/attachments, announcement receipts.  
Medium growth: tasks, documents/versions, channel members, invitations, role assignments.  
Lower growth: permission catalog, developer settings, departments, locations, teams, categories.

No partitioning, archive, or retention strategy was found for the largest append-only tables.

## Query risks

- visibleChannelIds loads channels and invokes authorization per row.
- canReadMessage can resolve channel data per message.
- deadline notification generation performs repeated existence checks and inserts.
- channels/categories/scope options/role assignments contain broad or unbounded reads.
- leading-wildcard ILIKE searches cannot use normal btree indexes effectively.
- global recent-message and audit ordering lack ideal leading indexes.

Positive evidence: message hydration batches senders, attachments and reactions with IN queries rather than a simple per-message N+1.

# 5. API Audit

All protected routes are mounted under /api and pass Clerk authentication plus the local suspended-account gate. The following is the verified endpoint inventory by route family.

## Public/session
- GET /healthz — public liveness.
- GET /app-config — public client configuration.
- GET /ws-ticket — authenticated short-lived WebSocket ticket.

## Profile, channel and social API
- GET /me; PATCH /me.
- GET /channels.
- GET /categories; POST /categories.
- POST /channels.
- POST /channels/:channelId/join.
- GET /channels/:channelId/join-requests.
- POST /channels/:channelId/join-requests/:requestId.
- POST /channels/:channelId/invites.
- POST /channels/:channelId/leave.
- GET /channels/:channelId/members.
- GET /channels/:channelId/messages.
- POST /channels/:channelId/messages.
- PATCH /channels/:channelId; DELETE /channels/:channelId.
- DELETE /messages/:messageId.
- POST /messages/:messageId/attachments.
- GET /attachments/:attachmentId.
- POST /messages/:messageId/reactions.
- DELETE /messages/:messageId/reactions/:emoji.
- POST /channels/:channelId/moderation.
- GET /users/search.
- POST /users/:userId/block; DELETE /users/:userId/block.
- GET /dm/threads.
- GET /dm/:userId/messages; POST /dm/:userId/messages.
- GET /search/messages.
- GET /notifications.
- GET /announcements.
- POST /notifications/:id/read.

## Workspace/business API
- GET /permissions/me; GET /permissions/catalog.
- GET /onboarding; POST /onboarding/:communityId/progress.
- GET /communities; POST /communities.
- GET /communities/:communityId.
- GET /communities/:communityId/dashboard.
- GET /communities/:communityId/activity.
- GET /communities/:communityId/tasks/:taskId.
- POST /communities/:communityId/tasks.
- PATCH /communities/:communityId/tasks/:taskId.
- POST /communities/:communityId/tasks/:taskId/comments.
- POST /communities/:communityId/tasks/:taskId/attachments.
- GET /communities/:communityId/tasks/:taskId/attachments/:attachmentId.
- POST /communities/:communityId/departments.
- POST /communities/:communityId/locations.
- POST /communities/:communityId/teams.
- PATCH /communities/:communityId/employees/:employeeId.
- PATCH /communities/:communityId/organization.
- PUT /communities/:communityId/teams/:teamId/members/:memberId.
- DELETE /communities/:communityId/teams/:teamId/members/:memberId.
- POST /communities/:communityId/invitations.
- POST /communities/:communityId/invitations/accept.
- POST /communities/:communityId/invitations/:invitationId/resend.
- POST /communities/:communityId/transfer-ownership.
- POST /communities/:communityId/policies.
- POST /communities/:communityId/policies/:policyId/acknowledge.
- GET /communities/:communityId/documents.
- POST /communities/:communityId/document-folders.
- POST /communities/:communityId/documents.
- POST /communities/:communityId/documents/:documentId/versions.
- POST /communities/:communityId/documents/:documentId/acknowledge.
- POST /communities/:communityId/documents/:documentId/permissions.
- GET /communities/:communityId/documents/:documentId/download.
- POST /communities/:communityId/categories.
- PATCH /communities/:communityId/categories/:categoryId.
- DELETE /communities/:communityId/categories/:categoryId.
- PATCH /communities/:communityId.
- POST /communities/:communityId/channels.
- DELETE /communities/:communityId/channels/:channelId.
- PATCH /communities/:communityId/members/:memberId/role.
- POST /communities/:communityId/announcements.
- DELETE /communities/:communityId/announcements/:announcementId.
- POST /communities/:communityId/announcements/:announcementId/read.
- POST /communities/:communityId/announcements/:announcementId/acknowledge.
- POST /communities/:communityId/announcements/:announcementId/attachments.
- GET /communities/:communityId/announcements/:announcementId/attachments/:attachmentId.
- GET /communities/:communityId/moderation-logs.

## Platform administration
- GET /admin/status; POST /admin/claim.
- GET /admin/health; GET /admin/overview.
- POST /admin/announcements.
- GET /admin/users.
- PATCH /admin/users/:userId/account-status.
- PATCH /admin/users/:userId/role.
- GET /admin/role-assignments.
- GET /admin/scope-options.
- GET /admin/custom-roles; POST /admin/custom-roles.
- POST /admin/role-assignments.
- DELETE /admin/role-assignments/:assignmentId.
- PATCH /admin/channels/:channelId.
- DELETE /admin/channels/:channelId/messages.

## Developer and storage
- GET /developer/settings; PATCH /developer/settings.
- GET /developer/releases; POST /developer/releases.
- PATCH /developer/releases/:releaseId/status.
- PATCH /developer/releases/:releaseId/announcement.
- POST /storage/uploads/request-url.

## API-wide concerns

- Numeric detached IDs are pervasive IDOR surfaces. Every child lookup must bind ID + parent community/channel + caller access.
- Request validation is often manual rather than one shared Zod/OpenAPI boundary.
- Pagination is inconsistent. Channel/member/category/scope lists and several business lists appear unbounded.
- Global user and message search require explicit visibility filtering.
- Upload URL issuance appears primarily login-gated; object keys and requested resources should be tenant-bound.
- Dashboard/admin aggregate queries become increasingly expensive with table growth.
- Join/password/invitation/search/upload endpoints need explicit rate and abuse limits.

# 6. Authentication and Authorization

## Verified controls

- Clerk verifies web/API sessions through official Express middleware.
- Local identity is keyed by Clerk subject.
- Suspended local accounts are rejected by requireAuth.
- Workspace membership and permission helpers exist.
- Private channel access checks bans, private-workspace membership, channel membership and privileged workspace permissions.
- WebSocket upgrade revalidates ticket, Clerk user, session and local account status.
- Notification read writes are user-scoped.
- Message deletion and reactions consult message/channel access.

## Principal risks

**HIGH — broad credentialed CORS**  
Evidence: artifacts/api-server/src/app.ts uses reflected origin behavior with credentials.  
Why it matters: untrusted origins should not receive credentialed API access.  
Direction: explicit trusted-origin allowlist by environment.

**HIGH — tenant scope integrity is distributed**  
Evidence: multiple globally unique IDs and missing composite tenant constraints; authorization is implemented route by route.  
Why it matters: one omitted parent predicate creates an IDOR.  
Direction: parent-scoped repository helpers and tests for every detached ID.

**HIGH — role scope combinations are weakly constrained**  
Evidence: nullable userRoles scopes and non-FK category references.  
Why it matters: malformed scope records can encode cross-tenant or ambiguous authority.  
Direction: database constraints plus centralized assignment validation.

**MEDIUM — automatic local profile creation**  
Any valid Clerk subject can receive a local profile. This may be intended for a public product, but it is not an invitation-only admission boundary.

**MEDIUM — admin/bootstrap hotspots**  
First-admin claim, role assignment/removal, account status and platform role changes need atomicity, last-admin protection, scope containment and explicit negative tests.

## Conceptual IDOR assessment

- user IDs: risk in global search, DMs, block endpoints, employee and role mutations.
- workspace IDs: generally nested routes help, but every nested child must be verified against the same workspace.
- channel IDs: risk in admin mutations, attachments, reactions, deletion broadcasts and broad channel listing.
- message IDs: deletion/reaction/attachment routes must resolve message and authorize its channel/DM participants.
- task IDs: nested route is positive; task must still belong to path community.
- document IDs/version IDs: download, permissions, version and acknowledgment must bind to community and user access.
- employee/member IDs: role and org mutations must verify membership in the path community.

# 7. WebSocket Audit

## Connection and controls

Single-use tickets expire after 60 seconds. Upgrade validates Clerk user/session/local status. Frames are limited to 4 KiB. Subscribe operations call channel-read authorization. Typing is rate-limited server-side and recently throttled client-side. Generation checks prevent stale asynchronous subscribe completion. Cleanup clears intervals and subscriptions.

## Findings

**HIGH — deletion event information leak**  
Evidence: broadcastChannelRemoved in artifacts/api-server/src/lib/ws.ts iterates all connected clients rather than authorized/subscribed recipients.  
Impact: any authenticated socket learns channel IDs and deletion timing.  
Direction: send only to previously authorized subscribers or authorized workspace recipients.

**HIGH — process-local realtime state**  
Tickets, connections and subscriptions are in memory. A load-balanced upgrade can reach a different process; events do not cross instances.  
Direction: shared ticket/session store and pub/sub before horizontal scaling.

**MEDIUM — expired ticket accumulation**  
Expired unused tickets are removed only when presented; there is no periodic sweep.  
Direction: bounded map plus scheduled expiry cleanup.

**MEDIUM — multi-socket presence correctness**  
Any socket close marks a user offline without checking remaining tabs/devices.  
Direction: per-user connection counts and last-socket semantics.

**MEDIUM — stale authorization race**  
Broadcast uses subscriber membership without rechecking access. Correctness depends on every revocation path invoking revokeChannelAccess.  
Direction: centralize revocation and add race tests; use authorization epochs if needed.

**MEDIUM — incomplete event ordering metadata**  
Most reaction/delete/message events lack common version/event IDs.  
Direction: stable event IDs/sequence or timestamp/version guards.

**MEDIUM — client applies reaction/delete by message ID without room scope**  
Direction: include/verify room key before mutation.

**LOW — silent protocol failures**  
Malformed/denied frames are mostly ignored, limiting diagnostics.

# 8. Frontend Audit

## Routing

Explicit routes include /, /chat, /onboarding, /accept-invitation, /communities, /communities/:id, /developer and /admin. Unknown routes fall back to Landing rather than a 404.

## State and API

State is local React state/effects around native fetch and WebSocket communication. There is no application-wide state machine. Business surfaces often have their own loading/error state, but patterns are repeated.

## Strengths

- Real permission-aware product surfaces.
- Many loading, empty and retry states.
- Responsive Tailwind grid variants.
- Destructive admin actions use confirmation.
- Message rows are memoized and long chat history uses content-visibility CSS.
- Recent deterministic reliability tests cover key chat races and failures.

## Weaknesses

- App.tsx is about 3,000 lines and all routes are eager; bundle warning is over 500 kB minified.
- Business lists commonly render full arrays without virtualization.
- Document search requests can fire on each keystroke without debounce.
- Some effects lack abort/cancellation beyond local flags.
- Error handling varies; some directory failures become empty lists and hide outages.
- Several browser prompt/alert flows remain.
- Icon controls and status messages do not consistently expose labels/live regions.
- Overlay focus management is not clearly implemented.
- Unknown deep links do not receive a real not-found state.

# 9. Business Systems

Relay’s implemented center is the combination of communication and operations. Chat is not isolated from the business directory: users, workspaces, channels, org structure, tasks, announcements, documents, policies, notifications and audit share one authorization/data model.

Strongest systems:
- Channels, DMs and realtime communication.
- Workspace directory and organizational structure.
- Documents/announcements/policy governance primitives.
- Audit and platform administration.

Weakest or incomplete systems:
- Reports and analytics.
- Full invitation/employee lifecycle administration.
- Manager relationship administration.
- Generalized global search.
- Mature policy lifecycle/versioning.
- Enterprise-scale role scope integrity.
- Business-wide moderation workflows.

# 10. UX Audit

## Strengths

- Distinct, consistent terminal-inspired design.
- Clear separation of chat, business workspace, platform admin and developer areas.
- Useful empty/loading states across many business panels.
- Failure feedback has improved substantially in chat creation/join/upload/pagination flows.
- Desktop information density suits administrative users.

## Weaknesses

- Dense monospace presentation may reduce scanability for large business datasets.
- The monolithic navigation model exposes many capabilities without a unified global discovery pattern.
- Mobile layouts are responsive, but high-density admin and chat workflows are not proven with device testing.
- Accessibility is inconsistent: labels, focus management, live errors and icon button names need a systematic audit.
- Destructive and sensitive flows rely on browser confirm/prompt in places.
- Some outages can look like empty data.
- Manager and employee lifecycle workflows are difficult to discover or incomplete.

# 11. Security Findings

## Automated scanners

| Scanner | Status | Findings |
|---|---|---|
| Dependency audit | OK | 0 critical, high, moderate, low or informational vulnerabilities. |
| SAST | OK | No findings. |
| HoundDog privacy/dataflow | OK | No findings. |

## Manual findings

| Severity | Finding | Affected area | Suggested direction |
|---|---|---|---|
| HIGH | Channel-removal broadcasts reach all sockets | WebSockets/isolation | Authorized/subscriber-only fanout. |
| HIGH | Broad credentialed CORS origin reflection | API perimeter | Environment-specific allowlist. |
| HIGH | Global/all-row channel authorization filtering | API/DB/isolation | SQL-scoped joins/EXISTS and bounded pages. |
| HIGH | Weak composite tenant integrity | DB/authz | Composite constraints and parent-scoped repositories. |
| HIGH | Audit actor deletion cascades erase history | Audit/compliance | Preserve snapshot and SET NULL/restrict deletion policy. |
| HIGH | Process-local realtime state | Availability/scaling | Shared pub/sub and shared ticket store. |
| MEDIUM | Missing upload resource binding/rate controls | Storage | Tenant-bound object keys, resource auth and quotas. |
| MEDIUM | Inconsistent input validation | API | Shared Zod/OpenAPI validation boundary. |
| MEDIUM | Admin/bootstrap privilege hotspots | Administration | Atomicity, scope containment and negative tests. |
| MEDIUM | Join/password/invite/search abuse controls not evident | API | Rate limiting and audit thresholds. |
| MEDIUM | Multi-socket presence can report false offline | Realtime | Per-user connection counting. |
| LOW | Protocol denials are silent | WebSockets/diagnostics | Structured error/ack frames without sensitive detail. |

No CRITICAL finding was proven from static inspection. HIGH findings should be resolved before broad release.

# 12. Performance Findings

- Unbounded or broad channel/category/scope/role reads are the largest immediate query concern.
- Per-channel authorization loops can become N+1 behavior.
- Leading-wildcard search on users and audit fields will scan as data grows.
- Global counts and recent-item queries grow with whole tables.
- Notifications and announcement fanout grow linearly with recipients.
- Append-only messages, audit, moderation and download tables need retention/partition planning.
- Frontend bundle exceeds Vite’s 500 kB warning threshold.
- Eager route inclusion and a 3,000-line component increase initial parse and maintenance cost.
- Business lists lack consistent server pagination and client virtualization.
- Process-local WebSockets prevent horizontal scaling rather than merely slowing it.

No supported latency, throughput or concurrency metrics were available. No synthetic performance numbers are claimed.

# 13. Testing Audit

## Existing evidence

- Web: App.test.tsx and message-state.test.ts; 28 tests passed immediately before this audit.
- API: admin, cleanup-admin-test-users and channel-moderation-policy tests plus validation scripts.
- DB: CI runner compatibility tests for PostgreSQL 14, 15 and 16.
- CI: API tests with disposable PostgreSQL and scheduled cleanup validation.
- TypeScript: root and package typecheck scripts exist.

## Gaps

- Current CI does not clearly gate frontend tests/build or the full root build.
- Web tsconfig excludes test files from normal typecheck.
- No lint script/configuration was found.
- Database-backed integration tests cannot run in the current Replit development environment without TEST_DATABASE_URL.
- Stronger negative authorization tests are needed for every detached/nested ID.
- Missing multi-socket presence, cross-process realtime, deletion fanout isolation and ticket-expiry tests.
- Missing migration-forward/rollback tests because versioned migrations do not exist.
- Missing large-list/pagination/load characterization.
- Missing systematic accessibility testing.

## Current status

- Web typecheck: passed immediately before audit.
- Web tests: 28/28 passed immediately before audit.
- Web production build: passed with chunk-size warning.
- Workflows: web, API and mockup workflows running.
- API DB integration: not rerun; disposable test database unavailable.
- Lint: unavailable/not configured.
- Migration status: Drizzle push model; no versioned migration chain.

# 14. Dependency Audit

Major runtime dependencies include React 19, Clerk React/Express, Express 5, ws, Drizzle ORM, PostgreSQL pg, Zod, Pino, Vite 7, Vitest 5, Tailwind 4, Radix UI and TanStack Query. An exact pnpm lockfile exists.

Positive:
- Automated dependency audit found no known vulnerabilities.
- Dependency/license inventory scripts and reports exist.
- Workspace catalog/overrides centralize versions.

Concerns:
- Dependency/license report freshness was not independently verified.
- Frontend declares a broad UI dependency surface relative to its monolithic implementation.
- No unused-dependency analysis was proven.
- Optional/platform-specific lockfile entries can complicate audit interpretation.

# 15. Scalability

## 25 employees

Likely operational on one process/database. Main concerns are correctness and release safety rather than capacity.

## 250 employees

Notification fanout, audit growth, dashboard counts, broad channel reads and full-array frontend rendering become noticeable. Add pagination, missing indexes, query plans and retention policies.

## 2,500 employees

Current global/all-row authorization filtering, wildcard searches, notification fanout and process-local WebSockets become architectural bottlenecks. Shared realtime infrastructure, server-side pagination, indexed search and background jobs become necessary.

## 25,000+ employees

The current architecture is not enterprise-scale. Requirements would include shared pub/sub, distributed ticket/session state, workload queues, partition/archive strategies, search infrastructure, strict tenant-scoped query repositories, incremental aggregates, object-storage lifecycle controls, observability/SLOs and tested deployment migrations.

# 16. Release 1 Readiness

## Ready or substantially ready

- Core authenticated web/API architecture.
- Channels, DMs and server-authoritative mutations.
- Workspace/business domain breadth.
- PostgreSQL persistence.
- Object-storage design pattern.
- Basic administration and audit surfaces.
- Current web build and focused reliability tests.

## Must address before broad Release 1

1. Scope channel-removal WebSocket broadcasts.
2. Restrict credentialed CORS.
3. Replace global/all-row authorization filtering with tenant-scoped SQL.
4. Enforce parent/tenant integrity for roles, channels, documents, tasks and nested resources.
5. Establish versioned migrations and rollback procedure.
6. Add frontend/root build and test gates to CI.
7. Preserve audit history across account deletion.
8. Add missing indexes and bounded pagination on high-growth paths.
9. Define retention/archival for append-only datasets.
10. Complete negative authorization tests for IDOR surfaces.

## Release 1 verdict

**NOT READY for broad production rollout.**  
**Potentially suitable for controlled pilot use** after the high-severity security/isolation items are resolved and deployment/database procedures are proven.

# 17. Release 2 Readiness

## Foundations worth retaining

- pnpm workspace separation.
- Express/API + Drizzle/PostgreSQL core.
- Clerk identity integration.
- Server-authoritative realtime mutation model.
- Shared permission vocabulary.
- App Storage object-path model.
- Business workspace + communication product model.

## Harden before expansion

- Tenant-scoped data access layer.
- Versioned migrations.
- Distributed realtime architecture.
- Role scope constraints.
- Pagination/search/index strategy.
- Frontend route/component decomposition.
- CI release gates and observability.

## Release 2 verdict

The domain foundation is broad enough for Release 2 planning, but expansion should follow hardening. Adding more features before tenant integrity, realtime scale and release safety are improved would compound risk.

# 18. Technical Debt

Prioritized technical debt:
1. Monolithic App.tsx and eager frontend routes.
2. Authorization filtered in memory after broad reads.
3. Ad hoc request validation despite generated contracts.
4. Missing versioned migrations.
5. Inconsistent FK/cascade/tenant constraints.
6. Missing indexes for reverse and unread/due-date lookups.
7. Process-local WebSocket infrastructure.
8. Incomplete CI frontend/root gates.
9. Browser alert/prompt and inconsistent error handling.
10. Documentation/environment drift.
11. No lint gate.
12. No retention/archive policy.

# 19. Missing Capabilities

- General report builder/export/analytics.
- Unified global workspace search.
- Comprehensive invitation and employee lifecycle console.
- Mature manager assignment and delegation UX.
- Full policy version/current-policy lifecycle.
- Enterprise moderation/appeal/review workflow.
- Distributed realtime/pub-sub.
- Versioned schema migration and rollback system.
- Proven production observability, SLOs and load testing.
- Consistent accessibility system and automated checks.

# 20. Recommended Priority Order

## P0 — release blockers

1. Fix channel-removal broadcast authorization.
2. Restrict CORS to trusted origins.
3. Audit and enforce parent-scoped authorization on every detached/nested ID.
4. Replace global channel/workspace reads with tenant-scoped SQL.
5. Preserve audit history and define deletion semantics.

## P1 — release safety and scale

6. Introduce versioned Drizzle migrations and rollback procedures.
7. Add frontend tests/build/root validation to CI.
8. Add bounded pagination and missing indexes.
9. Add abuse controls for joins, invites, search and uploads.
10. Define retention/archive policy.
11. Correct multi-socket presence and ticket cleanup.

## P2 — maintainability and product maturity

12. Decompose frontend routes/components and code-split.
13. Standardize Zod/OpenAPI request validation.
14. Improve accessibility and replace browser prompt/alert flows.
15. Complete employee/invitation/manager/policy lifecycle UX.
16. Add reporting and unified search only after hardening.

# RELAY AUDIT SNAPSHOT

**Architecture:** Real pnpm monorepo with React/Vite, Express, Clerk, Drizzle/PostgreSQL and App Storage; frontend and realtime state are too centralized for long-term scale.  
**Database:** Broad domain model with useful indexes, but missing tenant-integrity constraints, reverse indexes, retention policy and versioned migrations.  
**API:** Extensive implemented REST surface; inconsistent pagination/validation and pervasive IDOR-sensitive identifiers require systematic hardening.  
**WebSockets:** Strong short-lived ticket and subscribe authorization basics; high-risk global deletion broadcast and process-local scaling limitations.  
**Frontend:** Feature-rich and increasingly reliable, but monolithic, eager, accessibility-inconsistent and weak on large-list handling.  
**Security:** Automated scans clean; manual audit found multiple HIGH architectural/isolation risks.  
**Performance:** Main risks are broad reads, authorization loops, wildcard search, append-only growth, fanout and a large eager bundle.  
**Testing:** Focused web and API/DB tests exist; frontend/root CI gates, authorization negatives, migration and scale tests are incomplete.  
**Scalability:** Reasonable for small controlled use; medium requires query/index work; large/enterprise requires distributed realtime and stronger data architecture.  
**Business functionality:** Broadly implemented and structurally beyond basic chat; reports, lifecycle depth and enterprise workflows remain incomplete.  
**Release 1 readiness:** Not ready for broad release until P0 isolation/security and release-safety items are resolved.  
**Release 2 readiness:** Domain foundations are promising, but expansion should follow hardening rather than precede it.
