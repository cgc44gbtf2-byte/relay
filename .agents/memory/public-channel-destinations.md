---
name: Public channel destinations
description: User-confirmed authorization and product boundary for moving existing public channels.
---

The channel owner may move a public channel only into a public community that they also own. Do not offer someone else's public community, a private community, a paid business workspace, or the global public network as a destination without asking for a change in scope.

Keep the free plan limited to one public community per owner. Additional public communities are a separate one-time purchase from paid business workspaces: each fully paid, user-specific invoice grants one permanent additional community slot. Relay should email the PayPal invoice link itself rather than relying on PayPal's recipient email. This is a planned product rule, not an entitlement already implemented; do not create extra communities or imply the upgrade is available before payment verification and slot enforcement exist.

**Why:** The user explicitly selected owner-controlled public communities rather than unrestricted public communities or category-only moves, then chose one permanent extra slot per paid invoice instead of a recurring subscription. Moving a channel carries its existing members and messages, so broadening destinations changes exposure and ownership boundaries.

**How to apply:** For future channel organization changes, enforce destination ownership and public/free status on the server at mutation time, not only in UI options. Preserve channel identity and history, and clear category associations that belong to the previous space.