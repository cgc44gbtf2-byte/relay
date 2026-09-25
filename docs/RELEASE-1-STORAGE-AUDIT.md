# Storage access audit

Scope: authenticated upload URL issuance, object references, downloads, and
deletion of task, document, announcement, and chat attachments. The tests use
synthetic paths and a mocked signer; they never PUT, GET, or DELETE a real user
object.

| Boundary | Enforcement in this application | Qualification |
| --- | --- | --- |
| Upload URL issuance | `/storage/uploads/request-url` requires authentication, rate-limits requests, checks the declared filename, MIME type, and size (25 MB maximum; 10 MB for task, announcement, and channel contexts), and authorizes the exact workspace resource before requesting a 15-minute PUT URL. A document creator uses `document/new`; version uploads use the existing document ID. Workspace channel uploads require channel membership. New unscoped URLs for global rooms and direct messages use a server-signed, uploader-bound object path. | The signer receives a bucket, object name, method and expiry, **not a content-length or MIME constraint**. |
| Actual PUT to object storage | The browser sends the bytes directly to the signed provider URL; the API server is not on this data path. | **Provider-level size, type, byte-content, and single-use enforcement have not been established.** A client can change the bytes or content type after claiming valid metadata, or reuse a PUT URL until expiry. The 10/25 MB limits are application metadata checks, not limits on bytes accepted by the provider. No live provider objects were probed for this audit. |
| Reference creation | Task and announcement attachments, document creation/versions, and workspace channel messages/attachments require a valid path with the exact workspace, resource type, and resource ID suffix. The server checks the filename, declared size, and normalized MIME type again when saving the reference. Global-room/DM references require a valid uploader-bound signature on the unscoped path and reject paths already referenced in any task, document, announcement, or message attachment. Bare legacy unscoped paths cannot be newly attached, even after their old reference is deleted. A failed file-message transaction does not leave a blank message. | Scoped path matching does not prove who requested it; neither path form proves that a PUT happened or that stored bytes match declared metadata. Legacy unscoped references already saved remain readable by their original authorized audience. Unscoped path reuse checks are not a database-enforced uniqueness guarantee under concurrent writes, and the original uploader can reuse their signed path after a reference is removed. |
| Read/download | Attachment reads join the requested parent to its workspace (or message audience), require current membership/visibility permissions, then redirect to a short-lived signed GET URL. Cross-workspace resource-ID substitutions return a denial or not-found before signing. | A recipient can share a signed URL during its remaining validity. Provider bucket IAM and policies were not inspected here. |
| Deletion | Workspace and announcement deletion queue their referenced objects for deletion in the same transaction as reference removal; the worker signs DELETE requests, retries failures, and alerts operators after repeated or prolonged failures. | Abandoned uploads that were never referenced are not automatically collected by this queue; the provider may retain them. No production deletions were performed. |

## Isolated evidence

- `artifacts/api-server/src/routes/storage.test.ts` covers accepted/rejected metadata,
  parameterized active MIME types, context parsing, and exact resource/path matches.
- `artifacts/api-server/src/admin.test.ts` covers denied cross-workspace URL claims,
  workspace/resource and path substitutions across attachment types, duplicate legacy
  unscoped-path reuse before and after deletion, queued announcement cleanup, and
  authorized signed-download boundaries. The fixtures do
  not contact the storage provider.
- `artifacts/web-irc/src/App.test.tsx` checks that a workspace channel upload sends
  its workspace and channel context to the URL issuer.

Release qualification: these tests establish application authorization and
metadata policy, **not** provider-enforced upload limits or verified object
contents. If hard limits on uploaded bytes/types are required, add a supported
provider-side upload policy or a bounded server-mediated upload/verification
step before claiming that the actual PUT boundary enforces them.