---
name: Clerk test-account switching
description: Safe owner-to-test-account switching when the managed development Clerk tenant rejects additional concurrent sessions.
---

The managed development Clerk tenant may reject a ticket sign-in while another account is active with “already signed in.” Do not assume multi-session support is enabled.

**Why:** Owner-operated role testing must remain reversible even on a single-session Clerk configuration, without storing sign-in tickets or credentials in browser storage.

**How to apply:** Prefer reactivating the original owner session when available. Otherwise, allow only a server-verified marked test account to request a short-lived return ticket for its recorded exact workspace owner, exchange it immediately in memory, and never persist the ticket.