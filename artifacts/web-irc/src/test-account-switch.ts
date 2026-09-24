export const TEST_ACCOUNT_RETURN_CONTEXT_KEY = "relay:test-account:return-context";
export const TEST_ACCOUNT_RETURN_CONTEXT_VERSION = 1;
export const TEST_ACCOUNT_RETURN_CONTEXT_TTL_MS = 8 * 60 * 60 * 1000;

export type TestAccountReturnContext = {
  version: 1;
  ownerSessionId: string;
  ownerUserId: string;
  workspaceId: number;
  savedAt: number;
};

function isValidContext(value: unknown, now: number): value is TestAccountReturnContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<TestAccountReturnContext>;
  return context.version === TEST_ACCOUNT_RETURN_CONTEXT_VERSION
    && typeof context.ownerSessionId === "string" && context.ownerSessionId.trim().length > 0
    && typeof context.ownerUserId === "string" && context.ownerUserId.trim().length > 0
    && typeof context.workspaceId === "number" && Number.isInteger(context.workspaceId) && context.workspaceId > 0
    && typeof context.savedAt === "number" && Number.isFinite(context.savedAt)
    && context.savedAt > 0 && now - context.savedAt >= 0 && now - context.savedAt <= TEST_ACCOUNT_RETURN_CONTEXT_TTL_MS;
}

export function writeTestAccountReturnContext(
  context: Omit<TestAccountReturnContext, "version" | "savedAt">,
  storage: Storage = window.localStorage,
  now = Date.now(),
): void {
  storage.setItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY, JSON.stringify({
    ...context,
    version: TEST_ACCOUNT_RETURN_CONTEXT_VERSION,
    savedAt: now,
  }));
}

export function readTestAccountReturnContext(
  storage: Storage = window.localStorage,
  now = Date.now(),
): TestAccountReturnContext | null {
  const raw = storage.getItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValidContext(parsed, now)) return parsed;
  } catch {
    // Invalid JSON is removed below.
  }
  storage.removeItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY);
  return null;
}

export function clearTestAccountReturnContext(storage: Storage = window.localStorage): void {
  storage.removeItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY);
}

export function verifyTestAccountReturnOwner(context: TestAccountReturnContext, ownerUserId: string): void {
  if (ownerUserId !== context.ownerUserId) {
    throw new Error("The owner return identity did not match the original owner.");
  }
}

type OwnerSession = { id: string; status: string; user?: { id: string } | null };

export async function returnToTestAccountOwner(options: {
  testSessionId: string | undefined;
  ownerSessions: OwnerSession[];
  requestReturnTicket: (workspaceId: number) => Promise<{ ticket: string; ownerUserId: string }>;
  signOutTestSession: (sessionId: string) => Promise<unknown>;
  signInOwnerWithTicket: (ticket: string) => Promise<string>;
  activateSession: (sessionId: string) => Promise<unknown>;
  navigateToWorkspace: (workspaceId: number) => void;
  storage?: Storage;
  now?: number;
}): Promise<void> {
  const storage = options.storage ?? window.localStorage;
  const context = readTestAccountReturnContext(storage, options.now);
  if (!context) throw new Error("Your owner return context is unavailable. Sign out and sign in again to return to the owner account.");
  if (!options.testSessionId) throw new Error("Your test-account session is unavailable.");

  // Always check the current test identity against its workspace on the server,
  // even when Clerk still has the previous owner session on this device.
  const result = await options.requestReturnTicket(context.workspaceId);
  verifyTestAccountReturnOwner(context, result.ownerUserId);
  const ownerSession = options.ownerSessions.find((item) => item.id === context.ownerSessionId);
  if (ownerSession?.status === "active" && ownerSession.user?.id === context.ownerUserId) {
    await options.activateSession(context.ownerSessionId);
  } else {
    await options.signOutTestSession(options.testSessionId);
    const newOwnerSessionId = await options.signInOwnerWithTicket(result.ticket);
    await options.activateSession(newOwnerSessionId);
  }
  clearTestAccountReturnContext(storage);
  options.navigateToWorkspace(context.workspaceId);
}