# Replit package license evidence and release decision

Evidence checked: 2026-09-24. **All four unverified package versions were
removed from the workspace dependency graph, not approved.** The license gate
now passes; this is not a legal opinion or acquisition sign-off.

## Authoritative package evidence

The version-specific npm registry records below returned HTTP 200. All four
omit both `license` and `repository`. Their published tarballs were downloaded
from each record's `dist.tarball`, verified against its SHA-512 `dist.integrity`,
and their file lists inspected for LICENSE, COPYING, and NOTICE files
(case-insensitive, including extensions). None contain those files. Installed
package metadata and license-file checks agree. Public npm availability,
`private: false`, and `publishConfig.access: public` are not license grants.

| Removed package/version | Publisher's registry record | Tarball file count | Previous usage |
| --- | --- | --- | --- |
| @replit/connectors-sdk@0.4.3 | https://registry.npmjs.org/@replit%2fconnectors-sdk/0.4.3 | 18 | Runtime-reachable; API bundle dependency |
| @replit/vite-plugin-cartographer@0.5.21 | https://registry.npmjs.org/@replit%2fvite-plugin-cartographer/0.5.21 | 8 | Development tool; production configuration excludes it |
| @replit/vite-plugin-dev-banner@0.1.2 | https://registry.npmjs.org/@replit%2fvite-plugin-dev-banner/0.1.2 | 9 | Development tool; production configuration excludes it |
| @replit/vite-plugin-runtime-error-modal@0.0.6 | https://registry.npmjs.org/@replit%2fvite-plugin-runtime-error-modal/0.0.6 | 7 | Development tool; package applies only to Vite serve, not build |

Published tarball integrity values, in table order:

```text
sha512-7XoaRty/O6JF161UkVBI8UewZ96XCNNN1kRvT9Q41IRH3xr+6ImylvXtirIghydDd2FCQvIkY4HQscOOr45otA==
sha512-E5rco8Mov05QDfUOjoim3MVJdDX0/pBYql5Jay3w9cqmU/QOL6cEOUAjsBZPB/V8FEChsk++sZUrcWt1bHaAoQ==
sha512-YfW3U1xKnLrqvSiTzXeEX8AG+Vpz7XwBsJHNvGbp841AE1mLvishMQi2Zw7ApyHp+9EMGthXuCjP+mLbl3IuGA==
sha512-53iuzLsrvcUnWxAo0fvNrUhOf7LYJ+3at61dZeTIrkaZD4vGNjTbvE0j50TFcjjTC9UM74uprlnQ4+L2A//Cjg==
```

Official Replit documentation search for package licensing and public web
searches for these package licenses returned no relevant evidence. This is
not proof that no agreement exists; no package-specific grant was found.
No generic platform terms were substituted for a redistribution license.

## Previous usage and replacement

- The connectors SDK was imported in invitation-email delivery and bundled
  into the server. It has been replaced with a direct HTTPS request to Resend.
  Delivery now requires the server-side `RESEND_API_KEY` secret plus the
  existing verified sender and application URL. The fallback private link,
  safe failure messages, and token rotation on resend are unchanged.
- Cartographer and dev-banner ran in Vite development mode only, and
  runtime-error-modal applied only to `vite serve`. All three have been
  removed from Vite configuration and workspace manifests.
- Package removal, not development-only status, is what resolves the
  unverified license entries. Inspect actual release archives to ensure they
  do not still include old node_modules or source packages.

## Remaining human decisions

1. Configure and verify the Resend sender, server-side secret, and published
   application URL in each delivery environment. A license scan cannot prove
   a real email is delivered.
2. If older release artifacts include any of the removed packages, secure
   rights-holder authorization for those artifacts or rebuild them without
   the packages before distribution or transfer.
3. Complete MPL-2.0 file/source review, CC-BY-4.0 attribution, Unlicense
   dedication/backup-license review, and applicable notice preservation.

No license approval was inferred for the removed packages. Notice packaging
is a separate workstream, not evidence of permission.

## Reproduction and expected result

```sh
node --test scripts/dependency-license-policy.test.mjs
pnpm run audit:inventory
pnpm run audit:licenses
```

The policy tests pass; inventory generation succeeds. The license command
now exits **0** with no unknown packages in the installed graph, and still
prints MPL-2.0, CC-BY-4.0, and Unlicense review requirements. Unknown
packages would continue to block if introduced; no exception was added.

The inventory propagates development scope through transitive dependencies
while retaining runtime scope for packages also reached from runtime roots.
This corrects graph classification; it does not change license permissions.