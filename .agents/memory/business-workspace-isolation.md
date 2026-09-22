---
name: Business workspace isolation
description: Legacy IRC endpoints default to global visibility and need explicit workspace checks as the product evolves into private businesses.
---

Treat every business-facing IRC read or interaction as workspace-scoped at the API boundary. Listing, search, announcements, direct messages, channel history, and member visibility must verify shared business membership or a scoped business/platform permission; frontend filtering is not sufficient.

**Why:** The original IRC model was designed around public/global rooms, so existing endpoints can look correct while still exposing another business's data unless each path is audited explicitly.

**How to apply:** When adding CRM, automation, AI, or communication endpoints, start from the authenticated user's business memberships and enforce the same scope on every read, write, and cross-user interaction.