import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { parseDeliveryEvent, verifyResendSignature } from "./invitation-webhook-signature";
import { sendInvitationEmail } from "./invitation-email";

test("checks the exact signed raw bytes and rejects unsigned, altered and stale deliveries", () => {
  const secret = `whsec_${Buffer.from("test signing key").toString("base64")}`;
  const body = Buffer.from('{"type":"email.bounced"}');
  const headers = { id: "msg_123", timestamp: String(Math.floor(Date.now() / 1000)), signature: "" };
  headers.signature = `v1,${createHmac("sha256", "test signing key").update(`${headers.id}.${headers.timestamp}.`).update(body).digest("base64")}`;
  assert.equal(verifyResendSignature(body, headers, secret), true);
  assert.equal(verifyResendSignature(body, headers, undefined), false);
  assert.equal(verifyResendSignature(Buffer.from('{"type":"email.failed"}'), headers, secret), false);
  assert.equal(verifyResendSignature(body, { ...headers, signature: "v1,AAAA" }, secret), false);
  assert.equal(verifyResendSignature(body, headers, secret, Date.now() + 301_000), false);
});

test("accepts Resend email_id and invitation attempt tag without storing provider payload", () => {
  const attemptId = randomUUID();
  const createdAt = new Date().toISOString();
  assert.deepEqual(parseDeliveryEvent({
    type: "email.bounced", created_at: createdAt,
    data: { email_id: "provider-1", tags: { invitation_attempt: attemptId }, bounce: { diagnosticCode: ["private"] } },
  }), { attemptId, providerId: "provider-1", status: "bounced", createdAt: new Date(createdAt) });
  assert.equal(parseDeliveryEvent({ type: "email.bounced", data: { email_id: "provider-1" } }), null);
});

test("outbound tags correlate a webhook without including raw invitation tokens", async () => {
  const attemptId = randomUUID();
  const result = await sendInvitationEmail(
    { email: "person@example.com", communityId: 1, token: "private-token", attemptId },
    { INVITATION_EMAIL_FROM: "invites@example.com", INVITATION_APP_URL: "https://example.com", RESEND_API_KEY: "test-key" },
    async (body) => {
      assert.deepEqual(body.tags, [{ name: "invitation_attempt", value: attemptId }]);
      assert.ok(!JSON.stringify(body.tags).includes("private-token"));
      return new Response('{"id":"provider-1"}');
    },
  );
  assert.equal(result.providerId, "provider-1");
});