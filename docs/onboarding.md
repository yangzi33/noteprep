# Onboarding

Status: written 2026-11-02 against `origin/main` at ca766b9 (includes merged PR #64, MathText). Anything marked UNVERIFIED was not checked against code or a running system. When this page and the code disagree, the code wins; fix this page.

## 1. What the app is

NotePrep is a Next.js web app plus a separate worker. A signed-in tutor selects a curriculum, level, course and topic, creates a free draft, previews it, applies predefined adjustments (replace or remove a question, new version), then confirms an export. The worker compiles genuinely compiled PDFs (Tutor Notes, Student Worksheet, Answer Key) from a frozen snapshot in a sandbox. One generation is consumed only when the complete requested PDF set is ready. The binding rules are in `CLAUDE.md`; the decision log is `docs/decisions.md`.

## 2. Stack and versions (from `package.json`)

Node 24.13.1 (`.nvmrc`; `engines` ^24.11.0), pnpm 10.33.0, Next.js 16.4.2 (App Router), React 19.3.0, TypeScript 5.9.3, Tailwind 4.3.3, shadcn 4.22.1 with radix-ui, zod 4.6.7, Prisma 7.10.1 with `@prisma/adapter-pg` and pg 8.23.1, Supabase (ssr 0.12.7, js 2.118.0, CLI 2.121.0), katex 0.19.0, Vitest 5.0.5, Playwright 1.64.1, esbuild 0.28.2, tsx 4.23.15. Dependencies are pinned exactly; no dependency changes without a reason.

## 3. Repository layout

- `src/app`: routes (section 5). `src/proxy.ts`: request proxy (middleware). `src/components`: UI.
- `src/lib`: `auth`, `ui`, `domain` (pure rules: allowance, manifests), `server` (env, limits, `dal/` data access, auth, curriculum loader), `curriculum`, `content` (legacy content design, decoupled), `package` (lesson package, HTML view), `math`, `math-text` (MathText parser, see `docs/mathtext.md`), `latex` (templates, escaping, allowlist), `llm` (fake and Anthropic adapters), `storage`, `supabase`, `marketing`.
- `worker`: the long-running worker (`main`, `loop`, `pipeline`, `export`, `reconcile`, `recover*`, `runner`, `compile-store`, `healthcheck`, `env`).
- `prisma`: `schema.prisma` and `migrations/` (16 migration directories at this commit).
- `data/curricula` (loadable datasets, many `suggested-*` plus one sample), `data/curricula-src` (generator input).
- `docker/{worker,latex}`: images. `deploy/host`: systemd units and runner config for the worker host. `supabase`: local stack config.
- `tests`: `unit`, `integration`, `supabase`, `latex`, `image`, `e2e`, `smoke`, `fixtures`, `stubs`.
- `scripts`: curriculum build/validate/load, dev roles, sample build, prose eval. `docs`: documents (section 11).

## 4. Commands (from `package.json` scripts)

| Command | What it does | Needs |
| --- | --- | --- |
| `pnpm dev` / `build` / `start` | Next.js (dev binds 127.0.0.1) | `.env` from `.env.example` |
| `pnpm lint`, `pnpm typecheck` | ESLint; `next typegen` + `tsc --noEmit` | nothing |
| `pnpm test` | Vitest unit tests (`tests/unit`) | nothing |
| `pnpm test:integration` | Vitest against real Postgres | `pnpm db:up` (Docker) |
| `pnpm test:supabase` | Auth, Storage, RLS, Data API boundary | local Supabase stack; **do not run it casually or against any real project** |
| `pnpm test:latex` | Sandbox and compile tests in the real image | Docker, `pnpm latex:image` |
| `pnpm test:latex:host`, `test:image` | Host-image and worker-image tests | Docker and the worker images |
| `pnpm test:e2e` | Playwright critical journeys | local Supabase, a build, optionally Docker for real PDFs |
| `pnpm smoke:staging` | Playwright smoke config against a deployed site | a staging URL and credentials (UNVERIFIED how they are supplied) |
| `pnpm db:up` / `db:down` | Local Postgres via `compose.yaml` | Docker |
| `pnpm db:generate`, `db:migrate:dev`, `db:migrate:deploy`, `db:dev-roles` | Prisma client, migrations, dev login roles | Postgres |
| `pnpm supabase:start` / `stop` / `status` | Local Supabase | Docker |
| `pnpm worker:dev`, `worker:build`, `worker:start`, `worker:recover` | Run, bundle, start and recover the worker | `.env`, database; compile needs Docker |
| `pnpm worker:image`, `worker:hosttest-image`, `latex:image` | Build images | Docker |
| `pnpm curricula:build`, `curriculum:validate`, `curriculum:load <dir> [--allow-sample]` | Dataset tooling (load needs `CURRICULUM_TARGET_ENV`) | database for load |
| `pnpm samples:build`, `pnpm eval:prose` | Marketing samples; prose evaluation | `eval:prose` may call a real provider (UNVERIFIED) |

`README.md` has the setup order. `docs/local-testing-s5.md` is a by-hand walkthrough of the export flow.

## 5. App routes (`src/app`)

Pages: `/`, `/login`, `/login/reset`, `/login/resend`, `/auth/recovery`, `/account`, `/account/password`, `/dashboard`, `/prepare`, `/lessons`, `/lessons/new`, `/lessons/[id]`, `/drafts/[id]`, `/drafts/[id]/export`, `/exports/[id]`, `/jobs/[id]`.
Route handlers: `/auth/callback`, `/healthz`, `/api/jobs/[id]`, `/api/exports/[id]`, `/api/admin/refresh-allowance`, `/lessons/[id]/documents/[doc]` (document download).

## 6. Data model and jobs (`prisma/schema.prisma`)

Models: Profile, Lesson, LessonRevision, GenerationJob, IdempotencyKey, UsageBucket, UsageReservation, Subscription, WebhookEvent, RateLimitWindow, Draft, DraftVersion, ExportSnapshot, Export, and the curriculum tables (EducationSystem, Curriculum, CurriculumVersion, CurriculumLevel, CurriculumCourse, CurriculumUnit, CurriculumTopic, CurriculumObjective, TopicObjective, TopicPrerequisite, Concept, TopicConcept). Subscription and WebhookEvent exist but no Stripe code writes them; only `src/lib/server/dal/allowance-source.ts` reads Subscription (paid-bucket selection).

- Job kinds: `generate`, `compile`, `export`. Job states: `queued`, `running`, `succeeded`, `failed`, `canceled`. Stages: `generating`, `validating`, `compiling`, `storing`.
- Buckets: `trial` (lifetime 3), `paid`, `daily` (beta daily refresh, off unless `DAILY_REFRESH_ENABLED=1`). Reservations: `reserved` to `consumed` or `released`, one way.
- Revision status `draft|finalized|rejected`; validation status `verified|failed|unverified`.
- Export state is a string column with CHECK `export_state_valid`: `pending`, `succeeded`, `failed`, `retired` (migration `20261024110000_export_retired`); the partial unique index `export_live_key` covers only `pending` and `succeeded`, so a retired or failed export frees its identity.
- Roles: the web app and the worker use separate database roles (`docs/database-roles.md`); migrations use `MIGRATION_DATABASE_URL`.

## 7. Configuration (names only, no values here)

- `.env.example`: all app and worker variables, placeholders only. Web env is parsed in `src/lib/server/env.ts` and `src/lib/server/limits.ts` (rate, draft, export and daily-refresh limits); worker env in `worker/env.ts`. `process.env` is banned by lint outside `src/lib/server/env.ts`, `worker/env.ts` and `src/lib/supabase/public-env.ts` (`eslint.config.mjs`).
- `deploy/host/worker.env.example` and `worker.image.example`: worker host configuration.
- Notable switches: `FLOW_MODE` (default `draft`; `legacy` is the old generate flow), `EXPORT_ENABLED`, `DAILY_REFRESH_ENABLED`, `COMPILER` (`skeleton` or `docker`), `OBJECT_STORE` (`fs` or `supabase`), `LLM_PROVIDER` (`fake` or `anthropic`; no OpenAI adapter on main), `LESSON_PROSE` (`template` or `llm`), `RECONCILE_ENABLED`.
- Real secrets live only in the hosting providers and GitHub environments; never commit them.

## 8. CI and deployment

- Workflows (`.github/workflows`): `ci.yml` (jobs: static, latex-sandbox, integration, worker-image, supabase, e2e; on pull requests and pushes), `images.yml` (manual: build, test, push images to GHCR), `db-migrate.yml` (manual: status or deploy), `curriculum-load.yml` (manual: validate or load into a chosen environment).
- Web: Vercel (`vercel.json`). Worker: container image from GHCR running on a droplet with rootless Docker for the LaTeX sandbox (`docs/fresh-droplet-setup.md`, `docs/worker-host-runbook.md`, `docs/worker-update.md`).
- Staging site is https://noteprep.app. There is no production environment. Do not provision paid resources or enable live billing.
- Which exact staging services are currently deployed and healthy: UNVERIFIED.

## 9. Testing suites

Unit (`tests/unit`, about 107 files), integration (`tests/integration`, 25 files, real Postgres), supabase boundary (`tests/supabase`, 4 files), latex sandbox (`tests/latex`, 10 files, real image), image (`tests/image`), E2E (`tests/e2e`, 18 spec files) and a staging smoke. Counts at 2026-11-02 (ca766b9), from `pnpm exec vitest list --config <config>` and `pnpm exec playwright test --list` (offline, nothing executed): unit 1334 cases, integration 475, supabase 27, latex 70, image 7, E2E 76 (18 files, 4 projects). They drift; re-run the commands rather than trusting these numbers. E2E starts four servers from one build with pinned flags: 3100 draft+export (project `chromium`), 3101 legacy, 3102 export paused, 3103 daily refresh (`playwright.config.ts`). CI runs integration and E2E on every PR, so a red CI is the evidence, not a missing local Docker.

## 10. What works and what does not (as of ca766b9)

Working (verified in code at this commit; runtime behaviour on staging UNVERIFIED):
- Slice A flow: free drafts, HTML preview, deterministic adjustments, confirm-export (reserve and snapshot in one transaction), worker export job, compiled PDFs, history, re-download (`src/lib/server/dal/{drafts,export,reservation,settlement}.ts`, `src/lib/package/draft-ops.ts`, `worker/export.ts`).
- Curriculum datasets: many `suggested-*` datasets plus a sample, a loader and validator, a cascading selection on `/prepare`. Only linear equations in one variable is a supported topic.
- Beta daily refresh (opt-in), auth recovery, admin allowance refresh endpoint (off by default).
- MathText parser and renderers are merged (PR #64) and tested but **not wired** into drafts, packages or the worker; only the shared macro allowlist is consumed by `src/lib/latex`.

Not built:
- OpenAI adapter (PR #65, not merged); only the fake and Anthropic adapters exist.
- LLM item source, `ai_beta` topics, `draft_items` job kind, item statuses and flagging, question bank, free-text refinement.
- Stripe (checkout, portal, webhooks, reconciliation), analytics events and `track()`, a Content-Security-Policy header.

## 11. Constraints and pitfalls

- Do not add `loading.tsx` to any route: it makes `notFound()` and `redirect()` return 200 and breaks the security E2E tests.
- Never weaken math verification, owner isolation, sandbox isolation or the allowance invariants (`CLAUDE.md` sections 5, 7, 8, 9). Do not delete or soften a test to pass.
- Never run `pnpm test:supabase` against anything but a disposable local stack; never use production credentials.
- Stage explicit paths (`git add <path>`), never `git add -A`; check `git status` and the cached diff before committing.
- Work on a branch (`feat/`, `fix/`, `docs/`), open a PR so CI runs; the owner merges. Do not force-push or push to main.
- No paid API calls on PRs: the fake LLM and fictional data are the default. Keep `.env` out of git.
- `README.md` is public and English; keep it technical and vague about the project. Old Chinese documents stay Chinese until translated; new documents are English.
- Restart the worker after code changes; local E2E and a running `pnpm worker:dev` compete for jobs on the same database.

## 12. Reading order

1. `README.md`: setup, commands, env.
2. `CLAUDE.md`: the binding rules (read fully).
3. This page.
4. `docs/product-vision.md` and `docs/refactor-plan.md`: direction and milestones (partly historical).
5. `docs/generation-flow.md`: preview-first flow design; slice A built, slice B/C planned.
6. `docs/decisions.md`: decision log (D-nn); search it before changing behaviour.
7. `docs/architecture.md` (Chinese): state machines, allowance, jobs, sandbox design.
8. `docs/curriculum-architecture.md` and `docs/curricula-authoring.md`: curriculum model and dataset authoring.
9. `docs/mathtext.md`: MathText grammar and its current wiring.
10. `docs/testing-guide.md` (Chinese) and `docs/local-testing-s5.md`: how to run and hand-test.
11. `docs/security-and-privacy.md` and `docs/database-roles.md`: threat model and DB roles.
12. `docs/fresh-droplet-setup.md`, `docs/worker-host-runbook.md`, `docs/worker-update.md`, `docs/staging-setup.md`: operations.
13. `docs/daily-refresh-rollout.md`, `docs/auth-recovery.md`: beta features.
14. `docs/beta-roadmap.md`, `docs/analytics-design.md`, `docs/question-bank-design.md`: plans (analytics and the bank are not built).
15. Historical: `docs/content-architecture.md` (legacy), `docs/claude-md-amendment-draft.md`, `docs/audit-m1-m5.md`, `docs/test-plan.md`, `docs/implementation-plan.md`, `docs/ui-verification-checklist.md`, `docs/superpowers/*`, `docs/concierge/*`.
