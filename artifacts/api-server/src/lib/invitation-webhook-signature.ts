import { createHmac, timingSafeEqual } from "node:crypto";

export type DeliveryEvent = {
  attemptId: string;
  providerId: string;
  status: "delivered" | "bounced" | "failed" | "complained";
  createdAt: Date;
};

/** Svix signs the exact bytes: id.timestamp.rawBody. Reject stale and malformed signatures. */
export function verifyResendSignature(
  body: Buffer, headers: { id?: string; timestamp?: string; signature?: string },
  secret: string | undefined, now = Date.now(),
): boolean {
  if (!secret?.startsWith("whsec_") || !headers.id || !headers.timestamp || !headers.signature) return false;
  if (!/^[0-9]{10,}$/.test(headers.timestamp) || !/^[\w-]{1,256}$/.test(headers.id)) return false;
  const time = Number(headers.timestamp);
  if (!Number.isSafeInteger(time) || Math.abs(now - time * 1000) > 300_000) return false;
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const key = Buffer.from(encoded, "base64");
  if (!key.length) return false;
  const signed = Buffer.concat([Buffer.from(`${headers.id}.${headers.timestamp}.`), body]);
  const digest = createHmac("sha256", key).update(signed).digest();
  return headers.signature.split(" ").some((part) => {
    if (!part.startsWith("v1,")) return false;
    const value = part.slice(3);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const candidate = Buffer.from(value, "base64");
    return candidate.length === digest.length && timingSafeEqual(candidate, digest);
  });
}

export function parseDeliveryEvent(payload: unknown): DeliveryEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  const statuses: Record<string, DeliveryEvent["status"]> = {
    "email.delivered": "delivered", "email.bounced": "bounced",
    "email.failed": "failed", "email.complained": "complained",
  };
  const status = statuses[String(event.type)];
  if (!status) return null;
  if (!event.data || typeof event.data !== "object") return null;
  const data = event.data as Record<string, unknown>;
  const tags = data.tags;
  const attemptId = tags && typeof tags === "object" && !Array.isArray(tags)
    ? (tags as Record<string, unknown>).invitation_attempt : undefined;
  const providerId = data.email_id;
  const createdAt = typeof event.created_at === "string" ? new Date(event.created_at) : new Date(NaN);
  if (typeof attemptId !== "string" || !/^[a-f0-9]{8}-[a-f0-9-]{27,}$/.test(attemptId)
    || typeof providerId !== "string" || !/^[\w-]{1,128}$/.test(providerId)
    || !Number.isFinite(createdAt.getTime())) return null;
  return { attemptId, providerId, status, createdAt };
}