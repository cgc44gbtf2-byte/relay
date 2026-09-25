# Relay

**Relay is an Internet Relay Chat (IRC) application built for community and business communication.**

Channels, direct messages, presence, and moderation make real-time conversation the core of Relay. People can connect in communities around shared interests, while organizations can bring their teams together in private business workspaces. Business tools for tasks, announcements, files, permissions, and audit history add context to those conversations without replacing them.

## Internet Relay Chat

### Channels and rooms

- Create persistent public, private, and invite-only channels
- Organize rooms around shared interests, teams, departments, projects, or events
- Add channel topics and descriptions to keep discussions focused
- Browse, search, join, and manage accessible channels
- Request access to restricted spaces and review membership requests
- Invite members into private channels
- Preserve searchable message history

### Real-time collaboration

- Send and receive channel messages over WebSockets
- Start direct-message conversations with other members where access permits
- See online presence and typing indicators
- React to messages and mention members
- Receive live channel, membership, presence, and message updates
- Automatically revoke live subscriptions when access is removed

### Moderation and communication controls

- Promote channel moderators
- Mute, kick, ban, and block users
- Control channel membership and access
- Remove access immediately across active sessions
- Maintain clear boundaries between public and private conversations

### Secure file sharing

- Upload images, documents, and text-based files
- Attach files to conversations and operational records
- Validate file type, filename, and size before upload
- Restrict downloads to users who can access the related channel or direct message
- Deliver files through short-lived signed URLs

## Community Communication

Relay gives communities a place to gather and keep conversations going:

- Join public channels and discover conversations across the network
- Create a free community with starter rooms, then invite members to take part
- Give rooms clear topics, descriptions, and access settings
- Keep discussion history available to members who can access a room
- Use moderators and member controls to keep conversations welcoming

Community spaces are separate from private business workspaces; joining Relay does not automatically create a business workspace.

## Business Communication and Operations

### Organization workspaces

- Create private business workspaces with organization profile information
- Maintain workspace membership and employee profiles
- Organize people by department, category, location, and role
- Provide default spaces for announcements, HR, management, and general communication
- Keep business data isolated between workspaces

### Employee and team visibility

- View employee directories and online status
- Track workspace roles and scoped responsibilities
- See recent operational activity
- Monitor pending membership and access requests
- Use workspace dashboards for a consolidated view of people, communication, and work

### Task coordination

- Create and assign work to employees
- Add descriptions, priorities, due dates, departments, and locations
- Track open, due, and overdue tasks
- Add comments and attachments
- Notify employees when assignments change
- Keep task discussions and supporting files with the work itself

### Announcements

- Publish organization-wide or workspace announcements
- Attach supporting files and operational context
- Notify affected users
- Connect release communications with internal announcements

## Administration and Governance

### Role-based access control

Relay evaluates permissions across platform, workspace, department/category, and channel scopes.

- Provision platform and workspace administrators
- Create custom roles
- Assign scoped permissions
- Separate communication, moderation, business, reporting, analytics, integration, billing, and administrative capabilities
- Prevent users from operating outside their assigned workspace or permission scope

### Administrative console

- Review platform health and operational summaries
- Search and manage user accounts
- Suspend or restore account access
- Manage roles and scoped assignments
- Maintain channels and announcements
- Review organization activity and platform audit history
- Filter audit records by actor, action, resource, date, department, or location

### Audit-ready activity

- Record sensitive administrative and operational actions
- Preserve actor and resource context
- Paginate and filter high-volume activity streams
- Support investigation and accountability without exposing credentials in logs

## Release Management

- Create and manage application releases
- Move releases through draft, review, published, and archived states
- Maintain application-level settings
- Generate linked company announcement drafts when a release is published
- Notify users when release announcements are published
- Record release activity in the administrative audit trail

## Security

- Clerk-based authentication for browser and API access
- Suspended-account enforcement on protected requests
- Short-lived, single-use WebSocket tickets
- Server-side authorization for channel subscriptions and typing events
- Workspace isolation for business data and direct messages
- Access-checked message attachments and signed downloads
- Private-channel and private-community authorization
- Explicitly provisioned administrative access
- Environment-based credentials with no secrets committed to the repository

The WebSocket ticket and upload-URL endpoints have small, process-local
fixed-window abuse controls (10 requests per authenticated user and request
IP per minute). Counters are intentionally in memory: each API process tracks
its own requests, and restarting a process clears its counters. This is not a
replacement for distributed rate limiting.

## Platform Overview

```text
Browser
  ├── React + Vite application
  ├── Clerk authentication
  ├── Typed REST requests
  └── Authenticated WebSocket connection
          │
          ▼
Express API Server
  ├── Authentication and authorization
  ├── Communication and workspace APIs
  ├── Administrative and release APIs
  ├── WebSocket event hub
  └── Signed file operations
          │
          ▼
PostgreSQL
  └── Drizzle-managed users, workspaces, channels, messages,
      memberships, tasks, permissions, files, and audit records
```

## Technology

| Area | Technology |
| --- | --- |
| Frontend | React, Vite, TypeScript, Tailwind CSS, TanStack Query |
| Backend | Node.js, Express 5, TypeScript |
| Real-time | WebSockets |
| Authentication | Clerk |
| Database | PostgreSQL, Drizzle ORM |
| Validation | Zod, drizzle-zod |
| API tooling | OpenAPI, Orval |
| Build system | pnpm workspaces, TypeScript, esbuild |

## Repository Structure

```text
artifacts/
  web-irc/        React IRC interface for communities and businesses
  api-server/     REST API, authorization, and WebSocket server
lib/
  db/             PostgreSQL schema and database tooling
  api-spec/       OpenAPI source of truth
  api-client-react/
                  Generated React API client
  api-zod/        Generated validation schemas
scripts/          Workspace development utilities
```

## Getting Started

### Requirements

- Node.js 24
- pnpm 10
- PostgreSQL
- Clerk development application

### Install dependencies

```bash
pnpm install
```

### Configure the environment

Provide the required values through environment variables or your platform's secret manager. Do not commit them to source control.

```text
DATABASE_URL
CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY
VITE_CLERK_PUBLISHABLE_KEY
SESSION_SECRET
```

Object-storage configuration is also required for file uploads.

For credentialed browser requests, configure the API's explicit CORS allowlist
with `CORS_ALLOWED_ORIGINS` (a comma-separated list of complete `http` or
`https` origins). Replit deployments also trust the hosts in
`REPLIT_DOMAINS`, and development previews trust `REPLIT_DEV_DOMAIN`; these
variables are read as hostnames and are treated as HTTPS origins. Requests
without an `Origin` header (including same-origin requests) remain supported.

### Apply the database schema

```bash
pnpm --filter @workspace/db run push
```

### Start the API

```bash
pnpm --filter @workspace/api-server run dev
```

### Start the web application

```bash
pnpm --filter @workspace/web-irc run dev
```

## Development Commands

```bash
# Type-check the full workspace
pnpm run typecheck

# Type-check and build all packages
pnpm run build

# Run frontend tests
pnpm --filter @workspace/web-irc run test

# Run API tests with an isolated test database
pnpm --filter @workspace/api-server run test

# Regenerate API clients and validation schemas
pnpm --filter @workspace/api-spec run codegen
```

Authenticated API tests require a separate disposable `TEST_DATABASE_URL`. Test execution intentionally does not fall back to the development or production database.

## Ownership and license diligence

- [IP ownership register](docs/IP-OWNERSHIP.md) — source, brand, domain, schema, documentation, and custom-system transfer checklist
- [Release 1 data retention](docs/DATA-RETENTION.md) — retained records, future archive candidates, legal holds, and the current no-automatic-deletion posture
- [Database migrations and rollback](docs/DATABASE-MIGRATIONS.md) — versioned schema changes, disposable validation, and forward-only recovery
- [Message notification delivery operations](docs/MESSAGE-NOTIFICATION-DELIVERY.md) — queue monitoring, terminal failures, and safe requeue
- [Dependency inventory](docs/DEPENDENCY-INVENTORY.md) — exact installed direct and transitive package versions
- [Third-party license inventory](docs/THIRD-PARTY-LICENSES.md) — dependency screening and acquisition blockers
- [License compliance report](docs/LICENSE-COMPLIANCE.md) — obligations, unresolved terms, and readiness status
- `pnpm run audit:inventory` — regenerate the installed dependency inventory
- `pnpm run audit:licenses` — fail the workspace when installed dependencies report unknown or unapproved licenses

## Design Principles

- **Conversation first:** channels, direct messages, and presence are the foundation for both communities and businesses.
- **Communication with context:** business messages, tasks, files, people, and operational records belong in the same workspace.
- **Least-privilege access:** permissions are explicit and evaluated at the correct organizational scope.
- **Workspace isolation:** business data must never leak across organizations.
- **Real-time correctness:** access changes take effect across active connections, not only after refresh.
- **Operational accountability:** sensitive changes produce durable audit records.
- **Safe testing:** automated tests use isolated databases and test-only authentication environments.

## Project Status

Relay is under active development. Its IRC experience serves community conversations and business teams, with workspace operations, administration, security, file sharing, and release-management foundations supporting the business side.