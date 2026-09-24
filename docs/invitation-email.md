# Workspace invitation email

Creation and resend save the invitation first, then attempt delivery through the
Replit Resend connector. The manager always receives a private fallback link.
Provider failures do not undo the invitation or disclose provider error details.

## Enable delivery

1. Connect Resend to the project using Replit Integrations.
2. Verify a sending domain in Resend.
3. Configure these server-side environment variables for each environment:
   - `INVITATION_EMAIL_FROM`: a verified sender, e.g. `Relay <invites@example.com>`.
   - `INVITATION_APP_URL`: the trusted HTTPS frontend URL, including its base path
     if mounted beneath one. No query string, fragment, or credentials.
4. Restart the API service (and redeploy when configuring production).

No provider API key is stored in application code. The connector supplies
authentication at request time. With both settings absent, the UI reports that
email is not configured; partial or invalid settings report a delivery failure.
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
```