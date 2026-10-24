# Update the worker host after publishing new images

Run this every time the **Publish images** workflow produces new images. It replaces steps 20 to 23, 26 and 28 of [fresh-droplet-setup.md](fresh-droplet-setup.md) (section K, step 31) with one paste. The host must already be set up (runner account, rootless daemon, `/etc/noteprep/worker.env`, `/etc/noteprep/worker.image`, `noteprep-worker.service`).

**Status: written but never run on a real host.** Treat the first run as a rehearsal and write down what differs. A failed run changes nothing until the "switch" step, and the rollback block below restores the previous release.

## Before you start
1. Run database migrations first (**Database migrations** workflow) if the release has any. Keep migrations backward compatible.
2. The LaTeX image package (`noteprep-latex`) must be **public** on GitHub (Packages, Package settings, Change visibility). The runner pulls it with no credentials. `docker save | docker load` does not work: it loads the image by ID only, and the worker needs the digest name (failed on a real host, 2026-10-24). The worker and hosttest packages stay private.
3. Have a GitHub token with only `read:packages`. The block asks for it with hidden input and logs out afterwards. It is skipped when both private images are already on the host.
4. Deploy order for web and worker follows the notes in [fresh-droplet-setup.md](fresh-droplet-setup.md) section K (for S5: worker before web).

## Step 1: paste the three digests
The **Publish images** run prints them in its Summary as a ready-to-paste block (open the run, scroll to Summary, copy the whole block). It looks like this:

```bash
export WORKER_REF='ghcr.io/<owner>/noteprep-worker@sha256:<64 hex>'
export LATEX_REF='ghcr.io/<owner>/noteprep-latex@sha256:<64 hex>'
export HOSTTEST_REF='ghcr.io/<owner>/noteprep-hosttest@sha256:<64 hex>'
```

SSH to the host as root and paste it. Nothing else is needed from the build output.

## Step 2: paste the update block
It stops at the first failure. Everything runs inside one `( ... )` so a failure never closes your SSH session. The sandbox tests take about 10 minutes, and the restart can take up to 3 minutes while a running job finishes.

```bash
(
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[[ "${WORKER_REF:-}" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-worker@sha256:[0-9a-f]{64}$ ]] || { echo "WORKER_REF missing or malformed" >&2; exit 1; }
[[ "${LATEX_REF:-}" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-latex@sha256:[0-9a-f]{64}$ ]] || { echo "LATEX_REF missing or malformed" >&2; exit 1; }
[[ "${HOSTTEST_REF:-}" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-hosttest@sha256:[0-9a-f]{64}$ ]] || { echo "HOSTTEST_REF missing or malformed" >&2; exit 1; }
IMG=/etc/noteprep/worker.image; ENVF=/etc/noteprep/worker.env; LOG=/etc/noteprep/releases.log
[ -f "$IMG" ] && [ -f "$ENVF" ] || { echo "$IMG and $ENVF must exist (fresh-droplet-setup.md section E)" >&2; exit 1; }
rdocker() { sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker "$@"; }
getkey() { [ "$(grep -c "^$2=" "$1")" = 1 ] || { echo "$1 must contain exactly one $2= line" >&2; return 1; }; sed -n "s/^$2=//p" "$1"; }
setkey() { [ "$(grep -c "^$2=" "$1")" = 1 ] || { echo "$1 must contain exactly one $2= line" >&2; return 1; }; sed -i "s|^$2=.*|$2=$3|" "$1"; }
OLD_WORKER=$(getkey "$IMG" WORKER_IMAGE); OLD_LATEX=$(getkey "$ENVF" LATEX_IMAGE)
if [ "$OLD_WORKER" = "$WORKER_REF" ] && [ "$OLD_LATEX" = "$LATEX_REF" ]; then
  echo "Already on these digests. Service state: $(systemctl is-active noteprep-worker || true)"; exit 0
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
for r in "$WORKER_REF" "$HOSTTEST_REF"; do docker image inspect --format '{{join .RepoDigests "\n"}}' "$r" | grep -Fxq "$r" || { echo "digest mismatch for $r" >&2; exit 1; }; done
rdocker image inspect --format '{{join .RepoDigests "\n"}}' "$LATEX_REF" | grep -Fxq "$LATEX_REF" || { echo "digest mismatch for the runner's LaTeX image" >&2; exit 1; }
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
cp -p "$IMG" "$IMG.prev"
setkey "$IMG" WORKER_IMAGE "$WORKER_REF"; setkey "$ENVF" LATEX_IMAGE "$LATEX_REF"
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart noteprep-worker
ok=0
for _ in $(seq 1 100); do
  journalctl -u noteprep-worker --since "$since" --no-pager | grep -q worker_started && { ok=1; break; }; sleep 3
done
if [ "$ok" != 1 ]; then
  journalctl -u noteprep-worker -n 30 --no-pager >&2
  echo "worker_started not seen. The new digests are in place; run the rollback block to restore the previous release." >&2; exit 1
fi
journalctl -u noteprep-worker --since "$since" --no-pager | grep worker_started | tail -n 1
printf '%s old_worker=%s new_worker=%s old_latex=%s new_latex=%s\n' "$(date -u +%FT%TZ)" "$OLD_WORKER" "$WORKER_REF" "$OLD_LATEX" "$LATEX_REF" >> "$LOG"
echo "Updated. Release line appended to $LOG."
)
```

Check the printed `worker_started` line: it should show `"compiler":"docker-latex"` and `"store":"supabase"`. Old images are never deleted.

## Rollback
Restores the digests from the last line of `releases.log` (the previous release). It refuses if that line is itself a rollback. It does not touch the database; follow the rollback notes in [fresh-droplet-setup.md](fresh-droplet-setup.md) section K when a release also changed data.

```bash
(
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
IMG=/etc/noteprep/worker.image; ENVF=/etc/noteprep/worker.env; LOG=/etc/noteprep/releases.log
setkey() { [ "$(grep -c "^$2=" "$1")" = 1 ] || { echo "$1 must contain exactly one $2= line" >&2; return 1; }; sed -i "s|^$2=.*|$2=$3|" "$1"; }
last=$(tail -n 1 "$LOG")
case "$last" in *" rollback "*|*" rollback") echo "the last release line is already a rollback; stop and look at it by hand" >&2; exit 1;; esac
BAD_WORKER=$(sed -n 's/.* new_worker=\([^ ]*\).*/\1/p' <<<"$last"); BAD_LATEX=$(sed -n 's/.* new_latex=\([^ ]*\).*/\1/p' <<<"$last")
PREV_WORKER=$(sed -n 's/.* old_worker=\([^ ]*\).*/\1/p' <<<"$last"); PREV_LATEX=$(sed -n 's/.* old_latex=\([^ ]*\).*/\1/p' <<<"$last")
[[ "$PREV_WORKER" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-worker@sha256:[0-9a-f]{64}$ ]] || { echo "no usable previous worker digest in the last line: $last" >&2; exit 1; }
[[ "$PREV_LATEX" =~ ^ghcr\.io/[a-z0-9._-]+/noteprep-latex@sha256:[0-9a-f]{64}$ ]] || { echo "no usable previous LaTeX digest in the last line: $last" >&2; exit 1; }
docker image inspect "$PREV_WORKER" >/dev/null || { echo "previous worker image is no longer on the host" >&2; exit 1; }
sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker image inspect "$PREV_LATEX" >/dev/null || { echo "previous LaTeX image is no longer in the runner" >&2; exit 1; }
setkey "$IMG" WORKER_IMAGE "$PREV_WORKER"; setkey "$ENVF" LATEX_IMAGE "$PREV_LATEX"
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart noteprep-worker
ok=0
for _ in $(seq 1 100); do
  journalctl -u noteprep-worker --since "$since" --no-pager | grep -q worker_started && { ok=1; break; }; sleep 3
done
[ "$ok" = 1 ] || { journalctl -u noteprep-worker -n 30 --no-pager >&2; echo "worker_started not seen after rollback" >&2; exit 1; }
journalctl -u noteprep-worker --since "$since" --no-pager | grep worker_started | tail -n 1
printf '%s rollback old_worker=%s new_worker=%s old_latex=%s new_latex=%s\n' "$(date -u +%FT%TZ)" "$BAD_WORKER" "$PREV_WORKER" "$BAD_LATEX" "$PREV_LATEX" >> "$LOG"
echo "Rolled back. Release line appended to $LOG."
)
```

## What the block does and does not do
- It validates the three references (exact form `ghcr.io/<owner>/noteprep-<name>@sha256:<64 hex>`), so a bad paste changes nothing.
- It is safe to run again: with the same digests it prints "Already on these digests" and exits; with new digests, pulling and writing the same values has no further effect.
- It never edits `worker.env` beyond the single `LATEX_IMAGE=` line, never prints it, and never writes a secret to a log. The token is typed on the terminal, passed on stdin, and the registry login is removed afterwards.
- It never deletes images, never changes the sandbox settings, and never skips the host sandbox tests.
- Not covered: database migrations, the web deploy, flag changes, and the checks in the release notes of [fresh-droplet-setup.md](fresh-droplet-setup.md) section K.
