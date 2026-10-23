# Fresh worker droplet: every step from nothing (no snapshot)

Purpose: rebuild the NotePrep worker host from a blank droplet. It is a checklist assembled from [worker-host-runbook.md](worker-host-runbook.md) (the reference, in Chinese, with the reasons behind each step), [staging-setup.md](staging-setup.md) and the files in `deploy/host/`. Nothing here creates paid resources for you: steps 1 to 2 are yours.

**Honesty about verification.** Verified on a real DigitalOcean droplet (Ubuntu 24.04, 4 GB / 2 vCPU, Docker 29.9.1) on 2026-10-20: the runner account and rootless daemon checks, the `--group 0` socket fix, pulling images by digest, the 41 host sandbox tests, the running-worker inspection, the metadata block, and a first `worker_started`. **Not verified anywhere yet:** a full reboot with no manual steps, a restart during a running job, restarting the runner's daemon, a rollback drill, the staging smoke test, `docker save | load` followed by referencing the LaTeX image by digest, and cgroup v1 hosts. Treat the first run of this document as a rehearsal and write down what differs.

Steps tagged **[you]** need your accounts or your hands. Commands run as root unless stated. `<...>` is a value you fill in. Never paste secrets on a command line (they land in shell history).

---

## A. Before touching the droplet
1. **Database ready.** Migrations applied to the target database through the **Database migrations** workflow (status, then deploy). The `worker_login` role exists as described in [database-roles.md](database-roles.md); the worker uses it, never the migration credentials. Curriculum datasets loaded through **Load curriculum dataset** (the `all-suggested` option loads the suggested datasets). **[you]**
2. **Supabase Storage** has the private `lesson-artifacts` bucket (created by the migrations). Keep the project URL and the **secret key** in your password manager. **[you]**
3. **Publish images.** Run the **Publish images** workflow on `main`. From its Step Summary copy the three digest references: `<worker_ref>`, `<latex_ref>`, `<hosttest_ref>` (form `ghcr.io/<owner>/noteprep-worker@sha256:<64 hex>`). These are *manifest* digests, not image IDs. A worker image built before the last worker-related merge runs old code, so publish fresh. **[you]**
4. **Registry token.** Create a GitHub token with `read:packages` only. It is used once on the host and then discarded. **[you]**
5. **LaTeX image delivery** (pick one): (A, default) root pulls it and loads it into the runner's daemon with `docker save | docker load` (referencing it by digest afterwards is UNVERIFIED); or (B) make the LaTeX image package public (it contains no secrets), so the runner can `docker pull` it with no credentials. Your decision.
6. **LLM:** start with `LLM_PROVIDER=fake` and `LESSON_PROSE=template` (no model cost). The OpenAI adapter does not exist yet.

## B. Create the droplet **[you]**
7. Ubuntu 24.04 LTS, **x86_64, at least 4 GB RAM and 2 vCPU** (512 MB fails the sandbox tests), SSH key login only, no password login.
8. **Cloud firewall:** deny all inbound except SSH from your own IP. The worker needs **no inbound ports**; it polls the database. Outbound must reach Supabase (database and Storage), GHCR, and later the LLM provider.
9. Note the droplet IP. No DNS record is needed.

## C. Base system
10. Log in as root over SSH. Update and enable automatic security updates:
    ```sh
    apt-get update && apt-get -y upgrade
    apt-get -y install unattended-upgrades
    ```
11. Check the platform requirements (all must hold):
    ```sh
    uname -m                              # x86_64
    stat -fc %T /sys/fs/cgroup            # cgroup2fs
    timedatectl show -p NTPSynchronized   # yes
    ```
12. Install Docker Engine from Docker's **official apt repository** (follow <https://docs.docker.com/engine/install/ubuntu/>; do **not** use the `curl | sh` script), plus the packages rootless mode needs: `docker-ce-rootless-extras`, `uidmap`, `dbus-user-session`, `systemd-container`. Check that nobody is in the `docker` group:
    ```sh
    getent group docker        # members must be empty, e.g. docker:x:999:
    ```
13. Copy the repository's `deploy/host/` files to the droplet (for example `scp -r deploy/host root@<ip>:~/host`). The host does not check out the repo.

## D. The sandbox runner account (rootless Docker)
14. As root:
    ```sh
    useradd --system --create-home --shell /usr/sbin/nologin noteprep-runner
    grep noteprep-runner /etc/subuid /etc/subgid     # if no entries, add:
    #   echo 'noteprep-runner:200000:65536' >> /etc/subuid   (same for /etc/subgid; avoid existing ranges)
    loginctl enable-linger noteprep-runner

    cd ~/host
    install -d -m 0755 -o root -g root /etc/systemd/system/user@.service.d
    install -m 0644 -o root -g root user-delegate.conf /etc/systemd/system/user@.service.d/delegate.conf
    install -m 0644 -o root -g root noteprep-runner.tmpfiles.conf /etc/tmpfiles.d/noteprep-runner.conf
    install -d -m 0755 -o root -g root /etc/systemd/user/docker.service.d
    install -m 0644 -o root -g root runner-docker.conf /etc/systemd/user/docker.service.d/noteprep.conf
    systemd-tmpfiles --create /etc/tmpfiles.d/noteprep-runner.conf
    systemctl daemon-reload
    systemctl restart user@$(id -u noteprep-runner).service     # or reboot, so cgroup delegation takes effect
    ```
15. Confirm where `dockerd-rootless.sh` is installed (`command -v dockerd-rootless.sh`); `runner-docker.conf` expects `/usr/bin/dockerd-rootless.sh`. Fix the path in the installed drop-in if it differs. The repo file already uses `--group 0` (verified 2026-10-20; with `--group noteprep-runner` the socket group shows `UNKNOWN`).
16. Install and start the runner's rootless daemon (the account has no login shell; use one of these):
    ```sh
    machinectl shell noteprep-runner@ /bin/sh
    #   or: sudo -u noteprep-runner env XDG_RUNTIME_DIR=/run/user/$(id -u noteprep-runner) /bin/sh
    dockerd-rootless-setuptool.sh install
    systemctl --user enable --now docker
    exit
    ```
    The setup tool's final readiness probe is **expected to fail** (it looks for the socket in the default place; ours is in `/run/noteprep-runner`). Check the real socket instead:
    ```sh
    stat -c '%a %U %G' /run/noteprep-runner/docker.sock
    # must be: 660 noteprep-runner noteprep-runner
    sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker info | grep -E 'rootless|Cgroup Version|WARNING'
    # must show rootless and Cgroup Version: 2, and no "No memory limit support" / "No cpu cfs quota support" warnings
    ```
17. Runner health checks (all must pass, otherwise stop):
    ```sh
    getent passwd noteprep-runner | cut -d: -f7     # /usr/sbin/nologin
    sudo -l -U noteprep-runner                      # "not allowed to run sudo"
    id noteprep-runner                              # no docker group
    getent passwd 10001                             # no output (the worker container user needs no host account)
    getent group noteprep-runner | cut -d: -f3      # write this number down: RUNNER_GID
    ```

## E. Secrets and configuration
18. Create the root-only folder and files (edit values in an editor, never on the command line):
    ```sh
    install -d -m 0750 -o root -g root /etc/noteprep
    install -m 0600 -o root -g root /dev/null /etc/noteprep/worker.env
    nano /etc/noteprep/worker.env        # contents: see below
    install -m 0644 -o root -g root /dev/null /etc/noteprep/worker.image
    nano /etc/noteprep/worker.image      # WORKER_IMAGE=<worker_ref>   RUNNER_GID=<number from step 17>
    ```
    `worker.env` (from `deploy/host/worker.env.example`; fill in real values):
    ```
    NODE_ENV=production
    COMPILER=docker
    LATEX_IMAGE=<latex_ref>
    WORKER_DATABASE_URL=<connection string for worker_login>
    OBJECT_STORE=supabase
    SUPABASE_URL=<https://project-ref.supabase.co>
    SUPABASE_SECRET_KEY=<supabase secret key>
    LLM_PROVIDER=fake
    LESSON_PROSE=template
    WORKER_ID=staging-1
    ```
19. Check the permissions and that the runner cannot read them:
    ```sh
    stat -c '%a %U %G' /etc/noteprep /etc/noteprep/worker.env     # 750 root root, then 600 root root
    sudo -u noteprep-runner cat /etc/noteprep/worker.env           # Permission denied
    sudo -u noteprep-runner ls /etc/noteprep                       # Permission denied
    ```
    Editing `worker.env` later has **no effect until the service restarts** (the file is read at container start).

## F. Pull the images (by digest only)
20. As root, with the read-only token (typed with hidden input), then log out at once:
    ```sh
    read -rs GHCR_TOKEN && echo
    printf %s "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
    unset GHCR_TOKEN
    docker pull <worker_ref>
    docker pull <hosttest_ref>
    docker pull <latex_ref>
    docker logout ghcr.io
    docker image inspect --format '{{.RepoDigests}}' <worker_ref> <hosttest_ref> <latex_ref>   # must contain the same sha256 values
    ```
21. Give the LaTeX image to the runner's daemon (the runner holds no registry credentials):
    ```sh
    # option A
    docker save <latex_ref> | sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker load
    sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker image inspect --format '{{.Id}}' <latex_ref>
    # option B (LaTeX image package made public): sudo -u noteprep-runner env DOCKER_HOST=... docker pull <latex_ref>
    ```
    The sandbox runs with `--pull never`, so if the image cannot be resolved by digest here, the first compile fails. That is the UNVERIFIED part of option A.
22. Confirm the runner's home holds no credentials:
    ```sh
    find /home/noteprep-runner -path /home/noteprep-runner/.local/share/docker -prune -o -name config.json -print    # no output
    ```

## G. Gate: the host sandbox tests (blocks go-live; no workarounds)
23. ```sh
    RUNNER_GID=$(getent group noteprep-runner | cut -d: -f3)
    docker run --rm --init --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
      --tmpfs /run/noteprep:rw,noexec,nosuid,nodev,size=1m,uid=10001,gid=10001 \
      --user 10001:10001 --group-add "$RUNNER_GID" \
      --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 256 --memory 1g --memory-swap 1g --cpus 1 --pull never \
      --mount type=bind,source=/run/noteprep-runner,target=/run/noteprep-runner,readonly \
      -e HOST_SANDBOX_STRICT=1 -e LATEX_IMAGE=<latex_ref> \
      <hosttest_ref>
    ```
    Expected: all tests pass (41 on 2026-10-20, about 10 minutes), exit code 0. Do not loosen the sandbox, run as root, or skip a test to make it pass. A failure on a 512 MB host is memory, not sandbox settings.
    Reverse check: the same command with `-e LATEX_IMAGE=noteprep-latex:dev` must fail immediately with "pinned by digest".

## H. Network protection
24. Block the metadata endpoint and container-to-host SSH (both were reachable on DigitalOcean until this was added):
    ```sh
    cd ~/host
    install -m 0644 -o root -g root noteprep-block-metadata.service /etc/systemd/system/noteprep-block-metadata.service
    systemctl daemon-reload && systemctl enable --now noteprep-block-metadata
    iptables -L DOCKER-USER -v -n --line-numbers   # one DROP to 169.254.169.254
    iptables -L INPUT -v -n --line-numbers         # a docker0 tcp dpt:22 DROP (the "in" column must say docker0, not *)
    ```
25. Nothing but SSH should listen on the host: `ss -ltnp | grep -E '172\.17\.0\.1|0\.0\.0\.0:|\*:|\[::\]:'`.

## I. Start the worker
26. ```sh
    cd ~/host
    install -m 0644 -o root -g root noteprep-worker.service /etc/systemd/system/noteprep-worker.service
    systemctl daemon-reload
    systemctl enable --now noteprep-worker
    systemctl status noteprep-worker --no-pager
    journalctl -u noteprep-worker -n 30 --no-pager
    ```
    Expected log line `worker_started` with `"compiler":"docker-latex"` and `"store":"supabase"` (and `"llm":"fake"`, `"prose":"template"`). The unit refuses to start unless `WORKER_IMAGE` is `name@sha256:<64 hex>`.
27. Inspect the running container:
    ```sh
    docker inspect -f '{{json .Mounts}} {{.HostConfig.NetworkMode}} {{.HostConfig.PidMode}} {{.HostConfig.Privileged}} {{.HostConfig.CapDrop}}' noteprep-worker
    #   only /run/noteprep-runner, read-only; default bridge; Privileged=false; CapDrop=[ALL]
    docker exec noteprep-worker ls /var/run/docker.sock     # must fail
    docker exec noteprep-worker id                          # uid=10001 gid=10001, with RUNNER_GID among the groups
    docker exec noteprep-worker node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('REACHABLE',r.status)).catch(()=>console.log('blocked'))"   # blocked
    ```
28. Record the first release line:
    ```sh
    printf '%s old_worker=none new_worker=%s old_latex=none new_latex=%s\n' "$(date -u +%FT%TZ)" "<worker_ref>" "<latex_ref>" >> /etc/noteprep/releases.log
    ```

## J. Prove it works end to end **[you]**
29. From your dev machine, with a throwaway staging user (each run uses one of its free generations): `pnpm exec playwright install chromium`, then `read -rs SMOKE_PASSWORD; export SMOKE_PASSWORD; SMOKE_TARGET=staging SMOKE_BASE_URL=https://noteprep.app SMOKE_EMAIL=<throwaway user> pnpm smoke:staging; unset SMOKE_PASSWORD`. Expect Notes, Worksheet and Solutions all `ok`. Open one PDF and check the header shows the topic title (that proves the worker has the current template).
30. Drills (record dates and results in runbook section 12): restart during a running job (`systemctl restart noteprep-worker`: the job still succeeds and the account's allowance is used once); restart the runner daemon (`systemctl --user -M noteprep-runner@ restart docker`, then smoke again); **full reboot with no manual steps** (the runner daemon, `/run/noteprep-runner` and the worker unit all come back, the socket stat is unchanged, smoke passes); one rollback (below).

## K. Afterwards
31. **Updating the worker** (no automatic updates exist): publish new images, pull them by digest (steps 20 to 22), re-run the host sandbox tests with the new `<hosttest_ref>` and `<latex_ref>` (step 23), edit `LATEX_IMAGE` in `worker.env` and `WORKER_IMAGE` in `worker.image`, `systemctl restart noteprep-worker`, confirm `worker_started`, append to `releases.log`. Run database migrations first and keep them backward compatible.
32. **Rollback:** put the previous digests from the last line of `releases.log` back into both files, restart, confirm `worker_started`. Do not delete old images until the new version is proven.
33. **Rotating a secret:** change it at the provider, edit `worker.env`, **restart the service**, then revoke the old value.
34. **Watch for a stalled worker** (no alerting exists): a job stuck at "Curriculum and settings checked" means nothing is claiming jobs. Check `systemctl status noteprep-worker` and `journalctl -u noteprep-worker`. A read-only query for the oldest queued job helps: `SELECT min(created_at) FROM generation_job WHERE state = 'queued';`.
35. **Snapshots** are backups, not the way to get a working host. After kernel updates, reboot and re-run step 23 (the sandbox shares the host kernel).

### S4b export worker (English note; export billing, behind `EXPORT_ENABLED`)
Release procedure for the export feature. Background and rollback rules: [S4 spec, "Release and rollback"](superpowers/plans/2026-10-24-s4-export-billing-spec.md).
- **Republish and update the worker BEFORE `EXPORT_ENABLED=1` anywhere.** The worker image must be built from the S4b merge commit (steps 20 to 22, then step 31). An older worker does not know `runExport`: it fails every export safely with `export_not_supported`, the reservation is released and nobody is charged, but every export attempt would fail.
- **Deploy web and worker from the same commit.** `RENDER_VERSION` and `TEMPLATE_VERSION` skew between them makes an export retry and then fail with `render_version_mismatch` (no charge). It can also appear briefly inside the deploy window while only one side is updated.
- **`worker.env` gains no required variable.** `SKELETON_COMPILER_FAIL` is a test-only switch and must never be set on a host (the worker refuses it with `COMPILER=docker` and in production anyway).
- **Optional limits.** Most are read by the web app: `EXPORTS_PER_USER_PER_HOUR`, `EXPORT_CONFIRM_ATTEMPTS_PER_USER_PER_HOUR`, `EXPORT_CONCURRENCY_PER_USER`, `EXPORT_DEADLINE_MINUTES`, `EXPORT_MAX_ATTEMPTS`, `EXPORT_MAX_QUEUED_GLOBAL`. **`EXPORT_DEADLINE_GRACE_SECONDS` is read by the WORKER** (its sweep fails an export job that stays running past its deadline plus this grace). If you change it, set it in the host's `worker.env` as well and restart the worker; the worker also parses every limit variable it sees, so an invalid value stops it at startup. The defaults are placeholders (see `src/lib/server/limits.ts`).
- **Vercel scope.** Set `FLOW_MODE=draft` and `EXPORT_ENABLED=1` ONLY on the one staging environment you intend to test. Leave the Production and Preview scopes unset (defaults: `legacy` and `0`, export off). `vercel.json` sets neither, so every deployment without them has export off.
- **Rollout order:** run migrations (forward-only, they add the `export` enum value and the export tables) -> publish both images -> update the host (step 31) -> deploy web -> enable on staging only: `FLOW_MODE=draft` and `EXPORT_ENABLED=1` -> manual check: make a draft, export it, download all three PDFs, confirm the allowance went down by exactly one, then start a second export and cancel it (no generation used).
- **Rollback:** set `EXPORT_ENABLED=0`, then get the pending-export count to zero before running an older build: `SELECT count(*) FROM "export" WHERE state = 'pending';`, plus the two drift views `export_state_drift` and `usage_bucket_drift` (both must be empty). There is **no operator cancel tool yet**. With the flag off, a pending export is settled only by the tutor (cancel works with the flag off) or by the deadline sweep after `EXPORT_DEADLINE_MINUTES` (plus the grace). **Do not edit rows with raw SQL:** a deferred consistency trigger requires the export, its job, its reservation and the bucket counters to be settled together, and a partial edit makes the transaction fail or leaves drift. Running an older build with a pending export stalls the sweep for every job. This gap and its follow-up are listed in the spec's Known limits.

### S5 page format and manifest v3 (English note; deploy order)
- **Deploy order for S5: worker BEFORE web.** The new web app can offer A4; an old worker does not know the page format and fails an a4 export as `snapshot_invalid` (the reservation is released, nobody is charged). In a mixed deploy, after 3 such failures the same a4 export key is refused for 24 hours (failure memo, still no charge); letter exports are unaffected.
- **The S5-1 manifest reader must be deployed (web and worker) before any v3 manifest is written.** A web build older than S5-1 cannot read a v3 manifest, so the downloads of that export stay hidden until web is rolled forward again. Ship S5-1 first, then the v3 writer (S5-4).

### S5-6 retired export state (English note; migration and rollback)
- **Migrations `20261024110000_export_retired` and `20261024120000_lesson_delete_one_way`** run with the normal migration step, before the web build that knows `retired` (`pnpm db:migrate:deploy`). It is reversible and additive: it replaces two CHECKs on `export` (state text, no enum change), three functions, the `export_state_drift` view and adds one deferred trigger on `lesson`; the second adds one BEFORE UPDATE trigger on `lesson` that makes `deleted_at` final (no un-delete). No new grants.
- **Nothing in the app calls `deleteLesson` yet** (no UI until Phase 3), so no export is retired on a deployed system until that ships. The status page already shows "This lesson was deleted." for a retired export.
- **Rollback caveat.** Roll back `lesson_delete_one_way` first (its `down.sql` only drops the trigger and function, any time). The documented down script for retired is `prisma/migrations/20261024110000_export_retired/down.sql` (run by hand with the migration role, `psql -v ON_ERROR_STOP=1 -1 -f ...`, then delete its row from `_prisma_migrations`). It refuses while any `retired` export exists; in that case roll forward, do not edit rows. Deploy the previous web build first: an older build cannot display a retired export.
- Check after migrating: `SELECT count(*) FROM export_state_drift;` must be 0.

### S5-7 orphan object reconciler (English note; optional, off by default)
- **What it does.** An independent loop of the worker (its own timer, not a step of the sweep, so a slow or hung storage call cannot delay lease recovery, export deadlines, draft purge or the liveness file). Each pass has a wall-clock budget (`RECONCILE_STEP_BUDGET_SECONDS`) and a cap of 200 deletes; when the budget passes, no further storage call or delete starts, one error is logged (`reconcile_budget_exceeded`) and the next pass is skipped while a stuck call is still in flight. Shutdown waits for an in-flight pass at most 5 seconds. For lessons that are not deleted, have no queued or running job and no job activity inside `RECONCILE_GRACE_SECONDS`, it lists `<owner>/<lesson>/` in the private bucket and deletes (a) a revision folder when no `lesson_revision` row of that lesson has that id and (b) an attempt folder inside an existing revision when no manifest (v1 list, v2, v3) names a path under it. It re-reads the database before every delete, refuses (in code) any prefix a manifest references, writes no database rows and never touches allowance. Objects of deleted lessons are not cleaned yet. Its logs hold counts and lesson ids only.
- **Enable per environment:** add `RECONCILE_ENABLED=1` to `worker.env` and `systemctl restart noteprep-worker`; confirm `worker_started` shows `reconcile: true`. Optional: `RECONCILE_BATCH_LESSONS` (20), `RECONCILE_INTERVAL_SECONDS` (300), `RECONCILE_STEP_BUDGET_SECONDS` (60; 5-600), `RECONCILE_GRACE_SECONDS` (1800; with the reconciler on, the worker refuses to start if it is below `LEASE_SECONDS` + `EXPORT_DEADLINE_GRACE_SECONDS` + 60). Placeholders, not product rules.
- **Database role:** `worker_runtime` already has SELECT on `lesson`, `lesson_revision` and `generation_job`; no migration is needed. It needs the Storage secret key it already holds for uploads (list and remove).
- **Not verified against a live Supabase project:** the list call follows the pinned `@supabase/storage-js` 2.118.0 typings (one level, offset pagination, folders have no id). Rehearse on staging first: make an export, put a stray object under a random uuid folder of that lesson (Storage dashboard), wait one interval, and confirm only the stray is gone and the PDFs still download. Switch it off again with `RECONCILE_ENABLED=0` and a restart.

### S5-8 artifact recovery (English note; operator script, no database writes)
- **When:** a published export's stored PDF or source is missing or damaged (a bucket mishap, a partial restore). The command rebuilds it from the frozen snapshot and writes back ONLY to the manifest's own paths. It never writes a database row (no billing, job, revision or export change) and adds no job kind.
- **Run it on the worker host, as the operator, inside the running worker container** (same pinned `LATEX_IMAGE`, same environment, same sandbox runner socket; it needs nothing new). Dry run first (does every check including the recompile, writes nothing):
  ```sh
  docker exec noteprep-worker node --conditions=react-server --enable-source-maps /app/dist/worker/recover.mjs --revision <revision-uuid> --check
  docker exec noteprep-worker node --conditions=react-server --enable-source-maps /app/dist/worker/recover.mjs --revision <revision-uuid>
  ```
  The revision id is `lesson_revision.id` of the export (`SELECT revision_id FROM "export" WHERE id = '<export-uuid>';`, read only). Only a strict uuid is accepted; there is no shell and no other option. The worker image must be built from the S5-8 commit; the host's `releases.log` and step 31 apply.
- **Exit codes and log events:** 0 and `recover_done` with `status` `intact`, `restored`, or (with `--check`) `would_restore`; 1 and `recover_refused` with a `code`; 2 for bad arguments, an invalid worker configuration (a short `recover_usage` line, no stack, no value), or `COMPILER` not `docker`. Logs carry ids and codes only.
- **It refuses (and writes nothing) when:** the running `LATEX_IMAGE` differs from the image recorded in the manifest (`image_mismatch`; run it from a host that pins the manifest's image, which is why old images are not deleted at once), the compile profile differs (`profile_mismatch`), the render or template version differs from this worker (`render_*`), the rebuilt source does not equal both the snapshot's and the manifest's hash (`tex_mismatch`), the recompiled PDF is not byte-identical to the manifest's hash, size and page count (`recompile_not_identical`), the revision is not an export revision (manifest v1 or v2: `not_export_revision`), the lesson is deleted or its export is retired (`lesson_deleted`, `export_retired`), the export is not `succeeded`, the snapshot is missing, or the export, revision metadata and snapshot do not name each other (`export_not_succeeded`, `snapshot_missing`, `export_mismatch`, `export_ambiguous` for more than one export row), a manifest whose paths are not this revision's own with a uuid attempt segment (`manifest_invalid`). If the lesson is deleted while the files are being written, the command deletes exactly the files it wrote and exits 1 with `lesson_deleted_during_recovery` (`cleanup_failed_after_lesson_deleted` if that cleanup itself failed: run the lesson deletion path again). A manifest that records no image (written before images were recorded) is accepted without an image check; the byte-identical rule still applies.
- **Older exports (a different image or version).** The run refuses with `image_mismatch` when `LATEX_IMAGE` is not the image the export was compiled with. Look it up (read only):
  ```sql
  SELECT artifact_manifest -> 'compile' ->> 'image' AS image, artifact_manifest ->> 'renderVersion' AS render_version, artifact_manifest ->> 'templateVersion' AS template_version
    FROM lesson_revision WHERE id = '<revision-uuid>';
  ```
  Then run it with that image: `docker exec -e LATEX_IMAGE=<manifest image ref> noteprep-worker node --conditions=react-server --enable-source-maps /app/dist/worker/recover.mjs --revision <revision-uuid> --check`. The image must still exist in the runner's rootless daemon (the sandbox uses `--pull never`, so a missing image fails instead of being downloaded): check with `docker --host <runner socket> image ls` and keep old images until their exports no longer need recovery. If the manifest's `renderVersion` or `templateVersion` differs from the running worker (`render_*` refusal), the current worker cannot rebuild the same source: start a one-off container from the OLD worker image (the one built from the commit that wrote the export) with the full worker environment (same env file, same runner socket, `-e LATEX_IMAGE=<manifest image ref>`) and run the same command in it, then remove the container. Never edit the manifest or force a recovery; a refusal means the rebuild would not be identical.
- **Audit trail.** Every recovery attempt that is not a dry run is recorded by the operator: one line per attempt (revision id, UTC date, status such as `restored` or the refusal code, operator) appended to `/etc/noteprep/releases.log` style host log or the runbook log. The command itself writes no database row.
- **Not verified:** that two different hosts always produce identical PDFs (risk R3 of the S5 plan; a refusal with `recompile_not_identical` is the safe outcome) and the Supabase Storage adapter under this command (only the local-disk store was exercised in tests). In particular the take-back after `lesson_deleted_during_recovery` uses `deletePrefix(<file path>)`, which removes a single file on the local store but is NOT verified to remove a single object on Supabase Storage (its list-then-remove may treat a file path as an empty folder); after such a refusal on Supabase, confirm in the Storage dashboard that no file of that revision remains.

## Known gaps (recorded, not fixed)
- No gVisor; the sandbox shares the host kernel.
- The runner account has no outbound firewall; a compromised runner daemon could reach the network through rootless networking.
- A host root user can read the worker's secrets through `docker inspect`; only administrators have host access.
- No image signing or provenance attestation; no alerting system.
