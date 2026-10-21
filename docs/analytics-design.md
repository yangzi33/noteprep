# Analytics event design, v2 (proposal for approval; **no implementation yet**)

Status: proposal. No migration and no code until the owner approves this document. It replaces the first draft and applies the owner's six revisions of 2026-10-21 (strict structured allowlist, 90-day provisional retention, purpose classes, B0 scope, baseline security not postponed, no optional collection before legal review). Third-party analytics (GA4), the consent banner and their CSP additions wait for [B4](beta-roadmap.md#b4). The legal classification of every event below is **pending qualified privacy review**; nothing here is a legal conclusion.

## 1. Scope of B0 ([B0](beta-roadmap.md#b0))
In: the event table, a validated server-side `track()`, a minimal set of operational events, purpose classification, access restrictions, retention and deletion enforcement, tests.
Out: GA4 and any third-party analytics, the consent banner, anonymous (signed-out) events, free-text feedback, any event not listed in section 3.

## 2. Purpose classes
| Purpose | Meaning | Default |
|---|---|---|
| `operational` | Necessary for service delivery, reliability, security or billing (abuse detection, audit of signed-URL issuance, rate-limit enforcement) | Written |
| `analytics` | Optional product analytics (how the product is used) | **Disabled.** Written only when the optional-analytics switch is on |

Rules:
- Operational events are **never reused for product analytics** unless the privacy notice discloses that purpose.
- Product metrics that come from existing service records (jobs, lessons, allowance) are queries over those tables, not events. Whether analysing them for product decisions needs a disclosed purpose is part of the pending review.
- Enabling optional analytics in production requires a config value that names the privacy-review reference; the app refuses to start with optional analytics on in production without it. In development, tests and staging it can be switched on, and on staging only for tutors whose consent email covers analytics ([data note](concierge/tutor-data-note.md) must list it first).
- No consent UI in B0; the consent banner and per-user consent record arrive in B4, and optional events then also require the user's recorded choice.

## 3. Exact event allowlist (version 1)
Every event requires a signed-in user. There are no anonymous events. Property values are closed enumerations or dataset-validated ids. **No free text anywhere.**

| Event | Purpose | Properties (all required unless noted) | Why it exists |
|---|---|---|---|
| `document_download_issued` | operational | `document` in {notes, worksheet, solutions}; `disposition` in {inline, attachment} | Audit of signed-URL issuance; abuse and incident investigation |
| `rate_limit_rejected` | operational | `scope` in {generation, adjustment, download}; `limiter` in {user, ip} | Detect abuse and tune limits. The IP address itself is never stored |
| `preview_opened` | analytics | `view` in {pdf, draft}; `document` in {notes, worksheet, solutions} | Which preview tabs get used |
| `topic_requested` | analytics | `topic_id`: an id that exists in the loaded topic dataset, max 200 characters, validated server-side; `course_tag` (optional) in {ON, BC, AB, IB, AP, OTHER} (closed list, owner confirms) | Demand signal for unavailable topics, without free text |

Not allowed: free text, URLs, titles, lesson/job/revision ids, emails, IP addresses, User-Agent strings, numbers other than bounded enumerations. Free-text feature requests, if needed, get a **separate feedback flow** with its own privacy notice and retention, designed on its own.

## 4. Table `analytics_event`
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | random |
| occurred_at | timestamptz | UTC, set by the server |
| schema_version | smallint | allowlist version |
| purpose | enum (`operational`, `analytics`) | fixed per event name; a CHECK ties names to purposes |
| name | text | CHECK constraint lists the allowed names; adding an event needs a migration |
| owner_id | uuid not null | signed-in user's profile id |
| props | jsonb | CHECK: an object, at most 512 bytes; keys and values validated by `track()` against the per-event schema |

Access: browsers and the Data API get no grants and RLS denies everything to `anon` and `authenticated`; the web runtime role can INSERT only; reading is limited to an admin role and scripts. These grants are tested in the Supabase boundary suite like other business tables.

## 5. `track()`
- Server-side only. Client interactions call a Server Action that checks the session, origin (CSRF), request size and a rate limit, then calls the same validation function that server code calls directly.
- Validation: name in the allowlist; props keys exactly match the event's schema; values are in their enumerations or pass the dataset check; otherwise the event is dropped (throws in development and tests). Nothing unknown is ever stored.
- `purpose = analytics` events are dropped unless the optional-analytics switch is on (section 2).
- Errors in `track()` never break the user action.

## 6. Retention and deletion
| Data | Retention |
|---|---|
| Raw events, both purposes | **90 days, provisional**, then deleted |
| Daily aggregates (`analytics_daily`: day, name, props, event count, distinct-user count; no `owner_id`) | Kept longer, period to be set in the privacy notice. With 10 to 30 Beta users, small counts can still be identifying, so aggregates are labelled aggregate, **not** anonymised in a legal sense, and cells below 5 users are suppressed |
| Account deletion | Raw events for that `owner_id` are deleted in the deletion flow; aggregates remain. Delayed erasure from backups is documented |

Enforcement: the worker's existing periodic sweep runs a purge that first rolls expired days into `analytics_daily`, then deletes raw rows older than 90 days. Tested against a real Postgres: purge removes only expired rows; deletion removes exactly one owner's rows; aggregates carry no identifiers.

## 7. Verification plan
Unit: allowlist and property validation reject unknown names, extra keys, free text, out-of-enum values and unknown topic ids; `analytics` events are dropped when the switch is off; the production start-up guard refuses optional analytics without a review reference. Integration (real Postgres): grants and RLS, purpose/name CHECKs, purge and aggregate rollup, owner-deletion. E2E: downloading a PDF writes exactly one `document_download_issued` row with only its two properties; with the switch off, previewing writes nothing.

## 8. Separate item: baseline CSP (not analytics, not postponed)
The app sends no Content-Security-Policy header today. A baseline CSP is a launch security control independent of analytics. Proposal: add it as its own small task in B0: first `Content-Security-Policy-Report-Only`, checked against the real pages (Next.js, KaTeX, fonts, Supabase, PDF viewer), then enforced. It contains no Google domains. This needs your approval as a separate item.

## 9. Decisions for the owner
1. Approve or change the four events and their properties (section 3), including the `course_tag` list.
2. Approve the purpose classes and the optional-analytics default-off rule with the production guard (section 2).
3. Approve 90 days provisional retention, the aggregate rule, and deletion on account removal (section 6).
4. Approve the baseline CSP as a separate B0 task (section 8).
5. Confirm that B0 builds only sections 3 to 7; GA4, the banner and consent records stay in [B4](beta-roadmap.md#b4).
