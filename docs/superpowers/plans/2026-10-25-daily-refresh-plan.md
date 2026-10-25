# Free Daily Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While `DAILY_REFRESH_ENABLED=1`, free accounts draw from a per-UTC-day bucket (default 5); when it is off, the lifetime 3 applies and counts every beta export; tutors see the refresh and the count left; an operator API can top everyone up on demand.

**Architecture:** One new `bucket_kind` value `daily`. `src/lib/server/dal/allowance-source.ts` stays the only place that chooses a bucket (generation and export both call it), now given an `AllowancePolicy`. Settlement is untouched: it works from the reservation's `bucket_id`. The perk-off lifetime sum is checked under the trial row lock.

**Tech Stack:** Next.js 16 server actions and route handlers, Prisma 7 plus hand-written SQL migrations, Vitest (unit and real-Postgres integration), Playwright.

**Spec:** docs/superpowers/specs/2026-10-24-free-daily-refresh-design.md (sections 5, 6, 8, and the UI reminder bullet). Decision D-112 (owner-approved 2026-10-25). Branch from `main` after PR #50 (D-112 in CLAUDE.md and decisions.md) is merged.

## Global Constraints

- Settings: `DAILY_REFRESH_ENABLED` (default `0`) and `DAILY_REFRESH_LIMIT` (default `5`, integer 1..1000), parsed in `src/lib/server/limits.ts`. The worker reads neither.
- Daily bucket: one `usage_bucket` per account per UTC day; `starts_at` = 00:00 UTC, `ends_at` = next 00:00 UTC, `period_key` = days since the Unix epoch, `limit_count` = the limit at creation, created lazily inside the reservation transaction.
- Perk off: free availability = `trial.limit_count - trial.used - trial.reserved - SUM(daily.used + daily.reserved)`, never below 0, checked under the trial row lock. Use `limit_count`, not a literal 3.
- Paid path unchanged (D-07: no fallback from paid to trial or daily). Time comes from the DAL `clock`/`now`, never `Date.now()` inside the rule.
- The enum value goes in its own migration (D-110 and job_kind precedent). Applying migrations to staging or production is the owner's step; the plan never does it.
- No new route or action trusts a client-supplied day, bucket or count. `usage_bucket_drift` and `export_state_drift` return zero rows after every step. Never run `pnpm test:supabase`. Stage explicit paths.
- UI copy (spec): "Beta perk: 5 free exports every day. 3 of 5 left today. Refreshes at 00:00 UTC." Exhausted with the perk on says the count returns at 00:00 UTC. Billing is off for this test version: the exhausted state shows "contact us" and no subscribe button.

## Review Focus

1. A free account with some trial use when the perk turns on: it gets a fresh daily bucket; when the perk goes off, remaining = `limit_count - trial.used - daily sum`.
2. A reservation made on the trial bucket (perk off) that settles after the perk is turned on: it settles on the trial bucket, and daily rows are untouched.
3. The limit changed from 5 to 2 mid-day: today's existing bucket keeps its `limit_count`; tomorrow's uses the new value. Pin that behaviour in a test.
4. The exact boundary: `23:59:59.999` UTC and `00:00:00.000` UTC pick different buckets; the reservation made before midnight settles on its own day.
5. A paid, entitled account with daily rows lying around (perk on, then off): the paid path ignores them and the display is unchanged.

---

### Task 1: Migrations, schema and pure day math

**Files:**
- Create: `prisma/migrations/20261025100000_bucket_kind_daily/migration.sql`, `prisma/migrations/20261025100100_daily_bucket_shape/migration.sql`, `src/lib/domain/daily-refresh.ts`
- Modify: `prisma/schema.prisma` (enum `BucketKind`), `tests/integration/schema.test.ts`
- Test: `tests/unit/daily-refresh.test.ts`, `tests/integration/schema.test.ts`

**Interfaces:**
- Produces: `utcDayNumber(now: Date): bigint`, `utcDayWindow(day: bigint): { startsAt: Date; endsAt: Date }`, `lifetimeRemaining(trial: {limit: number; used: number; reserved: number}, daily: {used: number; reserved: number}): number`.

- [ ] **Step 1: Write failing unit tests** in `tests/unit/daily-refresh.test.ts`: `utcDayNumber(new Date("1970-01-01T00:00:00.000Z"))` is `0n`; `23:59:59.999` and the next `00:00:00.000` differ by `1n`; `utcDayWindow(utcDayNumber(d))` brackets `d` and `endsAt - startsAt` is 86 400 000 ms; `lifetimeRemaining({limit:3,used:1,reserved:1},{used:2,reserved:0})` is `0` (clamped, never negative).
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/daily-refresh.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three functions in `src/lib/domain/daily-refresh.ts` (pure, no imports from server code).
- [ ] **Step 4: Write the first migration**: only `ALTER TYPE "bucket_kind" ADD VALUE IF NOT EXISTS 'daily';` with the IRREVERSIBLE header comment copied from `20261024100000_job_kind_export`. Add `daily` to `enum BucketKind` in `prisma/schema.prisma`, then `pnpm db:generate`.
- [ ] **Step 5: Write the second migration**: drop and re-add `usage_bucket_kind_shape` with a third branch `kind = 'daily' AND subscription_id IS NULL AND period_key IS NOT NULL AND ends_at IS NOT NULL`, and `CREATE UNIQUE INDEX "usage_bucket_one_daily_per_owner_day" ON "usage_bucket"("owner_id","period_key") WHERE kind = 'daily'`. Do not touch grants or RLS (the table is already covered).
- [ ] **Step 6: Add integration tests** to `tests/integration/schema.test.ts` (names: `daily bucket requires period_key and ends_at`, `daily bucket rejects a subscription_id`, `one daily bucket per owner and day`, `daily buckets show up in usage_bucket_drift only when counters disagree`). Run `pnpm test:integration -- schema`. Expected: PASS.
- [ ] **Step 7: Commit** with the explicit paths above.

### Task 2: Settings and policy wiring

**Files:**
- Modify: `src/lib/server/limits.ts` (SHAPE: `dailyRefreshEnabled` int 0..1, env `DAILY_REFRESH_ENABLED`, default 0; `dailyRefreshLimit` int 1..1000, env `DAILY_REFRESH_LIMIT`, default 5), `src/lib/server/dal/instance.ts`, `src/lib/server/dal/index.ts`, `.env.example`
- Test: `tests/unit/limits.test.ts` (existing file; add cases)

**Interfaces:**
- Produces: `export interface AllowancePolicy { dailyRefresh: { enabled: boolean; limit: number } }` and `DEFAULT_ALLOWANCE_POLICY` (disabled, limit 5) exported from `src/lib/server/dal/allowance-source.ts`; `createWebDal(db, deps?: {... allowancePolicy?: AllowancePolicy})`, passed to the generation, export and history DALs.

- [ ] **Step 1: Tests**: defaults are `0` and `5`; `"1"` and `"7"` parse; `"2"` for enabled and `"0"` for limit throw; empty string counts as unset.
- [ ] **Step 2: Implement** in `limits.ts` and run the unit tests.
- [ ] **Step 3: Wire**: `instance.ts` builds `allowancePolicy` from `serverEnv().limits`; `createWebDal` forwards it to `createGenerationDal`, `createExportDal` and `createHistoryDal` (each stores it and passes it to the allowance functions in Task 3). Leave the default as disabled so every existing integration test is unchanged.
- [ ] **Step 4: `.env.example`**: add both variables, commented, with "temporary beta perk, D-112, web app only".
- [ ] **Step 5: Run** `pnpm typecheck && pnpm exec vitest run`. Expected: PASS. Commit.

### Task 3: Allowance rule and lifetime sum

**Files:**
- Modify: `src/lib/server/dal/allowance-source.ts`, `src/lib/server/dal/generation.ts:133`, `src/lib/server/dal/export.ts:220`, `src/lib/server/dal/history.ts` (`AllowanceView`, `getAllowance`), `src/lib/domain/errors.ts` (`AllowanceExhausted.source` adds `"daily"`)
- Test: `tests/integration/daily-refresh.test.ts` (new; pattern from `tests/integration/export-helpers.ts` and `allowance.test.ts`, with an injectable `clock`)

**Interfaces:**
- Consumes: Task 1 day math, Task 2 `AllowancePolicy`.
- Produces: `AllowanceSource` adds `{ kind: "daily"; day: bigint }`; `resolveAllowanceSource(tx, ownerId, now, policy)`; `lockAllowanceBucket(tx, ownerId, now, policy): Promise<{ bucket: BucketRow; source: "trial" | "paid" | "daily" }>`; `readAllowanceBucket(tx, ownerId, now, policy)` (same shape or null); `AllowanceView` gains `source: "trial"|"paid"|"daily"` and `resetsAt: Date | null` (set only for `daily`).

- [ ] **Step 1: Write failing integration tests** (names are the spec's acceptance checks):
  `perk on: five exports succeed, the sixth is ALLOWANCE_EXHAUSTED, trial bucket unchanged`; `perk on: next UTC day allows another export`; `two concurrent confirmations for the last daily export: exactly one wins`; `double click and identical re-export use no extra daily count`; `failed and canceled exports release the daily reservation`; `reservation at 23:59:59.999 settles on its own day, the next day's bucket untouched`; `perk off after N beta exports: remaining is max(0, limit_count - N), N >= 3 refuses, an in-flight beta export counts`; `perk on, off, on stays consistent and the drift views are empty after every step`; `paid entitled account ignores daily rows in both settings`; `createGeneration (legacy flow) follows the same rule`; plus the Review Focus cases 1 to 3.
- [ ] **Step 2: Run** `pnpm test:integration -- daily-refresh`. Expected: FAIL.
- [ ] **Step 3: Implement.** Source resolution: paid stays first; otherwise `daily` when `policy.dailyRefresh.enabled`, else `trial`. Locking a daily source: insert today's bucket (`ON CONFLICT (owner_id, period_key) WHERE kind = 'daily' DO NOTHING`, `limit_count` = policy limit), then select it `FOR UPDATE`. Locking the trial source: after the row lock, read `SUM(used + reserved)` over the owner's daily rows and throw `AllowanceExhausted(trial.reserved, "trial")` when `lifetimeRemaining(...)` is 0, because the conditional UPDATE in both callers only sees the trial row's own counters. Display for `daily` with no row yet returns a synthetic bucket (`used 0`, `reserved 0`, `limit_count` = policy limit), never inserted. Display for `trial` reports `used = trial.used + daily.used` and `pending = trial.reserved + daily.reserved` so the existing `limit - used - pending` formula already is the lifetime remainder.
- [ ] **Step 4: Run** `pnpm test:integration`. Expected: all PASS, including the untouched allowance and export suites.
- [ ] **Step 5: Commit.**

### Task 4: What the tutor sees

**Files:**
- Modify: `src/lib/ui/dashboard-view.ts` (`allowanceSentence`; new `dailyRefreshReminder`, `exportAfterSentence`), `src/lib/ui/messages.ts`, `src/app/dashboard/page.tsx`, `src/app/prepare/page.tsx:60`, `src/app/drafts/[id]/export/page.tsx`, `src/components/app/export-confirm.tsx`
- Test: `tests/unit/dashboard-view.test.ts`, `tests/unit/export-confirm-ui.test.ts`

**Interfaces:**
- Consumes: `AllowanceView.source` and `resetsAt` (Task 3).
- Produces: `dailyRefreshReminder(a: AllowanceView | null): string | null` (null unless `source === "daily"`; text exactly as in Global Constraints with the real numbers); `exportAfterSentence(a): string | null` ("After this export you will have N left today."); `exhaustedMessage(source: "trial"|"paid"|"daily"|null): string` in `messages.ts`.

- [ ] **Step 1: Write failing unit tests** for the exact strings, including: perk on 3 of 5; 0 left says "comes back at 00:00 UTC" and contains no "subscribe"; pending jobs are mentioned; perk off returns null and the old sentence; null allowance gives "Your account is being set up.".
- [ ] **Step 2: Implement** the functions. Render the reminder on the dashboard "Your allowance" block, the prepare header (`data-testid="allowance"` stays; add `data-testid="refresh-reminder"`), and the export confirmation next to `export-balance`, plus `exportAfterSentence`.
- [ ] **Step 3: Exhausted messages.** Find every place that maps `ALLOWANCE_EXHAUSTED` to text (`grep -rn ALLOWANCE_EXHAUSTED src`) and pass the page's allowance source into `exhaustedMessage`. Billing is off, so the daily and trial exhausted texts say "contact us" and no page links a subscribe action. The contact address is the owner's to supply; use the words only, no invented address. The `/account` link in the export page stays.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm exec vitest run`. Expected: PASS. Commit.

### Task 5: End-to-end, docs and rollout

**Files:**
- Modify: `playwright.config.ts` (a fourth pinned server with `DAILY_REFRESH_ENABLED: "1"`, following the existing three-server pattern and a new project name), `.env.example`, `README.md` (technical env var table only; no product wording)
- Create: `tests/e2e/daily-refresh.spec.ts`, `docs/daily-refresh-rollout.md`

- [ ] **Step 1: E2E on the perk-on server**: sign in, the dashboard and prepare page show the reminder with "5 of 5 left today"; create a draft; the export page shows the reminder and "After this export you will have 4 left today."; export succeeds; the dashboard now says "4 of 5". The perk-off journey is the existing default-server specs; keep their "3 of 3" assertions unchanged.
- [ ] **Step 2: Rollout doc** (technical, short): set `DAILY_REFRESH_ENABLED` and `DAILY_REFRESH_LIMIT` in the web scopes only, redeploy; apply the two migrations through the Database migrations workflow (the enum migration is irreversible: owner approval); the perk-off behaviour; "tell beta tutors before switching off".
- [ ] **Step 3: Run** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; the integration and E2E suites run in CI on the PR. Commit.

### Task 6: Operator top-up API (HOLD: owner approval of its semantics and a D-113 row)

An endpoint that changes every account's allowance is outside the "never resets" wording of CLAUDE.md section 5, so nothing in this task is built until the owner approves the semantics below. My call, for the owner to confirm or change.

**Semantics.** "Refresh" means: every free account has the full daily limit available again right now. It never zeroes counters (that would break the drift views). For each daily bucket of the current UTC day it sets `limit_count = used + reserved + <DAILY_REFRESH_LIMIT>`; accounts with no bucket today already have the full limit. It works only while the perk is on (otherwise it answers 409). A top-up does not change the lifetime sum, because it changes no `used` or `reserved`.

**Files:**
- Create: `src/app/api/admin/refresh-allowance/route.ts`, `src/lib/server/dal/allowance-admin.ts`, `tests/integration/allowance-admin.test.ts`, `tests/unit/admin-refresh-auth.test.ts`
- Modify: `src/lib/server/env.ts` (`ADMIN_REFRESH_ENABLED` default `0`; `ADMIN_REFRESH_TOKEN`, at least 32 characters, required only when enabled), `.env.example`, `docs/daily-refresh-rollout.md`

**Interfaces:**
- Produces: `refreshTodayForAll(tx: Tx, now: Date, policy: AllowancePolicy): Promise<{ accounts: number }>`; `POST /api/admin/refresh-allowance` with `Authorization: Bearer <token>`, answering `200 { accounts }`, `404` when disabled (indistinguishable from a missing route), `401` for a wrong token, `409` when the perk is off, `429` when called again within 60 seconds.

- [ ] **Step 1: Failing tests.** Unit: wrong, empty and prefix-only tokens are rejected; comparison is constant time (compare SHA-256 digests with `timingSafeEqual`); disabled gives 404 even with a correct token. Integration: after a top-up an exhausted account can reserve again; counters and both drift views stay clean; paid accounts are untouched; the perk-off request gets 409; a second call inside 60 seconds gets 429; nothing about the token appears in the response or the logs.
- [ ] **Step 2: Implement** the single-statement `UPDATE ... WHERE kind = 'daily' AND period_key = <today>` under `app_runtime`, a POST-only route (no GET), the 60-second guard through the existing `rate_limit_window` helper, and a log line holding only the request id and the account count.
- [ ] **Step 3: Run** the new tests and the full integration suite. Commit.
- [ ] **Step 4: Rollout doc.** The token lives only in the Vercel server environment (never `NEXT_PUBLIC_*`), `ADMIN_REFRESH_ENABLED` stays `0` unless the owner is about to call it, and the call is a documented `curl` example with a placeholder token.

## Self-review

- **Spec coverage:** sections 5 and 6 are covered by Tasks 1 to 3; the section 8 acceptance checks 1 to 9 are the Task 3 tests; the UI reminder bullet and display checks are Task 4 and the Task 5 E2E; the lifetime-sum builder note is the Task 3 trial-lock check; the `daily` typing note is `AllowanceExhausted.source`, `AllowanceView.source` and `exhaustedMessage`. Task 6 is new (owner request 2026-10-25).
- **Not in this plan:** a purge of old daily rows, per-user overrides, admin screens, and any change to rate limits (the owner may review `EXPORTS_PER_USER_PER_HOUR` separately).
