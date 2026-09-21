import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { requireAuth, type AuthenticatedRequest } from "../lib/auth";

const router: IRouter = Router();
const SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function objectParts(path: string): { bucketName: string; objectName: string } {
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts.slice(1).join("/")) throw new Error("Invalid object path");
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

async function signObjectUrl(
  path: string,
  method: "GET" | "PUT",
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

router.post("/storage/uploads/request-url", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const size = Number(req.body?.size);
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "application/octet-stream";
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 160) : "";
  if (!name || !Number.isSafeInteger(size) || size < 1 || size > 10_000_000) {
    res.status(400).json({ error: "Files must have a name and be smaller than 10 MB." });
    return;
  }
  if (!contentType.startsWith("image/") && !contentType.startsWith("text/") && contentType !== "application/pdf") {
    res.status(400).json({ error: "Only images, text files, and PDFs are supported." });
    return;
  }
  try {
    const objectPath = privateObjectPath();
    const uploadURL = await signedObjectUrlForPath(objectPath, "PUT");
    res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
  } catch {
    res.status(503).json({ error: "File storage is temporarily unavailable." });
  }
});

export async function signedObjectUrlForPath(objectPath: string, method: "GET" | "PUT" = "GET"): Promise<string> {
  const raw = objectPath.replace(/^\/objects\//, "");
  const privateDir = process.env.PRIVATE_OBJECT_DIR?.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!privateDir || !raw || raw.includes("..") || raw.startsWith("/")) throw new Error("Invalid object path");
  return signObjectUrl(`/${privateDir}/${raw}`, method);
}

export default router;