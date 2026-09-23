import { execFileSync } from "node:child_process";

const allowedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
]);

const reviewLicenses = new Set(["MPL-2.0", "CC-BY-4.0", "Unlicense"]);

function isAllowed(expression) {
  return expression
    .split(/\s+(?:AND|OR)\s+/i)
    .every((license) => allowedLicenses.has(license.trim()));
}

let report;
try {
  report = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }));
} catch (error) {
  console.error("Could not read the installed dependency license report.");
  process.exitCode = 1;
  throw error;
}

const unresolved = [];
const review = [];

for (const [license, packages] of Object.entries(report)) {
  if (!isAllowed(license) || license === "Unknown") {
    unresolved.push({ license, packages });
    continue;
  }
  if (reviewLicenses.has(license)) {
    review.push({ license, packages });
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
    console.error(`- ${license}: ${packages.map(({ name }) => name).join(", ")}`);
  }
  process.exitCode = 1;
} else {
  console.log("All installed dependency licenses are in the approved commercial-use set.");
}