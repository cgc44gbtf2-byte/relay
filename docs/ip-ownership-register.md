# Relay IP ownership register

**Audit snapshot:** 2026-09-22  
**Purpose:** keep product-owned intellectual property separate from provider,
open-source, and account-controlled dependencies during diligence or a company
transfer.

This register is an engineering inventory, not proof of legal title. Legal
ownership still depends on the company, contributor, contractor, account, and
service agreements that are not stored in this repository.

## Ownership inventory

| Asset | Repository evidence | Current control status | Acquisition action |
| --- | --- | --- | --- |
| Source code | `artifacts/`, `lib/`, `scripts/`, root configuration, and git history | Code is present in this workspace; the listed git remotes are Replit/internal remotes, not evidence of a company-controlled canonical repository | Establish a company-owned Git organization as the canonical repository, enable branch protection and 2FA, preserve history, and collect employee/contractor invention-assignment agreements |
| Domain | Custom-domain support exists in `artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts`, but no company domain or registrar is recorded in the repo | Not verifiable from source | Register the production domain in a company-controlled registrar account, enable renewal lock and MFA, record DNS/registrar ownership, and keep recovery contacts under company control |
| Brand | Relay name and product copy in `README.md`; logo in `artifacts/web-irc/public/logo.svg`; theme tokens in `artifacts/web-irc/src/index.css` | Design assets are in source control; trademark clearance and creator assignments are not verifiable here | Confirm the name is clear in target markets, document logo/font provenance, obtain assignments for commissioned work, and manage trademark filings from the company account |
| Database and schema | Drizzle schema in `lib/db/src/schema/irc.ts`; database setup in `lib/db`; API contract in `lib/api-spec/openapi.yaml` | Schema definitions are in source control; hosted data ownership, backups, and provider terms are external | Keep schema and export tooling in the company repository, test restores, document retention/export rules, and ensure the production database and object-storage accounts are company-owned |
| Documentation | `README.md`, `replit.md`, OpenAPI source, test/run instructions, and inline technical documentation | Product and engineering documentation is in source control; contributor authorship records are external | Keep customer, operator, API, and architecture documentation under the same company-controlled repository and include it in transfer checklists |
| Custom systems | Workspace isolation, scoped permissions, audit logging, release management, WebSocket hub, signed file access, notification flows, and recovery behavior | Implemented in the repository; third-party identity, hosting, storage, and telemetry services remain external dependencies | Maintain an architecture inventory, export configuration and runbooks, and make each external account transferable to the company |

## Immediate control gaps

1. **Canonical repository:** this workspace does not establish a company-owned
   Git host or legal owner.
2. **Domain:** no production domain or registrar account is recorded.
3. **Trademark and contributor chain of title:** source control alone does not
   prove that all employee, contractor, logo, font, or copy rights were
   assigned.
4. **Dependency licenses:** `pnpm run audit:licenses` currently flags the
   Replit packages whose metadata reports `Unknown`. Lightning CSS is MPL-2.0
   and should remain in the diligence review with its file-level obligations.
5. **License policy:** the root workspace is now marked `UNLICENSED` and
   private to avoid implying that the product itself is MIT-licensed. Add the
   company-approved copyright notice and license policy only after the legal
   owner is confirmed.

## Transfer checklist

- [ ] Company owns the canonical Git organization, repository, backup, and
  deploy credentials.
- [ ] Company owns the registrar, DNS, email, certificate, and domain recovery
  accounts.
- [ ] Company has signed invention-assignment agreements for employees and
  contractors.
- [ ] Company has provenance and assignment records for logos, fonts, photos,
  illustrations, copy, and generated assets.
- [ ] Company has a trademark search and filing decision for Relay and related
  marks.
- [ ] Company owns PostgreSQL, object storage, authentication, email, analytics,
  and billing accounts, with export and recovery procedures.
- [ ] `pnpm run audit:licenses` passes, and all attribution/file-level notices
  are included in the distribution process.
- [ ] Customer-facing terms, privacy documentation, data-retention rules, and
  security runbooks are versioned and included in the transfer.