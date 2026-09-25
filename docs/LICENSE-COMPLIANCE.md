# License compliance and acquisition readiness

**Snapshot date:** 2026-09-25
**Status:** The dependency license gate passes for the current installed graph. This is **not an acquisition sign-off**; notices and legal review remain outstanding.

This is a technical evidence report. It does not determine legal ownership,
trademark rights, or the legal interpretation of any license beyond the
license text and metadata identified below.

## Dependency license gate

No installed package has an unknown license in this snapshot. `pnpm run audit:licenses` passes the technical allowlist; this does not approve distribution.

The graph includes 2 platform-optional unknown records
not installed here: `@tailwindcss/oxide-wasm32-wasi@4.3.3`, `fsevents@2.3.3`.
Check their licenses before building on a platform that installs them.

**Notice handling:** the API and web production builds now generate
`THIRD-PARTY-NOTICES.txt` and a package/version manifest in their respective
outputs. `pnpm run verify:release-notices` checks both local outputs and fails
if a selected package lacks license text. The bundle is conservatively scoped
to bundler inputs plus runtime-reachable packages; it is not a legal approval
or proof of what an as-yet-uninspected published archive contains.

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
- **Replit packages:** none remain installed. The unverified packages were removed, not approved. See [removal history](./REPLIT-PACKAGE-LICENSE-REVIEW.md).



## Items requiring documentation

- Check that the generated notices and version manifests accompany the actual
  published browser/server deliverables; local build verification is not a
  substitute for inspecting the shipped release.
- Review the exact source and version used for each production browser/server
  artifact, including any external runtime packages.
- Preserve the Lightning CSS MPL-2.0 LICENSE file and any source-availability
  information when shipping artifacts that include it.
- Verify that release archives contain only the intended production dependencies and notices.

## Items requiring replacement or removal

The four previously unverified Replit packages were removed from the current dependency graph. Invitation delivery now uses Resend's HTTPS API directly; the Replit-only Vite development plugins were removed. See [removal history](./REPLIT-PACKAGE-LICENSE-REVIEW.md).

## Already compliant at the technical screening level

- 554 third-party package records have a
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
