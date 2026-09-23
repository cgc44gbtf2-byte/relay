# Release 1 data retention

## Scope and current behavior

This is the Release 1 retention position for the records represented by the
Relay schema. It is documentation, not a deletion policy or a scheduled-job
specification. **No automatic deletion or expiration job is currently
enabled.** An `expiresAt`, `readAt`, or `deletedAt` value changes product
state or visibility; it does not, by itself, remove the underlying record or
object.

The retention posture applies across workspaces. Access controls, account
status, and legal or administrative decisions still determine who may view a
record; retention does not grant access.

## Release 1: retain indefinitely

The following records remain available for the life of the installation unless
an authorized, documented action or a binding legal requirement says otherwise:

- **Messages and conversation context:** channel and direct messages, including
  threads, message metadata, reactions, and message attachments. A message
  marked with `deletedAt` remains a retained record with its deletion context;
  this is not an automatic purge.
- **Administrative accountability:** admin audit log entries, including actor
  snapshot information, action, resource and target context, scope, details,
  and timestamp. Audit history is retained even when the referenced account or
  resource later changes, subject to the applicable legal hold.
- **Moderation history:** moderation actions, including actor, target,
  workspace/channel scope, action, details, and timestamp.
- **Task discussions:** task comments and their task attachments, retained with
  the associated task context.
- **Announcement evidence:** published announcement records, announcement
  attachments, read receipts, and acknowledgements. Receipts and
  acknowledgements are evidence of delivery/reading or confirmation and are
  not treated as disposable notification state.
- **Document accountability:** business documents, document versions,
  document acknowledgements, and document download records. Download records
  identify the document/version, user, and download time.
- **Notifications:** notification records, including read state and the
  associated entity/workspace context. Release 1 does not automatically
  remove read or old notifications.

This indefinite posture includes the metadata needed to interpret the records,
but excludes secrets such as password hashes or credentials from any retention
exception. Storage objects referenced by retained attachments and document
versions must not be removed independently of an approved record disposition.

## Later archive or expiry candidates

These are design candidates for a future, separately approved lifecycle; they
are **not** Release 1 behavior:

- old notification rows after they are no longer needed for in-product
  history, while preserving security, delivery, and investigation needs;
- document download events after their operational and security value has
  elapsed, provided required access/audit evidence is preserved;
- expired or superseded announcement presentation state and its attachments,
  only after receipts/acknowledgements and required business records are
  preserved;
- historical message, task-comment, and attachment content through a
  searchable, access-controlled archive rather than an untracked purge;
- obsolete document versions and inactive task or document content, with
  links, acknowledgements, audit context, and legal holds kept intact;
- redundant or derived notification/receipt data where a source record remains
  authoritative.

An announcement or document's product expiry is not a retention decision.
Future archive/expiry work must specify whether it affects database rows,
object-storage content, indexes, backups, or only presentation.

## Legal and administrative overrides

Legal holds, litigation or investigation requests, regulatory obligations,
employment/workplace requirements, contractual commitments, and an
administrator-approved preservation request override any proposed archive or
expiry. A hold must cover related messages, attachments, task comments,
documents, versions, downloads, notifications, announcements, receipts,
acknowledgements, moderation actions, and audit records as appropriate.

Only an explicitly authorized administrator or approved operational process may
change disposition. It must record who approved it, its scope, rationale,
effective time, and affected data, without rewriting or silently removing the
audit trail. Holds must be released explicitly; release does not require
immediate deletion. Conflicts between a workspace request and a legal or
platform obligation are escalated for review rather than resolved by an
automatic job.

## Future partitioning and archive triggers

Release 1 makes no numeric capacity or retention promise. Future engineering
should evaluate partitioning or tiered archival when sustained growth causes
material query/maintenance impact, backup or restore pressure, storage-cost
pressure, or workspace isolation concerns. Candidate signals include
time-ordered message, notification, audit, moderation, download, receipt, and
comment tables becoming difficult to index or maintain, and attachment/object
storage growing faster than active use.

Before enabling such a system, define an owner, searchable archive format,
access and restore controls, workspace boundaries, legal-hold propagation,
backup treatment, reconciliation checks, and an auditable restore/disposition
process. Partitioning is an operational optimization, not permission to
discard data; any expiry requires a separately approved policy and migration
plan.