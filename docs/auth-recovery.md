# Sign-in recovery

Forgot password, set a new password, and resend the confirmation email. The email links use Supabase Auth's token-hash flow (`verifyOtp`), so they work in any browser. The two requesting actions use a stateless Supabase client that keeps no cookies and no PKCE verifier.

## Flows

| Step | Route | Behaviour |
|---|---|---|
| Request a reset | `/login/reset` (action `requestPasswordReset`) | Validates the email, calls `resetPasswordForEmail` with `redirectTo = <SITE_URL>/auth/recovery`, ignores the result, always redirects to `/login?notice=reset-sent`. A malformed address goes to `/login/reset?error=invalid`. |
| Resend confirmation | `/login/resend` (action `resendConfirmation`) | Validates the email, calls `auth.resend({ type: "signup" })` with `emailRedirectTo = <SITE_URL>/auth/callback`, ignores the result, always redirects to `/login?notice=check-email` (`check-email-invite` in invite mode; see "Invite-only sign-up"). |
| Open the reset link | `GET /auth/recovery` (page), then `confirmRecovery` (Server Action) | The page only validates the shape of `token_hash` (1 to 512 characters of `A-Za-z0-9._~-`) with `type=recovery`, or an old one-time `code`, and shows a Continue button; it needs no session and does not redeem anything. Pressing Continue POSTs a hidden field to `confirmRecovery`, which calls `verifyOtp` (or exchanges the code; old links only, and only if the browser still holds its PKCE verifier) with the cookie-keeping server client, so the session cookie is set by a Server Action exactly as in sign-in, and then redirects to the relative path `/account/password`. An unusable or missing parameter shows "This link cannot be used" with a link to `/login/reset`; any redemption failure or thrown error redirects to `/login?error=recovery`. A `next` parameter is ignored; the request Host and `SITE_URL` are not used for the redirect; the token is never echoed in page text or logged; the page sends `Referrer-Policy: no-referrer` metadata and `noindex`. Because the token is redeemed only on POST, a mail scanner that GETs the link does not consume it. |
| Confirm the address | `GET /auth/callback` | Still a route handler (not yet moved to a Continue page). Accepts `token_hash` with `type` `signup` or `email` (`verifyOtp`), or a `code`; honours a safe same-site `next` path. |
| Choose a password | `/account/password` (action `updatePassword`) | Requires a verified session and an active account (page and action both call `requireAccount`). Validates 10 to 72 characters and a matching confirmation, calls `auth.updateUser({ password })`, signs out the user's other sessions (`scope: "others"`), then redirects to `/account?notice=password-updated`. Errors use the allowlisted keys `invalid`, `mismatch`, `failed`. |

Messages are looked up by allowlisted key (`src/lib/ui/login-messages.ts`); nothing from the query string is rendered.

## Generic responses

The two email actions answer the same way whether or not the address has an account, whether the provider call succeeded, failed or threw, and whether the request was rate limited. There is no early return for unknown addresses. This keeps the pages from being used to probe which addresses are registered.

## Per-IP limit

The three actions that can send email to any address (reset, resend, sign-up) are each limited per kind, per hour, in `rate_limit_window` (`webDal().authRate.hit`): first a global counter (`auth:<kind>:global`), then a per-IP counter (`auth:<kind>:ip:<hash>`). Once the global cap is hit no per-IP row is created. Over either limit, the action skips the provider call and still redirects to the same generic page. A failing counter is treated as over the limit and logged as one line (event, kind, error class; no address, IP or code).

- Kinds are `reset`, `resend` and `signup`. In invite mode `resend` and `signup` hit the counter for every address, listed or not, before the listed-only provider call, so an unlisted address does the same metered database work as a listed one.
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

Response time can differ for known addresses (the provider call is slower when it sends mail). In invite mode the same applies to the invite list: a listed address also pays the remote Auth round trip, so a patient observer who can time many requests could tell listed from unlisted addresses; the per-IP limit (10 an hour by default) bounds how many can be tried from one host. This is accepted for the small tester pilot; closing it would need a deliberate delay or a queue and is not implemented. `rate_limit_window` rows are bounded by the global cap but not purged.

## Invite-only sign-up (tester pilot)

`SIGNUP_MODE` and `SIGNUP_ALLOWLIST` (README, environment table) gate **this app**, not Supabase Auth.

### What happens to an uninvited address

Verified on the local Supabase stack (`supabase/config.toml`: `enable_signup = true`, `enable_confirmations = true`) and by reading the code. Hosted project settings were not inspected.

| Path | Result |
|---|---|
| Sign-up or resend form in the app, unlisted address | No Auth call, no `auth.users` row, no email. The page shows the same notice as for a listed address (the timing difference is described under "Known limits"). The request still counts against the per-IP limiter. |
| Direct call to the Supabase Auth sign-up endpoint with the publishable key (which ships in the browser bundle by design) | Verified locally: an unconfirmed `auth.users` row is created for the supplied address and a confirmation email is sent to it. The address may belong to someone who never asked. No `profile` row and no `usage_bucket` row is created. |
| That mailbox owner opens the confirmation link, then signs in | The Auth user becomes confirmed. `requireAccount` sends them to `/not-invited`; still no profile or allowance. They hold an Auth identity (email, password hash, timestamps) and nothing else. |
| Confirmed Auth user with no profile | Reads nothing: the data routes only return rows owned by the caller, and `ensureAccount` has one caller, behind the allowlist check. |

NotePrep itself never deletes these Auth rows (the account-deletion flow in `docs/security-and-privacy.md` starts from a profile). Until the owner adds a purge, they stay until removed.

### Removal on request

A person who reached `/not-invited` can ask for removal through the contact address on that page. The owner deletes the Auth user in the Supabase dashboard (Authentication, Users) or with the Auth admin API using the secret key; there is no profile or storage object to delete for such a user. Nothing in the app can do this today.

### Owner-side hardening options

Remote Supabase settings are not changed by this repository. Each option below is a choice for the owner; "checked" means read in the current Supabase documentation on 2026-11-02, not tried on a hosted project.

1. **Auth rate limits** (checked): emails per hour (2 an hour with the built-in email service) and sign-ups/sign-ins per IP (30 requests per 5 minutes by default) are configured under Authentication, Rate Limits; there is also a 60-second per-user window for signup confirmations and resets. This bounds, but does not stop, direct sign-ups.
2. **Before User Created Auth Hook** (partly checked): the documentation describes a hook that runs before a user is created and can reject the request with an error object (`http_code`, `message`). It would close the gap at the source by rejecting non-allowlisted addresses. NOT verified: which plans include it, whether it also runs for admin-created users, and how the allowlist would be shared with the hook (it would need its own copy of the list).
3. **CAPTCHA** (partly checked): Supabase supports hCaptcha and Cloudflare Turnstile and expects a `captchaToken` from the client. Turning it on would make this app's own sign-up, resend and reset actions fail until they send that token, so it needs a code change first. Plan availability NOT verified.
4. **Disable public sign-ups** (dashboard, Authentication, Sign In / Providers): not tried. It would also stop this app's own sign-up form, because that uses the same Auth endpoint, so it only works if invited testers are created by the owner (admin-created or invited by email) instead of self-registering.
5. **Purge**: no automatic removal of unconfirmed users was found in the documentation (not found is not the same as absent). A periodic owner-run deletion of Auth users that are unconfirmed, or confirmed with no profile, after a retention period the owner chooses, is the manual alternative.

### Owner decisions pending

- Which hardening option(s) above, and the retention period for unconfirmed and profile-less Auth users.
- Whether to accept the invite-list timing difference for the pilot (current choice) or close it.
- Wording of `/not-invited` (the text is a proposal in PR #67) and whether the tester data note (`docs/concierge/tutor-data-note.md`) should say that tester addresses are also kept on an invite list held in the hosting provider's environment settings (`SIGNUP_ALLOWLIST`; mark it Sensitive in Vercel and keep real addresses out of git and issue comments).
- Staging: a deployment built with `NODE_ENV=production` and no `SIGNUP_ALLOWLIST` admits nobody; give staging its own allowlist, or `SIGNUP_MODE=open` with test data only.
