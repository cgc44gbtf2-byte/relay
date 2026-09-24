import { execFileSync } from "node:child_process";
import { evaluateLicense } from "./dependency-license-policy.mjs";

let report;
let productionPackages;
try {
  report = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  }));
  const production = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  }));
  productionPackages = new Set(Object.values(production).flatMap((packages) =>
    packages.flatMap(({ name, versions }) => versions.map((version) => `${name}@${version}`)),
  ));
} catch (error) {
  console.error("Could not read the installed dependency license report.");
  process.exitCode = 1;
  throw error;
}

const unresolved = [];
const review = [];

for (const [license, packages] of Object.entries(report)) {
  const policy = evaluateLicense(license);
  if (policy.review) review.push({ license, packages });
  if (!policy.allowed) {
    unresolved.push({ license, packages });
  }
}

if (review.length > 0) {
  console.warn("Dependency licenses requiring attribution or file-level review:");
  for (const { license, packages } of review) {
    console.warn(`- ${license}: ${packages.map(({ name }) => name).join(", ")}`);
  }
}

if (unresolved.length > 0) {
  console.error("Dependency licenses that are not cleared for acquisition:");
  for (const { license, packages } of unresolved) {
    for (const { name, versions } of packages) {
      for (const version of versions) {
        const key = `${name}@${version}`;
        const scope = productionPackages.has(key) ? "runtime-reachable" : "development-only dependency graph";
        console.error(`- ${license}: ${key} [${scope}]`);
      }
    }
  }
  console.error("Scope is not license approval or proof of bundle contents. Development tools remain subject to review.");
  console.error("Replit package evidence and required approvals: docs/REPLIT-PACKAGE-LICENSE-REVIEW.md");
  process.exitCode = 1;
} else {
  console.log("All installed dependency licenses pass the technical allowlist; attribution and indicated legal reviews still apply.");
}