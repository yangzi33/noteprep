# Local setup and manual test of the S5 export flow

Everything here runs on your machine: local Supabase (database, auth, storage), the web app, the worker, and the real LaTeX compiler in Docker. Nothing touches staging, the droplet, or any paid service.

Status: written from the README, `.env.example`, `package.json` and the E2E setup. The automated E2E passes in CI. The by-hand walkthrough below has **not** been run end to end by the assistant, so treat the first run as a rehearsal and report any step that does not match.

## 0. Prerequisites
- Node 24.13.1 and pnpm 10.33.0 (`.nvmrc`, `packageManager`).
- Docker running. WSL2 is fine.
- Supabase CLI (`pnpm supabase:start` uses it).
- The branch: `git checkout feat/export-s5 && pnpm install --frozen-lockfile`.

## 1. One-time setup
```bash
cp .env.example .env
pnpm supabase:start          # first run downloads images; Storage must be enabled (it is, in supabase/config.toml)
pnpm supabase:status         # copy the publishable key and the secret key
pnpm db:migrate:deploy       # applies all migrations, including the two S5 ones
pnpm db:dev-roles            # creates web_login and worker_login (dev-only passwords)
pnpm latex:image             # builds the sandbox image noteprep-latex:dev
CURRICULUM_TARGET_ENV=development pnpm curriculum:load data/curricula/sample-math/sample-1 --allow-sample
```
`CURRICULUM_TARGET_ENV` is deliberately not in `.env.example`: the loader refuses sample data unless you name a non-production target explicitly, so give it inline on this one command and do not put it in `.env`.
Check: `SELECT migration_name FROM _prisma_migrations WHERE migration_name LIKE '202610241%';` returns 2 rows (`psql "$MIGRATION_DATABASE_URL"`).

## 2. Edit `.env`
Set these (the file already has the rest):
```bash
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="<publishable key from pnpm supabase:status>"

# the flow under test
FLOW_MODE="draft"
EXPORT_ENABLED="1"

# real PDFs, stored where the preview and download pages can read them
COMPILER="docker"
LATEX_IMAGE="noteprep-latex:dev"
OBJECT_STORE="supabase"
SUPABASE_URL="http://127.0.0.1:54321"
SUPABASE_SECRET_KEY="<secret key from pnpm supabase:status>"
```
Remove or comment `ALLOW_FAKE_COMPILER="1"` so the worker cannot fall back to the placeholder compiler. Leave `RECONCILE_ENABLED` unset (off).
With `OBJECT_STORE=fs` (the default) the preview and download pages cannot open files, so use `supabase` for manual testing.

## 3. Run it (two terminals)
```bash
pnpm dev            # terminal 1: http://127.0.0.1:3000
pnpm worker:dev     # terminal 2: reads .env, compiles with Docker
```
Look for `worker_started` in terminal 2. Sign-up emails arrive in Mailpit at http://127.0.0.1:54324. Open the app at `http://127.0.0.1:3000` (not `localhost`; the dev server binds IPv4 loopback).

Do not run `pnpm test:e2e` while these two are running. The tests share the same database and fight your worker for jobs.

## 4. Walkthrough
Use a throwaway account. Database queries: `psql "$MIGRATION_DATABASE_URL"`.

1. **Sign up and confirm.** Register, click the link in Mailpit, log in. You start with 3 free generations.
2. **Create a draft.** Go to Prepare, choose the NotePrep sample curriculum, a topic, duration and difficulty, create. A draft preview opens. Nothing is charged (allowance still 3).
3. **Letter export.** Click Export PDFs. The confirm page shows "Page format" with US Letter selected. Confirm.
   - Status page goes queued, compiling, then COMPLETE with "This used 1 generation". Allowance shows 2.
   - Download all three PDFs. Each is 8.5 x 11 in (US Letter). Worksheet has no answers; Solutions match the preview.
   - SQL: `SELECT s.spec->>'pageFormat', r.artifact_manifest->>'manifestVersion', r.artifact_manifest->>'pageFormat', r.artifact_manifest->'compile' FROM export e JOIN export_snapshot s ON s.id=e.snapshot_id JOIN lesson_revision r ON r.id=e.revision_id WHERE e.id='<export id from the URL>';` expects `letter`, `3`, `letter`, and image `noteprep-latex:dev`.
4. **A4 export of the same draft.** Choose A4, confirm. New export, allowance 1. PDFs are 210 x 297 mm, same questions and answers as the Letter export.
5. **Free re-export.** Confirm A4 again. You land on the first A4 export with "This one used none". Allowance unchanged.
6. **Double click.** Create a new draft version (replace a question), then double-click Confirm. Exactly one new export, one charge.
7. **Cancel.** Stop the worker (Ctrl-C in terminal 2). Create another version, confirm, cancel from the status page. It shows CANCELED and "No generation was used"; allowance is unchanged. SQL: export `failed`, job `canceled`, reservation `released`. Start the worker again.
8. **Content.** Replace a question in the draft: earlier exports' PDFs stay as they were; the new version needs a new export.
9. **Books balance.** `SELECT count(*) FROM export_state_drift;` and `SELECT count(*) FROM usage_bucket_drift;` both 0, and `SELECT count(*) FROM export WHERE state='pending';` is 0.

Not testable locally: the droplet update steps and the recovery command through `docker exec noteprep-worker` (those need the real host). Retired state (lesson deletion) has no UI; the integration tests cover it.

## 5. Optional: recovery dry run locally
After step 3, with the worker built (`pnpm worker:build`):
```bash
pnpm worker:recover --revision <revision id> --check
```
Get the revision id with `SELECT revision_id FROM export WHERE id='<export id>';`. Expect `intact` (it returns before recompiling). To see a restore: delete that revision's `worksheet.pdf` in Supabase Studio (http://127.0.0.1:54323, Storage, `lesson-artifacts`), run with `--check` (expect `would_restore`, file stays missing), then run without `--check` (expect `restored`). The command needs `COMPILER=docker` and the same `.env` as the worker.

## 6. Automated checks on the same machine
Stop `pnpm dev` and `pnpm worker:dev` first.
```bash
pnpm test && pnpm test:integration
pnpm test:latex                                              # real compiler, needs pnpm latex:image and pnpm db:up
E2E_COMPILER=docker pnpm exec playwright test --project=chromium-export   # needs `pnpm exec playwright install chromium` once
```

## 7. Reset
- Wipe all local data: `pnpm supabase:stop` then `pnpm supabase:start`, then rerun section 1 from `db:migrate:deploy` on (stop with `--no-backup` for a clean slate).
- Stop everything: `pnpm supabase:stop`.

## Troubleshooting
- Export stays queued: the worker is not running, or it is running with `COMPILER=skeleton`. Check terminal 2.
- Worker refuses to start: read the first log line; common causes are `COMPILER=docker` without `LATEX_IMAGE`, or `OBJECT_STORE=supabase` without `SUPABASE_URL` and `SUPABASE_SECRET_KEY`.
- "Export PDFs" button missing or disabled: both `FLOW_MODE=draft` and `EXPORT_ENABLED=1` are needed, and the dev server must be restarted after editing `.env`.
- PDF preview blank: `OBJECT_STORE` is still `fs`, or Storage is not enabled (`pnpm supabase:stop`, `pnpm supabase:start`).
- Docker permission errors: your user must be able to run `docker` without sudo.
