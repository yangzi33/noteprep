# S4 export reservation, idempotency and settlement: hardened specification

Status: output of an independent Opus architecture review (2026-10-24) of the S4 plan in [2026-10-23-preview-adjust-export](2026-10-23-preview-adjust-export.md). This document replaces the S4 and S5 parts of that plan where they differ. Owner rules in force: a template/render version change is a new paid export; a superset of documents is a new paid export; drafts are never charged; verification stays a hard gate; the legacy flow keeps working until S6. Slices: **S4a** (database, billing core, settlement, jobs) and **S4b** (worker `runExport`, confirmation and status pages, E2E, docs); each gets an independent Opus review before merge. Everything is behind `EXPORT_ENABLED` (default off).

## Findings that changed the design
- **C1 (Critical) export identity must key on rendered output, not a projection.** The renderer reads `context.topic.title`, `request.difficulty`, `exercises.provenance.difficulty`, `outline.totalMinutes`, `documents[].{id,sectionIds}` and every section's kind, title and blocks; a projection that drops provenance can reuse a wrong PDF for free. `renderDocument` is pure string generation, so at confirm compute `texSha256[doc] = sha256(renderDocument(fullPkg, doc).tex)`; `exportKey = H({v:1, docs: sorted [doc, texSha], locale, pageFormat, templateVersion, renderVersion})`; the worker re-renders from the snapshot and must reproduce the same shas; `commitExport` checks `manifest.documents[d].tex.sha256 == snapshot.tex_sha256[d]`. A golden test pins a fixed tex sha per `RENDER_VERSION`.
- **C2 (Critical)** `confirmExport` never locks a `generation_job` row (profile X first; `commitExport` takes job first). A doomed pending export (cancel requested, or past deadline and unswept) gives `EXPORT_BUSY`, never a join or inline settle.
- **C3 (Critical)** `sweep` must not let one bad row stall the batch: per-row try/catch, `sweep_row_error` count, an `export_state_drift` view checked each sweep.
- **C4 (Critical)** deadlines: for export jobs `commitExport` requires `deadline_at > now()` (DB clock) else `DeadlineExceeded` (runner maps to `finishJob(failed)`); the worker checks the deadline at checkpoints; `sweep` also fails running export jobs past `deadline_at + grace` (fenced by state/token). Legacy behaviour unchanged.
- **I1** no `generation_job.export_id` column; use `export.job_id UNIQUE NOT NULL` with composite FK `(job_id, owner_id)` and a new unique index `generation_job(id, owner_id)`; the "export job has exactly one export" rule lives in the replaced deferred `generation_job_reservation_shape`.
- **I2** the consistency check uses constraint triggers with `WHEN` clauses (never on every heartbeat). **I3** consolidate every terminal path through `finishLockedJob`: `settleExportFailure` then `releaseReservation` then job update; `cancelJob` refactored to use it. **I4** a 23505 on the live-key index is an `InvariantViolation`, not a retry path. **I5** idempotency operation `export.confirm`, request hash of what the client sent, replay check before draft checks, fresh key per rendered form, same key replays a failed export. **I6** S4 writes an exact **v2** manifest (export data goes in `generation_meta`); v3 and the reader change move to S5. **I7** do the expensive work (validate, render, hash) before the transaction; re-check rev/hash/liveness inside it. **I8** order in confirm: reuse/join before limits and allowance (exhausted users may still reuse). **I9** a succeeded export occupies its key (a `retired` state comes with lesson deletion). **I10** after N=3 non-retryable failures of the same `(owner, export_key)` in 24 h refuse with `EXPORT_UNAVAILABLE`. **I11** worker compares `spec.renderVersion`/`TEMPLATE_VERSION` with its own (mismatch retryable; same version but different tex = non-retryable `render_mismatch` plus alert). **I12** gate export behind `EXPORT_ENABLED`, deploy order migrate -> worker -> web -> flag on. **I13** CLAUDE.md §5 edit needs owner approval (separate commit).

## Migrations (additive)
**M1 `job_kind_export` (alone; irreversible once applied)**: `ALTER TYPE "job_kind" ADD VALUE IF NOT EXISTS 'export';`
**M2 `export_tables`:**
```sql
CREATE UNIQUE INDEX generation_job_id_owner_id_key ON generation_job(id, owner_id);
CREATE TABLE export_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES profile(id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL, draft_version_id uuid NOT NULL, draft_version_rev int NOT NULL, -- no FK: drafts get purged
  content jsonb NOT NULL,           -- FULL LessonPackage (request + context included)
  package_hash text NOT NULL,       -- packageContentHash(content) = draft_version.content_hash at confirm
  question_meta jsonb NOT NULL, change_summary jsonb NOT NULL,
  spec jsonb NOT NULL,              -- {v:1, documents[], locale, pageFormat, templateVersion, renderVersion}
  tex_sha256 jsonb NOT NULL,        -- {doc: hex} for exactly spec.documents
  export_key text NOT NULL, content_key text NOT NULL,  -- content_key = H(docs, texShas, locale, pageFormat): enables a later cross-version reuse follow-up
  validation_report jsonb NOT NULL, validator_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id),
  CHECK (octet_length(content::text) <= 4000000),
  CHECK (validation_report->>'overall' = 'verified'),
  CHECK (jsonb_typeof(spec)='object' AND jsonb_typeof(tex_sha256)='object'));
CREATE TABLE export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
  snapshot_id uuid NOT NULL, export_key text NOT NULL, lesson_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE, revision_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','succeeded','failed')),
  failure_code text, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
  FOREIGN KEY (snapshot_id, owner_id) REFERENCES export_snapshot(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (lesson_id, owner_id) REFERENCES lesson(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, owner_id) REFERENCES generation_job(id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, lesson_id) REFERENCES lesson_revision(id, lesson_id) ON DELETE RESTRICT,
  CHECK ((state='succeeded') = (revision_id IS NOT NULL)),
  CHECK ((state='pending') = (settled_at IS NULL)),
  CHECK ((state='failed') = (failure_code IS NOT NULL)));
CREATE UNIQUE INDEX export_live_key ON export(owner_id, export_key) WHERE state IN ('pending','succeeded');
CREATE INDEX export_owner_created_idx ON export(owner_id, created_at DESC);
CREATE INDEX export_snapshot_content_key_idx ON export_snapshot(owner_id, content_key);
```
Guards: `export_snapshot_guard` BEFORE UPDATE always raises 55000; `export_guard` BEFORE UPDATE raises unless `OLD.state='pending'` and only state/revision_id/failure_code/settled_at change with `NEW.state IN ('succeeded','failed')`. Replace `generation_job_reservation_shape()` (same trigger, new body): generate and export require a reservation; compile forbids one; an export job requires a matching `export` row (job, owner, lesson). `check_export_consistency(export_id)` called by three DEFERRABLE INITIALLY DEFERRED constraint triggers (on `export` AFTER INSERT OR UPDATE; on `generation_job` AFTER UPDATE WHEN `NEW.kind='export' AND OLD.state IS DISTINCT FROM NEW.state`; on `usage_reservation` AFTER UPDATE WHEN `OLD.state IS DISTINCT FROM NEW.state`, looking the export up by job id and returning if none) enforcing: kind export; `e.lesson_id=j.lesson_id`; pending => job queued|running and reservation reserved; succeeded => job succeeded, reservation consumed, `j.revision_id=e.revision_id`; failed => job failed|canceled and reservation released. Add an `export_state_drift` view (security_invoker). Grants: `export_snapshot` app SELECT/INSERT, worker SELECT; `export` app SELECT/INSERT/UPDATE, worker SELECT/UPDATE; **no DELETE for either role**; RLS enabled with the `runtime_roles_all` policy; `worker_runtime` SELECT on the drift view; add both tables to `tests/integration/schema.test.ts` TABLES.

## Global lock order
`profile -> draft -> draft_version -> generation_job -> export -> lesson -> reservation -> usage_bucket`; `rate_limit_window` rows are leaf locks. The confirm-attempt counter (`exp:try:u:`) takes one alone, in its own transaction BEFORE the confirm transaction, holding no other lock. Rule: no path holding profile X may wait on a job, export or lesson lock.
| Path | Locks in order |
|---|---|
| createGeneration (unchanged) | profile X, rate_limit_window, bucket X, inserts |
| confirmExport | (separate earlier transaction: rate_limit_window `exp:try:u:` only), then lock_timeout, profile X, (reads without locks), rate_limit_window, bucket X, inserts (snapshot, lesson, job, export, reservation) |
| commitSuccess (unchanged) | job X, lesson S, profile S, reservation, bucket |
| commitExport | job X, export X, lesson S, profile S, revision insert, lesson U, reservation X, bucket X |
| finishLockedJob (finishJob, retryOrFail failing, sweep, cancelJob) | job X, export X (settle), reservation X, bucket X |
| claimNext | job X, SKIP LOCKED |

## DAL behaviour
**confirmExport(ctx, {draftId, versionId, expectedRev, expectedContentHash}, key, {ipHash})**: pre-transaction: validate ids/key; read draft+version owner-filtered (NOT_FOUND); assemble the full package; `packageContentHash` must equal the row hash (else invariant error) and `expectedContentHash`/`rev` (else EXPORT_CONFLICT); `validatePackage` must be verified (else EXPORT_NOT_VERIFIED); render each document (RenderError -> EXPORT_RENDER_FAILED, no charge); compute texShas, spec, exportKey, contentKey. Transaction (READ COMMITTED, `SET LOCAL lock_timeout`, 55P03 -> EXPORT_BUSY): 1 profile FOR UPDATE active; 2 idempotency createMany skipDuplicates (different hash -> IDEMPOTENCY_CONFLICT; same -> replayed with the current resource); 3 re-check rev + hash + draft active and `expires_at > now()` (EXPORT_CONFLICT / DRAFT_EXPIRED); 4 lookup `(owner, exportKey, pending|succeeded)` without locks: succeeded -> back-fill idempotency, `reused`; pending with cancel flag or past deadline -> EXPORT_BUSY; pending -> back-fill, `joined`; 5 failure memo (>= 3 non-retryable failures of this key in 24 h -> EXPORT_UNAVAILABLE); 6 limits only on the create path (`exp:u:{owner}` per hour via existing helper, `exportConcurrencyPerUser`, global queued cap), refusal rolls back; 7 shared `lockAllowanceBucket` + conditional `reserved+1` (ALLOWANCE_EXHAUSTED); 8 inserts: snapshot, lesson (title = topic title, `inputSpec={requestVersion:2, request, context}` + curriculum pins), job (kind export, `request_hash=exportKey`, deadline = now + `exportDeadlineMinutes`, call budgets 0), export, reservation, back-fill idempotency `('export', id)`; 23505 anywhere -> InvariantViolation. Returns `{outcome: created|joined|reused|replayed, exportId, jobId, lessonId}`.
**commitExport({jobId, fencingToken, attemptId, revisionId, manifest(v2)})**, one transaction: lock job (replay no-op if already succeeded with the same token and revision); state running, token matches, no cancel flag (else StaleOrCanceled); kind export; `deadline_at > now()` (else DeadlineExceeded); lock export by job_id (must be pending); lesson SHARE (not deleted) and profile SHARE (active); load the snapshot; `assertManifestV2Complete(scope, snapshot.spec.documents)`, manifest templateVersion equals spec, each `tex.sha256 == snapshot.tex_sha256[doc]` (else ManifestIncomplete); insert finalized revision number 1 (content and hash from the snapshot, `generation_meta={exportId, snapshotId, exportKey, spec, compiler, documents pages}`, manifest, `created_by_job_id`); set `lesson.current_revision_id`; consume reservation `WHERE job_id AND state='reserved' RETURNING` (none -> rollback) and bucket `reserved-1, used+1`; job succeeded with revision_id; export succeeded with revision_id and settled_at.
**settleExportFailure(tx, jobId, code)**: `UPDATE export SET state='failed', failure_code=$code, settled_at=now() WHERE job_id=$1 AND state='pending'`; called only from `finishLockedJob`, before `releaseReservation`.
**getExportStatus(ctx, exportId)** (owner-filtered): `{state, job:{state, stage, attempt, maxAttempts, cancelRequested, errorCode}, reservation:{state}, lessonId, revisionId, deadlineAt}`; the UI says "not used" only when the reservation is `released`.
**jobs.ts/history**: `claimNext` claims `kind IN ('generate','export')` with stage CASE (export -> compiling) and returns kind; `getExportInput(jobId, token)` joins job (running, token), export, snapshot; `sweep` per-row try/catch plus `sweep_row_error` count, fails running export jobs past `deadline_at + grace`, reports `export_state_drift`; `cancelJob` uses `finishLockedJob`; `listJobs` includes export (HistoryItem gets `kind`/`exportId`; failed or pending exports link to `/exports/[id]`); fix `getAllowance` to apply the paid-bucket window like `lockAllowanceBucket` while extracting both into `allowance-source.ts`.

## Export spec (`src/lib/domain/export-spec.ts`)
documents = the snapshot package's `documents[].id` (canonical order); locale = `request.locale`; pageFormat = constant `'letter'` (S5 makes it a template parameter); `templateVersion` = `TEMPLATE_VERSION`; `renderVersion` = new `RENDER_VERSION` constant in `render.ts` (renderer code + compile flags + image pin; enforced by the golden test); validatorVersion is recorded but NOT in the key.

## Slice boundary
**S4a**: migrations M1+M2, guards/triggers/drift view, `export-spec.ts` + `RENDER_VERSION` + golden render test, `allowance-source.ts`, `confirmExport`/`getExportStatus`/`commitExport`/`settleExportFailure`, `finishLockedJob`/`cancelJob` refactor, sweep hardening, claim/list/DTO changes, limits wiring (`exports*` keys exist in limits.ts) and `EXPORT_ENABLED`, tests including the real-database concurrency matrix. **S4b**: worker `runExport` with the real compiler (reuses the existing compile/store tail; checks render version, recomputes package hash, validates, re-renders and compares shas, compiles, stores with a final stat pass, commits), confirmation page (full page, exact copy, hidden key + expectedRev + expectedContentHash, no "don't show again"), `/exports/[id]` status page with polling and all UI states, `/api/exports/[id]`, E2E, docs, and the CLAUDE.md edit as a separate commit. **S5**: page format parameter, manifest v3 and reader, deterministic compile flags and PDF text-extraction proof tests, orphan reconciler, artifact recovery, retired state.

## Test matrix (real Postgres)
Drafts never charged; pay for exactly what was seen (mutation between view and confirm -> EXPORT_CONFLICT, nothing reserved); double click x10 same key -> 1 export, `reserved=1`, rest replayed; different keys same content x10 -> 1 export, rest joined; different versions with equal tex -> joined, different provenance difficulty -> different key (C1 regression); reuse free at 0 remaining; last-unit race (1 created, 1 ALLOWANCE_EXHAUSTED); retry after failure (index excludes failed; new key -> new export + reservation; same key replays the failed one); worker retry reuses the reservation; crash before commit (requeue, consume once); lost commit acknowledgement (replay no-op); late stale commit (StaleOrCanceled, counters unchanged); commit vs sweep barrier race (one outcome, drift views empty); cancel queued/running/after commit; deadline (no consumption, released); consistency trigger (raw SQL attempts at each inconsistent state -> 23514 at commit); poisoned sweep row (others recovered); no deadlock (parallel confirm/commit/createGeneration/cancel/sweep on one owner, 200 iterations, `pg_stat_database.deadlocks` delta 0); owner isolation; verification gate; render chain mismatch; historical lessons unaffected and legacy suites unchanged; drift views empty in `afterEach`; migration tests (generate without reservation fails, compile with reservation fails, export without an export row fails, grants, RLS, no DELETE). Existing tests to change: `schema.test.ts` (TABLES, grants), `worker.test.ts` (claim kinds, sweep report), `history.test.ts` (listJobs), `allowance.test.ts` if `lockAllowanceBucket` moves, DTO/job-view unit tests.

## Owner decisions (defaults adopted; none blocks S4a/S4b implementation)
1. (APPROVED by the owner 2026-10-22, D-110; D-109 also approved) `ADD VALUE 'export'` is irreversible: approve before it is applied to staging or production (recommended). 2. Validator version excluded from the export key (adopted). 3. Template/render change = new paid export (adopted, literal brief). 4. Cross-version reuse follow-up: cheap because `content_key` is stored (config flag + lookup, about a day, no migration); the choice is yours since reuse returns PDFs made with an older template. 5. Subset of an already exported pack is a new paid export (adopted). 6. Failure-memo threshold and export rate limits: defaults approved. 7. CLAUDE.md section 5 edit in S4b as a separate commit. 8. Rollout: migrate -> worker -> web -> enable `EXPORT_ENABLED`.


## Release and rollback (S4a)

**Deploy order:** migrate, then worker, then web, then set `EXPORT_ENABLED=1`. With the flag off nothing in the web app calls the export code (`confirmExport` throws `EXPORT_DISABLED` first), so the migrations and the new worker are safe to run ahead of enabling it.

**Forward-only.** `ALTER TYPE "job_kind" ADD VALUE 'export'` (migration `20261024100000_job_kind_export`, kept as its own statement) and the export tables (`20261024100100_export_tables`) have no down migration. Postgres cannot drop an enum value, and published export rows are never deleted (no DELETE grant for either runtime role). A rollback means rolling the *application* back, never the schema.

**Rolling the application back after exports exist.**
1. Set `EXPORT_ENABLED=0` first.
2. Let every pending export settle, or cancel each one with the *new* code (`cancelJob` settles the export, the reservation and the job together).
3. Only when there are **zero pending exports**, run a pre-S4a worker or web build against the database.

Why: a pre-S4a sweep or `finishLockedJob` still fails or cancels an overdue export job and releases its reservation, but it does not mark the export row failed. The deferred consistency trigger (`export_consistency_job`) then raises SQLSTATE 23514 at COMMIT. The old sweep has no per-row catch, so the whole sweep throws every cycle, the same oldest row is selected first each time (`ORDER BY created_at`), and recovery stalls for **all** jobs, legacy ones included, leaving their free reservations held. An old web build calling `cancelJob` on a queued export fails the same way.

**Check before downgrading (read-only):**
```sql
SELECT count(*) FROM "export" WHERE state = 'pending';   -- must be 0
SELECT * FROM "export_state_drift";                       -- must be empty
SELECT * FROM "usage_bucket_drift";                       -- must be empty
```

## Known limits and follow-ups (found in the S4a independent review; not implemented)
- **Sweep starvation:** the sweep selects `ORDER BY created_at LIMIT 50` and a poisoned row stays eligible, so with 50 or more poisoned rows nothing behind them is recovered. Poisoned rows are now logged with the job id and SQLSTATE (`sweep_row_error`); an alert on that event is advised.
- **M-1:** the in-transaction `rev`/content-hash re-check in `confirmExport` has no test (a hook between preparation and the transaction is needed). It is not load-bearing for billing because the snapshot is the version the tutor saw.
- **M-4:** `confirmExport` can join a queued export that the sweep will fail (`attempt >= max_attempts`). Nobody is charged; the tutor sees a failure and must confirm again.
- **M-5 (implemented in S4b-2):** `prepare()` (validation plus rendering three documents) used to run before any limit. `confirmExport` now counts every NEW idempotency key against `exportConfirmAttemptsPerUserPerHour` (`EXPORT_CONFIRM_ATTEMPTS_PER_USER_PER_HOUR`, key `exp:try:u:{owner}`) in its own short transaction BEFORE `prepare()`, whether the confirm later succeeds or is refused; the count stays committed. A true replay (same key and same request hash) is not counted; a recorded key reused with different input fails with `IDEMPOTENCY_KEY_REUSED` before `prepare()`. There is no per-IP limit (no IP hashing exists; the owner has not approved one). The matching CLAUDE.md edit was applied in PR #39.
- **M-a (accepted):** parallel first-time requests with the same new key each count one attempt, so a burst of N counts up to N. It costs only attempts, never allowance.
- **M-e (accepted):** a confirmation page opened without `rev` cannot tell that the draft changed since the link was made; the form still carries the revision and hash it was rendered from, so the tutor pays only for what that page showed.
- **M-7:** the golden render test pins one fixture; nothing ties the compiler image or compile flags to `RENDER_VERSION`.
- **M-8:** the reuse lookup did not check `lesson.deleted_at` and there was no deletion path. Resolved in S5-6: `export.state` gains `retired` (text CHECK, reversible migration `export_retired`), `deleteLesson` retires succeeded exports and frees the identity (no refund), the reuse lookup requires a live lesson. Lock order of `deleteLesson`: job, export, lesson, profile S (same as `commitExport`).

## S4b status (implemented behind `EXPORT_ENABLED`)
Done: worker `runExport` (S4b-1); confirmation page, action and confirm-attempt limit (S4b-2, M-5); status page, polling endpoint and cancel (S4b-3); export E2E on a third server, and the docs and rollout note in [fresh-droplet-setup.md](../../fresh-droplet-setup.md) section K (S4b-4). The CLAUDE.md edit was applied in PR #39.

Remaining for S5: page format parameter; manifest v3 and reader; deterministic compile flags; PDF text-extraction proof tests; orphan reconciler and artifact recovery; retired state (M-8); pinning `RENDER_VERSION` to the compiler image (M-7).

Known limits of S4b:
- Parallel first-time requests with the same new key each count one confirm attempt (M-a); it costs attempts only, never allowance.
- A confirm link without `rev` shows no stale-draft notice (the page cannot tell the link is old); the form it renders still carries the revision and hash it displays, which the server checks on submit.
- Login has no return-to-page, so a link opened with an expired session goes to `/login` and the tutor must navigate back.
- There is no per-IP limit on confirmation attempts (no IP hashing exists; not approved).
- **No operator cancel tool.** With `EXPORT_ENABLED=0` pending exports are settled only by the tutor or by the deadline sweep. Follow-up: an admin script that calls the DAL's cancel path (never raw SQL; the consistency trigger needs export, job, reservation and bucket counters settled together).
- **M3:** the confirmation page always promises a charge, even when the confirm will be a free reuse of an identical earlier export; a `TOO_MANY_ACTIVE_JOBS` refusal has no link to the export that is already running.
- **M7:** a cancel requested just before the worker commits shows "Stopping" until the lease expires and the sweep settles the export.
- **M2:** the status page header shows no lesson title or version label: `ExportStatusDto` carries neither, and adding them needs a new owner-filtered DAL field. Follow-up.
- **PDF proof is ordered-fragment, not full-text equality (S5-5, owner-accepted).** `tests/latex/pdf-proof.ts` extracts text inside the sandbox image and checks that every expected fragment (titles, headings, prose, each equation, step and answer, built from the package data, never from the .tex) occurs in document order, plus exact counts of "Solve for x" and "Answer:" and a worksheet leak check. Extra text in the PDF that is not an expected fragment would still pass. Fractions are matched with several digit orders because pdftotext's order for stacked and inline fractions is not fixed; a fragment with more than one fraction is refused by the proof (explicit error), and orders other than the observed ones are unverified.
- **Polling bound:** the status poller stops after about a minute of "finishing up" (30 polls) and shows "We cannot confirm the final state"; refreshing the page resumes it.
