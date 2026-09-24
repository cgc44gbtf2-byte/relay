export type InvitationResponse = {
  invitationToken: string;
  emailDelivery: { status: "sent" | "not_configured" | "failed"; message: string };
};

export function invitationDeliveryMessage(result: InvitationResponse): string {
  return result.emailDelivery?.message ?? "Invitation saved. Share the private invitation link with the recipient.";
}

export function invitationDeliveryLabel(status?: string | null): { text: string; failed: boolean } {
  switch (status) {
    case "queued": return { text: "Email sending", failed: false };
    case "sent": return { text: "Email accepted by provider · delivery not yet confirmed", failed: false };
    case "delivered": return { text: "Email delivered to recipient’s mail server", failed: false };
    case "bounced": return { text: "Email bounced · check the address or share the private link", failed: true };
    case "failed": return { text: "Email rejected or failed · retry or share the private link", failed: true };
    case "complained": return { text: "Email reported as spam · contact the recipient another way", failed: true };
    case "not_configured": return { text: "Email not configured · share the private link", failed: false };
    default: return { text: "Email delivery unknown", failed: false };
  }
}