import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendCommunitySubscriptionReminderEmail,
  sendInvitationEmail,
} from "./invitation-email";

const invitation = { email: "employee@example.com", communityId: 42, token: "private-test-token" };
const config = { INVITATION_EMAIL_FROM: "Relay <invites@example.com>", INVITATION_APP_URL: "https://example.com/workspace/", RESEND_API_KEY: "test-only-key" };
const reminder = {
  email: "owner@example.com",
  termId: 73,
  expiresAt: new Date("2026-10-02T12:30:00.000Z"),
};

test("unconfigured delivery preserves link fallback without calling provider", async () => {
  const result = await sendInvitationEmail(invitation, {}, async () => { throw new Error("Must not send"); });
  assert.equal(result.status, "not_configured");
});

test("configured delivery sends to invited email with scoped, encoded URL", async () => {
  let calls = 0;
  const result = await sendInvitationEmail(invitation, config, async (body) => {
    calls++;
    assert.deepEqual(body.to, [invitation.email]);
    assert.equal(body.from, config.INVITATION_EMAIL_FROM);
    assert.match(String(body.text), /https:\/\/example.com\/workspace\/accept-invitation\?communityId=42&token=private-test-token/);
    assert.match(String(body.text), /expires in 7 days/);
    return new Response('{"id":"sent"}', { status: 200 });
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "sent");
  assert.ok(!JSON.stringify(result).includes(invitation.token));
});

test("provider rejection and exceptions never expose private tokens", async () => {
  for (const send of [
    async () => new Response(invitation.token, { status: 429 }),
    async () => { throw new Error(`Provider rejected ${invitation.token}`); },
    async () => { throw new DOMException(invitation.token, "TimeoutError"); },
  ]) {
    const result = await sendInvitationEmail(invitation, config, send);
    assert.equal(result.status, "failed");
    assert.match(result.message, /saved.*private link/);
    assert.ok(!JSON.stringify(result).includes(invitation.token));
  }
});

test("incomplete or unsafe config fails without sending", async () => {
  for (const bad of [
    { INVITATION_EMAIL_FROM: config.INVITATION_EMAIL_FROM },
    { INVITATION_EMAIL_FROM: config.INVITATION_EMAIL_FROM, INVITATION_APP_URL: config.INVITATION_APP_URL },
    { ...config, INVITATION_APP_URL: "http://example.com" },
    { ...config, INVITATION_APP_URL: "https://user:password@example.com" },
    { ...config, INVITATION_APP_URL: "https://example.com?token=bad" },
    { ...config, INVITATION_APP_URL: "not-a-url" },
  ]) {
    let called = false;
    const result = await sendInvitationEmail(invitation, bad, async () => { called = true; return new Response(); });
    assert.equal(result.status, "failed");
    assert.equal(called, false);
  }
});

test("default sender uses authenticated Resend request with bounded timeout", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(input, "https://api.resend.com/emails");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${config.RESEND_API_KEY}`);
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
    assert.ok(init?.signal);
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.to, [invitation.email]);
    assert.match(payload.text, /private-test-token/);
    return new Response('{"id":"sent"}', { status: 200 });
  };
  try {
    const result = await sendInvitationEmail(invitation, config);
    assert.equal(calls, 1);
    assert.equal(result.status, "sent");
    assert.ok(!JSON.stringify(result).includes(config.RESEND_API_KEY));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resend content uses the newly rotated token", async () => {
  const messages: string[] = [];
  const send = async (body: Record<string, unknown>) => { messages.push(String(body.text)); return new Response('{"id":"sent"}'); };
  await sendInvitationEmail(invitation, config, send);
  await sendInvitationEmail({ ...invitation, token: "replacement-token" }, config, send);
  assert.match(messages[1]!, /replacement-token/);
  assert.ok(!messages[1]!.includes(invitation.token));
});

test("subscription reminder targets the renewal page with a stable per-term key", async () => {
  let idempotencyKey: string | undefined;
  const result = await sendCommunitySubscriptionReminderEmail(reminder, config, async (body, _key, options) => {
    idempotencyKey = options?.idempotencyKey;
    assert.deepEqual(body.to, [reminder.email]);
    assert.equal(body.from, config.INVITATION_EMAIL_FROM);
    assert.equal(body.subject, "Your Relay public community subscription ends soon");
    assert.match(String(body.text), /https:\/\/example\.com\/workspace\/community-upgrades/);
    assert.match(String(body.text), /2026-10-02T12:30:00\.000Z/);
    return new Response('{"id":"reminder-sent"}', { status: 200 });
  });
  assert.equal(result.status, "sent");
  assert.equal(idempotencyKey, "community-subscription-reminder-73");
});

test("default subscription reminder sender sets the provider idempotency header", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.resend.com/emails");
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "community-subscription-reminder-73");
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.to, [reminder.email]);
    assert.match(payload.text, /\/workspace\/community-upgrades/);
    return new Response('{"id":"reminder-sent"}', { status: 200 });
  };
  try {
    assert.equal((await sendCommunitySubscriptionReminderEmail(reminder, config)).status, "sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});