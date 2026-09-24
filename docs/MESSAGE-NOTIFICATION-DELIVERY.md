# Message notification delivery operations

Message notification intent is stored on `irc_messages`. Newly sent channel
text messages and direct messages are created with `notification_status =
'pending'`; existing messages and message types without notification intent
remain `skipped`. The API worker claims due rows with row locks, inserts the
complete notification fanout in a savepoint, and marks the message delivered in
the same transaction. A committed fanout is therefore not inserted again after
a worker crash. Live WebSocket broadcast happens only after commit and is not
durable or retried.

`notification_recipient_ids` is the immutable recipient-intent snapshot
captured by the same message insert. The worker does not resolve usernames from
the later message body, so edits and username changes cannot redirect an
alert. Before channel delivery it intersects the snapshot with current channel
membership, preventing delivery to users who no longer have access.

Delivery is attempted at most five times with bounded exponential backoff.
Terminal failures remain visible as `failed`. `notification_last_error` contains
only a SQLSTATE identifier or a generic safe code; message content and raw
database errors are not stored there.

## Monitor

Count queued and terminal rows without selecting message bodies:

```sql
SELECT notification_status, count(*)
FROM irc_messages
WHERE notification_status IN ('pending', 'failed')
GROUP BY notification_status
ORDER BY notification_status;
```

Inspect terminal metadata:

```sql
SELECT id, notification_attempts, notification_next_attempt_at,
       notification_last_error, created_at
FROM irc_messages
WHERE notification_status = 'failed'
ORDER BY created_at
LIMIT 100;
```

Application logs include the message ID, safe error code, attempt count, and
whether the failure is terminal. They intentionally omit the message body and
raw database error.

## Safely requeue

First correct the underlying database or data issue. Requeue only reviewed
message IDs, in a transaction, and never bulk-requeue every failed row without
investigation:

```sql
BEGIN;

UPDATE irc_messages
SET notification_status = 'pending',
    notification_attempts = 0,
    notification_next_attempt_at = now(),
    notification_last_error = NULL
WHERE id IN ('00000000-0000-0000-0000-000000000000')
  AND notification_status = 'failed'
  AND deleted_at IS NULL
RETURNING id;

COMMIT;
```

Confirm the returned IDs match the approved set. The next worker pass claims
them. Do not requeue a `delivered` message: its notification rows already
committed and requeueing it would intentionally create duplicates.