import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const unit = read("deploy/host/noteprep-worker.service");
const dockerfile = read("docker/worker/Dockerfile");
// Text checks are a tripwire next to the image tests and the host run, never a substitute for them.
describe("host deployment files", () => {
  it("runs the worker hardened, from a root-only env file, with only the runner's socket directory", () => {
    for (const flag of ["--init", "--read-only", "--user 10001:10001", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 256",
      "--memory 1g", "--tmpfs /tmp:", "--tmpfs /run/noteprep:", "--env-file /etc/noteprep/worker.env",
      "-v /run/noteprep-runner:/run/noteprep-runner", "--group-add ${RUNNER_GID}", "--stop-timeout 180", "${WORKER_IMAGE}",
      "EnvironmentFile=/etc/noteprep/worker.image", "TimeoutStopSec=200", "Restart=on-failure"]) {
      expect(unit, flag).toContain(flag);
    }
    expect(unit).not.toMatch(/docker\.sock|--privileged|--network[ =]host|--pid[ =]host|-v \/:|--cap-add/);
    // The only bind mount is the runner socket directory.
    const mounts = unit.match(/(?:-v|--volume|--mount)[ =]\S+/g) ?? [];
    expect(mounts).toEqual(["-v /run/noteprep-runner:/run/noteprep-runner"]);
  });
  it("the image never copies the whole context and bakes in no secret-looking variable", () => {
    expect(dockerfile).not.toMatch(/^COPY \. /m);
    expect(dockerfile).not.toMatch(/^ENV .*(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)/m);
    expect(dockerfile).toMatch(/AS runtime[\s\S]*USER 10001:10001/);
  });
  it("example env files hold placeholders only", () => {
    const env = read("deploy/host/worker.env.example");
    expect(env).not.toMatch(/sk-|eyJ|postgres(ql)?:\/\/[^<]*:[^<@]+@/);
    expect(env).toMatch(/^WORKER_DATABASE_URL=.*<.+>/m);
    expect(env).toMatch(/^SUPABASE_SECRET_KEY=<.+>/m);
    expect(env).not.toMatch(/^\s*(ALLOW_FAKE_COMPILER|DOCKER_HOST)=/m);
    const image = read("deploy/host/worker.image.example");
    expect(image).toMatch(/^WORKER_IMAGE=\S+@sha256:<digest>$/m);
    expect(image).toMatch(/^RUNNER_GID=<.+>$/m);
  });
  it("the rootless runner is reachable by group only and never by the docker group", () => {
    const dropin = read("deploy/host/runner-docker.conf");
    expect(dropin).toMatch(/^ExecStart=$/m);
    expect(dropin).toContain("-H unix:///run/noteprep-runner/docker.sock");
    expect(dropin).toContain("--group noteprep-runner");
    expect(read("deploy/host/noteprep-runner.tmpfiles.conf")).toMatch(/^d \/run\/noteprep-runner 0750 noteprep-runner noteprep-runner -$/m);
    expect(read("deploy/host/user-delegate.conf")).toMatch(/^Delegate=cpu cpuset io memory pids$/m);
    for (const f of ["noteprep-worker.service", "runner-docker.conf", "user-delegate.conf", "noteprep-runner.tmpfiles.conf", "worker.env.example", "worker.image.example"]) {
      expect(read(`deploy/host/${f}`), f).not.toMatch(/\bdocker group\b.*\b(add|usermod)|usermod .*docker|\/var\/run\/docker\.sock|\/run\/docker\.sock/);
    }
  });
});
