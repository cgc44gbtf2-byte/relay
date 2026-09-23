import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  confirmationMatches,
  exactCommunityOwner,
  targetMayBePermanentlyDeleted,
} from "./destructive-policy";

describe("destructive workspace policy", () => {
  test("requires exact owner identity", () => {
    assert.equal(exactCommunityOwner("owner", "owner"), true);
    assert.equal(exactCommunityOwner("owner", "admin"), false);
  });
  test("requires an exact typed confirmation", () => {
    assert.equal(confirmationMatches(ACCOUNT_DELETION_CONFIRMATION, "DELETE ACCOUNT Ada FROM WORKSPACE Acme", "Ada", "Acme"), true);
    assert.equal(confirmationMatches(ACCOUNT_DELETION_CONFIRMATION, "DELETE ACCOUNT ada FROM WORKSPACE Acme", "Ada", "Acme"), false);
  });
  test("only permits global deletion when every membership is requester-owned", () => {
    assert.equal(targetMayBePermanentlyDeleted([1, 2], [], [1, 2]), true);
    assert.equal(targetMayBePermanentlyDeleted([1, 3], [], [1, 2]), false);
    assert.equal(targetMayBePermanentlyDeleted([1], [9], [1, 9]), false);
  });
});