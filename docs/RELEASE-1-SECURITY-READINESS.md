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
| Latest hosted GitHub CI, `development` push of 2026-09-24 22:59 UTC | **FAIL** — [CI run](https://github.com/cgc44gbtf2-byte/relay/actions/runs/36070400685) | `release-validation` passed, but PostgreSQL 14/15/16 database-runner compatibility and authenticated API jobs failed, `validate-scheduled-cleanup` failed its Clerk concurrency step, and abandoned-test-user cleanup was skipped. The separately triggered [workflow validation run](https://github.com/cgc44gbtf2-byte/relay/actions/runs/36070400732) passed. These hosted runs predate the current local checkout and do not certify it. See investigation below. |

The security scanners returned no findings to fix in this reconciliation. Scan
counts are not a substitute for the targeted authorization and failure-path
tests below. No production data was accessed or changed for this report.

### Hosted CI failure investigation (2026-09-25)

The failed run used revision `1e09ca9`, whereas the investigated local checkout
was `a7b1ab8`. GitHub job metadata identifies the failing steps but **not their
full error output**: downloading the job logs returned HTTP 403 ("Must have
admin rights to Repository"). Public job annotations say only that the steps
exited 1. This limits any claim about the database jobs' exact failure cause.

- **Clerk concurrency validation — reproduced and corrected in the current
  tree.** Running the validator from the failed revision against the unchanged
  CI workflow exits 1 with “Expected at least two Clerk-using jobs, found 1:
  api-tests.” It missed credentials declared on a step rather than at job
  level. The current `scripts/ci/validate_clerk_concurrency.py` recognizes
  both forms. Its 12 local CI-policy tests and workflow validation pass. This
  explains the failing validation step, but it has not passed in a later
  hosted run.
- **Database compatibility and authenticated API jobs — plausible fresh-schema
  cause, not proven from hosted logs.** Subsequent changes in
  `lib/db/scripts/run-ci-tests.mjs` provision `pg_trgm` before a fresh
  current-schema push; migration 0017 already provisions it for the ordered
  migration path. The two paths use separate disposable databases, so the
  old runner could fail the fresh push even when the migration rehearsal
  passed. Current compatibility scripts passed **34/34** against a new,
  disposable local PostgreSQL 16 cluster, including real migration rehearsal,
  fresh schema setup, no-op check and database cleanup. PostgreSQL 14/15 and
  authenticated API execution were **not** rerun in this investigation.

The next proof is a **new hosted run on the current release revision**, with
all three PostgreSQL compatibility and authenticated jobs, policy validation
and scheduled cleanup checked independently. Do not rerun the old revision
and call the current tree verified. No workflow was dispatched or pushed
during this investigation.

### Production migration readiness audit (2026-09-25)

The deployment service reports **no active published deployment**. There is
therefore no deployed database target, production catalog or migration ledger,
confirmed current backup, or restore rehearsal to inspect. No production SQL
was queried or changed. Local validation of 28 ordered migration files and
the passing PostgreSQL 16 rehearsal do **not** substitute for these checks.
The migration-runner guard tests passed 8/8 locally, including refusal to
guess history when an application table exists without a ledger.

There is also an unresolved **migration-ownership risk before first Publish**:
the API artifact's production run command invokes `pnpm run release:start`,
which runs the custom SQL migration chain before starting the API and requires
a current backup confirmation. Replit's managed-database Publish flow can
apply the development schema to production during publishing. If that flow
creates Relay tables without `irc_schema_migrations`, the startup runner
intentionally refuses to infer a baseline and the API will not start.
Setting the backup flags alone cannot fix that mismatch; arbitrarily
baselining the new database would also risk skipping unapplied SQL. The
deployment has not been published, so this is a **conditional but credible
failure path**, not an observed production error. An external production
database would require a different, explicitly confirmed migration owner.

Before approval, the deployment/database owner must:

1. Confirm whether production will use Replit-managed PostgreSQL or an
   external database, and document **one** authoritative schema-change
   procedure that reconciles Publish behavior with the existing runner.
2. Inspect the actual target catalog, migration ledger and production-shaped
   data after a production target exists. Do not assume the example baseline
   in `docs/DATABASE-MIGRATIONS.md` applies to it.
3. Verify a current backup/snapshot and restore path, rehearse the selected
   procedure on a disposable production-shaped database, and check that the
   API starts after schema preparation without retrying applied SQL.
4. Record the outcome of first Publish and subsequent no-op/forward releases
   before calling production migration readiness verified.

This audit made no deployment-setting, environment-variable, database or
migration-runner changes.

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
| Database integrity and migration runner — **local verified; production unverified** | `docs/DATABASE-MIGRATIONS.md` specifies ordered checksummed SQL, advisory locking, rehearsal and fail-closed baseline behavior; local validation checked all 28 migrations and 8/8 runner guards passed. | No published deployment exists. Operations must reconcile managed Publish schema application with the startup migration runner (or confirm an external target), then inspect the actual catalog/ledger, verify backup and restore, and rehearse the selected path. No baseline or production migration was run here. |
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
   and database owner: first reconcile managed Publish schema changes with
   the startup migration runner, or confirm an external production target.
   Then review the actual production catalog/ledger and backup, decide
   whether a verified baseline is required, rehearse recovery and record
   approved rollout checks. There is no published target yet; never infer
   its baseline from the development database.
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