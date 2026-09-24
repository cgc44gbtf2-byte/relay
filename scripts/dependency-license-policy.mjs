export const allowedLicenses = new Set([
  "0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause",
  "CC0-1.0", "CC-BY-4.0", "ISC", "MIT", "MIT-0", "MPL-2.0",
  "Python-2.0", "Unlicense",
]);
const reviewLicenses = new Set(["MPL-2.0", "CC-BY-4.0", "Unlicense"]);

// Deliberately conservative: unsupported syntax still requires review.
export function evaluateLicense(expression) {
  const licenses = expression.split(/\s+(?:AND|OR)\s+/i).map((s) => s.trim());
  return {
    allowed: licenses.every((license) => allowedLicenses.has(license)),
    review: licenses.some((license) => reviewLicenses.has(license)),
  };
}

export function dependencyScope(group, parentScope) {
  return parentScope === "development" || group === "devDependencies"
    ? "development"
    : "runtime";
}