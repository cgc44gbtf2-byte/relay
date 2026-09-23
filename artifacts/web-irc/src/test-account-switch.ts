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
  storage: Storage = window.sessionStorage,
  now = Date.now(),
): void {
  storage.setItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY, JSON.stringify({
    ...context,
    version: TEST_ACCOUNT_RETURN_CONTEXT_VERSION,
    savedAt: now,
  }));
}

export function readTestAccountReturnContext(
  storage: Storage = window.sessionStorage,
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

export function clearTestAccountReturnContext(storage: Storage = window.sessionStorage): void {
  storage.removeItem(TEST_ACCOUNT_RETURN_CONTEXT_KEY);
}