---
name: Public channel destinations
description: User-confirmed authorization and product boundary for moving existing public channels.
---

The channel owner may move a public channel only into a public community that they also own. Do not offer someone else's public community, a private community, a paid business workspace, or the global public network as a destination without asking for a change in scope.

Keep the free plan limited to one public community per owner. Additional public communities are separate from paid business workspaces: each externally confirmed, one-time $19.99 USD upgrade grants one permanent additional public-community slot. A request must stay pending and notify the platform admin by in-app DM with the verified requester email; submitting it alone never activates a slot. There is no PayPal or invoice-email integration in this flow.

**Why:** The user explicitly selected owner-controlled public communities rather than unrestricted public communities or category-only moves, then chose one permanent extra slot per manually confirmed upgrade instead of a recurring subscription. They superseded the earlier PayPal invoice/email plan with pending requests and an in-app platform alert. Moving a channel carries its existing members and messages, so broadening destinations changes exposure and ownership boundaries.

**How to apply:** For future channel organization changes, enforce destination ownership and public free-or-purchased status on the server at mutation time, not only in UI options. Preserve channel identity and history, and clear category associations that belong to the previous space.