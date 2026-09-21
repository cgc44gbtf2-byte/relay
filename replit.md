# Web IRC

Web IRC is a browser-based Internet Relay Chat client for joining rooms, seeing who is online, and chatting through a live relay.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

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

CI must provide `TEST_DATABASE_URL` as a protected environment secret pointing to a
disposable database created for the job or test environment, then run
`pnpm --filter @workspace/db run push:test` before
`pnpm --filter @workspace/api-server run test`. Do not set `TEST_DATABASE_URL` to the
development or preview `DATABASE_URL`.

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
- `artifacts/api-server/src/routes/admin.ts` — one-time admin claim flow, protected platform overview, health checks, account search, role management, channel maintenance, and audit logging
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
- Claim the one-time admin seat at `/admin` from the first signed-in account, then use the protected platform control room to monitor health, manage accounts and roles, maintain public room topics, clear room history with confirmation, and review the admin audit stream.
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
