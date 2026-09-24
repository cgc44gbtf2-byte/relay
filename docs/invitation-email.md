# Workspace invitation email

Creation and resend save the invitation first, then attempt delivery through
Resend's HTTPS API. The manager always receives a private fallback link.
Provider failures do not undo the invitation or disclose provider error details.

## Enable delivery

1. Verify a sending domain in Resend and create a sending API key.
2. Save `RESEND_API_KEY` as a Replit Secret for the server environment. Never put
   it in frontend code, a `.env` file committed to the repository, or logs.
3. Configure these server-side environment variables for each environment:
   - `INVITATION_EMAIL_FROM`: a verified sender, e.g. `Relay <invites@example.com>`.
   - `INVITATION_APP_URL`: the trusted HTTPS frontend URL, including its base path
     if mounted beneath one. No query string, fragment, or credentials.
4. Restart the API service (and redeploy when configuring production).

## Track delivery

Create a Resend webhook for `email.delivered`, `email.bounced`, `email.failed`,
and `email.complained`, targeting the public API endpoint
`https://YOUR_API_HOST/api/webhooks/resend`. Save that webhook's signing secret
(the `whsec_` value from the Resend dashboard) in the API environment as
`RESEND_WEBHOOK_SECRET`. Set it independently in development and production;
do not reuse the API key as the webhook secret. Redeploy/restart the API after
setting it. Without this secret the endpoint rejects requests and no webhook
statuses are recorded. Ensure the release migration
`0025_invitation_email_delivery.sql` is applied before deploying this code,
following `docs/DATABASE-MIGRATIONS.md`; do not manually edit production
tables. Resend retries webhook failures. The endpoint requires the original
JSON bytes and verifies the Svix signature and five-minute timestamp window.
If exposing the API via a reverse proxy, forward the `svix-id`,
`svix-timestamp`, and `svix-signature` headers unchanged.

Manager invitation responses and workspace invitation pages expose
`emailDeliveryStatus` (`queued`, `sent`, `delivered`, `bounced`, `failed`,
`complained`, or `not_configured`) and `emailDeliveryUpdatedAt` (ISO timestamp
or null for older rows). `sent` is provider acceptance; `delivered` means
accepted by the recipient mail server, not read. `bounced`, `failed`, and
`complained` indicate delivery problems. Each resend rotates the invitation
token and delivery attempt, clearing the previous outcome. Events are correlated
by opaque attempt tag and Resend email ID; old attempts, duplicates, and
out-of-order delivery events cannot replace the active outcome. Neither
provider error details nor the private invitation token are saved as delivery
metadata. Only authorized managers should receive invitation lists.

The server sends the key as a bearer token to `https://api.resend.com/emails`.
With both settings absent, the UI reports that email is not configured; partial,
invalid, or missing-key settings report a delivery failure.
Use the published frontend URL in production, not a development preview URL.

`emailDelivery` in create/resend responses contains a status (`sent`,
`not_configured`, or `failed`) and a safe display message. `sent` means the provider
accepted the email, not confirmed inbox delivery. Failed or timed-out delivery can
be retried with resend, which rotates the token and invalidates the old link.
Invitation tokens are never sent to logs or included in error messages. The
existing manager-only private link response remains intentional.

Run focused checks:

```sh
cd artifacts/api-server
node build-tests.mjs
NODE_ENV=test node --test dist-tests/lib/invitation-email.test.cjs
NODE_ENV=test node --test dist-tests/lib/invitation-delivery.test.cjs
```