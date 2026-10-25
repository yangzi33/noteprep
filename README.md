# noteprep

A web application with a background worker that renders PDF documents from structured content. The web app validates requests and enqueues durable jobs; the worker claims them, renders LaTeX deterministically from versioned templates, compiles it in an isolated sandbox, and stores the PDFs in private object storage. Mathematical content is produced by deterministic, validated code, not by a language model.

## Stack

| Area | Version / choice |
|---|---|
| Node.js | 24.13.1 (`.nvmrc`; `engines`: `^24.11.0`) |
| Package manager | pnpm 10.33.0 (`packageManager`), one lockfile |
| Web | Next.js 16.4.2 (App Router), React 19.3.0, TypeScript 5.9.3 (strict), Tailwind CSS 4.3.3, shadcn/ui |
| Data | PostgreSQL via Prisma 7.10.1 (`@prisma/adapter-pg`), Supabase (Auth, private Storage) |
| Tests | Vitest 5.0.5, Playwright 1.64.1, axe-core |
| Compile sandbox | Docker image `docker/latex` (TeX, no network) |

Dependency versions are pinned exactly in `package.json`.

## Prerequisites

- Node.js 24 (`nvm use`) and `corepack enable` for pnpm.
- Docker (local Supabase stack and the LaTeX sandbox image).
- Supabase CLI: installed as a dev dependency, used through the `pnpm supabase:*` scripts.

## Quickstart

```bash
cp .env.example .env                  # placeholders only; edit as described in the file
pnpm install --frozen-lockfile
pnpm supabase:start                   # local Postgres, Auth, Storage, Mailpit
# put the publishable key from `pnpm supabase:status` into .env (and the secret key for the worker's object store)
pnpm db:migrate:deploy                # owner connection (MIGRATION_DATABASE_URL)
pnpm db:dev-roles                     # creates the runtime logins used by the web app and worker (dev-only passwords)
CURRICULUM_TARGET_ENV=development pnpm curriculum:load data/curricula/sample-math/sample-1 --allow-sample
pnpm dev                              # http://127.0.0.1:3000
pnpm worker:dev                       # in a second terminal
```

Notes:

- `CURRICULUM_TARGET_ENV` is deliberately not in `.env.example`. The loader refuses sample data unless a non-production target is named explicitly, so pass it inline on that one command.
- `pnpm dev` binds to `127.0.0.1` (IPv4 loopback). On WSL2 with a Windows browser the default IPv6 wildcard listener may not be reachable at `http://127.0.0.1:3000`; do not switch to `0.0.0.0`.
- Real PDFs locally: `pnpm latex:image`, then set `COMPILER="docker"`, `OBJECT_STORE="supabase"`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env` and restart the worker. Without them the worker needs `ALLOW_FAKE_COMPILER="1"` and writes labelled placeholder files.
- No paid API credentials are needed: `LLM_PROVIDER` defaults to `fake`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js dev server (127.0.0.1) / production build / serve the build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `next typegen` then `tsc --noEmit` |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:integration` | Integration tests against real Postgres |
| `pnpm test:e2e` | Playwright end-to-end tests (see Testing) |
| `pnpm test:latex` | Sandbox tests against the real LaTeX image |
| `pnpm test:latex:host` | Host-image sandbox tests |
| `pnpm test:image` | Boot and security tests of the worker image (needs `WORKER_IMAGE`) |
| `pnpm test:supabase` | Auth and Data API boundary tests; migrates the shared local Supabase stack |
| `pnpm smoke:staging` | Staging smoke (see Testing) |
| `pnpm supabase:start` / `supabase:stop` / `supabase:status` | Local Supabase stack |
| `pnpm db:up` / `db:down` | Standalone local Postgres from `compose.yaml` |
| `pnpm db:generate` | `prisma generate` (also runs on `postinstall`) |
| `pnpm db:migrate:dev` | `prisma migrate dev` (local development) |
| `pnpm db:migrate:deploy` | Apply committed migrations (`prisma migrate deploy`) |
| `pnpm db:dev-roles` | Create local runtime database logins (`scripts/dev-roles.sh`) |
| `pnpm worker:dev` | Run the worker from source (loads `.env`) |
| `pnpm worker:build` | Bundle the worker into `dist/` |
| `pnpm worker:start` / `worker:recover` | Run the bundled worker / the recovery entry point |
| `pnpm worker:image` / `worker:hosttest-image` | Build the worker runtime / host-test images |
| `pnpm latex:image` | Build the LaTeX sandbox image `noteprep-latex:dev` |
| `pnpm curricula:build` | Build reference datasets from `data/curricula-src` (`--check` verifies they are current) |
| `pnpm curriculum:validate` | Validate dataset files |
| `pnpm curriculum:load <dir> [--allow-sample]` | Load a dataset on the owner connection (idempotent, add-only) |
| `pnpm eval:prose` | Small prose-quality evaluation against the configured provider (not run in CI) |
| `pnpm samples:build` | Rebuild the static sample documents |

## Environment variables

`.env.example` lists placeholders for everything below. Variables are read in exactly two places, `src/lib/server/env.ts` (web) and `worker/env.ts` (worker); validation fails fast on bad values. Secrets must never be placed in `NEXT_PUBLIC_*` variables; only the Supabase URL, publishable key and site URL are browser-safe.

**Web**

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Runtime database login (`web_login` locally) |
| `FLOW_MODE` | `draft` | `draft`: free draft preview, allowance is reserved only at export. `legacy`: old generate flow, kept as a kill switch |
| `EXPORT_ENABLED` | `1` | `0` pauses export (pending exports still settle) |
| `CURRICULUM_ALLOW_SAMPLE` | `0` | `1` shows the labelled sample dataset (development/staging only) |
| `DRAFT_*`, `EXPORT_*` limits | see file | Rate, concurrency, deadline, size and lifetime limits; every name is listed in `src/lib/server/limits.ts` |

Rollback state "draft flow, export off": `FLOW_MODE=draft`, `EXPORT_ENABLED=0`. Set both flags explicitly in every hosted environment.

**Migrations**: `MIGRATION_DATABASE_URL` (owner role) is used only by migration and curriculum-load commands, never by the running app.

**Worker**

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_DATABASE_URL` | required | Worker runtime login (`worker_login` locally) |
| `COMPILER` | `skeleton` | `docker` compiles in the sandbox image; `skeleton` needs `ALLOW_FAKE_COMPILER=1` and is refused in production |
| `LATEX_IMAGE` | `noteprep-latex:dev` | Sandbox image; in production it must be pinned by digest (`name@sha256:...`) |
| `LATEX_WALL_CLOCK_SECONDS` | `90` | Compile timeout |
| `OBJECT_STORE` | `fs` | `fs` (local `.data/objects`, refused in production) or `supabase` (private bucket; needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, worker only) |
| `POLL_INTERVAL_MS`, `LEASE_SECONDS`, `SWEEP_INTERVAL_SECONDS` | `1000`, `30`, `15` | Claim polling, lease length, recovery sweep |
| `RECONCILE_ENABLED` | `0` | Orphan-object reconciler, off by default (destructive); tuned by `RECONCILE_BATCH_LESSONS`, `RECONCILE_INTERVAL_SECONDS`, `RECONCILE_GRACE_SECONDS`, `RECONCILE_STEP_BUDGET_SECONDS` |
| `LLM_PROVIDER` | `fake` | `fake` or `anthropic`; with `anthropic`, `LLM_API_KEY` and `LLM_MODEL` are required and held by the worker alone |
| `LESSON_PROSE` | `template` | `llm` asks the provider for prose wording |
| `LLM_MAX_OUTPUT_TOKENS`, `LLM_PRICE_*`, `LLM_BASE_URL` | see file | Token, cost-accounting and endpoint settings |
| `DOCKER_HOST`, `WORKER_LIVENESS_FILE` | unset | Set by the worker image on hosts; production requires the sandbox runner's unix socket, never the host's rootful `docker.sock` |

## Architecture

Detail: [docs/architecture.md](docs/architecture.md) (written in Chinese) and [docs/database-roles.md](docs/database-roles.md).

- **Web app** (`src/app`): Next.js Server Components and Server Actions. Identity comes from the Supabase server-side session; every query goes through a server-side data access layer that filters by the verified owner. Browsers never read or write business tables directly. The web app never runs TeX and never holds the worker's secrets.
- **Database**: PostgreSQL with Prisma migrations (`prisma/migrations`). Separate roles for migrations, the web runtime and the worker, with minimal grants.
- **Worker** (`worker/`): a separate long-running process. Jobs live in a Postgres table and are claimed with leases, heartbeats and a fencing token; only the current lease holder may commit results. A sweeper recovers expired jobs. States are `queued`, `running`, `succeeded`, `failed`, `canceled`; processing stages are tracked separately.
- **Allowance and export**: drafts and adjustments are free. Confirming an export, in one transaction, reserves allowance, freezes an immutable snapshot, enqueues the export job and records the idempotent request. The export identity is a hash of the rendered sources and settings, so repeats share one entitlement. Success publishes the revision, marks the job succeeded and consumes the reservation in one transaction; any terminal failure or cancellation releases the reservation.
- **Compile sandbox** (`docker/latex`, `worker/runner.ts`): one container per compilation, non-root, read-only root filesystem, no network, all capabilities dropped, memory/process/time limits, shell escape disabled, fixed executable with an argument array. The compiler receives no database, storage or model credentials.
- **Storage**: private Supabase Storage bucket `lesson-artifacts`; object paths are generated server-side by owner, job and revision, written per attempt, verified, then committed to a manifest in the database. Downloads use short-lived signed URLs issued after an ownership check.

## Testing

- **Unit**: `pnpm test`.
- **Integration**: `pnpm test:integration` against a real temporary Postgres (concurrency, constraints, rollbacks, migrations).
- **E2E**: `pnpm test:e2e` needs `pnpm supabase:start` first. Playwright builds the app once and starts three servers with both flags pinned, so a local `.env` cannot change them: port 3100 (`FLOW_MODE=draft`, `EXPORT_ENABLED=1`, project `chromium`), 3101 (`legacy`, export off, project `chromium-legacy`), 3102 (`draft`, export off, project `chromium-paused`). Set `E2E_COMPILER=docker` (after `pnpm latex:image`) to make downloads real PDFs. Stop your own dev server and worker before running it. The suite includes axe (WCAG A/AA) and 390x844 mobile layout checks.
- **LaTeX sandbox**: `pnpm latex:image`, then `pnpm test:latex` (valid output plus negative tests: file reads, traversal, shell escape, network, resource bombs, cleanup). `pnpm test:latex:host` and `pnpm test:image` cover the host and worker images. DB-backed tests under `tests/latex` are excluded in `vitest.host.config.mts`.
- **Supabase boundary**: `pnpm test:supabase` checks Auth, the Data API and RLS against the local stack; it applies migrations to that shared stack.
- **Staging smoke**: `pnpm smoke:staging` runs one real draft-and-export against the fixed staging origin allowlisted in `tests/smoke/target.ts`. It needs `SMOKE_TARGET=staging`, `SMOKE_EMAIL` and `SMOKE_PASSWORD` (a throwaway user), consumes one free generation per run, is never run by CI, and must never be run with `DEBUG` set.

More: [docs/testing-guide.md](docs/testing-guide.md), [docs/local-testing-s5.md](docs/local-testing-s5.md).

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to main, with read-only permissions, a frozen lockfile and third-party actions pinned to commit SHAs. Pull requests receive no secrets. Jobs:

- `static`: lint, typecheck, unit tests, dataset build check and validation, production build.
- `latex-sandbox`: builds the real LaTeX image and runs the sandbox tests and the host-image tests.
- `integration`: integration tests against real Postgres.
- `worker-image`: builds the worker image and runs its boot and security tests.
- `supabase`: Auth and Data API boundary tests on the local Supabase stack.
- `e2e`: the Playwright suite against the local Supabase stack and a real worker.

Manual-only workflows (`workflow_dispatch`): `images.yml` (build, test and publish images from main), `db-migrate.yml` (migration status or deploy for a chosen environment), `curriculum-load.yml` (load a dataset for a chosen environment). Migrations and dataset loads never run on push or at web startup.

## Deployment and operations

Release order: apply migrations, then update the worker, then deploy the web app. The worker is not updated automatically; updating it is a deliberate host step. Local rehearsal values are documented in the files below.

- [docs/fresh-droplet-setup.md](docs/fresh-droplet-setup.md): bring up a worker host.
- [docs/worker-host-runbook.md](docs/worker-host-runbook.md): host operation and recovery.
- [docs/s5-staging-checklist.md](docs/s5-staging-checklist.md): staging verification checklist.
- [docs/staging-setup.md](docs/staging-setup.md): staging environment setup.
- [docs/local-testing-s5.md](docs/local-testing-s5.md) and [docs/testing-guide.md](docs/testing-guide.md): local testing.
- [docs/security-and-privacy.md](docs/security-and-privacy.md): security controls.
- Host unit files and env templates: `deploy/host/`.

## Repository layout

| Path | Contents |
|---|---|
| `src/app` | Next.js routes, Server Actions, route handlers |
| `src/components` | UI components (shadcn/ui primitives under `ui`) |
| `src/lib/domain` | Pure domain modules (states, allowance, export identity) |
| `src/lib/server` | Server-only code: env, data access layer, limits, auth |
| `src/lib/curriculum` | Reference dataset schema and readers |
| `src/lib/math` | Exact solvers and validators |
| `src/lib/content`, `src/lib/package` | Structured content and document packages |
| `src/lib/latex` | Deterministic LaTeX rendering from fixed templates |
| `src/lib/llm` | Provider-agnostic model interface, adapter and deterministic fake |
| `src/lib/storage`, `src/lib/supabase` | Object storage and Supabase clients |
| `worker/` | Worker entry points, job loop, pipeline, sandbox runner, reconciler |
| `prisma/` | Schema and migrations |
| `supabase/` | Local Supabase configuration |
| `data/` | Reference datasets and their sources |
| `docker/` | LaTeX sandbox and worker images |
| `deploy/host/` | systemd units and env templates for the worker host |
| `scripts/` | Build, load, validate and dev-setup scripts |
| `tests/` | Unit, integration, E2E, LaTeX, image, Supabase and smoke tests |
| `docs/` | Architecture, database roles, testing and operations documents |

## Contributing

Repository-wide working rules for contributors and coding agents are in [CLAUDE.md](CLAUDE.md).
