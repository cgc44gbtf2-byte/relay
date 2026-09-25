# Release 1 security-readiness reconciliation

Reviewed: 2026-09-25. **Outcome: audit evidence reconciled; release approval is
blocked.** This report is a technical inventory, not a security certification,
legal opinion, production migration authorization, or approval to publish.
Statuses distinguish local evidence from hosted and production evidence.

## Current checks and their limits

| Check | Outcome | Qualification |
| --- | --- | --- |
| Dependency vulnerability scan | PASS — 0 critical, 0 high, 0 moderate, 0 low, 0 informational findings | Current scanner result only; a clean result does not establish that every reachable dependency is risk-free. |
| Static code scan | PASS — 0 findings; scan reported `incomplete: false` | Static analysis does not prove runtime authorization or business-logic safety. |
| Privacy/security dataflow scan | PASS — 0 findings | This does not verify provider configuration, live data handling or every data path. |
| Local `pnpm run release:validate` | PASS — 28 reviewed migrations validated, library/API/web typechecks, 60/60 API unit tests, 113/113 web tests, API/web builds and dependency license gate | No authenticated API integration tests, production database, release archive or hosted runner are included in this local command. The web build still warns about a large JavaScript chunk. |
| License policy regressions | PASS — 3/3 tests in `scripts/dependency-license-policy.test.mjs`; installed graph passes `pnpm run audit:licenses` | This is a technical allowlist, **not** legal clearance or a notice bundle. |
| Latest hosted GitHub CI, `development` push of 2026-09-24 22:59 UTC | **FAIL** — [CI run](https://github.com/cgc44gbtf2-byte/relay/actions/runs/36070400685) | `release-validation` passed, but PostgreSQL 14/15/16 database-runner compatibility and authenticated API jobs failed, `validate-scheduled-cleanup` failed its Clerk concurrency step, and abandoned-test-user cleanup was skipped. The separately triggered [workflow validation run](https://github.com/cgc44gbtf2-byte/relay/actions/runs/36070400732) passed. These hosted runs predate the current local checkout and do not certify it. |

The security scanners returned no findings to fix in this reconciliation. Scan
counts are not a substitute for the targeted authorization and failure-path
tests below. No production data was accessed or changed for this report.

## Original audit areas: fix, evidence and residual risk

“Verified” means the **named local or focused check** passed; it never means
release-wide or production verification. Evidence paths in the API column
below are relative to `artifacts/api-server`.

| Area / status | Fix and verification evidence | Remaining risk or release action (responsible role) |
| --- | --- | --- |
| Tenant HTTP access — **focused verified** | `docs/RELEASE-1-TENANT-ACCESS-MATRIX.md` traces read/write access chains; `src/admin.test.ts` exercises two-workspace substitution and announcement audience access, including attachment and scheduled delivery. | Matrix is not exhaustive for every realtime/storage path; security engineering should extend it as new routes are added. |
| Roles and destructive writes — **focused verified** | `src/admin.test.ts` covers revocation races, denied-operation audit absence, moderation records and rollback on forced audit-write failure; see `docs/RELEASE-1-AUDIT-STATUS.md`. | Concurrent authorization paths beyond the tested matrix still require review (security engineering). |
| WebSocket privacy and delivery — **focused verified** | `docs/RELEASE-1-WEBSOCKET-AUDIT.md` records post-commit offboarding and subscription-end fixes, subscriber-only events, reconnect contract and focused authenticated recipient/non-recipient tests in `src/admin.test.ts` and `src/lib/ws.test.ts`. | Not an exhaustive event-class or authorization-race matrix; the focused change did not receive a full authenticated-suite rerun at the time (API/security engineering). |
| Storage and uploads — **application boundary verified, provider boundary unverified** | `docs/RELEASE-1-STORAGE-AUDIT.md`, `src/routes/storage.test.ts`, `src/admin.test.ts` and the web upload-context test cover scoped claims, cross-workspace substitution, parent-scoped reads and cleanup. | Signed direct PUTs lack demonstrated provider-enforced byte/type/size limits and single-use enforcement; abandoned uploads lack automatic collection. Storage owner must validate provider controls and cleanup before claiming end-to-end enforcement. |
| Abuse controls — **single-process checks verified; deployment topology unverified** | `docs/RELEASE-1-ABUSE-CONTROL-AUDIT.md` inventories high-risk routes and process-local budgets; `src/lib/fixed-window-limiter.test.ts`, `src/lib/ws.test.ts` and focused authenticated checks exercise limits. | Operations must verify one continuously available API/WebSocket process, or add shared counters/tickets/routing before multi-instance deployment. No load or multi-instance guarantee. |
| Database integrity and migration runner — **local verified; production unverified** | `docs/DATABASE-MIGRATIONS.md` specifies ordered checksummed SQL, advisory locking, rehearsal and fail-closed baseline behavior; local validation checked all 28 migrations. | Operations must inspect the production catalog and ledger, confirm a current backup and reviewed baseline where needed, rehearse recovery, then document production checks. No baseline or production migration was run here. |
| Audit record preservation — **focused verified** | Actor snapshot/preservation migrations and authenticated tests are summarized in `docs/RELEASE-1-AUDIT-STATUS.md`. | No blanket test of every future audit producer (API/security engineering). |
| Frontend accessibility and recovery — **automated verified; manual unverified** | `docs/RELEASE-1-AUDIT-STATUS.md` records dialog keyboard behavior, alerts/retries, retained failed-send draft, 81 App UI tests and signed-out desktop/narrow screenshots. | QA/accessibility owner must verify signed-in layouts and native keyboard/screen-reader behavior; DOM tests do not certify conformance. |
| Collection pagination and query indexes — **focused verified** | Inventory and tests in `docs/RELEASE-1-AUDIT-STATUS.md` and `docs/RELEASE-1-QUERY-INDEX-JUSTIFICATION.md` cover bounded reads, continuation and index rationale. | Offset pages are not a snapshot under concurrent inserts/deletes; monitor real query plans before speculative indexing (API/database engineering). |
| Data retention — **strategy documented** | `docs/DATA-RETENTION.md` describes retention. | No destructive retention job has been implemented; operations/product must approve execution and recovery policy before claiming automated retention. |
| Dependency licensing — **technical gate passed; legal review open** | `docs/REPLIT-PACKAGE-LICENSE-REVIEW.md` documents removal, not approval, of four unverified Replit packages. `docs/LICENSE-COMPLIANCE.md` and current gate results find no installed unknown licenses. | Release/legal owner must review MPL-2.0, CC-BY-4.0 and Unlicense obligations. Two unknown *platform-optional, uninstalled here* records require review if a target installs them. License checking is distinct from vulnerability scanning. |
| Third-party notices — **not verified** | Inventory identifies notice candidates in `docs/LICENSE-COMPLIANCE.md`. | Release engineering must generate and inspect the notice/source-availability bundle **inside the actual shipped artifact**; no packaging or CI artifact verification is established. |
| Hosted CI and release deployment — **failed / unverified** | Current local release validation passes; the latest hosted CI run above fails. | CI owner must diagnose failed jobs, rerun the current revision to green, and confirm cleanup. Operations must separately verify production migration baseline, backup/recovery and single-process deployment assumptions. |

## Release decision and priorities

1. **Blocker — hosted CI is red.** CI owner: diagnose the failed PostgreSQL
   compatibility/authenticated jobs and Clerk-concurrency validation, then
   obtain a green hosted run on the release revision, including cleanup.
   Historical passing local tests or a passing workflow-format job do not
   override the failed run.
2. **Blocker — production migration readiness is not established.** Operations
   and database owner: review production schema/ledger and backup, decide
   whether a verified baseline is required, rehearse rollback and record the
   approved rollout checks. Never infer the production baseline from the
   development database.
3. **Blocker for distribution — notices and human license decisions.** Release
   engineering and legal owner: package and inspect the actual release
   archive's third-party notices and source-availability information; approve
   the remaining license obligations. Removed packages are not licensed by
   virtue of prior inclusion.
4. **Deployment/security qualification — provider controls and topology.**
   Storage owner must validate direct-upload enforcement and cleanup; operations
   must ensure the process-local abuse and WebSocket state match the intended
   deployment topology.
5. **Manual verification — accessibility.** QA/accessibility owner must test
   signed-in desktop/narrow interaction with keyboard and assistive technology
   before making an accessibility-conformance claim.

Until these gates are satisfied, the Release 1 audit work is documented but
**Release 1 is not signed off for production distribution**. Nothing in this
report changes live deployment settings, applies a migration, or grants legal
approval.