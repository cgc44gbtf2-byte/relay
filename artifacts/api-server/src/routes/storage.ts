import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  businessDocumentsTable,
  communityMembersTable,
  db,
  serverAnnouncementsTable,
  workspaceTasksTable,
} from "@workspace/db";
import { getUserId, requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { FixedWindowLimiter, rateLimitKey } from "../lib/fixed-window-limiter";
import { hasPermission } from "../lib/permissions";

const router: IRouter = Router();
const SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const uploadUrlLimiter = new FixedWindowLimiter(10, 60_000);

function objectParts(path: string): { bucketName: string; objectName: string } {
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts.slice(1).join("/")) throw new Error("Invalid object path");
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

async function signObjectUrl(
  path: string,
  method: "GET" | "PUT" | "DELETE",
): Promise<string> {
  const { bucketName, objectName } = objectParts(path);
  const response = await fetch(`${SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Storage signer returned ${response.status}`);
  const payload = await response.json() as { signed_url?: string };
  if (!payload.signed_url) throw new Error("Storage signer did not return a URL");
  return payload.signed_url;
}

function privateObjectPath(): string {
  if (!process.env.PRIVATE_OBJECT_DIR) throw new Error("PRIVATE_OBJECT_DIR is not configured");
  return `/objects/uploads/${randomUUID()}`;
}

const supportedUploadTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const blockedActiveContentTypes = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
]);

export const MAX_UPLOAD_SIZE = 25_000_000;

export function validateUploadMetadata(input: {
  name?: unknown;
  size?: unknown;
  contentType?: unknown;
}): { name: string; size: number; contentType: string } | null {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 160) : "";
  const size = typeof input.size === "number" ? input.size : Number(input.size);
  const contentType = typeof input.contentType === "string"
    ? input.contentType.trim().toLowerCase().slice(0, 120)
    : "";
  if (
    !name
    || name.includes("/")
    || name.includes("\\")
    || name === "."
    || name === ".."
    || !Number.isSafeInteger(size)
    || size < 1
    || size > MAX_UPLOAD_SIZE
    || blockedActiveContentTypes.has(contentType)
    || (!contentType.startsWith("image/") && !contentType.startsWith("text/") && !supportedUploadTypes.has(contentType))
  ) return null;
  return { name, size, contentType };
}

function safePathPart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const part = value.trim();
  return /^[a-zA-Z0-9_-]{1,100}$/.test(part) ? part : null;
}

const scopedUploadResourceTypes = ["document", "task", "announcement"] as const;
type ScopedUploadResourceType = typeof scopedUploadResourceTypes[number];
type UploadResourceContext = {
  workspaceId: number;
  resourceType: ScopedUploadResourceType;
  resourceId: number | "new";
};

export function parseUploadResourceContext(input: {
  workspaceId?: unknown;
  resourceType?: unknown;
  resourceId?: unknown;
}): UploadResourceContext | null | undefined {
  const hasAnyContext = input.workspaceId !== undefined
    || input.resourceType !== undefined
    || input.resourceId !== undefined;
  if (!hasAnyContext) return undefined;
  const workspaceId = Number(input.workspaceId);
  const resourceType = typeof input.resourceType === "string" ? input.resourceType.trim() : "";
  const rawResourceId = input.resourceId;
  const resourceId = rawResourceId === "new" ? "new" : Number(rawResourceId);
  if (
    !Number.isSafeInteger(workspaceId)
    || workspaceId <= 0
    || !scopedUploadResourceTypes.includes(resourceType as ScopedUploadResourceType)
    || (resourceId !== "new" && (!Number.isSafeInteger(resourceId) || resourceId <= 0))
    || (resourceId === "new" && resourceType !== "document")
  ) return null;
  return {
    workspaceId,
    resourceType: resourceType as ScopedUploadResourceType,
    resourceId,
  };
}

async function canUploadToResource(userId: string, context: UploadResourceContext): Promise<boolean> {
  if (context.resourceType === "document") {
    if (!(await hasPermission(userId, "manage_community", { communityId: context.workspaceId }))) return false;
    if (context.resourceId === "new") return true;
    const [document] = await db.select({ id: businessDocumentsTable.id }).from(businessDocumentsTable)
      .where(and(
        eq(businessDocumentsTable.id, context.resourceId),
        eq(businessDocumentsTable.communityId, context.workspaceId),
      ));
    return Boolean(document);
  }
  if (context.resourceId === "new") return false;
  if (context.resourceType === "task") {
    const [task] = await db.select({ id: workspaceTasksTable.id }).from(workspaceTasksTable)
      .innerJoin(communityMembersTable, and(
        eq(communityMembersTable.communityId, workspaceTasksTable.communityId),
        eq(communityMembersTable.userId, userId),
      ))
      .where(and(
        eq(workspaceTasksTable.id, context.resourceId),
        eq(workspaceTasksTable.communityId, context.workspaceId),
      ));
    return Boolean(task);
  }
  const [announcement] = await db.select({ id: serverAnnouncementsTable.id }).from(serverAnnouncementsTable)
    .where(and(
      eq(serverAnnouncementsTable.id, context.resourceId),
      eq(serverAnnouncementsTable.communityId, context.workspaceId),
      eq(serverAnnouncementsTable.authorId, userId),
    ));
  return Boolean(announcement);
}

export function uploadObjectPath(input: {
  workspaceId?: unknown;
  resourceType?: unknown;
  resourceId?: unknown;
}): string {
  const workspaceId = safePathPart(input.workspaceId);
  const resourceType = safePathPart(input.resourceType);
  const resourceId = safePathPart(input.resourceId);
  if (workspaceId && resourceType && resourceId) {
    return `${privateObjectPath()}/workspaces/${workspaceId}/${resourceType}/${resourceId}`;
  }
  return privateObjectPath();
}

export function isValidUploadedObjectPath(value: unknown): value is string {
  return typeof value === "string"
    && /^\/objects\/uploads\/[0-9a-f-]{36}(?:\/workspaces\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100})?$/i.test(value)
    && !value.includes("..");
}

router.post("/storage/uploads/request-url", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const result = uploadUrlLimiter.check(rateLimitKey(getUserId(req), req.ip ?? req.socket.remoteAddress ?? "unknown"));
  if (!result.allowed) {
    res.set("Retry-After", String(result.retryAfterSeconds)).status(429).json({ error: "Too many upload URL requests." });
    return;
  }
  const metadata = validateUploadMetadata(req.body ?? {});
  if (!metadata) {
    res.status(400).json({ error: "Files must have a name and be smaller than 25 MB." });
    return;
  }
  const context = parseUploadResourceContext(req.body ?? {});
  if (context === null) {
    res.status(400).json({ error: "A complete and valid upload resource context is required." });
    return;
  }
  if (context && !(await canUploadToResource(getUserId(req), context))) {
    res.status(403).json({ error: "You cannot upload files to this workspace resource." });
    return;
  }
  try {
    const objectPath = uploadObjectPath(context ? {
      workspaceId: String(context.workspaceId),
      resourceType: context.resourceType,
      resourceId: String(context.resourceId),
    } : {});
    const uploadURL = await signedObjectUrlForPath(objectPath, "PUT");
    res.json({ uploadURL, objectPath, metadata });
  } catch {
    res.status(503).json({ error: "File storage is temporarily unavailable." });
  }
});

export async function signedObjectUrlForPath(objectPath: string, method: "GET" | "PUT" | "DELETE" = "GET"): Promise<string> {
  const raw = objectPath.replace(/^\/objects\//, "");
  const privateDir = process.env.PRIVATE_OBJECT_DIR?.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!privateDir || !raw || raw.includes("..") || raw.startsWith("/")) throw new Error("Invalid object path");
  return signObjectUrl(`/${privateDir}/${raw}`, method);
}

export default router;