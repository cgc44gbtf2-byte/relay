# License compliance and acquisition readiness

**Snapshot date:** 2026-09-22  
**Status:** **Not cleared for acquisition** until the blockers below are
resolved or accepted by documented legal review.

This is a technical evidence report. It does not determine legal ownership,
trademark rights, or the legal interpretation of any license beyond the
license text and metadata identified below.

## Critical blockers

1. **4 installed package records are unverified.** The
   current install includes: `@replit/connectors-sdk@0.4.3`, `@replit/vite-plugin-cartographer@0.5.21`, `@replit/vite-plugin-dev-banner@0.1.2`, `@replit/vite-plugin-runtime-error-modal@0.0.6`.
   No license field or license file was found in the installed package evidence.
   The graph also contains 2 optional package records
   that are not installed on the current platform: `@tailwindcss/oxide-wasm32-wasi@4.3.3`, `fsevents@2.3.3`.
2. **The license gate is not green.** `pnpm run audit:licenses` exits
   non-zero while unknown licenses remain.
3. **No distribution notice bundle is tracked.** Before distributing a
   production bundle or transferring it, preserve the applicable license and
   notice texts for the packages listed in the inventory.

## Items requiring legal or license review

- **Lightning CSS:** `lightningcss@1.32.0` and
  `lightningcss-linux-x64-gnu@1.32.0` report MPL-2.0 and include a LICENSE
  file. They are reachable through `@tailwindcss/vite -> @tailwindcss/node`
  and Vite's peer toolchain in the web and mockup build environments. The
  repository has no direct application import. `artifacts/api-server/build.mjs`
  lists `lightningcss` as an external bundling candidate, but no API source
  import was found.
- **MPL-2.0 obligations for this usage:** if the MPL-covered package itself or
  a modification is distributed in executable form, make the corresponding
  Covered Software available in source form under MPL-2.0, tell recipients how
  to obtain it, and do not remove or alter substantive license, copyright,
  patent, disclaimer, or limitation notices. A Larger Work may remain under
  other terms when the MPL-covered material is in separate files, but the MPL
  requirements still apply to that material. No repository modification to
  Lightning CSS was found in this audit.
- **CC-BY-4.0:** `caniuse-lite` reports CC-BY-4.0; retain the required
  attribution and license information if its data is distributed.
- **Unlicense:** `fast-sha256` and `wouter` report Unlicense; preserve the
  license evidence and have counsel review how the public-domain dedication
  and backup license are treated in each distribution jurisdiction.
- **Replit packages:** the exact terms for the packages below could not be
  verified from installed metadata or package/license files:

- `@replit/connectors-sdk@0.4.3` — Unknown; no license field or license file found in installed package; installed; used by workspace.
- `@replit/vite-plugin-cartographer@0.5.21` — Unknown; no license field or license file found in installed package; installed; used by @workspace/mockup-sandbox, @workspace/web-irc.
- `@replit/vite-plugin-dev-banner@0.1.2` — Unknown; no license field or license file found in installed package; installed; used by @workspace/web-irc.
- `@replit/vite-plugin-runtime-error-modal@0.0.6` — Unknown; no license field or license file found in installed package; installed; used by @workspace/mockup-sandbox, @workspace/web-irc.

## Items requiring documentation

- Add a generated third-party notice bundle to the release process.
- Record the exact source and version used for each production browser/server
  artifact.
- Preserve the Lightning CSS MPL-2.0 LICENSE file and any source-availability
  information when shipping artifacts that include it.
- Obtain written license evidence for the unresolved Replit packages.
- Document whether development-only packages are excluded from customer
  distribution; do not treat dev-only status as a license clearance.

## Items requiring replacement or removal

No dependency was removed or replaced by this audit. The unresolved packages
must either receive authoritative license evidence or be evaluated for
replacement before acquisition clearance. This report intentionally does not
choose a replacement.

## Already compliant at the technical screening level

- 555 third-party package records have a
  recognized license expression in package metadata or an installed license
  file.
- The workspace does not report GPL, AGPL, LGPL, SSPL, EPL, or CDDL packages
  in the current installed graph.
- The root workspace is private and marked `UNLICENSED`; this avoids
  implying that Relay itself is MIT-licensed. It is not a legal ownership
  determination and still requires an approved legal owner/copyright policy.

## Verification commands

```sh
pnpm run audit:inventory
pnpm run audit:licenses
pnpm why lightningcss --recursive
```

The inventory is a snapshot and must be regenerated after dependency changes.
