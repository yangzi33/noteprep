# S5 export: page format, manifest v3, deterministic PDFs, proof tests, reconciler, retired state

Status: plan (2026-10-24), planner output, not implemented. Builds on the [S4 spec](2026-10-24-s4-export-billing-spec.md) (I6, M-7, M-8, "Remaining for S5"). Binding: CLAUDE.md sections 5, 7, 8. Owner constraints: lean scope, no LLM calls, no new product features, no weakening of allowance, ownership or sandbox invariants, never run `pnpm test:supabase`, irreversible migrations need owner approval (S5 has none).

## What already exists (do not rebuild)
- `src/lib/latex/sandbox.ts` sets `SOURCE_DATE_EPOCH=1704067200` and `FORCE_SOURCE_DATE=1`. `docker/latex/compile.sh` runs a fixed `pdflatex -no-shell-escape -halt-on-error -interaction=nonstopmode`. `tests/latex/compile.test.ts` ("is reproducible") already checks byte-identical PDFs on one host.
- `\pdfobjcompresslevel=0` is in the preamble. `docker/latex/packages.lock` is checked by `tests/latex/image.test.ts`. Production `LATEX_IMAGE` must be digest-pinned (`worker/env.ts`).
- `commitExport` checks `manifest.documents[d].tex.sha256 == snapshot.tex_sha256[d]`. The worker re-renders and compares before compiling (`worker/export.ts verifyExportInput`).
- Readers: `parseManifestV2` is used by `src/lib/server/dal/lessons.ts` and `tests/unit/lesson-view.test.ts`.
- No lesson deletion path exists (only `deletedAt: null` filters). `ObjectStore` has no `list`.

## Ordered sub-slices
Each goes on `feat/export-s5` as small commits, checks run before the next starts. Deploy order is unchanged: migrate, worker, web.

### S5-1 Manifest reader for v2 and v3 (read-only; ships together with the v3 writer, see R1)
- Files: `src/lib/domain/manifest.ts` (add `ManifestV3` strict schema; `parseManifest(value)` normalizing v2 and v3), `src/lib/server/dal/lessons.ts` (use it).
- V3 shape: `{manifestVersion:3, templateVersion, renderVersion, pageFormat:'letter'|'a4', compile:{profile, image|null}, exportKey, documents}`; documents identical to v2.
- Acceptance: a stored v2 fixture parses as before, a v3 fixture parses, unknown versions, extra keys and v1 are rejected; lesson-view tests unchanged.
- No migration. Ships in the same release as the v3 writer; the rollout sequence is in R1.

### S5-2 Pin RENDER_VERSION to compiler image and flags (M-7); cross-host determinism
- New `src/lib/latex/compile-profile.ts` (`COMPILE_PROFILE`, moves `SOURCE_DATE_EPOCH` here). `render-golden.test.ts` gets a second golden: hash of `docker/latex/{Dockerfile,compile.sh,texmf.cnf,packages.lock}` plus the profile, pinned per `RENDER_VERSION`.
- Optional (owner decision 4): image label `org.noteprep.compile-profile`; worker refuses to start on mismatch.
- Determinism tests: two containers with different clocks give the same PDF sha; no host paths in the PDF.
- Letter golden tex shas stay unchanged, so no version bump. No migration.

### S5-3 Page format (letter, a4)
- Files: `export-spec.ts` (`PAGE_FORMATS`, spec field), `templates.ts` (`letterpaper`/`a4paper` only), `render.ts`, `worker/export.ts`, `dal/export.ts` (input validated against the allowlist; request hash includes `pageFormat` only when not `letter`, so old keys still replay), export confirm page and action (radio group, default letter, copy names the format).
- Draft content and package hash do not change (format is an export option).
- Acceptance: letter golden unchanged, a4 golden added; a4 gives a different key; real compile reports 595x842 pt; real-DB: letter and a4 of one draft are two exports and two reservations, ten double clicks make one; unknown format refused before reserving; E2E confirms with a4 and downloads.
- Deploy note: worker before web; an old worker fails an a4 spec as `snapshot_invalid` (reservation released, counts toward the failure memo).

### S5-4 Manifest v3 writer (export path only)
- `worker/compile-store.ts` takes a `buildManifest` callback (generate path keeps v2); `worker/export.ts` builds v3; `settlement.ts commitExport` accepts only v3 and checks renderVersion, pageFormat, templateVersion and exportKey against the snapshot, else ManifestIncomplete.
- Acceptance: settlement integration tests on v3; v2 or mismatching v3 leaves the reservation reserved (released by the runner); generate pipeline still writes v2; downloads of v3 revisions work.

### S5-5 PDF text-extraction proof tests
- New `tests/latex/pdf-proof.ts`: expected fragments built from the package data (never from the tex): titles, headings, paragraph and list text, each question equation, answers, "Answer:" count. Normalize hyphenation and whitespace. Assert ordered presence plus exact counts. Worksheet has no "Answer" and no exercise answers.
- Tests: all three documents of several fixtures, letter and a4; a sensitivity test where a regenerated question must FAIL the proof; DB-backed `export-pipeline` test proves stored PDFs against `export_snapshot.content` and recompiles the stored `.tex` to the manifest sha (excluded from the host image run).
- Limitation to record: ordered-fragment proof, not full-text equality.

### S5-6 Retired export state (M-8)
Status: implemented on `feat/export-s5` (migration `20261024110000_export_retired` with `down.sql`; `dal/lesson-delete.ts`; tests `tests/integration/export-retire.test.ts`). Deviation from the text below, found by the extended deadlock loop: the lock order of `deleteLesson` is job, export, lesson, then profile FOR SHARE (the same as `commitExport`), not profile first. With profile first, a delete holding profile S and waiting on a job that a commit holds deadlocked against that commit waiting for profile S queued behind a `confirmExport` (profile X): deadlock counter 0 to 2 in one run. Also the guard needs the lesson already deleted, so the lesson is updated before its exports are retired in the same transaction.
- Reversible migration `export_retired`: CHECK gains `'retired'`; `export_guard` allows `succeeded -> retired` only with the lesson deleted and revision and settled_at unchanged; consistency check and drift view updated; deferred constraint trigger on `lesson` refuses a deleted lesson that still has pending or succeeded exports. `export_live_key` already excludes retired.
- `deleteLesson(ctx, lessonId)` DAL helper, no UI. Lock order job, export, lesson, then profile FOR SHARE. A queued or running job gives LESSON_BUSY. Never touches reservations or buckets (no refund). Storage cleanup out of scope.
- Reuse lookup also requires the lesson not deleted; status page shows "This lesson was deleted".
- Real-DB acceptance (all in `export-retire.test.ts`, plus the extended loop in `export-locking.test.ts`): delete refused while pending; delete retires succeeded and `used` is unchanged; re-confirming the same identity afterwards charges again; raw-SQL bypass attempts fail; races (delete vs commit, confirm reuse, sweep, cancel); the S4 deadlock loop extended with delete; foreign lesson gives NotFound.

### S5-7 Orphan object reconciler
- `ObjectStore.list(prefix, {limit, cursor})`, Supabase implementation (verify pagination first), `listReconcileCandidates`, `worker/reconcile.ts`, third sweep step in `worker/loop.ts` whose failure never affects recovery or liveness.
- Rule: delete a revision prefix only if no `lesson_revision` row has that id for the lesson, and an attempt prefix only if no manifest path uses it. Re-read the lesson for a live job right before deleting. Never delete any path a manifest (v1, v2, v3) references, asserted in code. Bounded batch and interval; logs only counts and ids.
- Writes no database rows, so it cannot double-charge.
- Acceptance: crash after upload retries and succeeds once, the first attempt's prefix is deleted, published files remain; stale late upload deleted with counters unchanged; running job untouched; legacy v1 pack untouched; 50-run race of commit vs reconciler never deletes published files.
- Check that `worker_runtime` can SELECT lesson and lesson_revision (else a reversible GRANT).

### S5-8 Artifact recovery (operator script)
- `worker/recover.ts` plus a CLI entry: stat every manifest file; for export revisions only, re-render from the snapshot, require tex sha equal to manifest and snapshot, recompile, require the PDF sha equal to the manifest's, then put only to the manifest path.
- Refuses on a different `LATEX_IMAGE` or a non-identical recompile. No billing writes, no new job kind.
- Acceptance: deleted or corrupted stored PDF restored to the identical sha; mismatch refused with nothing written; counters unchanged.

### S5-9 Docs and rollout
Update the S4 spec status, `docs/fresh-droplet-setup.md` section K (reader-first deploy, image republish if the label is adopted, `RECONCILE_*` variables, recovery command, rollback caveat), README and `.env.example`.

## Migrations
Only S5-6 `export_retired` and possibly a GRANT in S5-7. Both reversible. No enum `ADD VALUE`.

## Risks
- R1 S5-1 and the v3 writer ship together, so "reader first" is impossible. Rollout: `EXPORT_ENABLED=0`, wait for zero pending exports, migrate, publish all three images, update host, deploy web, `EXPORT_ENABLED=1`. A new worker with the old web writes v3 manifests the old reader cannot parse (lesson view and downloads 404 until web is deployed; files and billing intact). Rolling the web app back below S5-1 has the same effect.
- R2 Old worker with new web fails a4 specs; keep deploy order and same-commit builds.
- R3 pdfTeX `/ID` or dates may differ across hosts (not verified). A fix would change the preamble, bump `TEMPLATE_VERSION`, and make identical content a new paid export.
- R4 Supabase list pagination and folder semantics not verified; the manifest-reference assertion and the re-read before delete are the guard.
- R5 Lock order in `deleteLesson` must be job, export, lesson, then profile FOR SHARE; no trigger may write `export`.
- R6 The fragment proof can pass with extra text present; exact counts and the sensitivity test reduce this.
- R7 The compile-inputs golden makes any Dockerfile edit force a profile bump (intended).

## Reviews and tests
- Independent Opus review: S5-3, S5-6, S5-7, S5-8. Sonnet is enough for S5-1, 2, 4, 5.
- Real-DB concurrency tests: S5-3, S5-6, S5-7.
- Never run `pnpm test:supabase`.

## Owner decisions
1. Page format: default letter, a4 offered for every locale, no stored per-account preference (recommended).
2. After lesson deletion the export is retired and its identity freed, so re-exporting identical content is charged again (recommended). Alternative: keep the identity blocked.
3. Lesson deletion in S5 is DB rule, DAL helper and tests only; UI stays in Phase 3 (recommended).
4. Worker startup check via a LaTeX image label (needs one image republish, packages unchanged).
5. Artifact recovery only by operator script (recommended).
6. Reconciler grace, batch and interval defaults (placeholders); cleaning objects of deleted lessons deferred.
7. If the cross-host determinism test fails and the fix needs a preamble change, `TEMPLATE_VERSION` is bumped and re-exports cost a generation. Approve only if needed.
8. Accept the rollback caveat R1 and document it.
9. Accept the ordered-fragment proof as meeting "the confirmed version equals the PDF content exactly".

## Owner answers (2026-10-24): "go with recommended"
1, 2, 3, 5, 8: approved as recommended. 4: not adopted (no image label, no startup check; M-7 is pinned by the compile-inputs golden test only). 6: placeholder defaults, deleted-lesson object cleanup deferred. 7: stop and ask the owner before any preamble or `TEMPLATE_VERSION` change. 9: ordered-fragment proof accepted.
