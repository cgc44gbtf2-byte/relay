import test from "node:test";
import assert from "node:assert/strict";
import { isPositiveSafeInteger, isValidQuery } from "./validation";

process.env.TEST_DATABASE_URL ??= "postgresql://unit-test.invalid/relay_validation_unit";
const { validateUploadMetadata } = require("../routes/storage") as typeof import("../routes/storage");

test("query validation accepts at most 200 characters", () => {
  assert.equal(isValidQuery("x".repeat(200)), true);
  assert.equal(isValidQuery("x".repeat(201)), false);
  assert.equal(isValidQuery(123), false);
});

test("upload metadata validation rejects unsafe metadata", () => {
  assert.deepEqual(validateUploadMetadata({
    name: "report.pdf",
    size: 1024,
    contentType: "application/pdf",
  }), {
    name: "report.pdf",
    size: 1024,
    contentType: "application/pdf",
  });
  assert.equal(validateUploadMetadata({
    name: "report.pdf",
    size: 25_000_001,
    contentType: "application/pdf",
  }), null);
  assert.equal(validateUploadMetadata({
    name: "../report.pdf",
    size: 1024,
    contentType: "application/pdf",
  }), null);
  assert.equal(validateUploadMetadata({
    name: "page.html",
    size: 1024,
    contentType: "text/html",
  }), null);
});

test("scope and assignment IDs must be positive safe integers", () => {
  assert.equal(isPositiveSafeInteger(1), true);
  assert.equal(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isPositiveSafeInteger(0), false);
  assert.equal(isPositiveSafeInteger(-1), false);
  assert.equal(isPositiveSafeInteger(1.5), false);
  assert.equal(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isPositiveSafeInteger("1"), false);
});