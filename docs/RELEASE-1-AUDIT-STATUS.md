# Release 1 audit status

Reviewed: 2026-09-24. This is a reconciliation of the original audit-fix
checklist, not a production-readiness sign-off.

## Verification evidence

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

## Implemented safeguards and evidence locations

| Area | Evidence | Remaining qualification |
| --- | --- | --- |
| Tenant authorization | Scoped helpers and negative integration tests in `artifacts/api-server/src/admin.test.ts` and `src/lib/channel-access.ts` | Endpoint-by-endpoint coverage of every resource in the original checklist is not yet established. |
| WebSocket event privacy | `src/lib/ws.ts`, `src/lib/ws.test.ts`: subscriber-only deletion; access-checked channel-list invalidation; bounded, per-user authorization checks | Complete event-class and real multi-workspace delivery matrix is not yet established. Invalidation unit tests inject access decisions. |
| Roles and destructive operations | Integration tests for revocation races, denied-operation audit absence, moderation records, and forced audit-write rollback | Does not prove every mutation and failure path. |
| Database integrity and migrations | `lib/db/migrations`, `docs/DATABASE-MIGRATIONS.md`, rehearsal/bootstrap tests | Production baseline/application and recovery remain an operational verification step. |
| Audit preservation | Actor snapshot/preservation migrations and integration tests | No blanket sign-off on every audit producer. |
| Storage | `src/routes/storage.ts`, storage unit tests, authenticated attachment/document tests | Exhaustive object-ID substitution and provider-level size/type enforcement remain to be reviewed. |
| Abuse protection | Fixed-window limiter and ticket-cleanup tests; route-specific limits | Full route inventory and multi-instance behavior remain unverified. |
| Data retention | `docs/DATA-RETENTION.md` | Strategy documented; no destructive retention job added. |
| Frontend recovery | `artifacts/web-irc/src/App.test.tsx`: room retry, reconnect, DM preservation, username conflicts, developer denial | Comprehensive keyboard/focus/accessibility and error-state review is still outstanding. |

API source paths in the table are relative to `artifacts/api-server`.

## Outstanding audit scope

1. Complete the resource-by-resource tenant authorization inventory and close
   missing negative read/write tests. An ID-only lookup is a review candidate,
   not by itself proof of an exploitable authorization defect.
2. Review broad workspace-detail and other collection queries for bounded,
   stable pagination with matching frontend behavior. Avoid silently truncating
   existing screens or weakening permission filtering.
3. Finish query/index justification, all-event WebSocket review, storage
   enforcement, abuse-control inventory, and accessibility verification.
4. Run/document the available security/static-analysis checks and reconcile
   their findings; do not equate license checking with security analysis.
5. Resolve the separately queued unclassified dependency-license review.
6. Produce the original checklist's final per-fix report and confirm hosted CI
   and production migration readiness before release approval.

No Release 2 feature work is included.