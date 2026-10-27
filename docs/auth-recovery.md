# Sign-in recovery

Forgot password, set a new password, and resend the confirmation email. All of it uses Supabase Auth's PKCE email flow.

## Flows

| Step | Route | Behaviour |
|---|---|---|
| Request a reset | `/login/reset` (action `requestPasswordReset`) | Validates the email, calls `resetPasswordForEmail` with `redirectTo = <SITE_URL>/auth/recovery`, ignores the result, always redirects to `/login?notice=reset-sent`. A malformed address goes to `/login/reset?error=invalid`. |
| Resend confirmation | `/login/resend` (action `resendConfirmation`) | Validates the email, calls `auth.resend({ type: "signup" })` with `emailRedirectTo = <SITE_URL>/auth/callback`, ignores the result, always redirects to `/login?notice=check-email`. |
| Open the reset link | `GET /auth/recovery` | Exchanges the one-time `code` for a session, then redirects to the fixed path `/account/password` on `<SITE_URL>`. On any failure it redirects to `/login?error=recovery`. A `next` parameter is ignored; the request Host is never used; the code is never echoed. |
| Choose a password | `/account/password` (action `updatePassword`) | Requires a verified session (page and action both call `requireUser`). Validates 10 to 72 characters and a matching confirmation, calls `auth.updateUser({ password })`, then redirects to `/account?notice=password-updated`. Errors use the allowlisted keys `invalid`, `mismatch`, `failed`. |

Messages are looked up by allowlisted key (`src/lib/ui/login-messages.ts`); nothing from the query string is rendered.

## Generic responses

The two email actions answer the same way whether or not the address has an account, whether the provider call succeeded, failed or threw, and whether the request was rate limited. There is no early return for unknown addresses. This keeps the pages from being used to probe which addresses are registered.

## Per-IP limit

The two actions can send email to any address, so each is limited per client IP and per kind: `rate_limit_window` keys `auth:reset:ip:<hash>` and `auth:resend:ip:<hash>`, counted per hour (`webDal().authRate.hit`). Over the limit, the action skips the provider call and still redirects to the same generic page. A failing counter is treated as over the limit.

- `AUTH_EMAIL_PER_IP_PER_HOUR`: integer 1 to 1000, default 10.
- The address comes from `x-real-ip`, else the first `x-forwarded-for` entry, and is stored only as a truncated SHA-256 hash. Requests with no address share one fallback bucket.
- This relies on the hosting proxy setting those headers; behind a proxy that passes client-supplied values through, the limit can be evaded by rotating the header.

## Owner steps (Supabase dashboard, staging and production)

Remote settings are not changed by this repository.

1. Authentication, URL Configuration, Redirect URLs: add the exact URL `<SITE_URL>/auth/recovery` (for example `https://noteprep.app/auth/recovery`). `<SITE_URL>/auth/callback` is already required.
2. Authentication, Email Templates: check that "Reset password" and "Confirm signup" use `{{ .ConfirmationURL }}` (the default).
3. The default Supabase email service is heavily rate limited (a few emails per hour for the whole project). Real use needs a custom SMTP provider (Authentication, SMTP Settings).
4. Supabase also enforces its own per-address cooldown between emails; a second request inside it sends nothing, and the page still shows the generic notice.

Local: `supabase/config.toml` lists `http://127.0.0.1:3000/auth/recovery` in `additional_redirect_urls` (an exact-match list).
