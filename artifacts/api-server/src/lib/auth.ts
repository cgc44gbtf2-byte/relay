import { clerkClient, getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";

export type AuthenticatedRequest = Request & { userId?: string; user?: User };

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId = auth.userId;
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue" });
    return;
  }
  const profile = await db.query.usersTable.findFirst({
    where: eq(usersTable.clerkId, userId),
  });
  if (profile?.accountStatus === "suspended") {
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
    .onConflictDoNothing();
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