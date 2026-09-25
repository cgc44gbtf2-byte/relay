export type InvitationEmailDelivery = {
  status: "sent" | "not_configured" | "failed";
  message: string;
  /** Resend's opaque message identifier; never return this to the client. */
  providerId?: string;
};

type InvitationEmail = { email: string; communityId: number; token: string; attemptId?: string };
export type CommunitySubscriptionReminderEmail = {
  email: string;
  termId: number;
  expiresAt: Date;
};
type SendEmail = (
  body: Record<string, unknown>,
  apiKey: string,
  options?: { idempotencyKey?: string },
) => Promise<Response>;

const sendThroughResend: SendEmail = async (body, apiKey, options) => {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
};

/** Only return fixed messages: provider errors can contain the private link. */
export async function sendInvitationEmail(
  invitation: InvitationEmail,
  config = process.env,
  send: SendEmail = sendThroughResend,
): Promise<InvitationEmailDelivery> {
  const from = config.INVITATION_EMAIL_FROM?.trim();
  const publicUrl = config.INVITATION_APP_URL?.trim();
  if (!from && !publicUrl) {
    return { status: "not_configured", message: "Email delivery is not configured. Share the private invitation link with the recipient." };
  }
  try {
    const apiKey = config.RESEND_API_KEY?.trim();
    if (!from || !publicUrl || !apiKey || /[\r\n]/.test(from) || /[\r\n]/.test(apiKey)) {
      throw new Error("Invalid configuration");
    }
    // Trusted configuration only; never build emailed links from request headers.
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid application URL");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/accept-invitation`;
    url.search = new URLSearchParams({
      communityId: String(invitation.communityId),
      token: invitation.token,
    }).toString();
    const response = await send({
      from,
      to: [invitation.email],
      ...(invitation.attemptId ? { tags: [{ name: "invitation_attempt", value: invitation.attemptId }] } : {}),
      subject: "Your Relay workspace invitation",
      text: `You have been invited to a Relay workspace.\n\nAccept your invitation:\n${url.toString()}\n\nSign in with ${invitation.email} to accept. This private link expires in 7 days. If you did not expect this invitation, you can ignore this email.`,
    }, apiKey);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Delivery failed");
    }
    const body: unknown = await response.json();
    const providerId = body && typeof body === "object" && "id" in body && typeof body.id === "string"
      && /^[\w-]{1,128}$/.test(body.id) ? body.id : undefined;
    if (!providerId) throw new Error("Missing provider id");
    return { status: "sent", providerId, message: "Invitation email accepted for delivery. The private link is also available as a fallback." };
  } catch {
    // Do not log exceptions or response bodies: either may contain invitation tokens.
    return { status: "failed", message: "The invitation was saved, but email delivery could not be confirmed. Share the private link or try resending." };
  }
}

/** Deliver one renewal reminder per active paid term. Its stable provider key
 * lets the worker retry safely if delivery succeeded but persistence did not. */
export async function sendCommunitySubscriptionReminderEmail(
  reminder: CommunitySubscriptionReminderEmail,
  config = process.env,
  send: SendEmail = sendThroughResend,
): Promise<InvitationEmailDelivery> {
  const from = config.INVITATION_EMAIL_FROM?.trim();
  const publicUrl = config.INVITATION_APP_URL?.trim();
  if (!from && !publicUrl) {
    return { status: "not_configured", message: "Email delivery is not configured." };
  }
  try {
    const apiKey = config.RESEND_API_KEY?.trim();
    if (!from || !publicUrl || !apiKey || /[\r\n]/.test(from) || /[\r\n]/.test(apiKey)
      || !Number.isSafeInteger(reminder.termId) || reminder.termId < 1
      || !Number.isFinite(reminder.expiresAt.getTime())) {
      throw new Error("Invalid configuration");
    }
    // Trusted configuration only; never build emailed links from request headers.
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid application URL");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/community-upgrades`;
    const response = await send({
      from,
      to: [reminder.email],
      tags: [{ name: "community_subscription_term", value: String(reminder.termId) }],
      subject: "Your Relay public community subscription ends soon",
      text: `Your public community subscription ends on ${reminder.expiresAt.toISOString()}.\n\nRenew your subscription before then to keep subscriber communities available:\n${url.toString()}\n\nIf you have already renewed, you can ignore this email.`,
    }, apiKey, { idempotencyKey: `community-subscription-reminder-${reminder.termId}` });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Delivery failed");
    }
    const body: unknown = await response.json();
    const providerId = body && typeof body === "object" && "id" in body && typeof body.id === "string"
      && /^[\w-]{1,128}$/.test(body.id) ? body.id : undefined;
    if (!providerId) throw new Error("Missing provider id");
    return { status: "sent", providerId, message: "Subscription reminder email accepted for delivery." };
  } catch {
    // Provider errors may contain private response data; the worker retries without exposing it.
    return { status: "failed", message: "Subscription reminder email delivery could not be confirmed." };
  }
}