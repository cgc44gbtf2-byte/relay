export type InvitationEmailDelivery = {
  status: "sent" | "not_configured" | "failed";
  message: string;
  /** Resend's opaque message identifier; never return this to the client. */
  providerId?: string;
};

type InvitationEmail = { email: string; communityId: number; token: string; attemptId?: string };
type SendEmail = (body: Record<string, unknown>, apiKey: string) => Promise<Response>;

const sendThroughResend: SendEmail = async (body, apiKey) => {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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