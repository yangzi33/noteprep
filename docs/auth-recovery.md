# Sign-in recovery

Forgot password, set a new password, and resend the confirmation email. The email links use Supabase Auth's token-hash flow (`verifyOtp`), so they work in any browser. The two requesting actions use a stateless Supabase client that keeps no cookies and no PKCE verifier.

## Flows

| Step | Route | Behaviour |
|---|---|---|
| Request a reset | `/login/reset` (action `requestPasswordReset`) | Validates the email, calls `resetPasswordForEmail` with `redirectTo = <SITE_URL>/auth/recovery`, ignores the result, always redirects to `/login?notice=reset-sent`. A malformed address goes to `/login/reset?error=invalid`. |
| Resend confirmation | `/login/resend` (action `resendConfirmation`) | Validates the email, calls `auth.resend({ type: "signup" })` with `emailRedirectTo = <SITE_URL>/auth/callback`, ignores the result, always redirects to `/login?notice=check-email`. |
| Open the reset link | `GET /auth/recovery` (page), then `confirmRecovery` (Server Action) | The page only validates the shape of `token_hash` (1 to 512 characters of `A-Za-z0-9._~-`) with `type=recovery`, or an old one-time `code`, and shows a Continue button; it needs no session and does not redeem anything. Pressing Continue POSTs a hidden field to `confirmRecovery`, which calls `verifyOtp` (or exchanges the code; old links only, and only if the browser still holds its PKCE verifier) with the cookie-keeping server client, so the session cookie is set by a Server Action exactly as in sign-in, and then redirects to the relative path `/account/password`. An unusable or missing parameter shows "This link cannot be used" with a link to `/login/reset`; any redemption failure or thrown error redirects to `/login?error=recovery`. A `next` parameter is ignored; the request Host and `SITE_URL` are not used for the redirect; the token is never echoed in page text or logged; the page sends `Referrer-Policy: no-referrer` metadata and `noindex`. Because the token is redeemed only on POST, a mail scanner that GETs the link does not consume it. |
| Confirm the address | `GET /auth/callback` | Still a route handler (not yet moved to a Continue page). Accepts `token_hash` with `type` `signup` or `email` (`verifyOtp`), or a `code`; honours a safe same-site `next` path. |
| Choose a password | `/account/password` (action `updatePassword`) | Requires a verified session and an active account (page and action both call `requireAccount`). Validates 10 to 72 characters and a matching confirmation, calls `auth.updateUser({ password })`, signs out the user's other sessions (`scope: "others"`), then redirects to `/account?notice=password-updated`. Errors use the allowlisted keys `invalid`, `mismatch`, `failed`. |

Messages are looked up by allowlisted key (`src/lib/ui/login-messages.ts`); nothing from the query string is rendered.

## Generic responses

The two email actions answer the same way whether or not the address has an account, whether the provider call succeeded, failed or threw, and whether the request was rate limited. There is no early return for unknown addresses. This keeps the pages from being used to probe which addresses are registered.

## Per-IP limit

The two actions can send email to any address, so each is limited per kind, per hour, in `rate_limit_window` (`webDal().authRate.hit`): first a global counter (`auth:<kind>:global`), then a per-IP counter (`auth:<kind>:ip:<hash>`). Once the global cap is hit no per-IP row is created. Over either limit, the action skips the provider call and still redirects to the same generic page. A failing counter is treated as over the limit and logged as one line (event, kind, error class; no address, IP or code).

- `AUTH_EMAIL_PER_IP_PER_HOUR`: integer 1 to 1000, default 10.
- `AUTH_EMAIL_GLOBAL_PER_HOUR`: integer 1 to 100000, default 200, per kind.
- IPv6 addresses are bucketed by /64; IPv4-mapped IPv6 counts as its IPv4. A value that is not a valid IPv4 or IPv6 address (malformed, bracketed, leading zeros) uses the shared fallback bucket.
- Only requests the per-IP limit accepts count toward the global cap, so one host cannot use up the global cap for everyone.
- The address comes from `x-real-ip`, else the first `x-forwarded-for` entry, and is stored only as a truncated SHA-256 hash. Requests with no address share one fallback bucket.
- This relies on the hosting proxy setting those headers; behind a proxy that passes client-supplied values through, the limit can be evaded by rotating the header.

## Owner steps (Supabase dashboard, staging and production)

Remote settings are not changed by this repository.

0. REQUIRED, staging and production: update the hosted email templates to the token-hash form, or reset links fail closed ("invalid or expired") because the requesting actions no longer keep a PKCE verifier. Authentication, Email Templates:
   - Reset password: link `{{ .SiteURL }}/auth/recovery?token_hash={{ .TokenHash }}&type=recovery`
   - Confirm signup: link `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup`
   - Site URL (Authentication, URL Configuration) must be the exact origin, for example `https://noteprep.app`, with no trailing slash.
   - Until the hosted "Confirm signup" template is also switched, resent confirmation links land on `/login?error=callback`; the address may already be confirmed server-side, so the user can just sign in.
   - The link opens a Continue page; the token is redeemed only when the user presses Continue. `/auth/recovery` also accepts old `code` links, but only if the browser still has its verifier.
1. Authentication, URL Configuration, Redirect URLs: add the exact URL `<SITE_URL>/auth/recovery` (for example `https://noteprep.app/auth/recovery`). `<SITE_URL>/auth/callback` is already required.
2. Authentication, Providers, Email: minimum password length 10; "Secure password change" on; leaked password protection on if the plan offers it. Locally `supabase/config.toml` sets `minimum_password_length = 10` and `secure_password_change = true`.
3. The default Supabase email service is heavily rate limited (a few emails per hour for the whole project). Real use needs a custom SMTP provider (Authentication, SMTP Settings).
4. Supabase also enforces its own per-address cooldown between emails; a second request inside it sends nothing, and the page still shows the generic notice.

Local: `supabase/templates/recovery.html` and `confirmation.html` carry the token-hash links and are registered in `supabase/config.toml`, which also lists `http://127.0.0.1:3000/auth/recovery` in `additional_redirect_urls` (an exact-match list).

## Known limits

Response time can differ for known addresses (the provider call is slower when it sends mail). `rate_limit_window` rows are bounded by the global cap but not purged.
