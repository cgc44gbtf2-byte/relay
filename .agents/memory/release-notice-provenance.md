---
name: Release notice provenance
description: How to avoid incorrect license terms when npm packages omit license files
---

Match notice text to the exact distributed package and version, not just its repository or SPDX metadata. If a published package omits a standalone license, a complete license section in its own README or a version-pinned upstream subproject license can supply the text; record provenance and validate it offline.

**Why:** A JavaScript package in a larger repository reported MIT, while that repository's root license was Apache-2.0. Fetching the current root license would have put the wrong terms in the release bundle. Published tarballs can also omit their upstream license files entirely.

**How to apply:** Check the published package and its full license section first. For gaps, verify the exact upstream tag or commit and subproject path, pin a digest for any alternate local source, and keep human legal approval separate from technical notice completeness.