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
```