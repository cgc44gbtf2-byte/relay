import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_DATABASE_URL ??= "postgresql://unit-test.invalid/relay_storage_unit";
const {
  isAvailableUnscopedObjectPath,
  isUploadedObjectPathForResource,
  isUnscopedUploadedObjectPath,
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
  assert.equal(validateUploadMetadata({ name: "active.svg", size: 10, contentType: "image/svg+xml; charset=utf-8" }), null);
  assert.equal(validateUploadMetadata({ name: "active.html", size: 10, contentType: "text/html; charset=utf-8" }), null);
  assert.equal(validateUploadMetadata({ name: "file.txt", size: 0, contentType: "text/plain" }), null);
  assert.equal(validateUploadMetadata({ name: "file.txt", size: 25_000_001, contentType: "text/plain" }), null);
  assert.equal(validateUploadMetadata({ name: "file.txt", size: 10, contentType: "application/octet-stream" }), null);
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

test("upload resource context parses workspace channel claims", () => {
  assert.deepEqual(
    parseUploadResourceContext({ workspaceId: "42", resourceType: "channel", resourceId: "7" }),
    { workspaceId: 42, resourceType: "channel", resourceId: 7 },
  );
  assert.equal(parseUploadResourceContext({ workspaceId: "42", resourceType: "channel" }), null);
});

test("uploaded object paths must exactly match scoped resource context", () => {
  const path = "/objects/uploads/123e4567-e89b-12d3-a456-426614174000/workspaces/42/channel/7";
  const context = { workspaceId: 42, resourceType: "channel" as const, resourceId: 7 };
  assert.equal(isUploadedObjectPathForResource(path, context), true);
  assert.equal(isUploadedObjectPathForResource(
    "/objects/uploads/123e4567-e89b-12d3-a456-426614174000/workspaces/43/channel/7",
    context,
  ), false);
  assert.equal(isUploadedObjectPathForResource(
    "/objects/uploads/123e4567-e89b-12d3-a456-426614174000/workspaces/42/channel/8",
    context,
  ), false);
  assert.equal(isUnscopedUploadedObjectPath("/objects/uploads/123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isUnscopedUploadedObjectPath(path), false);
});

test("new unscoped paths are bound to the uploader and bare legacy paths cannot be reattached", async () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "isolated-storage-test-signing-key";
  try {
    const path = uploadObjectPath({}, "original-uploader");
    assert.match(path, /^\/objects\/uploads\/[0-9a-f-]{36}-[0-9a-f]{64}$/);
    assert.equal(isUnscopedUploadedObjectPath(path), true);
    assert.equal(await isAvailableUnscopedObjectPath(path, "other-user"), false);
    assert.equal(await isAvailableUnscopedObjectPath(
      "/objects/uploads/123e4567-e89b-12d3-a456-426614174000", "original-uploader",
    ), false);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});