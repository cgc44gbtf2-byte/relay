# Web IRC

Web IRC is a browser-based Internet Relay Chat client for joining rooms, seeing who is online, and chatting through a live relay.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Git workflow

- `main` is the stable branch and must remain unchanged during Phase 1 reliability and optimization work.
- All ongoing changes must be committed to `development`.
- Merge `development` into `main` only after Phase 1 and the remaining reliability and optimization tasks are complete and verified.

### Authenticated API regression tests

The admin access regression suite must use a separate disposable PostgreSQL database. In
test mode, `@workspace/db` requires `TEST_DATABASE_URL` and never falls back to
`DATABASE_URL`, so the suite cannot read or delete developer or preview rows.

For a local run, create or provision a disposable database, push the schema to it, and
run the suite with the test URL:

```sh
TEST_DATABASE_URL='postgres://.../web_irc_test' pnpm --filter @workspace/db run push:test
TEST_DATABASE_URL='postgres://.../web_irc_test' \
  CLERK_SECRET_KEY='...' CLERK_PUBLISHABLE_KEY='...' \
  pnpm --filter @workspace/api-server run test
```

CI should provide `CI_TEST_DATABASE_ADMIN_URL` as a protected environment secret for a
PostgreSQL server where the validation job may create and drop databases. Run
`pnpm --filter @workspace/api-server run test:ci`; this creates a unique database for
the run, pushes the schema with `push:test`, runs the API tests, and drops the database
even when setup or tests fail. The command never reads `DATABASE_URL` or a pre-existing
`TEST_DATABASE_URL`, so development and preview databases cannot be used by accident.

If an authenticated admin test run is interrupted, its Clerk users may survive after
the test process stops. The test users are identified by the exact
`admin_access_test_` username plus matching `@example.com` email convention. With
the test Clerk keys and disposable test database configured, inspect leftovers with:

```sh
env -u DATABASE_URL NODE_ENV=test TEST_DATABASE_URL='postgres://.../web_irc_test' \
  CLERK_SECRET_KEY='sk_test_...' CLERK_PUBLISHABLE_KEY='pk_test_...' \
  pnpm --filter @workspace/api-server run cleanup:test-users
```

The command is dry-run by default. Add `--apply` only after confirming the
listed users belong to an interrupted regression run. It refuses non-test Clerk
keys, requires `NODE_ENV=test` and `TEST_DATABASE_URL`, refuses a simultaneous
`DATABASE_URL`, revokes active sessions, deletes only matching test users, and
removes their rows from the disposable database. Run it only when no admin
regression test is still using the test Clerk environment.

The API package automatically runs
`cleanup:test-users:scheduled` after `pnpm --filter @workspace/api-server run test`.
The same script can be attached to a recurring maintenance job for interrupted
runs:

```sh
env -u DATABASE_URL NODE_ENV=test TEST_DATABASE_URL='postgres://.../web_irc_test' \
CLERK_SECRET_KEY='sk_test_...' CLERK_PUBLISHABLE_KEY='pk_test_...' \
pnpm --filter @workspace/api-server run cleanup:test-users:scheduled
```

The scheduled entry point always applies cleanup, but the same safeguards still
require test Clerk keys and the disposable test database. Its structured log
records the matching user IDs/usernames and a `dry_run`, `started`, `succeeded`,
or `failed` status; credentials are never included in the log. A failed apply
also emits a maintenance alert with the affected-user count and safe IDs or
usernames, while diagnostic Clerk key values are redacted.

GitHub Actions runs the scheduled cleanup every six hours in the
`cleanup-abandoned-test-users` job. The job starts a disposable PostgreSQL
service, creates its test schema, and sets only `TEST_DATABASE_URL`,
`CLERK_TEST_SECRET_KEY`, `CLERK_TEST_PUBLISHABLE_KEY`, and
`TEAM_NOTIFICATION_WEBHOOK_URL` from GitHub Actions secrets. The webhook should
target the team's operational notification channel. It explicitly removes
`DATABASE_URL` before both database setup and cleanup. Configure the two Clerk
secrets with `sk_test_` and `pk_test_` values; live Clerk keys must not be used
for this job. Cleanup failures POST only the redacted affected-user summary to
the configured webhook; the webhook URL and Clerk credentials are never
included in the message.

The authenticated `api-tests` job and the scheduled cleanup use separate
GitHub Actions concurrency groups because they use separate disposable Clerk
test environments. The API tests use `CLERK_SECRET_KEY` and
`CLERK_PUBLISHABLE_KEY`; cleanup uses the dedicated `CLERK_TEST_SECRET_KEY`
and `CLERK_TEST_PUBLISHABLE_KEY` secrets. This lets scheduled maintenance run
without waiting behind an API regression run. Each group keeps
`cancel-in-progress: false` so repeated runs wait rather than canceling an
active run within the same Clerk environment.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/web-irc/src/App.tsx` — responsive authenticated IRC workspace, Clerk auth UI, REST client, and WebSocket client
- `artifacts/web-irc/src/index.css` — terminal-inspired theme and motion
- `artifacts/api-server/src/routes/irc.ts` — authenticated PostgreSQL-backed IRC REST endpoints
- `artifacts/api-server/src/lib/ws.ts` — ticket-authenticated WebSocket hub for channel, DM, and presence events
- `artifacts/api-server/src/routes/admin.ts` — protected platform overview, health checks, account search, explicitly provisioned role management, channel maintenance, and audit logging
- `lib/db/src/schema/irc.ts` — persistent users, channels, memberships, messages, moderation, blocks, and notifications
- `lib/api-spec/openapi.yaml` — source of truth for the IRC API contract
- `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/` — generated client and validation helpers

## Architecture decisions

- Clerk is the authentication provider; browser session cookies are used for HTTP and short-lived authenticated tickets are used for WebSocket upgrades.
- IRC data is persisted in PostgreSQL through Drizzle; use `pnpm --filter @workspace/db run push` after schema changes.
- The frontend uses direct typed fetch helpers for the expanded IRC routes and a WebSocket for live events. The older generated client remains for legacy API-spec routes.
- The UI uses a terminal-inspired dark theme with amber, teal, and coral accents to make active conversation easy to scan.

## Product

- Register and sign in with Clerk, then set a username and display name.
- Register with Clerk as a regular member, then use the IRC to discover public channels and create rooms. Administrative access is provisioned by the platform rather than claimed by the first signed-in account; provisioned operators can use `/admin` to monitor health, manage accounts and roles, maintain public room topics, clear room history with confirmation, and review the audit stream.
- Browse, search, create, and join public channels with persistent topics and history.
- Send real-time channel messages and direct messages through WebSockets.
- See member presence, join/leave system notifications, timestamps, searchable history, and notification inbox items.
- Edit topics, promote moderators, mute, kick, ban, block, and message other users from the member panel.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
