# S5 staging checklist (page format, manifest v3, recovery)

Run on the ONE staging environment (`https://noteprep.app`) with a throwaway tutor account, after the S5 branch is merged. Use fictional data only. Background: [fresh-droplet-setup.md](fresh-droplet-setup.md) (sections "S5 page format and manifest v3", "S5-6", "S5-7", "S5-8") and the [S5 plan](superpowers/plans/2026-10-24-s5-pdf-consistency-plan.md). Record the result of each step (pass/fail, date, operator) in `releases.log` or your runbook log. A step that fails stops the rehearsal: fix forward or roll back per the setup guide.

## 1. Migrate and deploy (rollout sequence)

Order matters. A new worker with the old web app writes v3 manifests the old reader cannot parse, so lesson view and downloads 404 until the web app is deployed (files and billing stay intact).

1. Set `EXPORT_ENABLED=0` on staging.
2. Wait until `SELECT count(*) FROM export WHERE state='pending';` returns 0.
3. Run migrations (`pnpm db:migrate:deploy`).
4. Publish all three images: web is built by Vercel; the worker image (it now contains `recover.mjs`) and the hosttest image (it has the new tests).
5. Update the host (setup guide step 31, including the host sandbox tests with the new hosttest and latex refs).
6. Deploy the web app.
7. Set `EXPORT_ENABLED=1`.

Checks:
- `SELECT migration_name FROM _prisma_migrations WHERE migration_name LIKE '202610241%';` returns 2 rows.
- `SELECT count(*) FROM export_state_drift;` is 0.
- The `worker_started` log line shows `reconcile` false.

## 2. Letter export

Make a draft, open export confirm.
- The page-format radio shows US Letter selected.
- Confirm. The export reaches COMPLETE and the page says "This used 1 generation". The allowance went down by 1.
- SQL (read only), with the export id from the status URL:
  ```sql
  SELECT s.spec->>'pageFormat', r.artifact_manifest->>'manifestVersion', r.artifact_manifest->>'pageFormat', r.artifact_manifest->'compile'
    FROM export e JOIN export_snapshot s ON s.id = e.snapshot_id JOIN lesson_revision r ON r.id = e.revision_id
   WHERE e.id = '<export id>';
  ```
  Expect `letter`, `3`, `letter`, and a compile object whose image equals the worker's `LATEX_IMAGE` digest.
- Download all three PDFs: each page is 8.5 x 11 in.

## 3. A4 export of the same draft

Export the same draft again, choosing A4.
- It is a new export (new export id) and the allowance goes down by 1 more.
- The PDFs are 210 x 297 mm.
- Questions and answers are the same as in the preview.

## 4. Free re-export of the A4 export

Export the same draft in A4 again.
- The browser lands on the status page with `?outcome=reused`, which says "This one used none".
- The allowance does not change.
- The draft has 2 exports in total (letter and a4), not 3.

## 5. Double click on a new draft version

Create another version of the draft (or a new draft), open export confirm and double-click Confirm.
- Exactly one export is created and exactly one generation is used.

## 6. Cancel

1. Stop the worker (`systemctl stop noteprep-worker`) so the export stays pending.
2. Confirm an export on a fresh version.
3. Cancel it from the status page. The page shows CANCELED and "No generation was used".
4. SQL: the export is `failed`, its job is `canceled`, the reservation is `released`, and the allowance is unchanged.
5. Start the worker again and confirm `worker_started`.

## 7. Content checks

- The worksheet PDF contains no "Answer:".
- The solutions PDF matches the preview.
- Replace one question in the draft and export again: the earlier PDFs still download unchanged (same questions and answers as when they were exported).

## 8. Recovery dry run

On the worker host, with the revision id of a good export (`SELECT revision_id FROM "export" WHERE id = '<export id>';`):
1. `docker exec noteprep-worker node --conditions=react-server --enable-source-maps /app/dist/worker/recover.mjs --revision <id> --check` reports `intact` (it returns before any re-render or recompile).
2. In the Supabase Storage dashboard delete one `worksheet.pdf` of that revision. Run the same command with `--check`: it reports `would_restore` and writes nothing.
3. Run it without `--check`: it reports `restored`. Download the worksheet and confirm it opens.
4. Append one line to `releases.log` (revision id, UTC date, status, operator).

## 9. Retired state

Recommended: do NOT test by hand. The integration tests cover it (`tests/integration/export-retire.test.ts`) and there is no UI that deletes a lesson yet.

Optional, throwaway account only. WARNING: lesson deletion is final (`deleted_at` cannot be undone), and once a `retired` export row exists on this staging database, the `export_retired` `down.sql` refuses to run, so you could only roll forward. Do this only if you accept that. It needs the application's `deleteLesson` DAL helper run by an operator; do not edit rows with raw SQL (a deferred trigger requires the export, job, reservation and bucket to be settled together). Afterwards check `SELECT count(*) FROM export_state_drift;` is 0 and the status page shows "This lesson was deleted."

## 10. The reconciler stays off

- No `reconcile` lines in the worker journal (`journalctl -u noteprep-worker`).
- `SELECT count(*) FROM export_state_drift;` and `SELECT count(*) FROM usage_bucket_drift;` are both 0.
- No export is left `pending`.
