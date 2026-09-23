import { clerkClient, getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";

export type AuthenticatedRequest = Request & { userId?: string; user?: User };

export const SESSION_STATUS_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 2_000 : 5_000;
const MAX_SESSION_STATUS_CACHE_ENTRIES = 10_000;
const sessionStatusCache = new Map<string, { active: boolean; userId: string; expiresAt: number }>();
const sessionStatusRequests = new Map<string, Promise<{ active: boolean; userId: string }>>();
const testSessionStatuses = new Map<string, { active: boolean; userId: string }>();

export function setTestSessionStatus(
  sessionId: string,
  value: { active: boolean; userId: string },
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test session overrides are only available when NODE_ENV=test.");
  }
  testSessionStatuses.set(sessionId, value);
  sessionStatusCache.delete(sessionId);
}

function cacheSessionStatus(sessionId: string, value: { active: boolean; userId: string }): void {
  if (sessionStatusCache.size >= MAX_SESSION_STATUS_CACHE_ENTRIES && !sessionStatusCache.has(sessionId)) {
    const oldest = sessionStatusCache.keys().next().value;
    if (oldest) sessionStatusCache.delete(oldest);
  }
  sessionStatusCache.set(sessionId, {
    ...value,
    expiresAt: Date.now() + SESSION_STATUS_CACHE_TTL_MS,
  });
}

async function activeClerkSession(sessionId: string, userId: string): Promise<boolean> {
  const testStatus = testSessionStatuses.get(sessionId);
  if (testStatus) {
    return testStatus.active && testStatus.userId === userId;
  }
  const cached = sessionStatusCache.get(sessionId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.active && cached.userId === userId;
  }
  if (cached) sessionStatusCache.delete(sessionId);

  let request = sessionStatusRequests.get(sessionId);
  if (!request) {
    request = clerkClient.sessions.getSession(sessionId)
      .then((session) => ({
        active: session.status === "active",
        userId: session.userId,
      }))
      .then((value) => {
        cacheSessionStatus(sessionId, value);
        return value;
      })
      .finally(() => {
        sessionStatusRequests.delete(sessionId);
      });
    sessionStatusRequests.set(sessionId, request);
  }
  const session = await request;
  return session.active && session.userId === userId;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId = auth.userId;
  const sessionId = auth.sessionId;
  if (!userId || !sessionId) {
    res.status(401).json({ error: "Sign in to continue" });
    return;
  }
  try {
    if (!(await activeClerkSession(sessionId, userId))) {
      res.status(401).json({ error: "Sign in to continue" });
      return;
    }
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    if (status === 401 || status === 404) {
      res.status(401).json({ error: "Sign in to continue" });
      return;
    }
    next(error);
    return;
  }
  const profile = await db.query.usersTable.findFirst({
    where: eq(usersTable.clerkId, userId),
  });
  if (profile?.accountStatus === "suspended" || profile?.deletionStatus === "pending" || profile?.deletionStatus === "completed") {
    res.status(403).json({ error: "This account is suspended." });
    return;
  }
  req.userId = userId;
  next();
}

export async function ensureProfile(userId: string): Promise<User> {
  const existing = await db.query.usersTable.findFirst({
    where: eq(usersTable.clerkId, userId),
  });
  if (existing) return existing;

  const shortId = userId.replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase();
  const username = `guest_${shortId || "user"}`;
  await db
    .insert(usersTable)
    .values({
      clerkId: userId,
      username,
      displayName: username,
      status: "online",
    })
    .onConflictDoNothing({ target: usersTable.clerkId });
  const created = await db.query.usersTable.findFirst({
    where: eq(usersTable.clerkId, userId),
  });
  if (!created) throw new Error("Unable to create profile");
  return created;
}

export function getUserId(req: AuthenticatedRequest): string {
  if (!req.userId) throw new Error("Missing authenticated user");
  return req.userId;
}

export async function verifiedEmailAddressesForUser(userId: string): Promise<string[]> {
  const user = await clerkClient.users.getUser(userId);
  return user.emailAddresses
    .filter((emailAddress) => emailAddress.verification?.status === "verified")
    .map((emailAddress) => emailAddress.emailAddress.trim().toLowerCase());
}