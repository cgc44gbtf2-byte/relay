# Third-party license inventory

**Audit snapshot:** 2026-09-22  
**Command:** `pnpm licenses list --json`

This is a technical screening report, not a legal opinion. Dependency licenses
must be reviewed together with the exact versions, transitive notices, bundled
assets, and the product's distribution model.

## Screening result

The installed dependency graph is primarily permissive and commercially
usable:

- 465 packages report MIT
- 33 report ISC
- 12 report Apache-2.0
- 7 report BSD-3-Clause
- 4 report BSD-2-Clause
- The remaining packages report 0BSD, MIT-0, BlueOak-1.0.0, CC0-1.0,
  Python-2.0, Unlicense, CC-BY-4.0, or MIT AND ISC

The following items are not cleared:

| Package(s) | Reported license | Action |
| --- | --- | --- |
| `@replit/connectors-sdk`, `@replit/vite-plugin-cartographer`, `@replit/vite-plugin-dev-banner`, `@replit/vite-plugin-runtime-error-modal` | `Unknown` | Obtain the license text and redistribution terms from the package owner or replace the package before acquisition |
| `lightningcss`, `lightningcss-linux-x64-gnu` | `MPL-2.0` | Keep the license text and notices, identify any modified MPL-covered files, and have counsel confirm distribution obligations |
| `caniuse-lite` | `CC-BY-4.0` | Preserve attribution if the package or its data is distributed |

`pnpm run audit:licenses` is a repeatable gate. It exits non-zero when a
dependency reports an unknown or unapproved license. The current failure is
intentional: it prevents an acquisition review from silently treating the four
unknown Replit packages as cleared.

## Policy for new dependencies

1. Prefer MIT, Apache-2.0, BSD, ISC, 0BSD, MIT-0, BlueOak, CC0, and other
   clearly commercial-use-compatible licenses.
2. Do not add a package with `Unknown`, `UNLICENSED`, source-available,
   non-commercial, SSPL, AGPL, or GPL terms without a documented legal decision.
3. Preserve license and notice files for production dependencies and any
   dependency bundled into the browser build.
4. Re-run the audit after every dependency update and attach the output to the
   release or diligence record.