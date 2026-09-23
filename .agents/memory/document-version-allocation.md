---
name: Document version allocation
description: Concurrency and integrity rule for assigning document version numbers.
---

Allocate a document's next version while holding a row lock on that document, and enforce uniqueness on the document/version pair in PostgreSQL.

**Why:** Reading the latest version and inserting the next number without serialization lets concurrent uploads create duplicate version numbers.

**How to apply:** Keep the lookup and insert in one transaction after locking the workspace-scoped document row. Migrations must fail loudly if legacy duplicates exist; never deduplicate version history automatically.