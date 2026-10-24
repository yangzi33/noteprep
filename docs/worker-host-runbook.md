# Worker host runbook (staging)

> Related: [decisions D-52..D-56](decisions.md) · [architecture §11](architecture.md) · [staging-setup §5](staging-setup.md) · [database-roles](database-roles.md) · host files: [deploy/host/](../deploy/host/)
>
> **Marker convention**: `[verify on host]` = can only be verified on a real Linux host. This repository has no run evidence from any host; until you run it yourself on a host and record the result, every such statement is **UNVERIFIED**. The commands in this document come from reading the Docker/systemd documentation and from the repository's unit tests. **Since 2026-10-20**, part of it has been run item by item on one DigitalOcean Droplet (Ubuntu 24.04, Docker 29.9.1, 4 GB / 2 vCPU); the verified items are ticked in §12 with the date, and **anything not marked is still UNVERIFIED**. This is the record of one staging rehearsal, not a production-readiness claim.
>
> This document contains no command that creates paid resources (buying a host, a registry, DNS and so on are your decision, see D-20).

## 0. Scope

- **Staging** only. This is **not** a production-readiness claim; the items that have been run on a real host are in §12 (2026-10-20), and the rest are still UNVERIFIED.
- For the topology see D-52: the worker container (uid 10001, read-only root, no capabilities) is run by the host's rootful Docker; the LaTeX sandbox is run by a **rootless** Docker under a separate account `noteprep-runner`, whose socket is in `/run/noteprep-runner/`, and only that directory is mounted read-only into the worker container.
- **What it protects**: a compromised worker is not host root (it can only start containers as the runner); a sandbox escape lands in the runner account, which holds no secrets (under the rootless daemon there is one more user-namespace layer to cross).
- **What it does not protect** (D-52 verbatim):
  1. Shared kernel: a kernel vulnerability can go from the sandbox or the worker straight to host root (there is no gVisor).
  2. When the worker is compromised, the attacker holds all worker secrets (worker DB role, Storage secret key, LLM key), and can use the runner daemon to consume resources, tamper with the artifacts of other jobs being compiled, and send traffic out through the rootless network.
  3. An attacker who escapes into the runner can likewise tamper with the PDFs of concurrent jobs (the host only checks the format and active content) and fill the disk.
  4. The runner account has no egress firewall.
  5. Host root can see worker secrets through `docker inspect` (administrators only).

Wherever the text below writes `<worker_ref>`, `<latex_ref>` or `<hosttest_ref>`, take the value from the Step Summary of the release workflow `images.yml` (manual trigger, main only), in the form `ghcr.io/<owner>/noteprep-worker@sha256:<64 hex characters>`. Use digests only, never tags.

## 1. Host checklist (provider-independent)

- x86_64 (the images are built for linux/amd64 only).
- **At least 4 GB of memory and 2 vCPU** (measured, 2026-10-20). On a 512 MB Droplet, the kernel's global OOM killed the runner's `dockerd`, and 9 of the 41 tests in §7 failed (the real compilation failed within about 90 ms, and the concurrency and "fresh container" tests timed out). The cause is that the hosttest container (1 GB limit), the sandbox container (1 GB limit) and the two Docker daemons run at the same time. After changing to 4 GB / 2 vCPU (CPU and RAM only, disk unchanged) all 41 tests passed. `dmesg -T | grep -c global_oom` should be 0. Disk: an 8.7 GB root disk had about 3.5 GB left after pulling the three images worker, hosttest (root daemon) and LaTeX (runner daemon); image updates (§6 does not delete old images) take more, so watch the disk alert in §11.
- cgroup v2:

  ```sh
  stat -fc %T /sys/fs/cgroup        # expected: cgroup2fs
  ```

- The systemd version meets the requirements of the Docker rootless documentation of the day (the authority is <https://docs.docker.com/engine/security/rootless/>; this document does not hard-code a version number).
- **No inbound ports** (SSH for administration only; the worker polls the database). The cloud firewall denies all inbound traffic by default and allows only SSH from your administration address.
- Automatic security updates are on (for example `unattended-upgrades` on Debian/Ubuntu); after a kernel update, reboot and rerun §7 (the shared kernel is a known limitation of D-52).
- Disk usage alert threshold (80% suggested); time synchronization (`timedatectl show -p NTPSynchronized` is `yes`). Leases and the webhook tolerance depend on the clock.
- The host has no cloud instance role / metadata credentials, or the metadata endpoint is blocked (see §9).

[verify on host] every item above.

## 2. Install Docker

Install the Engine from Docker's official apt repository, and additionally install `docker-ce-rootless-extras` and `uidmap` (official steps at <https://docs.docker.com/engine/install/>; do not use the `curl | sh` convenience script). It is also recommended to install `dbus-user-session` (Docker's rootless documentation requires a user-level D-Bus) and `systemd-container` (which provides the `machinectl` used by option 1 in §3). The 2026-10-20 run only confirmed that `machinectl shell noteprep-runner@ /bin/sh` works on this host; it did **not** separately verify whether the rootless daemon fails to start without `dbus-user-session`, so "it must be installed" is still UNVERIFIED. **Do not add anyone to the `docker` group**:

```sh
getent group docker               # expected: empty member list, like docker:x:999:
```

The root daemon still exists (it runs the worker container); its socket (`/var/run/docker.sock`) is never mounted into any container.

## 3. The runner account and the rootless daemon

```sh
# run as root
useradd --system --create-home --shell /usr/sbin/nologin noteprep-runner
grep noteprep-runner /etc/subuid /etc/subgid     # if there is no entry, add one, for example:
#   echo 'noteprep-runner:200000:65536' >> /etc/subuid   (same for subgid; pick a range that avoids existing entries)
loginctl enable-linger noteprep-runner

# host files from the repository (first copy the repository's deploy/host/ to the host, for example with scp; the repository is not checked out on the host)
install -d -m 0755 -o root -g root /etc/systemd/system/user@.service.d
install -m 0644 -o root -g root user-delegate.conf /etc/systemd/system/user@.service.d/delegate.conf
install -m 0644 -o root -g root noteprep-runner.tmpfiles.conf /etc/tmpfiles.d/noteprep-runner.conf
install -d -m 0755 -o root -g root /etc/systemd/user/docker.service.d
install -m 0644 -o root -g root runner-docker.conf /etc/systemd/user/docker.service.d/noteprep.conf
systemd-tmpfiles --create /etc/tmpfiles.d/noteprep-runner.conf
systemctl daemon-reload
```

Key points:

- `runner-docker.conf` is owned by root and placed in `/etc/systemd/user/docker.service.d/`, so the expected daemon arguments are controlled by root and reviewable; **do not** put it in the runner's home directory. Note that this does **not** stop the runner from overriding its own user-level unit under `~/.config/systemd/user` (the user directory has higher priority); the runner does not gain more privileges in the threat model than it already has (see the comment at the top of `deploy/host/runner-docker.conf`).
- It applies to the `docker.service` of every user; only `noteprep-runner` is expected to run this unit.
- First restart so that cgroup delegation takes effect: `systemctl restart user@$(id -u noteprep-runner).service`, or reboot the host. [verify on host]

Install and enable the rootless daemon as the runner. The account is nologin, so **do not give it a real login shell**; use `/bin/sh` as the command only for the duration of this command. `sudo -i`/`-s` would be refused or land in nologin, and `systemctl --user` has no user bus under sudo either, so pass `XDG_RUNTIME_DIR` explicitly (linger must be enabled for `/run/user/<uid>` to exist):

```sh
# run as root. Option 1:
machinectl shell noteprep-runner@ /bin/sh
# Option 2 (without machinectl):
sudo -u noteprep-runner env XDG_RUNTIME_DIR=/run/user/$(id -u noteprep-runner) /bin/sh
# the following run inside the /bin/sh opened above; no shell is left behind after exit
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
exit
```

The readiness probe at the end of `dockerd-rootless-setuptool.sh install` checks `$XDG_RUNTIME_DIR/docker.sock`, while our drop-in moves the socket to `/run/noteprep-runner`, so its final check **will** report an error (measured 2026-10-20: `failed to connect to the docker API at unix:///run/user/999/docker.sock … no such file or directory`), but at that point the daemon is already `active (running)` and the drop-in has taken effect. This error is harmless; the authoritative checks are the `stat` and `docker info` in the next step. Also, run `systemctl --user enable --now docker` as a separate command (pasting it on the same line would make it an argument of the setuptool); afterwards confirm `enabled` with `systemctl --user -M noteprep-runner@ is-enabled docker`.

[verify on host] Both options are only inferred from the documentation; which one works on your host has to be tested, and the same goes for the path of `dockerd-rootless-setuptool.sh` and for `PATH`.

**Check where dockerd-rootless.sh is**: `runner-docker.conf` says `/usr/bin/dockerd-rootless.sh`; go by the actual install location (`command -v dockerd-rootless.sh`; `rpm`/`dpkg -L docker-ce-rootless-extras` also work), and confirm that it accepts `-H` and `--group` (`dockerd-rootless.sh --help` forwards to dockerd). If the location differs, change the path in the drop-in (edited as root), then have the runner's user manager reload and restart: `systemctl --user -M noteprep-runner@ daemon-reload && systemctl --user -M noteprep-runner@ restart docker`. [verify on host]

Verify (on the **host**, as root or another account):

```sh
stat -c '%a %U %G' /run/noteprep-runner/docker.sock
# expected: 660 noteprep-runner noteprep-runner
stat -c '%a %G' /run/noteprep-runner/docker.sock
# must print: 660 noteprep-runner

sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker info | grep -E 'rootless|Cgroup Version|WARNING'
# expected: contains "rootless" and "Cgroup Version: 2"; warnings such as "No memory limit support" / "No cpu cfs quota support" must not appear [verify on host]
```

**Socket group** (verified on DigitalOcean / Ubuntu 24.04 / Docker 29.9.1, 2026-10-20): the rootless daemon runs inside a user namespace, where `--group noteprep-runner` is an unmapped gid in the namespace, so the socket's group shows as `UNKNOWN` (that is, `nogroup`): `660 noteprep-runner UNKNOWN`. `deploy/host/runner-docker.conf` in the repository now uses `--group 0` (namespace root, which corresponds to the runner's own primary group gid on the host); measured, `stat -c '%a %U %G'` is `660 noteprep-runner noteprep-runner` and `stat -c '%u:%g'` is `999:987`, unchanged after a full reboot. If your drop-in still has the old `--group noteprep-runner`, change it as follows:

```sh
sed -i 's/--group noteprep-runner$/--group 0/' /etc/systemd/user/docker.service.d/noteprep.conf
systemctl --user -M noteprep-runner@ daemon-reload && systemctl --user -M noteprep-runner@ restart docker
```

Then check `stat -c '%a %G'` again. The group must be the runner's own primary group; **do not** change it to the `docker` group. Behavior on other distributions/Docker versions is still UNVERIFIED.

`RUNNER_GID` in `worker.image` must equal the gid of the runner group:

```sh
getent group noteprep-runner | cut -d: -f3        # write this number into RUNNER_GID in /etc/noteprep/worker.image
```

Account health check (all of these must hold, otherwise stop):

```sh
getent passwd noteprep-runner | cut -d: -f7       # expected: /usr/sbin/nologin
sudo -l -U noteprep-runner                        # expected: prints "User noteprep-runner is not allowed to run sudo" (no entries at all)
id noteprep-runner                                # expected: docker is not in the group list
getent group docker                               # expected: members empty
# there are no credentials in the home directory (the runner must not hold a GHCR token, .env files or keys).
find /home/noteprep-runner -xdev -path /home/noteprep-runner/.local/share/docker -prune -o \( -name config.json -o -name '.env*' -o -name '*token*' -o -name '*.pem' -o -name '*.key' \) -print 2>/dev/null
# expected: no output (the rootless data directory ~/.local/share/docker is excluded; its contents are image layers, not credentials). Exception: if the daemon's own configuration such as ~/.config/docker/daemon.json appears, inspect each one; it must not contain auths/credentials.
```

The worker container's uid 10001 **does not need** a host account, and there should be no loginable 10001 user on the host: `getent passwd 10001` should print nothing. [verify on host]

## 4. Secrets

```sh
install -d -m 0750 -o root -g root /etc/noteprep
# prepare the values in a password manager and paste them in the editor (do not put values on the command line, to keep them out of the shell history)
install -m 0600 -o root -g root /dev/null /etc/noteprep/worker.env
${EDITOR:-nano} /etc/noteprep/worker.env           # contents follow deploy/host/worker.env.example; fill in only the real values for the placeholders
install -m 0644 -o root -g root /dev/null /etc/noteprep/worker.image
${EDITOR:-nano} /etc/noteprep/worker.image         # WORKER_IMAGE=<worker_ref>  RUNNER_GID=<see §3>
```

Check:

```sh
stat -c '%a %U %G' /etc/noteprep /etc/noteprep/worker.env
# expected:  750 root root   and   600 root root
sudo -u noteprep-runner cat /etc/noteprep/worker.env     # expected: Permission denied
sudo -u noteprep-runner ls /etc/noteprep                 # expected: Permission denied
```

- Create the `worker_login` database role as described in [database-roles.md](database-roles.md); the worker uses only it, not the migration credentials.
- Rotation: put the new value in the password manager → change `/etc/noteprep/worker.env` → `systemctl restart noteprep-worker` → (if needed) revoke the old value at the provider.
- **After changing `worker.env` you must restart the unit for it to take effect**: `docker run --env-file` reads the file only when the container starts. Measured 2026-10-20: the file was changed without a restart, the worker kept using the old `SUPABASE_SECRET_KEY`, and every generation failed with `storage_failed`; after the restart the first generation succeeded. To check which key the running container actually has, use a **fingerprint** rather than printing the value (the first 12 characters of the hash cannot be inverted to recover the key):

  ```sh
  docker exec noteprep-worker node -e "console.log(require('crypto').createHash('sha256').update(process.env.SUPABASE_SECRET_KEY||'').digest('hex').slice(0,12))"
  # on your development machine, hash the new key you hold in the same way (enter it with read -rs, no echo); the two 12-character values should match
  ```

- **Troubleshooting `storage_failed`** (2026-10-20): the worker used to log only `job_failed code=storage_failed` and `attempt_cleanup_failed code=StorageError`, and did **not** log the HTTP status or message, so upload, read-back verification and cleanup failures looked identical in the log. Now `job_failed`, `job_requeued` and `attempt_cleanup_failed` also carry `storageOp` (`put`/`stat`/`list`/`remove`/`verify`/`path`), `storageStatus` (the HTTP status) and `storageMessage` (a sanitized short message, single line, at most 200 characters, containing no key-like or JWT-like text and no object path). **These fields appear only after you publish and deploy a new worker image (§6) that contains `fix/storage-error-detail`**; an image that was running before still has the old behavior. If even `attempt_cleanup_failed` appears, listing/removing also failed, which is most likely the key, `SUPABASE_URL` or the network; only when it is absent do the path, size or bucket settings come into question. To tell a key problem from a bucket problem, test directly on the development machine with the **same** supabase-js (version in `package.json`) rather than handwritten curl: a new-style `sb_secret_…` key is not a JWT, so bare curl either lacks `Authorization` (`headers must have required property 'authorization'`) or has it parsed as a JWT (`Invalid Compact JWS`), and neither of these 400/403 responses says anything about whether the key is good:

  ```sh
  read -rs SB_KEY; export SB_KEY
  node -e "const {createClient}=require('@supabase/supabase-js');createClient('https://<project-ref>.supabase.co',process.env.SB_KEY,{auth:{persistSession:false}}).storage.from('lesson-artifacts').list('',{limit:1}).then(r=>console.log(r.error?{status:r.error.status??r.error.statusCode,message:r.error.message}:'ok, '+r.data.length+' items'))"
  unset SB_KEY
  ```
- **Never** put secrets in the runner's home directory, in an image, in command-line arguments or in the shell history.
- `LATEX_IMAGE` (in `worker.env`) and the host sandbox tests in §7 use the same digest.
- For the first rehearsal use `LLM_PROVIDER=fake` and `LESSON_PROSE=template` (the defaults in the sample file), which incurs no model cost.

[verify on host] The `stat` checks above and the refused reads.

## 5. Pull the images (by digest only; the runner holds no registry credentials)

[verify on host] None of the host commands in this section, or in §2, §6, §10 and §11, has been run on a real host.

As **root**, pull the three images from GHCR with a read-only PAT (only `read:packages`), then log out immediately:

```sh
read -rs GHCR_TOKEN && echo                              # paste the read-only PAT, no echo
printf %s "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
unset GHCR_TOKEN
docker pull <worker_ref>
docker pull <hosttest_ref>
docker pull <latex_ref>
docker logout ghcr.io
```

Check the digests (the output must contain the same manifest digest `sha256:` as the Step Summary; the Step Summary gives the **manifest digest**, not the image ID):

```sh
docker image inspect --format '{{.RepoDigests}}' <worker_ref> <hosttest_ref> <latex_ref>
```

**The LaTeX image has to get into the runner's daemon, and the runner cannot `docker login`** (it must not hold a GHCR token). There are two approaches; pick one:

- Approach A (default): root pulls, then imports into the runner's daemon through a pipe:

  ```sh
  docker save <latex_ref> | sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker load
  sudo -u noteprep-runner env DOCKER_HOST=unix:///run/noteprep-runner/docker.sock docker image inspect --format '{{.Id}}' <latex_ref>
  ```

  **UNVERIFIED**: whether `<latex_ref>` can still be resolved by digest in the runner's daemon after `save`/`load` depends on the Docker image store implementation (containerd image store vs. classic store), and this repository has not verified it. Because the sandbox runs with `--pull never`, if `save|load` did not preserve the digest reference, compilation fails outright (image not found). In that case do **not** switch to running by tag, and do not compare the image ID against the Step Summary (they are not the same value); use approach B instead (public image, pulled by digest directly by the runner's daemon). This point stays UNVERIFIED. [verify on host]
- Approach B: make the LaTeX image package public (it contains no secrets), and the runner runs `docker pull <latex_ref>` directly, with no credentials at all. Whether to make it public is your decision.

Check that no credentials were left in the runner's home directory: `find /home/noteprep-runner -path /home/noteprep-runner/.local/share/docker -prune -o -name config.json -print` (should print nothing).

## 6. Start, stop, update and roll back

First enablement (precondition: §3-§5 and the host sandbox tests in §7 are all green):

```sh
install -m 0644 -o root -g root noteprep-worker.service /etc/systemd/system/noteprep-worker.service
systemctl daemon-reload
systemctl enable --now noteprep-worker
systemctl status noteprep-worker --no-pager
```

For the unit's behavior see `deploy/host/noteprep-worker.service` (`--pull never`, read-only root, read-only mount of the runner directory, `--log-driver none`, `--stop-timeout 180`). **Its arguments are not copied here**; the file is authoritative. The `ExecStartPre` guard refuses a `WORKER_IMAGE` that is not `name@sha256:<64 hex characters>`, and a `RUNNER_GID` that is not a positive integer. Negative checks (order matters: `start` on an already running unit does nothing):

```sh
systemctl stop noteprep-worker
cp /etc/noteprep/worker.image /root/worker.image.bak          # back up first
# change WORKER_IMAGE in /etc/noteprep/worker.image to a tagged value (for example ...:latest), then:
systemctl start noteprep-worker; echo "exit=$?"                # expected: non-zero exit
journalctl -u noteprep-worker -n 20 --no-pager                 # expected: an ExecStartPre failure is visible
docker ps -a --filter name=noteprep-worker                     # expected: no container
# restore the digest value (the negative check for RUNNER_GID works the same way: change it to an empty value or 0, then restore):
install -m 0644 -o root -g root /root/worker.image.bak /etc/noteprep/worker.image
systemctl reset-failed noteprep-worker
systemctl start noteprep-worker
```

Because of `Restart=on-failure`, after a failure the unit status may show `failed`, or `activating (auto-restart)` (inside the `RestartSec=10` wait, and refused by the guard again each time); both count as a pass. Always restore afterwards and confirm `worker_started`. [verify on host]

Update order (each step can be turned back from):

1. First run the database migration (expand, backward compatible), see [staging-setup §1](staging-setup.md) point 4 (the `Database migrations` workflow, status first, then deploy).
2. `images.yml` publishes the new images; note the new digests.
3. Root pulls (§5), and the LaTeX image is delivered to the runner (§5). **Do not delete the old images.**
4. Run the §7 host sandbox tests (with the new `<hosttest_ref>` and `<latex_ref>`).
5. Change `LATEX_IMAGE` in `/etc/noteprep/worker.env` and `WORKER_IMAGE` in `/etc/noteprep/worker.image` to the new digests.
6. `systemctl restart noteprep-worker` (graceful stop of up to 180 s, see §10).
7. Append one line to `/etc/noteprep/releases.log`:

   ```sh
   printf '%s old_worker=%s new_worker=%s old_latex=%s new_latex=%s\n' "$(date -u +%FT%TZ)" "<old-worker-digest>" "<new-worker-digest>" "<old-latex-digest>" "<new-latex-digest>" >> /etc/noteprep/releases.log
   ```

Rollback: write `worker.env` and `worker.image` back to the old digests from the previous line of `releases.log` → `systemctl restart noteprep-worker` → confirm that `worker_started` appears in the log. Do not delete the old images before the new version has been verified. Migrations are only backward-compatible expands, so rolling back the code does not require rolling back the database.

Start limit: after 10 consecutive failed starts within 300 s, systemd refuses to start it again (`start-limit-hit`). After fixing the cause, first `systemctl reset-failed noteprep-worker`, then `systemctl start noteprep-worker`.

## 7. Host sandbox tests (the gate that blocks going live)

Run `tests/latex` on the host with the `hosttest` image (no env-file, no secrets; only `pipeline.test.ts`, which needs a database, is excluded). It uses **the same uid/gid, the same supplementary group, read-only root, all capabilities dropped, no-new-privileges and the same socket directory mount** as the worker, and mirrors the unit's `--init`/`--pids-limit`/`--memory`/`--cpus` and the `/run/noteprep` tmpfs; but it is **not** a bit-for-bit identical runtime environment (for example there is no env-file and the entrypoint differs), so a pass only shows that the sandbox works under these conditions. The concrete values follow `deploy/host/noteprep-worker.service`; if they change, update this text to match. `HOST_SANDBOX_STRICT=1` requires `LATEX_IMAGE` to be a digest, otherwise the test errors out at startup:

```sh
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
# expected: all vitest tests pass, exit code 0
```

Task 5/5b ran the hosttest image on a local Docker with `--read-only --tmpfs /tmp` (Docker's default tmpfs options include `noexec`) (41 tests passed); the `ci.yml` hosttest step on GitHub Actions passed in the `LaTeX sandbox` job of PR #10 (2026-10-20); behavior on a real host is still UNVERIFIED. So the `noexec` on `/tmp` is not a likely cause of failure. What has **really not been tested** on a real host is: the 64m capacity limit of `/tmp`, `--memory 1g`, `--pids-limit 256`, `--cap-drop ALL`, uid 10001, and the real runner socket directory mount. If you hit out-of-disk or out-of-memory under these limits, that is a **result to record** (open an issue or write it into decisions and adjust the configuration based on the evidence), **not** a reason to loosen the isolation parameters. [verify on host]

- This command is a container run by the root daemon, and the socket **directory** is mounted into it; **do not** mount `/var/run/docker.sock` (in the repository, CI does this for a throwaway runner; a production host never does).
- Reverse check: `-e LATEX_IMAGE=noteprep-latex:dev` with `HOST_SANDBOX_STRICT=1` must fail immediately (`pinned by digest`).
- **Any failure blocks going live, with no downgrade** (architecture §11.2). Do not "fix" it by loosening the sandbox parameters, switching to root, or skipping a test.
- The worker secrets must not be readable as the runner (checked in §4, rechecked here): `sudo -u noteprep-runner cat /etc/noteprep/worker.env` is refused.

**Measured record (2026-10-20, DigitalOcean, Ubuntu 24.04, Docker 29.9.1, 4 GB / 2 vCPU)**: all 41 tests passed (about 10 minutes, exit code 0); hosttest with uid 10001 + supplementary group 987 could connect to the runner's socket directory. The reverse check (`LATEX_IMAGE=noteprep-latex:dev`) failed immediately, with exit code 1 and a message containing `requires LATEX_IMAGE pinned by digest`. Notes:

- `RUNNER_GID` is a shell variable; in a new session (for example after a reboot) it is empty, and `--group-add ""` reports `unable to find group : no matching entries in group file`. Each time, first run `RUNNER_GID=$(getent group noteprep-runner | cut -d: -f3)`.
- On a 512 MB host this step fails (see the memory requirement in §1); do not treat that failure as a problem with the sandbox parameters.
- During the run, `dmesg` may show one `CONSTRAINT_MEMCG` kill of `perl` (the container's own memory limit taking effect); it matches the timing of the "cannot use more memory than its limit" test, but we did not match them one to one. Unlike global OOM: `dmesg -T | grep -c global_oom` should be 0.

Still unverified: cgroup v1 hosts.

## 8. Inspect the running worker

```sh
docker inspect -f '{{json .Mounts}} {{.HostConfig.NetworkMode}} {{.HostConfig.PidMode}} {{.HostConfig.Privileged}} {{.HostConfig.CapDrop}}' noteprep-worker
# expected: Mounts has only the /run/noteprep-runner entry and it is "RW":false; NetworkMode is `default` or `bridge` (that is, the default bridge, see §9); PidMode is empty; Privileged=false; CapDrop=[ALL]
docker exec noteprep-worker ls /var/run/docker.sock
# expected: fails ("No such file or directory"), non-zero exit code
docker exec noteprep-worker id          # expected: uid=10001 gid=10001, supplementary groups include RUNNER_GID
docker inspect -f '{{.HostConfig.LogConfig.Type}} {{.HostConfig.ReadonlyRootfs}}' noteprep-worker   # expected: none true
docker logs noteprep-worker             # expected: an error because of --log-driver none; logs are only in journalctl
```

[verify on host] The above.

## 9. Network exposure

The worker container is on the default bridge and can make outbound connections (it needs to reach Supabase and the LLM provider). Confirm:

- The host has no cloud instance role, or the metadata endpoint (`169.254.169.254`) is blocked:

  ```sh
  docker exec noteprep-worker node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('REACHABLE',r.status)).catch(()=>console.log('blocked'))"
  # expected: blocked (also blocked if the cloud vendor has no metadata endpoint). If it prints REACHABLE, first block the endpoint or remove the instance role, then continue
  ```

  **DigitalOcean measured (2026-10-20)**: **reachable** by default (`REACHABLE 404`), and the host sshd could also be reached from the container through the bridge address `172.17.0.1:22` (`SSH REACHABLE`; sshd listens on `0.0.0.0:22` and `[::]:22`). The fix is `deploy/host/noteprep-block-metadata.service`: traffic to the metadata endpoint is forwarded traffic, so it goes in the `DOCKER-USER` chain; container-to-host sshd goes through the `INPUT` chain, limited to `-i docker0` and port 22 (docker0 is not blocked as a whole, because whether container DNS and the like would be affected has not been tested). It is reapplied after Docker starts and before the worker starts (iptables rules are lost on reboot). Install:

  ```sh
  install -m 0644 -o root -g root noteprep-block-metadata.service /etc/systemd/system/noteprep-block-metadata.service
  systemctl daemon-reload && systemctl enable --now noteprep-block-metadata
  iptables -L DOCKER-USER -v -n --line-numbers      # expected: one DROP line to 169.254.169.254
  iptables -L INPUT -v -n --line-numbers            # expected: a tcp dpt:22 DROP with docker0 in the in column (it must not be *, otherwise your own SSH is blocked too)
  ```

  Verify: the metadata check prints `blocked`; the SSH check, because it is a DROP and not a REJECT, shows up as a **connection timeout** rather than `closed`, and both count as a pass; only `SSH REACHABLE` is a failure (use the version with a 3-second timeout: `const s=require('net').connect({port:22,host:'172.17.0.1'});s.setTimeout(3000);…`). After a full reboot both rules came back automatically (see §12). This protects only the worker container, not the runner's rootless network (the third item below is still unchecked).

- No service on the host listens on the docker0 bridge address (containers can reach it), including IPv6 wildcard listeners:

  ```sh
  ip -4 addr show docker0 | grep inet            # note the bridge address, usually 172.17.0.1
  ss -ltnp | grep -E '172\.17\.0\.1|0\.0\.0\.0:|\*:|\[::\]:'   # expected: no listeners other than SSH
  # if SSH listens on a wildcard address (0.0.0.0 / [::]), manually confirm that the host firewall rejects docker0 → 22 (for example there is a matching rule in nft list ruleset), and confirm from inside the container:
  docker exec noteprep-worker node -e "require('net').connect(22,'172.17.0.1').on('connect',()=>{console.log('SSH REACHABLE');process.exit()}).on('error',()=>console.log('closed'))"   # expected: closed
  ```

- Run the same metadata endpoint check from the runner's rootless network (use a throwaway container started through the runner's socket; the LaTeX image already delivered in §5 is not suitable for the command, because it has no node/curl; use any minimal image you already have in the runner daemon, or manually confirm the host firewall's egress rules for the runner uid; if there is no such image, record it as "not checked"). [verify on host]
- Record honestly (not a fix item): the **runner account has no egress firewall** (D-52 ④); the sandbox container itself is `--network none`, but an attacker who compromises the runner daemon can send traffic out through the rootless network. **Host root can read the worker secrets through `docker inspect noteprep-worker`** (D-52 ⑤), for administrators only, and administrator accounts must be protected accordingly.

[verify on host] The above.

## 10. Graceful stop and restart (D-55)

[verify on host] The behavior described in this section comes from the unit file and the code, and has not been rehearsed on a host (for the rehearsal see §12).

- `systemctl stop|restart noteprep-worker`: stops claiming new jobs and **lets in-flight jobs finish**; the container waits up to 180 s (`--stop-timeout 180`, `TimeoutStopSec=200`). After the timeout it gets SIGKILL, and lease expiry + the sweeper take over: the job is requeued or failed according to the rules, **with no double charge of allowance**.
- Docker does not restart a container automatically because it is `unhealthy`; the health status is used only for alerting (§11).
- The unit has `Restart=on-failure` and `StartLimitBurst=10`/300 s; continuous crashing is rate-limited by systemd, showing up as growing `NRestarts`.

## 11. Logs and alerts

**Limits of the health check (D-55)**: the container `HEALTHCHECK` only proves that the worker can reach the database (the liveness file is updated after a successful sweep/poll). If the runner's socket or group mapping is broken, the worker still shows `healthy`, and every compilation fails with `sandbox_unavailable`. So alerting **must also** monitor the number of failed jobs (see the SQL below). Also, the Dockerfile `HEALTHCHECK` hard-codes `/run/noteprep/alive`, so **do not** override `WORKER_LIVENESS_FILE` in `worker.env`.

[verify on host] The `jq` filters and the `docker inspect` output format below need to be confirmed against real logs.

`journalctl -u noteprep-worker` is the **only authoritative log** (the container uses `--log-driver none`). Logs are JSON lines and contain no lesson content.

```sh
journalctl -u noteprep-worker -o cat | jq -c 'select(.event=="worker_fatal" or .event=="loop_error" or .event=="sweep_error" or .event=="job_unsettled" or .event=="liveness_write_failed")'
journalctl -u noteprep-worker -o cat | jq -c 'select(.event=="sweep" and .drift>0)'
docker inspect -f '{{.State.Health.Status}}' noteprep-worker      # expected healthy; any other value = alert
systemctl show -p NRestarts noteprep-worker                       # growing = alert
```

(Log lines look like `{"ts":...,"event":...,...}`, see `worker/log.ts`.)

Alert events: `worker_fatal`, `loop_error`, `sweep_error`, `job_unsettled`, `liveness_write_failed`, and `sweep` with `drift>0`. For now these are only **searchable logs and queries**; they are not wired into any alerting system (nor is that in this plan, see §13).

Run in the SQL Editor of Supabase staging (read-only):

```sql
-- backlog: should have started running 5 minutes ago but is still queued
select count(*) from generation_job where state = 'queued' and run_after < now() - interval '5 minutes';
-- stuck: running jobs whose lease expired more than 2 minutes ago (the sweeper normally takes them over; persistently non-zero = alert)
select count(*) from generation_job where state = 'running' and lease_expires_at < now() - interval '2 minutes';
-- failure rate over the last hour
select count(*) filter (where state = 'failed')::float
       / nullif(count(*) filter (where state in ('succeeded', 'failed')), 0)
from generation_job where finished_at > now() - interval '1 hour';
-- sandbox unavailable (socket/group mapping/runner daemon broken; persistently non-zero = alert, even if the container is healthy)
select count(*) from generation_job where state = 'failed' and error_code = 'sandbox_unavailable' and finished_at > now() - interval '15 minutes';
-- error distribution over the last day
select error_code, count(*) from generation_job where finished_at > now() - interval '1 day' group by 1;
```

(Table and column names are taken from the `@map` entries in `prisma/schema.prisma`.)

## 12. Staging rehearsal checklist (tick item by item, record the date and digests)

Rehearsal date: 2026-10-20 (first one, partially completed; DigitalOcean, Ubuntu 24.04, 4 GB / 2 vCPU)  
worker digest: `ghcr.io/yangzi33/noteprep-worker@sha256:18662c994ebcc05c2404a71f8092fd4168e471b64b39b3005c2b2b7015454840`  
latex digest: `ghcr.io/yangzi33/noteprep-latex@sha256:6a0aa483856e90be750e9c76919699e76050fc513e26793b6b220c69548dff20`  
hosttest digest: `ghcr.io/yangzi33/noteprep-hosttest@sha256:6414bdc1b00c50ec7c7f9ef3990ff09748ba691da45742d0db8c1efa47b7d677`  
(The digests were read from the GitHub API, commit `7c207fa`; they were not checked one by one against the Step Summary.)

- [x] §1 the host checklist is fully met (`cgroup2fs`, x86_64, systemd 255, time sync, `unattended-upgrades` installed) (2026-10-20). "The cloud firewall allows only SSH from your IP" is for you to confirm in the console; the rules themselves were not seen here; `ss -ltn` showed only sshd and the DNS stub on loopback. **For the memory requirement see §1: 512 MB is not enough.**
- [x] §3 the runner account health check passed (2026-10-20): `stat` of the socket = `660 noteprep-runner noteprep-runner` (needs `--group 0`, see §3); `docker info` shows rootless, cgroup v2, no warnings; nologin, no sudo, not in the docker group (the `docker` group has no members), `getent passwd 10001` prints nothing, no credentials in the home directory. The rootless drop-in is owned by root.
- [ ] §4 `/etc/noteprep` = `750 root root`, `worker.env` = `600 root root`; the runner cannot read it. **The output of these `stat` and `Permission denied` checks was not recorded**, so it is not ticked. All that was verified is: the variable names in `worker.env` are complete (a typo `COMPLIER` once made the worker refuse to start, see D-57), and connecting to the database with its connection string as `worker_login` works (`current_user` = `worker_login`; the first attempt wrongly used the `postgres` owner connection string and was corrected).
- [x] §5 the images were pulled by digest and checked (the RepoDigests of `docker image inspect` match the above); worker and hosttest were pulled by root with a read-only PAT and then `docker logout` was run; the runner home directory has no `config.json`; the LaTeX image was pulled by the runner's daemon directly by digest through **approach B** (package made public), without `save | load`, so the digest-preservation question of approach A is **still UNVERIFIED** (2026-10-20)
- [ ] Database migrations: the `Database migrations` workflow (status → deploy), see [staging-setup §1](staging-setup.md)
- [ ] Curriculum dataset: the `Load curriculum dataset` workflow (validate → load sample-1)
- [x] §7 host sandbox tests all green (`HOST_SANDBOX_STRICT=1`, digest-pinned `LATEX_IMAGE`): 41/41, exit code 0, the reverse check failed as expected (2026-10-20; the first time, on a 512 MB host, 9 failed because of insufficient memory, see §1)
- [x] Start the worker: the `worker_started` line contains `"compiler":"docker-latex"` and `"store":"supabase"` (`llm: fake`, `prose: template`) (2026-10-20). The two negative checks of §6 were also done: a tagged `WORKER_IMAGE` and `RUNNER_GID=0` were both refused by `ExecStartPre` (`exit=1`, no container), and after restoring it started normally
- [x] §8 all checks of the running worker matched expectations (2026-10-20): only one read-only mount, `/run/noteprep-runner`, bridge, `Privileged=false`, `CapDrop=[ALL]`; `/var/run/docker.sock` does not exist; `uid=10001 gid=10001 groups=10001,987`; log driver `none`, root filesystem read-only; `docker logs` reports an error
- [x] §9 the metadata endpoint is blocked and nothing listens on docker0 (2026-10-20, `noteprep-block-metadata.service` is **required**, see §9: before the fix both were reachable). Egress from the runner's rootless network was **not checked**
- [ ] On your development machine, run the smoke test (each run consumes 1 free generation of that test account, and the allowance is never reset; the account is a throwaway staging user):

  ```sh
  pnpm exec playwright install chromium
  read -rs SMOKE_PASSWORD; export SMOKE_PASSWORD        # input is not echoed and stays out of the shell history
  SMOKE_TARGET=staging SMOKE_BASE_URL=https://noteprep.app SMOKE_EMAIL=<throwaway-test-user> pnpm smoke:staging
  unset SMOKE_PASSWORD
  ```

  Expected: all three of Notes, Worksheet and Solutions are `ok`.
- [ ] Restart rehearsal: run `systemctl restart noteprep-worker` while a generation is in progress; expected: the job still succeeds, and that account's allowance is consumed only once (check the usage records with read-only SQL, never edit data by hand)
- [ ] Runner daemon restart: after `systemctl --user -M noteprep-runner@ restart docker` (run as root), run the smoke test once more (verifies that what is mounted is the directory and not the socket file, and the worker does not need to be restarted)
- [ ] **Full host reboot rehearsal**: after `reboot`, with no manual action, expected: the runner's rootless daemon (linger), `/run/noteprep-runner` (tmpfiles) and the `noteprep-worker` unit all come up automatically, the socket attributes shown by `stat` are unchanged, and one more smoke run succeeds. **The "comes up automatically" part was verified on 2026-10-20**: after the reboot the socket was `660 noteprep-runner noteprep-runner`, rootless + cgroup v2 with no warnings, `docker`/`noteprep-block-metadata`/`noteprep-worker` were all `active`, both iptables rules were present, there was one `worker_started`, and the container was `healthy`. **"One more smoke run succeeds" has still not been done**, so the whole item is not ticked
- [ ] One rollback rehearsal (§6)

**Status as of 2026-10-20**: the ticked items in the list above are those whose output was seen with our own eyes on that host; the unticked ones (the permission check output of §4, the database migration and curriculum dataset workflows, the smoke test, restart during a generation, the smoke test after a runner daemon restart, the rollback rehearsal, and the smoke test after a full reboot) are **still UNVERIFIED**. In addition, the "update order" of §6, the graceful stop of in-flight jobs in §10, the logs and alerts of §11, and the check of the `images.yml` Step Summary have none of them been rehearsed. Also: on 2026-10-20 one generation was done **manually** on `https://noteprep.app` and succeeded (`fake` LLM, `template` prose; the person who generated it looked at the result, and small layout improvements were left for later); this is **not** the scripted `pnpm smoke:staging`, so the smoke item is still not ticked. **Do not conclude from the progress of this table that staging is usable for real users.**

## 13. Needed before production (D-52 verbatim, not in this plan)

- Evaluate gVisor `runsc` (compatibility with rootless is unverified) or Firecracker on the target host (D-03/D-20).
- nftables egress deny for the runner uid.
- Image signing / provenance attestation.
- An alerting system (wire the logs and queries of §11 into it).
- Rerun `test:latex` on the production host (D-44), and run the host sandbox tests on that host as in §7.
- And the remaining launch conditions of CLAUDE.md §11 (real payments, manual math review, backup restoration rehearsal, cost limits and so on).

The entire content of this runbook is **UNVERIFIED** until someone runs it item by item on a real host and leaves a record.

## 14. S4b export (English)

Exports (`kind = 'export'` jobs) are handled by the same worker unit and the same compiler. Nothing in this runbook changes, and `worker.env` gains no required variable. Before enabling `EXPORT_ENABLED` anywhere, update this host to the S4b image and keep web and worker on the same commit. See the "S4b export worker" note in [fresh-droplet-setup.md](fresh-droplet-setup.md) (section K) for the rollout order, the failure modes of an old worker, and the zero-pending-exports rollback check.
