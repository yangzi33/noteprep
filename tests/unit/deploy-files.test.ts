import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const unit = read("deploy/host/noteprep-worker.service");
const dockerfile = read("docker/worker/Dockerfile");
const deployFiles = readdirSync("deploy/host").map((f) => `deploy/host/${f}`);

/** Shell-like splitting: whitespace separates, single and double quotes group, no escapes or expansions. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** The exact, systemd-unescaped ExecStartPre guard. Any other text (appended commands included) is rejected. */
const GUARD_SCRIPT =
  'case "$WORKER_IMAGE" in -*|*[!A-Za-z0-9._:/@-]*) exit 1;; esac; ' +
  'printf %s "$WORKER_IMAGE" | grep -Eq "^[^@]+@sha256:[0-9a-f]{64}$" || exit 1; ' +
  'case "$RUNNER_GID" in ""|0*|*[!0-9]*) exit 1;; esac';
const unescapeSystemd = (x: string) => x.replaceAll("$$", "$").replaceAll("%%", "%");

const ALLOWED_KEYS = new Set(["Description", "After", "Requires", "Wants", "StartLimitIntervalSec", "StartLimitBurst", "EnvironmentFile",
  "ExecStartPre", "ExecStart", "ExecStop", "TimeoutStopSec", "Restart", "RestartSec", "WantedBy"]);
const BOOL_FLAGS = ["--rm", "--init", "--read-only"];
const VALUE_FLAGS: Record<string, string[]> = {
  "--name": ["noteprep-worker"],
  "--tmpfs": ["/tmp:rw,noexec,nosuid,nodev,size=64m", "/run/noteprep:rw,noexec,nosuid,nodev,size=1m,uid=10001,gid=10001"],
  "--user": ["10001:10001"],
  "--group-add": ["${RUNNER_GID}"],
  "--cap-drop": ["ALL"],
  "--security-opt": ["no-new-privileges"],
  "--pids-limit": ["256"],
  "--memory": ["1g"],
  "--memory-swap": ["1g"],
  "--cpus": ["1"],
  "--pull": ["never"],
  "--env-file": ["/etc/noteprep/worker.env"],
  "--mount": ["type=bind,source=/run/noteprep-runner,target=/run/noteprep-runner,readonly"],
  "--stop-timeout": ["180"],
  "--log-driver": ["none"],
};

/** Returns the list of violations; empty means the unit is acceptable. */
function checkUnit(text: string): string[] {
  const v: string[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith(";"));
  if (lines.some((l) => l.endsWith("\\"))) v.push("line continuation not allowed");
  const pre: string[] = [];
  const start: string[] = [];
  const stop: string[] = [];
  for (const l of lines) {
    if (l.startsWith("[")) continue;
    const i = l.indexOf("=");
    const key = i < 0 ? l : l.slice(0, i);
    const val = i < 0 ? "" : l.slice(i + 1);
    if (!ALLOWED_KEYS.has(key)) v.push(`directive not allowed: ${key}`);
    if (key === "ExecStartPre") pre.push(val);
    if (key === "ExecStart") start.push(val);
    if (key === "ExecStop") stop.push(val);
    if (key === "EnvironmentFile" && val !== "/etc/noteprep/worker.image") v.push(`unexpected EnvironmentFile ${val}`);
  }
  const g = pre[0] === undefined ? [] : tokenize(pre[0]);
  if (pre.length !== 2 || g.length !== 3 || g[0] !== "/bin/sh" || g[1] !== "-c" || unescapeSystemd(g[2]!) !== GUARD_SCRIPT || pre[1] !== "-/usr/bin/docker rm -f noteprep-worker") v.push("ExecStartPre must be exactly the guard then docker rm");
  if (stop.length !== 1 || stop[0] !== "/usr/bin/docker stop --time 180 noteprep-worker") v.push("ExecStop mismatch");
  if (start.length !== 1) return [...v, "exactly one ExecStart required"];
  const t = tokenize(start[0]!).flatMap((x) => (x.startsWith("--") && x.includes("=") ? [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] : [x]));
  if (t.slice(0, 2).join(" ") !== "/usr/bin/docker run") v.push("ExecStart must be /usr/bin/docker run");
  if (t.includes("host")) v.push("token host");
  if (t[t.length - 1] !== "${WORKER_IMAGE}") v.push("last token must be ${WORKER_IMAGE}");
  const seen = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 2; i < t.length; i++) {
    const tok = t[i]!;
    if (BOOL_FLAGS.includes(tok)) seen.set(tok, [...(seen.get(tok) ?? []), ""]);
    else if (tok in VALUE_FLAGS) {
      seen.set(tok, [...(seen.get(tok) ?? []), t[i + 1] ?? ""]);
      i++;
    } else if (tok.startsWith("-")) v.push(`flag not allowed: ${tok}`);
    else positional.push(tok);
  }
  if (positional.join(" ") !== "${WORKER_IMAGE}") v.push(`unexpected positional tokens: ${positional.join(" ")}`);
  for (const f of BOOL_FLAGS) if ((seen.get(f) ?? []).length !== 1) v.push(`${f} must appear exactly once`);
  for (const [f, want] of Object.entries(VALUE_FLAGS)) {
    const got = [...(seen.get(f) ?? [])].sort();
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) v.push(`${f} values ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
  return v;
}

const SECRET_PATTERNS = [/sb_secret_/, /\b[sr]k_(live|test)_/, /whsec_/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /sk-[A-Za-z0-9]/, /eyJ/, /postgres(ql)?:\/\/[^\s<]+:[^\s<@]+@/];
const secretsIn = (text: string) => SECRET_PATTERNS.filter((r) => r.test(text)).map(String);

// Text checks are a tripwire next to the image tests and the host run, never a substitute for them.
describe("host deployment files", () => {
  it("the real unit passes every structural rule", () => {
    expect(checkUnit(unit)).toEqual([]);
  });

  const withFlag = (flag: string) => [
    unit.replace(" ${WORKER_IMAGE}", () => ` ${flag} ${"$"}{WORKER_IMAGE}`),
    unit.replace(/(ExecStart=.*)$/m, (m) => `${m} ${flag}`),
  ];
  const mutations: Record<string, string[]> = {
    "--net host": withFlag("--net host"),
    "--net=host": withFlag("--net=host"),
    "--network host": withFlag("--network host"),
    "--ipc host": withFlag("--ipc host"),
    "--uts=host": withFlag("--uts=host"),
    "--userns=host": withFlag("--userns=host"),
    "--cgroupns=host": withFlag("--cgroupns=host"),
    "--pid host": withFlag("--pid host"),
    "seccomp=unconfined": withFlag("--security-opt seccomp=unconfined"),
    "apparmor=unconfined": withFlag("--security-opt apparmor=unconfined"),
    "--device": withFlag("--device /dev/kmsg"),
    "-v glued": withFlag("-v/var/run:/hostrun"),
    "-v": withFlag("-v /:/host"),
    "--volumes-from": withFlag("--volumes-from other"),
    "--privileged": withFlag("--privileged"),
    "--cap-add": withFlag("--cap-add SYS_ADMIN"),
    "--entrypoint": withFlag("--entrypoint /bin/sh"),
    "--add-host": withFlag("--add-host a:1.2.3.4"),
    "--label": withFlag("--label a=b"),
    "second --user": withFlag("--user 0:0"),
    "--read-only=false": withFlag("--read-only=false"),
    "--pids-limit -1": withFlag("--pids-limit -1"),
    "no-new-privileges=false": withFlag("--security-opt no-new-privileges=false"),
    "-e secret": withFlag("-e SUPABASE_SECRET_KEY=sb_secret_abc"),
    "--env secret": withFlag("--env X=1"),
    "second --mount": withFlag("--mount type=bind,source=/etc,target=/etc"),
    ":latest image": [unit.replace("${WORKER_IMAGE}", "ghcr.io/o/noteprep-worker:latest")],
    "read-only moved to comment": [unit.replace(" --read-only", "").replace("[Install]", "# --read-only\n[Install]")],
    "cap-drop moved to comment": [unit.replace(" --cap-drop ALL", "").replace("[Install]", "# --cap-drop ALL\n[Install]")],
    "ExecStartPost docker exec -u 0": [unit.replace("[Install]", "ExecStartPost=/usr/bin/docker exec -u 0 noteprep-worker sh\n[Install]")],
    "Environment= secret": [unit.replace("[Install]", "Environment=WORKER_DATABASE_URL=postgres://u:p@h/db\n[Install]")],
    "guard script appended": [unit.replace(/^(ExecStartPre=\/bin\/sh -c '.*)'$/m, (_m, a: string) => `${a}; /usr/bin/docker run --privileged -v /:/h alpine & true'`)],
    "mount source changed": [unit.replace("source=/run/noteprep-runner", "source=/run")],
    "mount writable": [unit.replace(",readonly", "")],
  };
  for (const [name, variants] of Object.entries(mutations)) {
    it(`rejects mutation: ${name}`, () => {
      for (const m of variants) {
        expect(m, "mutation did not change the unit").not.toBe(unit);
        expect(checkUnit(m), name).not.toEqual([]);
      }
    });
  }

  it("the guard validates WORKER_IMAGE and RUNNER_GID, failing closed", () => {
    const line = unit.split("\n").find((l) => l.startsWith("ExecStartPre=/bin/sh -c "))!;
    const script = unescapeSystemd(tokenize(line.slice("ExecStartPre=".length))[2]!);
    const run = (env: Record<string, string>) => spawnSync("/bin/sh", ["-c", script], { env: { PATH: "/usr/bin:/bin", ...env } as unknown as NodeJS.ProcessEnv }).status;
    const hex = "ab12".repeat(16);
    const img = `ghcr.io/o/n@sha256:${hex}`;
    expect(run({ WORKER_IMAGE: img, RUNNER_GID: "1000" })).toBe(0);
    for (const bad of ["ghcr.io/o/n:latest", `ghcr.io/o/n:1@sha256:${hex.slice(1)}`, `ghcr.io/o/n@sha256:${hex.toUpperCase()}`, `ghcr.io/o/n@sha256:${hex}0`,
      `@sha256:${hex}`, `${img}\nx`, `-v/:/h@sha256:${hex}`, `--privileged@sha256:${hex}`, ""]) {
      expect(run({ WORKER_IMAGE: bad, RUNNER_GID: "1000" }), JSON.stringify(bad)).not.toBe(0);
    }
    for (const bad of ["", "0", "00", "-1", "1000x", "1000\n", " 1000"]) expect(run({ WORKER_IMAGE: img, RUNNER_GID: bad }), JSON.stringify(bad)).not.toBe(0);
    expect(run({ RUNNER_GID: "1000" })).not.toBe(0);
    expect(run({ WORKER_IMAGE: img })).not.toBe(0);
  });

  it("no deploy file contains a secret-looking value, and the scan catches them", () => {
    for (const f of deployFiles) expect(secretsIn(read(f)), f).toEqual([]);
    for (const bad of ["sb_secret_abc", "sk_live_abc", "sk_test_abc", "rk_live_abc", "whsec_abc", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----", "postgres://u:p@h/db", "eyJhbGciOi", "sk-ant123"]) expect(secretsIn(`X=${bad}`), bad).not.toEqual([]);
  });

  it("the image never copies the whole context and bakes in no secret-looking variable", () => {
    expect(dockerfile).not.toMatch(/^COPY \. /m);
    expect(dockerfile).not.toMatch(/^ENV .*(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)/m);
    expect(dockerfile).toMatch(/AS runtime[\s\S]*USER 10001:10001/);
  });

  it("example env files hold placeholders only", () => {
    const env = read("deploy/host/worker.env.example");
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
    expect(dropin).toContain("/etc/systemd/user/docker.service.d/noteprep.conf");
    expect(dropin.split("\n")[0]).not.toContain(".config/systemd");
    expect(read("deploy/host/noteprep-runner.tmpfiles.conf")).toMatch(/^d \/run\/noteprep-runner 0750 noteprep-runner noteprep-runner -$/m);
    expect(read("deploy/host/user-delegate.conf")).toMatch(/^Delegate=cpu cpuset io memory pids$/m);
    for (const f of deployFiles) expect(read(f), f).not.toMatch(/usermod .*docker|\/var\/run\/docker\.sock|\/run\/docker\.sock/);
  });
});
