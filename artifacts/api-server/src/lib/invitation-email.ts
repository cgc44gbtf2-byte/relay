import { ReplitConnectors } from "@replit/connectors-sdk";

export type InvitationEmailDelivery = {
  status: "sent" | "not_configured" | "failed";
  message: string;
};

type InvitationEmail = { email: string; communityId: number; token: string };
type SendEmail = (body: Record<string, unknown>) => Promise<Response>;

const sendThroughResend: SendEmail = async (body) => {
  const connectors = new ReplitConnectors();
  const proxyFetch = connectors.createProxyFetch("resend");
  return proxyFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    if (!from || !publicUrl || /[\r\n]/.test(from)) throw new Error("Invalid configuration");
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
      subject: "Your Relay workspace invitation",
      text: `You have been invited to a Relay workspace.\n\nAccept your invitation:\n${url.toString()}\n\nSign in with ${invitation.email} to accept. This private link expires in 7 days. If you did not expect this invitation, you can ignore this email.`,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Delivery failed");
    }
    return { status: "sent", message: "Invitation email accepted for delivery. The private link is also available as a fallback." };
  } catch {
    // Do not log exceptions or response bodies: either may contain invitation tokens.
    return { status: "failed", message: "The invitation was saved, but email delivery could not be confirmed. Share the private link or try resending." };
  }
}