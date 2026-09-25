---
name: Responsive UI test visibility
description: Why keyboard-oriented RTL queries can find controls duplicated by responsive layout
---

React Testing Library in this workspace's JSDOM environment does not reliably treat Tailwind breakpoint classes as browser visibility. A role query can find both a desktop control and an equivalent narrow-screen control even though only one is visible in a real viewport. Prefer `within()` on the relevant named region/dialog or exact accessible names when testing one responsive path.

**Why:** Broad accessible-name queries became ambiguous after keyboard-visible member actions and a narrow room picker were introduced; the issue was the test environment's CSS visibility, not a duplicate control in the live layout.

**How to apply:** Scope responsive tests to the intended UI region, then use a real browser viewport/screenshot for layout claims. A passing JSDOM focus or role assertion does not prove desktop or mobile CSS visibility or native tab traversal.