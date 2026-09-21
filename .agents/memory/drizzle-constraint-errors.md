---
name: Drizzle constraint errors
description: Handling PostgreSQL constraint failures surfaced through Drizzle ORM.
---

PostgreSQL constraint errors raised through Drizzle ORM may be wrapped in a query error, with the original SQLSTATE available through `cause`.

**Why:** A direct `error.code` check can miss a unique-constraint violation and turn an expected conflict into an HTTP 500.

**How to apply:** When mapping database constraint failures to API responses, inspect the wrapped cause as well as the outer error, with a bounded traversal.