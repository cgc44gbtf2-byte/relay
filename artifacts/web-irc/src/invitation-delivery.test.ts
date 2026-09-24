import { describe, expect, it } from "vitest";
import { invitationDeliveryLabel } from "./lib/invitation-delivery";

describe("invitation delivery labels", () => {
  it("does not equate provider acceptance with delivery", () => {
    expect(invitationDeliveryLabel("sent").text).toContain("not yet confirmed");
    expect(invitationDeliveryLabel("delivered").text).toContain("mail server");
    expect(invitationDeliveryLabel(null).text).toContain("unknown");
  });

  it.each(["bounced", "failed", "complained"])("highlights %s independently of invitation status", (status) => {
    expect(invitationDeliveryLabel(status).failed).toBe(true);
  });
});