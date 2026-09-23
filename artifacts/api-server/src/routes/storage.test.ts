import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_DATABASE_URL ??= "postgresql://unit-test.invalid/relay_storage_unit";
const {
  isValidUploadedObjectPath,
  parseUploadResourceContext,
  uploadObjectPath,
  validateUploadMetadata,
} = require("./storage") as typeof import("./storage");

test("upload metadata requires a bounded name, size, and supported type", () => {
  assert.deepEqual(validateUploadMetadata({
    name: "report.pdf",
    size: 1024,
    contentType: "application/pdf",
  }), { name: "report.pdf", size: 1024, contentType: "application/pdf" });
  assert.equal(validateUploadMetadata({ name: "../secret", size: 10, contentType: "text/plain" }), null);
  assert.equal(validateUploadMetadata({ name: "file.bin", size: 10, contentType: "application/octet-stream" }), null);
  assert.equal(validateUploadMetadata({ name: "active.svg", size: 10, contentType: "image/svg+xml" }), null);
  assert.equal(validateUploadMetadata({ name: "active.html", size: 10, contentType: "text/html" }), null);
  assert.equal(validateUploadMetadata({ name: "file.txt", size: 25_000_001, contentType: "text/plain" }), null);
});

test("resource context produces a workspace-scoped object path", () => {
  process.env.PRIVATE_OBJECT_DIR = "/private";
  const path = uploadObjectPath({ workspaceId: "42", resourceType: "document", resourceId: "7" });
  assert.match(path, /^\/objects\/uploads\/[0-9a-f-]{36}\/workspaces\/42\/document\/7$/i);
  assert.equal(isValidUploadedObjectPath(path), true);
  assert.equal(isValidUploadedObjectPath("/objects/uploads/123e4567-e89b-12d3-a456-426614174000/../../secret"), false);
});

test("upload resource context rejects incomplete and unsupported workspace claims", () => {
  assert.equal(parseUploadResourceContext({}), undefined);
  assert.equal(parseUploadResourceContext({ workspaceId: "42" }), null);
  assert.equal(parseUploadResourceContext({ workspaceId: "42", resourceType: "document" }), null);
  assert.equal(parseUploadResourceContext({ workspaceId: "42", resourceType: "profile", resourceId: "7" }), null);
  assert.equal(parseUploadResourceContext({ workspaceId: "42", resourceType: "task", resourceId: "new" }), null);
  assert.deepEqual(
    parseUploadResourceContext({ workspaceId: "42", resourceType: "document", resourceId: "new" }),
    { workspaceId: 42, resourceType: "document", resourceId: "new" },
  );
  assert.deepEqual(
    parseUploadResourceContext({ workspaceId: 42, resourceType: "announcement", resourceId: "7" }),
    { workspaceId: 42, resourceType: "announcement", resourceId: 7 },
  );
});