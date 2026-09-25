import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dependencyScope } from "./dependency-license-policy.mjs";

const rootDir = process.cwd();
const packageJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const markdown = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
const packagePathFor = (value) => value ? path.resolve(value) : null;

const workspaceRoots = JSON.parse(execFileSync("pnpm", [
  "list",
  "--recursive",
  "--depth",
  "Infinity",
  "--json",
], { cwd: rootDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const licenseReport = JSON.parse(execFileSync("pnpm", [
  "licenses",
  "list",
  "--json",
], { cwd: rootDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));

const workspaceByName = new Map(
  workspaceRoots.map((root) => [root.name, root]),
);
const licenseByPath = new Map();
const licenseByPackageVersion = new Map();

for (const [license, entries] of Object.entries(licenseReport)) {
  for (const entry of entries) {
    for (const version of entry.versions ?? []) {
      licenseByPackageVersion.set(`${entry.name}@${version}`, license);
    }
    for (const packagePath of entry.paths ?? []) {
      licenseByPath.set(path.resolve(packagePath), license);
    }
  }
}

function packageMetadata(packagePath) {
  if (!packagePath) return {};
  const filePath = path.join(packagePath, "package.json");
  if (!existsSync(filePath)) return {};
  return packageJson(filePath);
}

function packageLicenseFiles(packagePath) {
  if (!packagePath || !existsSync(packagePath)) return [];
  const names = [];
  const visit = (directory, depth) => {
    if (depth > 2) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && /^(license|copying|notice)(\.|$)/i.test(entry.name)) {
        names.push(path.relative(packagePath, entryPath));
      } else if (entry.isDirectory() && depth < 2 && entry.name !== "node_modules") {
        visit(entryPath, depth + 1);
      }
    }
  };
  visit(packagePath, 0);
  return names.sort();
}

function formatLicense(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.type === "string") return value.type;
  return JSON.stringify(value);
}

function classifyLicense(license, internal) {
  if (internal) return "Relay workspace package";
  if (!license || license === "Unknown") return "Unknown/unverified";
  const normalized = license.toLowerCase();
  if (/(gpl|agpl|lgpl|sspl|mpl|epl|cddl|eup[l]?|osl)/.test(normalized)) {
    return "Copyleft";
  }
  if (/(proprietary|commercial|unlicensed|source-available|non-commercial)/.test(normalized)) {
    return "Proprietary/commercial";
  }
  return "Permissive";
}

function obligationsFor(license, evidence) {
  if (!license || license === "Unknown") {
    return "Verify terms before distribution; no license grant is recorded in the installed metadata.";
  }
  const normalized = license.toLowerCase();
  const obligations = [];
  if (normalized.includes("mpl")) {
    obligations.push("MPL-2.0 file-level source and notice obligations if Covered Software is distributed or modified");
  }
  if (normalized.includes("cc-by")) {
    obligations.push("attribution and license notice");
  }
  if (/(apache|mit|bsd|isc|python|blueoak|0bsd)/.test(normalized)) {
    obligations.push("preserve copyright and license notices");
  }
  if (normalized.includes("unlicense")) {
    obligations.push("record the public-domain dedication/backup license terms");
  }
  if (obligations.length === 0) obligations.push("review the license text and retain required notices");
  if (evidence.includes("license file")) obligations.push(`evidence: ${evidence}`);
  return obligations.join("; ");
}

const records = new Map();

function recordDependency({
  name,
  node,
  parent,
  rootName,
  group,
  direct,
}) {
  if (!node) return;
  const workspace = String(node.version ?? "").startsWith("link:") || workspaceByName.has(name);
  const workspaceRoot = workspaceByName.get(name);
  const installedVersion = workspace
    ? workspaceRoot?.version ?? "workspace"
    : node.version ?? packageMetadata(packagePathFor(node.path)).version ?? "unknown";
  const key = workspace ? `workspace:${name}` : `${name}@${installedVersion}`;
  let record = records.get(key);
  if (!record) {
    record = {
      name,
      version: installedVersion,
      internal: workspace,
      direct: false,
      scopes: new Set(),
      parents: new Set(),
      roots: new Set(),
      paths: new Set(),
      resolved: new Set(),
    };
    records.set(key, record);
  }
  record.direct ||= direct;
  const scope = dependencyScope(group, group);
  record.scopes.add(scope);
  record.parents.add(parent);
  record.roots.add(rootName);
  if (node.path) record.paths.add(path.resolve(node.path));
  if (node.resolved) record.resolved.add(node.resolved);

  for (const childGroup of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [childName, childNode] of Object.entries(node[childGroup] ?? {})) {
      recordDependency({
        name: childName,
        node: childNode,
        parent: name,
        rootName,
        group: dependencyScope(childGroup, scope),
        direct: false,
      });
    }
  }
}

for (const root of workspaceRoots) {
  for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, node] of Object.entries(root[group] ?? {})) {
      recordDependency({
        name,
        node,
        parent: root.name,
        rootName: root.name,
        group,
        direct: true,
      });
    }
  }
}

function details(record) {
  if (record.internal) {
    return {
      availability: "installed in workspace",
      license: "Relay-original workspace code",
      category: "Relay workspace package",
      evidence: "workspace package in this repository",
      obligations: "ownership depends on contributor and assignment records, not an npm license",
      repository: "",
    };
  }
  const packagePath = [...record.paths].find((candidate) => existsSync(candidate));
  const availability = packagePath ? "installed" : "graph-only optional; not installed on current platform";
  const metadata = packageMetadata(packagePath);
  const packageLicense = formatLicense(metadata.license);
  const reportLicense = licenseByPath.get(packagePath)
    ?? licenseByPackageVersion.get(`${record.name}@${record.version}`);
  const license = packagePath ? packageLicense ?? reportLicense ?? "Unknown" : "Unknown";
  const licenseFiles = packageLicenseFiles(packagePath);
  const evidence = packageLicense
    ? "package.json license field"
    : licenseFiles.length
      ? `package license file: ${licenseFiles.join(", ")}`
      : license === "Unknown"
        ? availability === "installed"
          ? "no license field or license file found in installed package"
          : "package appears in the dependency graph but is not installed on the current platform"
        : "pnpm license report";
  return {
    availability,
    license,
    category: classifyLicense(license, false),
    evidence,
    obligations: obligationsFor(license, evidence),
    repository: typeof metadata.repository === "string"
      ? metadata.repository
      : metadata.repository?.url ?? metadata.homepage ?? "",
  };
}

const rows = [...records.values()]
  .map((record) => ({ ...record, ...details(record) }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const thirdParty = rows.filter((row) => !row.internal);
const unknown = thirdParty.filter((row) => row.category === "Unknown/unverified");
const installedUnknown = unknown.filter((row) => row.availability === "installed");
const graphOnlyUnknown = unknown.filter((row) => row.availability !== "installed");
const copyleft = thirdParty.filter((row) => row.category === "Copyleft");
const proprietary = thirdParty.filter((row) => row.category === "Proprietary/commercial");
const attribution = thirdParty.filter((row) => /attribution|notice|source|public-domain/i.test(row.obligations));
const licenseCounts = new Map();
for (const row of thirdParty) licenseCounts.set(row.license, (licenseCounts.get(row.license) ?? 0) + 1);
const snapshotDate = new Date().toISOString().slice(0, 10);

const tableRows = rows.map((row) => [
  row.name,
  row.version,
  row.availability,
  row.internal ? "workspace" : row.direct ? "direct" : "transitive",
  [...row.scopes].sort().join(", "),
  [...row.parents].sort().slice(0, 8).join(", ") + (row.parents.size > 8 ? ", …" : ""),
  row.license,
  row.category,
  row.evidence,
  row.repository || "not provided",
  row.obligations,
].map(markdown).join(" | "));

const inventory = `# Dependency inventory

**Snapshot date:** ${snapshotDate}
**Sources:** \`pnpm-lock.yaml\`, \`pnpm list --recursive --depth Infinity --json\`, installed package \`package.json\` files, installed license files, and \`pnpm licenses list --json\`.

This snapshot records every unique package/version reported by the workspace
dependency graph, including workspace packages, direct dependencies, transitive
dependencies, and optional platform packages that are not installed on the
current platform. It does not assert that an unknown license is permissive or
proprietary.

## Summary

- Unique records: **${rows.length}**
- Records physically present in current \`node_modules\`: **${rows.filter((row) => row.availability === "installed" || row.availability === "installed in workspace").length}**
- Third-party records: **${thirdParty.length}**
- Relay workspace records: **${rows.length - thirdParty.length}**
- Graph-only optional records: **${rows.filter((row) => row.availability !== "installed" && row.availability !== "installed in workspace").length}**
- Direct records: **${rows.filter((row) => row.direct).length}**
- Transitive records: **${rows.filter((row) => !row.direct && !row.internal).length}**
- Unknown/unverified licenses in current install: **${installedUnknown.length}**
- Unknown/unverified graph-only optional licenses: **${graphOnlyUnknown.length}**
- Copyleft licenses: **${copyleft.length}**
- Proprietary/commercial licenses identified from metadata: **${proprietary.length}**

The complete record is below. A package can be runtime and development scoped
when it is reachable from more than one workspace package.

| Package | Version in installed graph | Availability | Reach | Scope | Parent package(s) | License | Classification | Evidence | Repository/homepage | Obligations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ${tableRows.join("\n| ")} |
`;

const licenseSections = [...licenseCounts.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([license, count]) => `- **${license}:** ${count}`)
  .join("\n");

const thirdPartyLicenseDoc = `# Third-party licenses

**Snapshot date:** ${snapshotDate}
**Source:** installed package metadata and package license files, cross-checked
with \`pnpm licenses list --json\`.

This document separates what was verified from what remains unresolved. A
package with an unknown license is not classified as proprietary, permissive,
or copyleft.

## License distribution

${licenseSections}

## Permissive licenses

The installed graph contains packages reporting MIT, MIT-0, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, Python-2.0, CC0-1.0,
Unlicense, CC-BY-4.0, and MIT AND ISC. Their exact package/version rows and
evidence are in [DEPENDENCY-INVENTORY.md](./DEPENDENCY-INVENTORY.md).
Permissive does not mean obligation-free: copyright, license, notice, or
attribution requirements still apply where the license text requires them.

## Copyleft licenses

${copyleft.length === 0 ? "No GPL, AGPL, LGPL, EPL, CDDL, SSPL, or other copyleft license besides MPL-2.0 was found." : copyleft.map((row) => `- \`${row.name}@${row.version}\` — ${row.license}; ${row.evidence}`).join("\n")}

## Unknown or unverified licenses

See [Replit package evidence and removal history](./REPLIT-PACKAGE-LICENSE-REVIEW.md)
for the distinction between runtime and development-only packages. Scope does not grant a license.

${installedUnknown.length === 0 ? "None among packages installed on the current platform." : installedUnknown.map((row) => `- \`${row.name}@${row.version}\` — ${row.evidence}; no license conclusion is made.`).join("\n")}

### Graph-only optional packages

${graphOnlyUnknown.length === 0 ? "None." : graphOnlyUnknown.map((row) => `- \`${row.name}@${row.version}\` — ${row.evidence}; it is not installed on the current platform, so its license must be verified before building for a platform that selects it.`).join("\n")}

## Proprietary or commercial dependencies

No installed package reported a proprietary or commercial license in the
available metadata. Unknown packages are not placed in this category. External
services and account terms are outside this npm package scan and require their
own contract review.

## Attribution and notice obligations

${attribution.length === 0 ? "No additional attribution or notice candidates were identified." : attribution.map((row) => `- \`${row.name}@${row.version}\` — ${row.license}; ${row.obligations}`).join("\n")}
`;

const replitRows = thirdParty.filter((row) => row.name.startsWith("@replit/"));
const replitSection = replitRows.length === 0
  ? "No @replit packages were found."
  : replitRows.map((row) => `- \`${row.name}@${row.version}\` — ${row.license}; ${row.evidence}; ${row.availability}; used by ${[...row.roots].sort().join(", ")}.`).join("\n");

const compliance = `# License compliance and acquisition readiness

**Snapshot date:** ${snapshotDate}
**Status:** ${installedUnknown.length
  ? "**Not cleared for acquisition** while unverified dependency licenses remain."
  : "The dependency license gate passes for the current installed graph. This is **not an acquisition sign-off**; notices and legal review remain outstanding."}

This is a technical evidence report. It does not determine legal ownership,
trademark rights, or the legal interpretation of any license beyond the
license text and metadata identified below.

## Dependency license gate

${installedUnknown.length
  ? `**${installedUnknown.length} installed package records are unverified:** ${installedUnknown.map((row) => `\`${row.name}@${row.version}\``).join(", ")}. \`pnpm run audit:licenses\` fails while installed unknowns remain.`
  : "No installed package has an unknown license in this snapshot. `pnpm run audit:licenses` passes the technical allowlist; this does not approve distribution."}

The graph includes ${graphOnlyUnknown.length} platform-optional unknown records
not installed here: ${graphOnlyUnknown.map((row) => `\`${row.name}@${row.version}\``).join(", ") || "none"}.
Check their licenses before building on a platform that installs them.

**Notice handling:** the API and web production builds now generate
\`THIRD-PARTY-NOTICES.txt\` and a package/version manifest in their respective
outputs. \`pnpm run verify:release-notices\` checks both local outputs and fails
if a selected package lacks license text. The bundle is conservatively scoped
to bundler inputs plus runtime-reachable packages; it is not a legal approval
or proof of what an as-yet-uninspected published archive contains.

## Items requiring legal or license review

- **Lightning CSS:** \`lightningcss@1.32.0\` and
  \`lightningcss-linux-x64-gnu@1.32.0\` report MPL-2.0 and include a LICENSE
  file. They are reachable through \`@tailwindcss/vite -> @tailwindcss/node\`
  and Vite's peer toolchain in the web and mockup build environments. The
  repository has no direct application import. \`artifacts/api-server/build.mjs\`
  lists \`lightningcss\` as an external bundling candidate, but no API source
  import was found.
- **MPL-2.0 obligations for this usage:** if the MPL-covered package itself or
  a modification is distributed in executable form, make the corresponding
  Covered Software available in source form under MPL-2.0, tell recipients how
  to obtain it, and do not remove or alter substantive license, copyright,
  patent, disclaimer, or limitation notices. A Larger Work may remain under
  other terms when the MPL-covered material is in separate files, but the MPL
  requirements still apply to that material. No repository modification to
  Lightning CSS was found in this audit.
- **CC-BY-4.0:** \`caniuse-lite\` reports CC-BY-4.0; retain the required
  attribution and license information if its data is distributed.
- **Unlicense:** \`fast-sha256\` and \`wouter\` report Unlicense; preserve the
  license evidence and have counsel review how the public-domain dedication
  and backup license are treated in each distribution jurisdiction.
- **Replit packages:** ${replitRows.length
  ? "the exact terms for the packages below could not be verified from installed metadata or package/license files:"
  : "none remain installed. The unverified packages were removed, not approved. See [removal history](./REPLIT-PACKAGE-LICENSE-REVIEW.md)."}

${replitRows.length ? `\n${replitSection}\n` : ""}

## Items requiring documentation

- Check that the generated notices and version manifests accompany the actual
  published browser/server deliverables; local build verification is not a
  substitute for inspecting the shipped release.
- Review the exact source and version used for each production browser/server
  artifact, including any external runtime packages.
- Preserve the Lightning CSS MPL-2.0 LICENSE file and any source-availability
  information when shipping artifacts that include it.
${replitRows.length ? "- Obtain written license evidence for the unresolved Replit packages.\n- Document whether development-only packages are excluded from customer distribution; do not treat dev-only status as a license clearance." : "- Verify that release archives contain only the intended production dependencies and notices."}

## Items requiring replacement or removal

${replitRows.length
  ? "Unresolved installed packages must receive authoritative license evidence or be removed before clearance."
  : "The four previously unverified Replit packages were removed from the current dependency graph. Invitation delivery now uses Resend's HTTPS API directly; the Replit-only Vite development plugins were removed. See [removal history](./REPLIT-PACKAGE-LICENSE-REVIEW.md)."}

## Already compliant at the technical screening level

- ${thirdParty.length - unknown.length} third-party package records have a
  recognized license expression in package metadata or an installed license
  file.
- The workspace does not report GPL, AGPL, LGPL, SSPL, EPL, or CDDL packages
  in the current installed graph.
- The root workspace is private and marked \`UNLICENSED\`; this avoids
  implying that Relay itself is MIT-licensed. It is not a legal ownership
  determination and still requires an approved legal owner/copyright policy.

## Verification commands

\`\`\`sh
pnpm run audit:inventory
pnpm run audit:licenses
pnpm why lightningcss --recursive
\`\`\`

The inventory is a snapshot and must be regenerated after dependency changes.
`;

const ipOwnership = `# Relay IP ownership and provenance

**Snapshot date:** ${snapshotDate}

This document distinguishes repository evidence from legal ownership. No
domain, trademark, registrar, contributor assignment, account, or user-asset
ownership is asserted unless it is directly evidenced in the repository.

## Relay-original code

Repository-authored implementation appears in:

- \`artifacts/api-server/src/\` — Express API, authorization, workspace
  isolation, WebSocket hub, notifications, audit and release behavior.
- \`artifacts/web-irc/src/\` — Relay web application behavior and UI.
- \`lib/db/src/schema/\` — Drizzle schema definitions.
- \`lib/api-spec/openapi.yaml\` — API contract source.
- \`scripts/\` and root configuration — build, test, and audit tooling.

Repository presence is evidence of possession in this workspace, not proof
that every contributor assigned rights to a legal entity.

## Third-party code

The complete installed dependency graph is in
[DEPENDENCY-INVENTORY.md](./DEPENDENCY-INVENTORY.md). Third-party source,
compiled packages, package metadata, and license obligations remain subject
to their respective licenses.

## Generated code

Generated artifacts include:

- \`lib/api-zod/src/generated/\`
- \`lib/api-client-react/src/generated/\`

Their generation sources are in \`lib/api-spec/openapi.yaml\` and
\`lib/api-spec/orval.config.ts\`. Generated output should not be treated as
independent proof of ownership without reviewing the generator and all
included schemas/templates.

## Open-source dependencies

License categories, exact installed versions, evidence, and obligations are
listed in [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md) and
[LICENSE-COMPLIANCE.md](./LICENSE-COMPLIANCE.md). Unknown licenses remain
unverified and are not classified.

## Replit-provided components

${replitRows.length ? "The installed graph includes Replit-namespaced packages:" : "No Replit-namespaced packages remain in the current installed graph."}

${replitRows.length ? `\n${replitSection}\n` : ""}

${replitRows.length ? "Their installed package metadata does not contain a license field or license file in this snapshot. No ownership or license conclusion is made. Obtain authoritative terms before acquisition clearance." : "The prior unclassified package versions were removed rather than assigned an unsupported license. See the [investigation](./REPLIT-PACKAGE-LICENSE-REVIEW.md)."}

## User-provided assets

The repository contains \`attached_assets/\` and source-controlled product
assets such as \`artifacts/web-irc/public/logo.svg\`. The source repository
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
${unknown.length ? "- Resolved license evidence for every unknown package." : "- Preserve current package license evidence and review any newly introduced unknown dependency before release."}
`;

writeFileSync(path.join(rootDir, "docs/DEPENDENCY-INVENTORY.md"), inventory);
writeFileSync(path.join(rootDir, "docs/THIRD-PARTY-LICENSES.md"), thirdPartyLicenseDoc);
writeFileSync(path.join(rootDir, "docs/LICENSE-COMPLIANCE.md"), compliance);
writeFileSync(path.join(rootDir, "docs/IP-OWNERSHIP.md"), ipOwnership);

console.log(`Generated ${rows.length} dependency records and four acquisition documents.`);