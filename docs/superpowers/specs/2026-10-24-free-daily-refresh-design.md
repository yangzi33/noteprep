# Free daily refresh (temporary beta allowance): design

Status: draft for the owner's review. Nothing here is built. It changes the allowance rules in CLAUDE.md section 5, so the exact wording to add is in section 9 and needs the owner's approval before anyone edits CLAUDE.md or `docs/decisions.md`. Written 2026-10-24 from a conversation with the owner; items marked "builder's call" or "my call" were not decided by the owner.

## 1. Intent and why
During the beta, a free lifetime allowance of 3 exports runs out before a tutor has formed a habit. The owner wants real beta tutors to get **5 free exports per UTC day, refreshed at 00:00 UTC**, as a **temporary** perk that is switched off later. When it is switched off, the permanent rule applies again: **3 free exports for the account's whole life, counting every export made during the beta**. A tutor who made 3 or more exports during the beta then has 0 free exports left and sees the subscribe path.

## 2. Goals
- Free accounts can export up to a daily limit (default 5), counted per UTC day, resetting at 00:00 UTC.
- One on/off setting turns the perk on and off without a code change. Default off.
- Switching it off returns to the lifetime-3 rule, with beta exports counted toward the 3.
- Every existing invariant of CLAUDE.md section 5 keeps holding: reserve at confirmation, one-way reserved to consumed or released, consume only when the complete PDF set is stored, release on failure or cancel, identical re-export never charges twice, no refund for deleted lessons, no double spend under concurrency.
- The tutor sees the right numbers: how many exports are left today and when they refresh (perk on), or how many are left in total (perk off).

## 3. Non-goals
- A permanent daily allowance, a configurable per-plan allowance, or a per-account limit setting.
- Any change to paid subscriptions: an entitled account keeps drawing only from its paid period bucket (D-07) and the perk never applies to it.
- Admin screens, per-user overrides, analytics, or a purge of old daily rows.
- Changing export identity, pricing, Stripe behaviour, rate limits or compile quotas.

## 4. Anti-goals (a failure even if it technically works)
- Anyone getting more than the daily limit on one UTC day, or a restored allowance after the perk is switched off.
- A perk-off account that made 3 or more beta exports still being able to export.
- A reservation that settles against the wrong bucket, or a counter that disagrees with the reservation rows.
- Unbounded compile cost: the perk must not remove the existing rate, concurrency and global queue limits.

## 5. How it works (the decided behaviour)
- **Setting.** `DAILY_REFRESH_ENABLED` (default `0`) and `DAILY_REFRESH_LIMIT` (default `5`, small positive integer). Read by the web app, which is the only place that chooses the bucket (worker settlement works from the reservation's bucket). Both are placeholders until the owner confirms the values.
- **Which allowance a request uses.** The one rule stays in one place (`resolveAllowanceSource` and `selectBucket` in `src/lib/server/dal/allowance-source.ts`; generation and export both go through it, so both flows get the perk). An entitled paid account: paid bucket, unchanged. Anyone else: with the setting on, today's daily bucket; with it off, the lifetime trial bucket as today. The source is fixed at enqueue time and never re-chosen.
- **Daily bucket.** One per account per UTC day: a `usage_bucket` row of a new kind `daily`, `limit_count` = the limit at creation, `starts_at` = 00:00 UTC of that day, `ends_at` = 00:00 UTC of the next day, identified by a day number (days since the Unix epoch). Created lazily inside the reservation transaction (insert, ignoring a concurrent duplicate), then locked like any bucket. `used + reserved <= limit_count` holds per bucket as today. A reservation made before midnight finishes against the bucket it reserved on, like a paid job finishing after its period.
- **Lifetime accounting (the "3 in total").** While the setting is on, the trial bucket is untouched. When the setting is off, free availability is `3 - trial.used - trial.reserved - SUM(daily.used + daily.reserved)` over the account's daily buckets, clamped at 0, computed under the trial bucket's row lock. Counting `daily.reserved` as well as `daily.used` makes a beta export still in flight at the moment the perk is switched off count too. The trial bucket's own `used + reserved <= limit` constraint is unchanged. While the perk is on there is no lifetime cap (that is the perk).
- **Display.** Perk on: "N of 5 exports left today, refreshes at 00:00 UTC" wherever the allowance is shown today. Perk off: the existing lifetime wording with the beta-adjusted remaining count. Exact copy is the builder's call within the existing UI patterns.
- **Reminder (owner requirement, 2026-10-25).** With the perk on, a tutor must be told about the daily refresh and see how many exports are left, not just find a number. It shows in each place the allowance is shown today (the dashboard "Your allowance" block, the prepare page header, and the export confirmation page) and reads like: "Beta perk: 5 free exports every day. 3 of 5 left today. Refreshes at 00:00 UTC." The export confirmation also says how many will be left after this export. When the daily count is used up, the message says the count comes back at 00:00 UTC (see section 6 and the builder notes). While billing is off, the exhausted state shows no subscribe button, only "contact us". The reminder disappears when the perk is off. All of it is computed from the same allowance view as the numbers, so text and count cannot disagree.
- **Switching on and off.** Turning it on later starts a fresh daily bucket for that day and counts toward the lifetime total as above. Turning it off and on again is allowed and consistent with the formulas.

## 6. Constraints
- CLAUDE.md section 5 and the existing tests stay true except for the amendment in section 9. Math verification, owner isolation, sandboxing, fencing and settlement invariants are not touched.
- Schema changes need migrations that are reviewable and forward-only: a new `bucket_kind` value, the `usage_bucket_kind_shape` check extended for `daily` (no subscription, a period key, an end time), and a unique index on the owner and day number for daily buckets. Adding the enum value needs its own migration (the D-110 precedent). Applying migrations to staging or production is the owner's step through the Database migrations workflow.
- `usage_bucket_drift` must still report zero rows; it already works per bucket regardless of kind.
- Time comes from one source, the same one the paid bucket window uses (the app passes `now`), so the day boundary is tested with injected times.
- Old daily rows are kept: they are the record that feeds the lifetime sum. One row per account per active day is acceptable for the beta.

## 7. Risks the owner should know
- **Cost.** Each verified signup can export up to 5 times a day for as long as the perk is on, and every export is a real compile. The existing controls stay (verified email, per-user and global export limits, concurrency limits), but they were sized for a lifetime of 3. The limit values should be reviewed before the perk is on anywhere the public can sign up.
- **The switch-off is a visible change** for tutors who used the perk heavily: they will have 0 free exports left. Tell beta tutors beforehand (copy and timing are the owner's).
- **Clock skew** between web instances is negligible at day granularity, but a reservation near 00:00 UTC lands on whichever day the reserving transaction's `now` falls on.

## 8. Acceptance checks (observable behaviour, for the plan)
Allowance rules, with fake time and a real Postgres:
1. Perk on: five exports on one UTC day succeed, the sixth is refused with the existing "allowance exhausted" outcome; after 00:00 UTC the next export succeeds; the trial bucket is unchanged throughout.
2. Two concurrent confirmations for the last daily export: exactly one wins.
3. A double click, retry or identical re-export on the same day uses no extra export (existing identity rules) and no extra daily count.
4. A failed or canceled export releases its daily reservation; a successful one consumes exactly once.
5. A reservation made at 23:59:59 UTC settles against that day's bucket after midnight; the new day's bucket is untouched.
6. Perk off after N beta exports: remaining free is `max(0, 3 - N)`; N >= 3 refuses with the existing exhausted outcome; an export in flight when the perk is switched off counts.
7. Perk on, off, on: counts stay consistent; `usage_bucket_drift` and `export_state_drift` return zero rows after every step.
8. A paid, entitled account is unaffected in both settings.
9. The legacy generate flow gets the same behaviour as export (one shared rule).
Display and flow: the allowance text matches the numbers in both settings; with the perk on, the dashboard, prepare page and export confirmation each show the daily-refresh reminder with the count left today and the 00:00 UTC refresh time, and the exhausted state shows no subscribe button while billing is off; exhausted state shows the existing paths; E2E covers one journey with the perk on and one with it off.
Security and limits: no new route or action trusts a client-supplied day, bucket or count; existing rate, concurrency and queue limits still apply with the perk on.

## 9. Wording to approve (not yet written anywhere)
**CLAUDE.md section 5**, add this bullet right after the bullet that starts "Create one lifetime trial bucket per account with limit=3":
"Temporary beta exception (decision D-112): while `DAILY_REFRESH_ENABLED=1`, an account that is not entitled to a paid bucket draws from a per-UTC-day bucket (limit `DAILY_REFRESH_LIMIT`, default 5) instead of the lifetime trial bucket. Consumption and in-flight reservations in daily buckets count toward the lifetime 3: when the setting is off, free availability is `3 - trial.used - trial.reserved - SUM(daily.used + daily.reserved)`, never below 0. Every other invariant in this section applies to daily buckets unchanged; deleting lessons, signing out or switching the setting never resets an account's lifetime count."
**docs/decisions.md**: "D-112 (beta daily refresh, temporary): 5 free exports per UTC day behind `DAILY_REFRESH_ENABLED` (default off); counted toward the lifetime 3 when switched off; paid accounts unaffected; to be removed or turned off after the beta. Approved by the owner on <date>."

## 10. Left to the builder
Naming and exact schema shape within section 6; where the setting is parsed (next to the other limits in `src/lib/server/limits.ts`); the UI copy; how the lifetime sum is queried (one query under the trial row lock); test structure.

Builder notes from the pre-build review (my calls, not the owner's): use the trial bucket's `limit_count` instead of a literal 3 in the lifetime formula; add a `daily` case wherever the allowance source is typed (`AllowanceExhausted.source`, the allowance view, the exhausted message in `src/lib/ui/messages.ts`, with wording like "refreshes at 00:00 UTC"); the perk-off reservation needs one extra lifetime-sum check under the trial row lock, because today's arbiter is a conditional update that only knows the trial bucket's own counters.
