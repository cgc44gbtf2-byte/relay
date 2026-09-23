import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTestAccountReturnContext,
  readTestAccountReturnContext,
  TEST_ACCOUNT_RETURN_CONTEXT_KEY,
  writeTestAccountReturnContext,
} from "./test-account-switch";

describe("test account return context", () => {
  beforeEach(() => sessionStorage.clear());

  it("round trips a versioned context without credentials", () => {
    writeTestAccountReturnContext({ ownerSessionId: "sess_owner", ownerUserId: "user_owner", workspaceId: 7 }, sessionStorage, 1000);
    expect(readTestAccountReturnContext(sessionStorage, 1001)).toMatchObject({
      version: 1, ownerSessionId: "sess_owner", ownerUserId: "user_owner", workspaceId: 7, savedAt: 1000,
    });
    expect(sessionStorage.getItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY)).not.toContain("ticket");
  });

  it("removes corrupt and expired values", () => {
    sessionStorage.setItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY, "{bad");
    expect(readTestAccountReturnContext(sessionStorage, 1000)).toBeNull();
    expect(sessionStorage.getItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY)).toBeNull();
    writeTestAccountReturnContext({ ownerSessionId: "s", ownerUserId: "u", workspaceId: 1 }, sessionStorage, 1);
    expect(readTestAccountReturnContext(sessionStorage, 8 * 60 * 60 * 1000 + 2)).toBeNull();
    expect(sessionStorage.getItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY)).toBeNull();
  });

  it("rejects malformed contexts", () => {
    sessionStorage.setItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY, JSON.stringify({
      version: 1, ownerSessionId: "", ownerUserId: "u", workspaceId: 0, savedAt: 100,
    }));
    expect(readTestAccountReturnContext(sessionStorage, 100)).toBeNull();
    clearTestAccountReturnContext();
  });
});