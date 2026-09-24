import assert from "node:assert/strict";
import test from "node:test";
import { dependencyScope, evaluateLicense } from "./dependency-license-policy.mjs";

test("unknown and unapproved expressions fail closed", () => {
  for (const expression of ["Unknown", "", "UNLICENSED", "GPL-3.0", "MIT OR Unknown", "(MIT OR ISC)", "MIT WITH custom-exception"]) {
    assert.equal(evaluateLicense(expression).allowed, false, expression);
  }
});

test("existing allowlist and review obligations survive compound expressions", () => {
  assert.deepEqual(evaluateLicense("MIT"), { allowed: true, review: false });
  for (const expression of ["MPL-2.0", "MIT OR MPL-2.0", "MIT AND CC-BY-4.0", "Unlicense"]) {
    assert.deepEqual(evaluateLicense(expression), { allowed: true, review: true });
  }
  assert.deepEqual(evaluateLicense("Unknown AND MPL-2.0"), { allowed: false, review: true });
});

test("development scope propagates through transitive dependencies", () => {
  const direct = dependencyScope("devDependencies");
  assert.equal(direct, "development");
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    assert.equal(dependencyScope(group, direct), "development");
  }
  assert.equal(dependencyScope("dependencies"), "runtime");
  assert.equal(dependencyScope("optionalDependencies", "runtime"), "runtime");
  // Separate production reachability must not inherit a different root's dev scope.
  assert.equal(dependencyScope("dependencies", "runtime"), "runtime");
});