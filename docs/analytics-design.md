# Analytics event design (draft, D-84; **not approved for build**, needs confirmation first)

Status: design draft. No migration and no code. Basis: D-84 (two layers: GA4 + first-party events) and CLAUDE.md §9 (logs and metrics must not contain lesson content, student information, JWTs or signed URLs).

## 1. First, separate what needs no new table
These metrics can be queried from **existing tables**. They need no event table and are not affected by the consent banner, because they are records the service needs to run:
- Activation: each account's first successful generation time (`generation_job` / `lesson_revision`).
- Return visits: the number of jobs an account creates on different days or weeks.
- Cost and duration per lesson: the job's token/cost fields and stage durations (**to verify**: which fields already exist).
- Allowance use: `usage_bucket` / `usage_reservation`.
- Adjustment counts (after B2): the adjustment records.

**Only signals that no existing table holds need events**: UI behaviour (opening a preview, which PDF was downloaded, clicking "request this topic", submitting feedback, the banner choice) and marketing-site traffic.

## 2. Table `analytics_event` (only for the UI signals above)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | random default |
| occurred_at | timestamptz | UTC |
| owner_id | uuid null | signed-in user's profile id; null for anonymous events. Deleted together with the account |
| name | text | an allowlisted event name (see §3), enforced by a CHECK constraint |
| params | jsonb | allowlisted keys only; values are short strings, numbers or booleans; CHECK on size |
| consent | text | consent level when recorded: `all` / `essential` |

Notes:
- No email, IP address, User-Agent, URL, or lesson/job/revision ids are stored. Topics and levels in `params` use stable topic ids from the dataset, never user-typed text.
- Under the `deny` level **no** such events are written.
- Retention: 13 months by default (`TEST VALUE`, to be fixed in the privacy notice), with a periodic cleanup job.
- The runtime role may INSERT only its own rows and may not read other users' data; reading is limited to admin accounts and scripts. RLS and grants must be tested separately, like other business tables.

## 3. Event allowlist (first version, can change)
`topic_requested` (topic_text truncated and cleaned, optional course tag), `pdf_downloaded` (document=notes|worksheet|solutions), `preview_opened` (view=pdf|draft), `feedback_submitted` (no body; the body goes through the feedback channel), `consent_chosen` (level), `signup_started`. The allowed parameter keys for each event live in one TypeScript constant, and `track()` drops everything else.

Note: the free text of `topic_requested` may contain personal information. Store only a **topic id chosen from a list**, or text with a length limit, and show the hint "do not enter student names" in the UI. Whether to keep free text at all is undecided.

## 4. The `track()` wrapper
- A single entry point: `track(name, params)` on the client calls a server endpoint that validates and writes; server-side actions call the same validation function directly.
- Validation: the name is in the allowlist; parameter keys are in that event's allowed set; value types and lengths are checked; anything else is dropped (throws in development).
- Consent: the server reads the `np_consent` cookie (`all` / `essential` / `deny`). A missing cookie counts as `deny`. `deny` writes nothing; `essential` writes with `consent='essential'`; `all` additionally allows GA.
- Rate limits and a request size cap prevent table flooding.
- GA is switched off by environment flag in development, tests and CI. First-party writes stay available in tests.

## 5. GA4 (B4)
- Loaded dynamically only after `np_consent=all`; no `user_id`; no email; page paths cleaned to route patterns (`/lessons/:id`); events go through the same `track()`, with a subset of the allowlist forwarded.
- CSP: add response headers that allow Google's script and connect domains only when enabled. (**The domains and quotas must be checked against official documentation; they are not verified here.**)

## 6. Consent banner (B4)
Three buttons: Accept all / Essentials only / Deny all. The choice is stored in the `np_consent` cookie (one year, SameSite=Lax) and a single `consent_chosen` event is recorded (not for deny). A "Cookie settings" footer link lets people change it.

## 7. Questions for the owner
1. Is the first event allowlist right (§3), especially: should `topic_requested` allow free text?
2. Is 13 months of retention acceptable?
3. Should first-party UI-signal events be recorded under `essential` (the D-84 assumption; someone qualified must check whether they count as "essential")?
4. Build only this table and `track()` now (B0), and leave GA4, the banner and the CSP to B4?

## 8. Verification plan
Unit: the allowlist and parameter validation reject forbidden keys and over-long values; `deny` writes nothing. Integration (real Postgres): RLS and role permissions, account-deletion cascade, retention cleanup. E2E: no analytics request without consent; a PDF download produces one event with no ids.
