# S6 plan: switch the default flow to draft and export, rewrite the E2E tests, check every UI state, final review

Status: plan (2026-10-24), planner output, work in progress on branch `feat/draft-s6` (from main at 5d31ed1, S1 to S5 merged). The owner merges. Binding: CLAUDE.md sections 1, 5, 10, 11. Constraints: lean scope, no LLM work, never run `pnpm test:supabase`, legacy generate code stays (only entry points reachable in draft mode get a guard), no invariant for allowance, ownership or sandbox gets weaker. S6 changes no migration and no worker code.

## 1. Critical risk: switching FLOW_MODE alone leaves tutors with no way to get PDFs
Today `FLOW_MODE` defaults to `legacy` and `EXPORT_ENABLED` to `0` (`src/lib/server/env.ts`); `vercel.json` sets neither; `docs/fresh-droplet-setup.md` section K says leave Production and Preview unset. If only the `FLOW_MODE` default changed, any deployment with no variables would offer free drafts, hide the legacy "Generate lesson" path, and show a disabled "Export is coming next" button: tutors could never get PDFs.

Options: **A (chosen for the build): change both defaults together** (`FLOW_MODE=draft`, `EXPORT_ENABLED=1`), keep both as kill switches, and the owner sets both explicitly in every Vercel scope before merge. B: make the FLOW_MODE default follow EXPORT_ENABLED (fallback only). C: refuse to start when unset (rejected). D: change FLOW_MODE only (rejected).

"Draft flow, export off" stays legal: it is the documented pause and rollback state (`EXPORT_ENABLED=0` while pending exports drain). S6-1 words it honestly ("PDF export is paused right now. Your draft is saved.").

| Environment | Before S6 (vars unset) | After S6 (vars unset) | Action |
|---|---|---|---|
| Vercel scope serving noteprep.app (which scope is NOT verified) | legacy / 0, or what the owner set for the S5 tests | draft / 1 if unset; unchanged if already set | Owner sets both explicitly before merge; worker on the S6 merge commit |
| Vercel Preview | legacy / 0 | draft / 1 (charges on whatever DB Preview uses) | Recommended: explicit `FLOW_MODE=draft`, `EXPORT_ENABLED=0` |
| Future Production | n/a | draft / 1 | Set both explicitly; migrate, worker, web |
| Local dev, no `.env` entries | legacy | draft plus export (needs `pnpm worker:dev`) | README and `.env.example` |
| CI and E2E | each server pinned | each server pinned (S6-4) | none |
| Worker | reads neither flag | unchanged | none |

Rollback is flags only: `FLOW_MODE=legacy`, `EXPORT_ENABLED=0` explicitly. Pending exports still settle (the worker ignores the flag; cancel works with the flag off). Rolling code back below S4 or S5 still needs zero pending exports.

Legacy lessons and jobs are unaffected: `/lessons`, `/dashboard`, `/jobs/[id]`, `/lessons/[id]` and the documents route do not read the flag. A legacy job queued or running at the switch is finished by the worker as before (S6-5 proves it).

Paths to the legacy flow that stay reachable and get guarded in S6-1: `/lessons/new` and its `createLesson` action (reachable by URL, and through the quick-form link `/prepare` shows when no curriculum exists). `createLesson` charges at job start, which contradicts "charge only at export" in draft mode. Gap fixed in S6-2: `drafts.listDrafts` exists but no page uses it, so a left draft can only be reopened from browser history.

## 2. Sub-slices (commit after each, run its checks first)
- **S6-1 defaults, honest pause wording, legacy guard (S):** `env.ts` defaults `draft` and `"1"`; `export-entry.tsx` pause message (button stays disabled); `prepare/page.tsx` quick-form link only in legacy mode; `lessons/new/page.tsx` redirects to `/prepare` in draft mode; `lessons/new/actions.ts` refuses in draft mode BEFORE `createGeneration` (server check is what counts); `.env.example`, README, `docs/architecture.md`. Tests: limits defaults unit test, pause message unit test, `lessons-new-guard` unit test (never calls `createGeneration` in draft mode, still does in legacy).
- **S6-2 drafts on the dashboard and /lessons (S, O3):** `draftCards()` in `dashboard-view.ts`; a "Drafts" section on `/dashboard` and `/lessons` using `listDrafts` (owner-filtered, link to `/drafts/[id]`, "expires <UTC date>"); unit tests; an integration isolation test if not already covered.
- **S6-3 marketing copy (XS, O4):** `src/lib/marketing/content.ts`: Select, Preview (a free draft you can read and adjust), Adjust, Export (uses 1 generation only when all PDFs are ready). Remove every claim that a PDF can be opened before export.
- **S6-4 restructure `playwright.config.ts` (S):** three servers pinned: 3100 `draft`/`1` (project `chromium`, default), 3101 `legacy`/`0` (project `chromium-legacy`, `legacy-*.spec.ts`), 3102 `draft`/`0` (project `chromium-paused`, `*-paused.spec.ts`). Defaults themselves are proven by the S6-1 unit test.
- **S6-5 rewrite existing specs (M):** `prepare.spec.ts` (select, Create draft preview, `/drafts/[id]`, allowance unchanged); `lesson-preview.spec.ts` (lessons made through draft and export via `exportDraft(page)` helper); `skeleton-path.spec.ts` split: new-flow tests on 3100 (draft, export, history; double submit charges once; cancel queued export returns allowance; timed-out export fails and is "not used"; fourth export refused; cross-user denial; signed-out redirects incl. `/drafts/x` and `/exports/x`), legacy tests moved to `legacy-generate.spec.ts` on 3101 (happy path, double submit, cancel, `/lessons/new` works in legacy); a 3100 test that `/lessons/new` redirects to `/prepare` and reserves nothing; legacy data survives the switch (lesson made on 3101 opens on 3100); `dashboard.spec.ts` (new account, populated dashboard with export card and draft card); tests that need export off move to `draft-paused.spec.ts`.
- **S6-6 new `draft-adjust-export.spec.ts` (M, own worker):** test 1 follows CLAUDE.md section 11: sign in; select (only the chosen curriculum's options); free draft (allowance unchanged, no reservation row); preview Notes, Worksheet (no "Answer:"), Solutions; replace and remove; another version (v1 unchanged); confirm export (one reservation); success (allowance down by exactly 1); free re-download and re-confirm gives `reused`; history lists it; back and refresh at steps 3, 5, 8, 9 change nothing and add no reservation or consumption. Test 2: three charged exports, fourth refused with the exhausted notice and no reservation, re-export of an identical earlier version still free, drafts still free at 0. Stripe is out of scope.
- **S6-7 mobile and accessibility (S, O5):** `mobile-a11y.spec.ts` at 390x844 on `/prepare`, `/drafts/[id]`, `/drafts/[id]/export`, `/exports/[id]`, `/lessons/[id]`, `/dashboard`, `/lessons`: no horizontal scroll, primary controls visible and at least 44 px tall, nav reachable; keyboard (Tab to Create draft preview and Enter submits; Tab order to Replace then Export PDFs; focus goes to the candidate panel after Replace; visible focus ring; confirm page submits by keyboard); labels and roles (`getByLabel`, one h1, `role="status"`, `aria-current` on the version list). Contrast: add `@axe-core/playwright` as a pinned dev dependency (wcag2a/wcag2aa, fail on serious or critical). Without it contrast is NOT verified.
- **S6-8 every UI state (S):** exhaustive unit tables (`satisfies Record<ExportPhase, ...>`) so every phase and confirm error code has a message and the "generation used / not used" wording comes from `reservation.state`; E2E coverage map (queued, running, failed, canceled, timed out, allowance exhausted, reused/joined, expired draft, conflict; retired is covered by integration test and a unit render since no UI deletes a lesson).
- **S6-9 staging smoke and docs (S):** rewrite `tests/smoke/staging.spec.ts` (draft, export, three signed-URL downloads; uses one generation per run); `docs/fresh-droplet-setup.md` S6 note (explicit vars per scope, the table, rollback); pointer from `docs/s5-staging-checklist.md`; `docs/decisions.md` D-111 and a D-106 note ONLY WITH OWNER APPROVAL; `docs/testing-guide.md` English note line.
- **S6-10 final security review (independent Opus):** no path creates a reservation outside `confirmExport` in draft mode; defaults cannot reach an inconsistent billing state (old worker fails safely and releases); ownership in every touched list and route; Server Actions CSRF and idempotency; no cross-user caching; no secrets or signed URLs in smoke output, traces or logs; flags not `NEXT_PUBLIC_*`; `git diff main -- src/lib/server/dal/export.ts worker prisma docker` is empty; rollback leaves pending exports settleable; copy makes no zero-error or alignment claim.

## 3. Checks per slice
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e` (CI runs E2E on the PR), `pnpm test:latex` only if templates change (none planned). Before done, run `E2E_COMPILER=docker` locally once for `draft-adjust-export`.

## 4. Owner decisions
O1 option A (both defaults together, both kill switches), recommended. O2 explicit vars in every Vercel scope before merge (noteprep.app scope: `draft`/`1`; Preview: `draft`/`0` unless Preview should export) and confirm which scope serves noteprep.app. O3 drafts on dashboard and /lessons, recommended. O4 marketing copy, recommended. O5 `@axe-core/playwright` dev dependency, recommended. O6 guard `/lessons/new` in draft mode, recommended. O7 smoke test keeps using one free generation per run, accept.

## 5. Risks
R1 an environment relying on the old legacy default starts charging at export after deploy (mitigation O2). R2 export on by default with a worker older than S5 fails safely, no charge, but tutors see failures (same-commit deploys). R3 E2E gets slower. R4 the cross-server legacy test needs the same auth cookie across ports (cookies are host-scoped, should work; else sign in again). R5 S6 must not merge before the owner finishes S5 checks on staging.

## 6. Not verified without staging or Vercel access
Which Vercel scope serves noteprep.app and its flag values; which database and worker Preview uses; real compiles and Supabase signed-URL downloads after the switch; real mobile devices and Safari/WebKit (only Chromium at 390 px is planned); contrast if O5 is declined.

## 7. E2E coverage map (S6-8)
Default server (3100) unless noted. "Unit" means an exhaustive table in `tests/unit/export-view.test.ts`, `export-errors.test.ts` or `draft-states.test.ts`; those tables, not E2E, are what guarantee every phase and every confirm error code has wording and that the "used / not used" sentence follows the reservation state.

| State | Covered by |
|---|---|
| Journey: select, free draft, preview, adjust, versions, export, re-download, history, back/refresh with SQL counts | `draft-adjust-export.spec.ts` test 1 |
| Allowance exhausted (fourth export refused, no reservation; identical re-export and new drafts still free) | `draft-adjust-export.spec.ts` test 2 and `skeleton-path.spec.ts` |
| queued, canceled (allowance returned, "No generation was used.") | `export-flow.spec.ts`, `skeleton-path.spec.ts` |
| running, succeeded ("This used 1 generation."), three real downloads | `export-flow.spec.ts`, `draft-adjust-export.spec.ts` (PDF header check with `E2E_COMPILER=docker`) |
| failed and timed out ("No generation was used.") | `export-flow.spec.ts`, `skeleton-path.spec.ts` |
| reused (same version again, free) | `draft-adjust-export.spec.ts`, `export-flow.spec.ts` |
| joined (equivalent export already pending) | no E2E; unit (`export-view`, `export-status-view`, `export-errors`) and integration (`export-confirm`, `export-locking`) |
| created, replayed | E2E created path everywhere; replayed (same key) by unit and integration only |
| retrying, stopping, confirming, stalled, unknown, session expired | unit only (phase and wording tables, `export-poller`, `export-status-view`); not reproducible in a browser without fault injection |
| retired (lesson deleted) | integration `export-retire`, unit render; no UI deletes a lesson |
| Expired draft, start again | `draft-flow.spec.ts` |
| Conflict (stale tab: draft and stale confirmation page) | `draft-flow.spec.ts`, `export-flow.spec.ts` |
| Version limit, candidate pending, minimum questions | `draft-flow.spec.ts` (limit, candidate); minimum questions by unit and integration only |
| Export paused (`EXPORT_ENABLED=0`) | `draft-paused.spec.ts` on 3102 |
| Legacy flow and legacy data after the switch | `legacy-*.spec.ts` on 3101, `switch-survival.spec.ts` |
| Mobile 390x844, keyboard, labels and roles, axe wcag2a/wcag2aa | `mobile-a11y.spec.ts` |
| Ownership and signed-out redirects | `skeleton-path.spec.ts`, `export-flow.spec.ts`, `draft-flow.spec.ts` |

Not covered by any E2E: Stripe and subscriptions (out of scope for S6), Safari/WebKit, real devices.
