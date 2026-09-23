---
name: Community product separation
description: Product boundary between self-service free communities and paid business workspaces.
---

Self-service signup must automatically provision a single free community with starter rooms and member invitations; it must not create or configure a paid business workspace.

**Why:** Free communities are the no-manual-input entry point, while workspaces are a paid product with separate business setup and access rules.

**How to apply:** Keep free-community onboarding scoped to the free plan and keep paid workspace creation, business fields, and workspace-only roles on the separate workspace path.