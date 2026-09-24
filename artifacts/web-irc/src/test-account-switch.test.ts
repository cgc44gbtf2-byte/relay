import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTestAccountReturnContext,
  readTestAccountReturnContext,
  returnToTestAccountOwner,
  TEST_ACCOUNT_RETURN_CONTEXT_KEY,
  verifyTestAccountReturnOwner,
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

  it("rejects a missing return context without persisting credentials", () => {
    expect(readTestAccountReturnContext(sessionStorage, 1000)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("refuses a different owner even when the saved context is otherwise valid", () => {
    writeTestAccountReturnContext({ ownerSessionId: "sess_owner", ownerUserId: "user_owner", workspaceId: 7 }, sessionStorage, 1000);
    const context = readTestAccountReturnContext(sessionStorage, 1001)!;
    expect(() => verifyTestAccountReturnOwner(context, "user_other")).toThrow("did not match the original owner");
    expect(() => verifyTestAccountReturnOwner(context, "user_owner")).not.toThrow();
  });
});

describe("return to owner from a test account", () => {
  const owner = { ownerSessionId: "sess_owner", ownerUserId: "user_owner", workspaceId: 7 };
  function setup() {
    const calls: string[] = [];
    const requestReturnTicket = vi.fn(async (workspaceId: number) => {
      calls.push(`request:${workspaceId}`);
      return { ticket: "one-time-ticket", ownerUserId: owner.ownerUserId };
    });
    const signOutTestSession = vi.fn(async (id: string) => { calls.push(`signOut:${id}`); });
    const signInOwnerWithTicket = vi.fn(async (ticket: string) => { calls.push(`signIn:${ticket}`); return "sess_new_owner"; });
    const activateSession = vi.fn(async (id: string) => { calls.push(`activate:${id}`); });
    const navigateToWorkspace = vi.fn((id: number) => { calls.push(`navigate:${id}`); });
    return {
      calls, requestReturnTicket, signOutTestSession, signInOwnerWithTicket, activateSession, navigateToWorkspace,
      testSessionId: "sess_test", ownerSessions: [], storage: sessionStorage, now: 1001,
    };
  }

  beforeEach(() => sessionStorage.clear());

  it("returns through a new owner ticket when the old session was removed on mobile", async () => {
    writeTestAccountReturnContext(owner, sessionStorage, 1000);
    const options = setup();
    await returnToTestAccountOwner(options);
    expect(options.calls).toEqual([
      "request:7", "signOut:sess_test", "signIn:one-time-ticket", "activate:sess_new_owner", "navigate:7",
    ]);
    expect(sessionStorage.getItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY)).toBeNull();
  });

  it("does not sign out or change session for missing and expired contexts", async () => {
    const options = setup();
    await expect(returnToTestAccountOwner(options)).rejects.toThrow("return context is unavailable");
    writeTestAccountReturnContext(owner, sessionStorage, 1);
    await expect(returnToTestAccountOwner({ ...options, now: 8 * 60 * 60 * 1000 + 2 })).rejects.toThrow("return context is unavailable");
    expect(options.calls).toEqual([]);
    expect(sessionStorage.getItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY)).toBeNull();
  });

  it("refuses a server response for a different owner before sign-out", async () => {
    writeTestAccountReturnContext(owner, sessionStorage, 1000);
    const options = setup();
    options.requestReturnTicket.mockResolvedValue({ ticket: "one-time-ticket", ownerUserId: "user_other" });
    await expect(returnToTestAccountOwner(options)).rejects.toThrow("did not match the original owner");
    expect(options.requestReturnTicket).toHaveBeenCalledExactlyOnceWith(7);
    expect(options.calls).toEqual([]);
    expect(options.signOutTestSession).not.toHaveBeenCalled();
    expect(options.activateSession).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY)).not.toBeNull();
  });

  it("validates the return endpoint even with a cached owner session", async () => {
    writeTestAccountReturnContext(owner, sessionStorage, 1000);
    const options = setup();
    await returnToTestAccountOwner({
      ...options, ownerSessions: [{ id: "sess_owner", status: "active", user: { id: "user_owner" } }],
    });
    expect(options.calls).toEqual(["request:7", "activate:sess_owner", "navigate:7"]);
    expect(options.signInOwnerWithTicket).not.toHaveBeenCalled();
  });
});