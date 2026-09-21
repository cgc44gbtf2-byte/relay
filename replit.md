# Web IRC

Web IRC is a browser-based Internet Relay Chat client for joining rooms, seeing who is online, and chatting through a live relay.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/web-irc/src/App.tsx` — responsive IRC workspace and SSE client
- `artifacts/web-irc/src/index.css` — terminal-inspired theme and motion
- `artifacts/api-server/src/routes/irc.ts` — in-memory room state, IRC REST endpoints, and SSE broadcast
- `lib/api-spec/openapi.yaml` — source of truth for the IRC API contract
- `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/` — generated client and validation helpers

## Architecture decisions

- The first version uses server-sent events for room updates so browsers can reconnect without a custom WebSocket client.
- Room state is intentionally in memory for the first build; persistence is proposed as a follow-up.
- The frontend uses the generated React Query client for REST state and mutations, with EventSource for the streaming endpoint.
- The UI uses a terminal-inspired dark theme with amber, teal, and coral accents to make active conversation easy to scan.

## Product

- Browse the default IRC rooms and filter the room list.
- Join a new room with a chosen nickname.
- Read seeded room history, see online/away users, and send messages with Enter.
- Receive messages and presence-related system events through a reconnecting live stream.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
