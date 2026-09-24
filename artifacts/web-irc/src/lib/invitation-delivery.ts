export type InvitationResponse = {
  invitationToken: string;
  emailDelivery: { status: "sent" | "not_configured" | "failed"; message: string };
};

export function invitationDeliveryMessage(result: InvitationResponse): string {
  return result.emailDelivery?.message ?? "Invitation saved. Share the private invitation link with the recipient.";
}