# Relay IP ownership and provenance

**Snapshot date:** 2026-09-22

This document distinguishes repository evidence from legal ownership. No
domain, trademark, registrar, contributor assignment, account, or user-asset
ownership is asserted unless it is directly evidenced in the repository.

## Relay-original code

Repository-authored implementation appears in:

- `artifacts/api-server/src/` — Express API, authorization, workspace
  isolation, WebSocket hub, notifications, audit and release behavior.
- `artifacts/web-irc/src/` — Relay web application behavior and UI.
- `lib/db/src/schema/` — Drizzle schema definitions.
- `lib/api-spec/openapi.yaml` — API contract source.
- `scripts/` and root configuration — build, test, and audit tooling.

Repository presence is evidence of possession in this workspace, not proof
that every contributor assigned rights to a legal entity.

## Third-party code

The complete installed dependency graph is in
[DEPENDENCY-INVENTORY.md](./DEPENDENCY-INVENTORY.md). Third-party source,
compiled packages, package metadata, and license obligations remain subject
to their respective licenses.

## Generated code

Generated artifacts include:

- `lib/api-zod/src/generated/`
- `lib/api-client-react/src/generated/`

Their generation sources are in `lib/api-spec/openapi.yaml` and
`lib/api-spec/orval.config.ts`. Generated output should not be treated as
independent proof of ownership without reviewing the generator and all
included schemas/templates.

## Open-source dependencies

License categories, exact installed versions, evidence, and obligations are
listed in [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md) and
[LICENSE-COMPLIANCE.md](./LICENSE-COMPLIANCE.md). Unknown licenses remain
unverified and are not classified.

## Replit-provided components

The installed graph includes Replit-namespaced packages:

- `@replit/connectors-sdk@0.4.3` — Unknown; no license field or license file found in installed package; installed; used by workspace.
- `@replit/vite-plugin-cartographer@0.5.21` — Unknown; no license field or license file found in installed package; installed; used by @workspace/mockup-sandbox, @workspace/web-irc.
- `@replit/vite-plugin-dev-banner@0.1.2` — Unknown; no license field or license file found in installed package; installed; used by @workspace/web-irc.
- `@replit/vite-plugin-runtime-error-modal@0.0.6` — Unknown; no license field or license file found in installed package; installed; used by @workspace/mockup-sandbox, @workspace/web-irc.

Their installed package metadata does not contain a license field or license
file in this snapshot. No ownership or license conclusion is made. Obtain
authoritative terms before acquisition clearance.

## User-provided assets

The repository contains `attached_assets/` and source-controlled product
assets such as `artifacts/web-irc/public/logo.svg`. The source repository
does not identify the creator, contributor, purchaser, assignment, or license
for each asset. Asset provenance and assignment are therefore **not verified**.

## Unverified ownership and control

- No production domain, registrar, DNS account, or recovery account is
  identified in the source tree.
- No legal owner or trademark owner is identified in the source tree.
- No employee, contractor, agency, or contributor assignment records are
  present in the source tree.
- No external service account ownership or transfer rights are established by
  source code.
- PostgreSQL schema definitions are present, but hosted data, backups,
  object-storage contents, and provider contracts are not proven by the repo.

## Acquisition evidence still required

- Company-controlled canonical Git repository and backups.
- Signed contributor, employee, and contractor assignment records.
- Brand, font, image, copy, and generated-asset provenance.
- Domain registrar, DNS, certificate, authentication, storage, email, and
  deployment account transfer records.
- Production database export/restore evidence and provider contract review.
- Resolved license evidence for every unknown package.
