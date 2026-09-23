import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  exactWorkspaceOwner,
  isMarkedTestAccount,
  testAccountExternalId,
  testAccountMetadata,
  testAccountsAvailable,
  TEST_ACCOUNT_ROLES,
} from "./test-account-policy";

describe("Relay test account policy", () => {
  test("only allows development Clerk test keys", () => {
    assert.equal(testAccountsAvailable({ NODE_ENV: "development", CLERK_SECRET_KEY: "sk_test_x", CLERK_PUBLISHABLE_KEY: "pk_test_x" }), true);
    assert.equal(testAccountsAvailable({ NODE_ENV: "production", CLERK_SECRET_KEY: "sk_test_x", CLERK_PUBLISHABLE_KEY: "pk_test_x" }), false);
    assert.equal(testAccountsAvailable({ NODE_ENV: "development", CLERK_SECRET_KEY: "sk_live_x", CLERK_PUBLISHABLE_KEY: "pk_test_x" }), false);
  });
  test("requires exact owner identity and rejects cross-workspace markers", () => {
    assert.equal(exactWorkspaceOwner("owner-1", "owner-1"), true);
    assert.equal(exactWorkspaceOwner("owner-1", "manager-1"), false);
    const metadata = testAccountMetadata(7, "member", "owner-1");
    assert.equal(isMarkedTestAccount(metadata, 7, "member"), true);
    assert.equal(isMarkedTestAccount(metadata, 8, "member"), false);
    assert.equal(isMarkedTestAccount(metadata, 7, "workspace_owner"), false);
  });
  test("keeps the exact five non-owner role identifiers", () => {
    assert.deepEqual(TEST_ACCOUNT_ROLES, ["workspace_admin", "department_admin", "manager", "moderator", "member"]);
    assert.equal(testAccountExternalId(7, "manager"), "relay-test:7:manager");
  });
});