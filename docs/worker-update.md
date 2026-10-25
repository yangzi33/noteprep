# Update the worker host after publishing new images

Run this every time the **Publish images** workflow produces new images. It replaces steps 20 to 23, the digest edits of step 31 and the release line of step 28 of [fresh-droplet-setup.md](fresh-droplet-setup.md) with one paste. The host must already be set up (runner account, rootless daemon, `/etc/noteprep/worker.env`, `/etc/noteprep/worker.image`, `noteprep-worker.service`).

**Status: written but never run on a real host.** Treat the first run as a rehearsal and write down what differs. The update block changes nothing until its "switch" step. If the new release does not come up healthy, the block puts the previous digests back itself and restarts.

## Before you start
1. Run database migrations first (**Database migrations** workflow) if the release has any. Keep migrations backward compatible.
2. The LaTeX image package (`noteprep-latex`) must be **public** on GitHub (Packages, Package settings, Change visibility). The runner pulls it with no credentials. `docker save | docker load` does not work: it loads the image by ID only, and the worker needs the digest name (failed on a real host, 2026-10-24). The worker and hosttest packages stay private.
3. Have a GitHub token with only `read:packages`. The block asks for it with hidden input and logs out afterwards. It is skipped when both private images are already on the host.
4. Deploy order for web and worker follows the notes in [fresh-droplet-setup.md](fresh-droplet-setup.md) section K (for S5: worker before web).
5. Do not run with `set -x` active in your shell. The blocks turn it off, but do not rely on that alone.

## Step 1: paste the three digests
The **Publish images** run prints them in its Summary as a ready-to-paste block (open the run, scroll to Summary, copy the whole block). It looks like this:

```bash
export WORKER_REF='ghcr.io/<owner>/noteprep-worker@sha256:<64 hex>'
export LATEX_REF='ghcr.io/<owner>/noteprep-latex@sha256:<64 hex>'
export HOSTTEST_REF='ghcr.io/<owner>/noteprep-hosttest@sha256:<64 hex>'
```

SSH to the host as root and paste it. Nothing else is needed from the build output.

## Step 2: paste the update block
It stops at the first failure. Everything runs inside one `( ... )` so a failure never closes your SSH session. The sandbox tests take about 10 minutes. The restart can take up to 3 minutes while a running job finishes, and a healthy start is then watched for about 15 more seconds.

```bash
(
set +x
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
RE='@sha256:[0-9a-f]{64}$'
[[ "${WORKER_REF:-}" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-worker$RE ]] || { echo "WORKER_REF missing or malformed" >&2; exit 1; }
[[ "${LATEX_REF:-}" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-latex$RE ]] || { echo "LATEX_REF missing or malformed" >&2; exit 1; }
[[ "${HOSTTEST_REF:-}" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-hosttest$RE ]] || { echo "HOSTTEST_REF missing or malformed" >&2; exit 1; }
IMG=/etc/noteprep/worker.image; ENVF=/etc/noteprep/worker.env; LOG=/etc/noteprep/releases.log
[ -f "$IMG" ] && [ -f "$ENVF" ] || { echo "$IMG and $ENVF must exist (fresh-droplet-setup.md section E)" >&2; exit 1; }
rdocker() { sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker "$@"; }
getkey() { [ "$(grep -c "^$2=" "$1")" = 1 ] || { echo "$1 must contain exactly one $2= line" >&2; return 1; }; sed -n "s/^$2=//p" "$1"; }
setkey() { [ "$(grep -c "^$2=" "$1")" = 1 ] || { echo "$1 must contain exactly one $2= line" >&2; return 1; }; sed -i "s|^$2=.*|$2=$3|" "$1"; }
healthy() { local out; out=$(journalctl -u noteprep-worker --since "$1" --no-pager 2>&1 || true)
  grep worker_started <<<"$out" | grep '"compiler":"docker-latex"' >/dev/null || return 1
  ! grep worker_fatal <<<"$out" >/dev/null; }
wait_healthy() { local i; for i in $(seq 1 100); do
    if healthy "$1"; then sleep 15; healthy "$1" && systemctl is-active --quiet noteprep-worker && return 0; return 1; fi
    sleep 3; done; return 1; }
OLD_WORKER=$(getkey "$IMG" WORKER_IMAGE); OLD_LATEX=$(getkey "$ENVF" LATEX_IMAGE)
last=$(tail -n 1 "$LOG" 2>/dev/null || true)
LAST_W=$(sed -n 's/.* new_worker=\([^ ]*\).*/\1/p' <<<"$last"); LAST_L=$(sed -n 's/.* new_latex=\([^ ]*\).*/\1/p' <<<"$last")
if [ "$OLD_WORKER" = "$WORKER_REF" ] && [ "$OLD_LATEX" = "$LATEX_REF" ]; then
  if [ "$LAST_W" = "$WORKER_REF" ] && [ "$LAST_L" = "$LATEX_REF" ]; then
    echo "Already on these digests (the last release line matches). Service state: $(systemctl is-active noteprep-worker || true)"; exit 0
  fi
  echo "The files already hold these digests but no release line confirms them; continuing to verify and log."
  [[ "$LAST_W" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-worker$RE ]] && OLD_WORKER=$LAST_W
  [[ "$LAST_L" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-latex$RE ]] && OLD_LATEX=$LAST_L
fi
echo "== pull =="
if ! docker image inspect "$WORKER_REF" "$HOSTTEST_REF" >/dev/null 2>&1; then
  owner=${WORKER_REF#ghcr.io/}; owner=${owner%%/*}
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  read -rp "GitHub user [$owner]: " ghuser </dev/tty; ghuser=${ghuser:-$owner}
  printf 'GitHub token (read:packages, hidden): ' >&2; IFS= read -rs GHCR_TOKEN </dev/tty; echo >&2
  printf %s "$GHCR_TOKEN" | docker login ghcr.io -u "$ghuser" --password-stdin; unset GHCR_TOKEN
  docker pull "$WORKER_REF"; docker pull "$HOSTTEST_REF"
  docker logout ghcr.io >/dev/null 2>&1 || true
fi
rdocker pull "$LATEX_REF" || { echo "runner could not pull the LaTeX image: is the noteprep-latex package public?" >&2; exit 1; }
for r in "$WORKER_REF" "$HOSTTEST_REF"; do docker image inspect --format '{{join .RepoDigests "\n"}}' "$r" | grep -Fxq "$r" || { echo "$r is not on the host under that digest" >&2; exit 1; }; done
rdocker image inspect --format '{{join .RepoDigests "\n"}}' "$LATEX_REF" | grep -Fxq "$LATEX_REF" || { echo "the runner's LaTeX image is not there under that digest" >&2; exit 1; }
echo "== host sandbox tests (about 10 minutes; a failure stops the update) =="
RUNNER_GID=$(getent group noteprep-runner | cut -d: -f3)
docker run --rm --init --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --tmpfs /run/noteprep:rw,noexec,nosuid,nodev,size=1m,uid=10001,gid=10001 \
  --user 10001:10001 --group-add "$RUNNER_GID" \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 256 --memory 1g --memory-swap 1g --cpus 1 --pull never \
  --mount type=bind,source=/run/noteprep-runner,target=/run/noteprep-runner,readonly \
  -e HOST_SANDBOX_STRICT=1 -e LATEX_IMAGE="$LATEX_REF" \
  "$HOSTTEST_REF"
echo "== switch =="
if ! { setkey "$IMG" WORKER_IMAGE "$WORKER_REF" && setkey "$ENVF" LATEX_IMAGE "$LATEX_REF"; }; then
  setkey "$IMG" WORKER_IMAGE "$OLD_WORKER" || true; setkey "$ENVF" LATEX_IMAGE "$OLD_LATEX" || true
  echo "could not write both files; the previous digests were put back, nothing was restarted" >&2; exit 1
fi
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart noteprep-worker
if ! wait_healthy "$since"; then
  journalctl -u noteprep-worker --since "$since" -n 30 --no-pager >&2 || true
  echo "The new release did not start cleanly. Putting the previous digests back and restarting." >&2
  setkey "$IMG" WORKER_IMAGE "$OLD_WORKER"; setkey "$ENVF" LATEX_IMAGE "$OLD_LATEX"
  since=$(date '+%Y-%m-%d %H:%M:%S'); systemctl restart noteprep-worker
  if wait_healthy "$since"; then echo "The previous release is running again. No release line was written." >&2
  else echo "The previous release did not start cleanly either. Read: journalctl -u noteprep-worker. Previous digests: $OLD_WORKER $OLD_LATEX" >&2; fi
  exit 1
fi
journalctl -u noteprep-worker --since "$since" --no-pager | grep worker_started | tail -n 1
printf '%s old_worker=%s new_worker=%s old_latex=%s new_latex=%s\n' "$(date -u +%FT%TZ)" "$OLD_WORKER" "$WORKER_REF" "$OLD_LATEX" "$LATEX_REF" >> "$LOG"
echo "Updated. Release line appended to $LOG."
)
```

"Healthy" means: a `worker_started` line with `"compiler":"docker-latex"`, no `worker_fatal` since the restart, the unit active, and still so 15 seconds later. It does not prove a job compiles: run `pnpm smoke:staging` (or the smoke steps in fresh-droplet-setup.md step 29) afterwards. Old images are never deleted.

## Rollback
Use it when a release that logged as updated turns out bad later. It goes back to the release before it (the `old_` values of the last line of `releases.log`) and refuses unless the host currently runs the `new_` values of that line, so it cannot restore the wrong release. It does not touch the database; follow the rollback notes in [fresh-droplet-setup.md](fresh-droplet-setup.md) section K when a release also changed data. The previous images must still be on the host (they are never deleted).

```bash
(
set +x
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
RE='@sha256:[0-9a-f]{64}$'
IMG=/etc/noteprep/worker.image; ENVF=/etc/noteprep/worker.env; LOG=/etc/noteprep/releases.log
getkey() { [ "$(grep -c "^$2=" "$1")" = 1 ] || { echo "$1 must contain exactly one $2= line" >&2; return 1; }; sed -n "s/^$2=//p" "$1"; }
setkey() { [ "$(grep -c "^$2=" "$1")" = 1 ] || { echo "$1 must contain exactly one $2= line" >&2; return 1; }; sed -i "s|^$2=.*|$2=$3|" "$1"; }
healthy() { local out; out=$(journalctl -u noteprep-worker --since "$1" --no-pager 2>&1 || true)
  grep worker_started <<<"$out" | grep '"compiler":"docker-latex"' >/dev/null || return 1
  ! grep worker_fatal <<<"$out" >/dev/null; }
wait_healthy() { local i; for i in $(seq 1 100); do
    if healthy "$1"; then sleep 15; healthy "$1" && systemctl is-active --quiet noteprep-worker && return 0; return 1; fi
    sleep 3; done; return 1; }
last=$(tail -n 1 "$LOG")
case "$last" in *" rollback "*) echo "the last release line is already a rollback; stop and look at it by hand" >&2; exit 1;; esac
field() { sed -n "s/.* $1=\([^ ]*\).*/\1/p" <<<"$last"; }
CUR_W=$(field new_worker); CUR_L=$(field new_latex); PREV_W=$(field old_worker); PREV_L=$(field old_latex)
[ "$(getkey "$IMG" WORKER_IMAGE)" = "$CUR_W" ] && [ "$(getkey "$ENVF" LATEX_IMAGE)" = "$CUR_L" ] || { echo "the host does not run the release in the last line; compare $IMG and $ENVF with: $last" >&2; exit 1; }
[[ "$PREV_W" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-worker$RE ]] || { echo "no usable previous worker digest in the last line: $last" >&2; exit 1; }
[[ "$PREV_L" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-latex$RE ]] || { echo "no usable previous LaTeX digest in the last line: $last" >&2; exit 1; }
docker image inspect "$PREV_W" >/dev/null || { echo "previous worker image is no longer on the host" >&2; exit 1; }
sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker image inspect "$PREV_L" >/dev/null || { echo "previous LaTeX image is no longer in the runner" >&2; exit 1; }
if ! { setkey "$IMG" WORKER_IMAGE "$PREV_W" && setkey "$ENVF" LATEX_IMAGE "$PREV_L"; }; then
  setkey "$IMG" WORKER_IMAGE "$CUR_W" || true; setkey "$ENVF" LATEX_IMAGE "$CUR_L" || true
  echo "could not write both files; the current digests were put back, nothing was restarted" >&2; exit 1
fi
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart noteprep-worker
wait_healthy "$since" || { journalctl -u noteprep-worker --since "$since" -n 30 --no-pager >&2 || true; echo "the rolled-back worker did not start cleanly; the files now hold the previous digests" >&2; exit 1; }
journalctl -u noteprep-worker --since "$since" --no-pager | grep worker_started | tail -n 1
printf '%s rollback old_worker=%s new_worker=%s old_latex=%s new_latex=%s\n' "$(date -u +%FT%TZ)" "$CUR_W" "$PREV_W" "$CUR_L" "$PREV_L" >> "$LOG"
echo "Rolled back. Release line appended to $LOG."
)
```

## What the blocks do and do not do
- They validate the three references (exact form `ghcr.io/<owner>/noteprep-<name>@sha256:<64 hex>`), so a bad paste changes nothing.
- The update block is safe to run again: with the same digests and a matching last release line it prints "Already on these digests" and exits. If the files hold the digests but no release line confirms them, it goes on to verify and log.
- A release line is written only after the new worker is healthy, so the last line always describes what is running. A failed update restores the previous digests itself and leaves the log alone.
- They never edit `worker.env` beyond the single `LATEX_IMAGE=` line, never print it, and never write a secret to a log. The token is typed on the terminal, passed on stdin, and the registry login is removed afterwards.
- They never delete images, never change the sandbox settings, and never skip the host sandbox tests.
- Not covered, do these by hand: a changed `deploy/host/noteprep-worker.service` (reinstall it and run `systemctl daemon-reload`), the step 23 reverse check and the step 27 inspection of [fresh-droplet-setup.md](fresh-droplet-setup.md), database migrations, the web deploy and flag changes.
