import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, inject, it } from "vitest";

const run = promisify(execFile);
const IMAGE = process.env.WORKER_IMAGE;
if (!IMAGE) throw new Error("set WORKER_IMAGE (build it with pnpm worker:image)"); // never skip
const PIN = `registry.example.test/noteprep-latex@sha256:${"a".repeat(64)}`;
const SENTINEL = `sentinel-${randomBytes(8).toString("hex")}`;
const REPO = process.cwd();
const started: string[] = [];

// A secret-looking file in the repository root for the duration of one check. It is git-ignored (.env*) and always removed.
async function withPlantedSecret(fn: (value: string) => Promise<void>): Promise<void> {
  const file = join(REPO, ".env.image-sentinel");
  const value = `planted-${randomBytes(12).toString("hex")}`;
  writeFileSync(file, `PLANTED_SECRET=${value}\n`);
  try { await fn(value); } finally { rmSync(file, { force: true }); }
}
async function listTree(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(root, rel))); else out.push(rel);
  }
  return out;
}
afterAll(async () => { for (const n of started) await run("docker", ["rm", "-f", n]).catch(() => {}); });

const envArgs = (vars: Record<string, string>) => Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
const prod = (db: string) => ({ NODE_ENV: "production", WORKER_DATABASE_URL: db, COMPILER: "docker", LATEX_IMAGE: PIN, OBJECT_STORE: "supabase",
  SUPABASE_URL: "https://example.invalid", SUPABASE_SECRET_KEY: SENTINEL, LLM_API_KEY: SENTINEL, POLL_INTERVAL_MS: "200", SWEEP_INTERVAL_SECONDS: "1" });
async function docker(args: string[]): Promise<{ code: number; out: string }> {
  try { const r = await run("docker", args, { timeout: 120_000 }); return { code: 0, out: r.stdout + r.stderr }; } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : -1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

describe("the worker image", () => {
  it("refuses to boot without configuration", async () => {
    const r = await docker(["run", "--rm", IMAGE]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("worker_fatal");
  });
  it("refuses an unpinned compile image or the host's rootful socket, and never prints a secret", async () => {
    const db = inject("testDb").workerUrl;
    for (const [over, message] of [[{ LATEX_IMAGE: "noteprep-latex:latest" }, "pinned by digest"], [{ DOCKER_HOST: "unix:///var/run/docker.sock" }, "DOCKER_HOST"]] as const) {
      const r = await docker(["run", "--rm", ...envArgs({ ...prod(db), ...over }), IMAGE]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(message);
      expect(r.out).not.toContain(SENTINEL);
    }
  });
  it("runs as 10001 with no dev tooling, no package managers and no .env", async () => {
    // pnpm keeps packages under node_modules/.pnpm/<name>@<version>, so check there as well as at the top level.
    const r = await docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
      `id -u; test ! -e /app/.env && echo noenv;
       ls -d /app/node_modules/vitest /app/node_modules/tsx /app/node_modules/prisma /app/node_modules/.pnpm/node_modules/.bin 2>/dev/null;
       cd /app/node_modules/.pnpm 2>/dev/null && ls -d prisma@* typescript@* playwright* @playwright* vitest@* tsx@* esbuild@* shadcn@* next@* 2>/dev/null;
       echo checked; command -v npm || command -v pnpm || echo nopm`]);
    expect(r.out.trim().split("\n")).toEqual(["10001", "noenv", "checked", "nopm"]);
    const info = JSON.parse((await docker(["image", "inspect", "--format", "{{json .Config}}", IMAGE])).out) as { User: string; Env: string[] };
    expect(info.User).toBe("10001:10001");
    expect(info.Env.filter((e) => /KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(e.split("=")[0]!))).toEqual([]);
  });
  it("keeps a planted .env file out of the build context", async () => {
    await withPlantedSecret(async () => {
      const dir = mkdtempSync(join(tmpdir(), "ctx-"));
      writeFileSync(join(dir, "Dockerfile"), "FROM scratch\nCOPY . /ctx\n");
      const out = join(dir, "out");
      const r = await docker(["build", "-q", "-f", join(dir, "Dockerfile"), "--output", `type=local,dest=${out}`, REPO]);
      expect(r.code).toBe(0);
      const entries = await listTree(join(out, "ctx"));
      // Only what .dockerignore allows: no env files, VCS data, docs, host node_modules or the host-generated Prisma client.
      expect(entries.filter((e) => /(^|\/)\.env/.test(e) || /(^|\/)\.git(\/|$)/.test(e))).toEqual([]);
      const top = [...new Set(entries.map((e) => e.split("/")[0]!))].sort();
      expect(top).toEqual([".npmrc", "docker", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "prisma", "prisma7.config.ts", "scripts", "src", "tests", "tsconfig.json", "worker"]);
      expect(entries.some((e) => e.startsWith("src/generated"))).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    });
  });
  it("bakes no .env file or secret value into any image layer", async () => {
    await withPlantedSecret(async (value) => {
      const tag = `noteprep-worker:secretscan-${randomBytes(4).toString("hex")}`;
      const dir = mkdtempSync(join(tmpdir(), "save-"));
      try {
        const built = await docker(["build", "-q", "--platform", "linux/amd64", "-f", "docker/worker/Dockerfile", "--target", "runtime", "-t", tag, REPO]);
        expect(built.code).toBe(0);
        expect((await docker(["save", "-o", join(dir, "image.tar"), tag])).code).toBe(0);
        const root = join(dir, "x");
        mkdirSync(root);
        await run("tar", ["-xf", join(dir, "image.tar"), "-C", root]);
        // Unpack every layer blob (they are tar archives, possibly compressed); non-archive blobs (config, manifests) stay as files.
        for (const blob of await listTree(root)) {
          const file = join(root, blob);
          const isTar = await run("tar", ["-tf", file]).then(() => true, () => false);
          if (isTar) { const to = `${file}.layer`; mkdirSync(to); await run("tar", ["-xf", file, "-C", to, "--no-same-owner", "--no-same-permissions"]).catch(() => {}); }
        }
        const files = await listTree(root);
        expect(files.length).toBeGreaterThan(50); // the scan really looked at the layers
        expect(files.filter((f) => /(^|\/)\.env/.test(f))).toEqual([]);
        const hit = await run("grep", ["-rl", "--binary-files=text", "-F", "--", value, root]).then((x) => x.stdout, () => "");
        expect(hit).toBe("");
      } finally {
        await docker(["rmi", tag]);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  it("boots against a real database, turns healthy, and stops cleanly on SIGTERM", async () => {
    const name = `noteprep-worker-test-${randomBytes(4).toString("hex")}`;
    started.push(name);
    const up = await docker(["run", "-d", "--name", name, "--network", "host", "--init", "--read-only", "--tmpfs", "/tmp",
      "--tmpfs", "/run/noteprep:uid=10001,gid=10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--health-interval", "1s", "--health-retries", "1", "--health-start-period", "0s",
      ...envArgs({ ...prod(inject("testDb").workerUrl), DOCKER_HOST: "unix:///run/noteprep-runner/docker.sock" }), IMAGE]);
    expect(up.code).toBe(0);
    await expect.poll(async () => (await docker(["inspect", "-f", "{{.State.Health.Status}}", name])).out.trim(), { timeout: 60_000 }).toBe("healthy");
    expect((await docker(["stop", "--time", "30", name])).code).toBe(0);
    expect((await docker(["inspect", "-f", "{{.State.ExitCode}}", name])).out.trim()).toBe("0");
    const logs = (await docker(["logs", name])).out;
    expect(logs).toMatch(/"event":"worker_started".*"compiler":"docker-latex".*"store":"supabase"/);
    expect(logs).toContain("shutdown_requested");
    expect(logs).toContain("worker_stopped");
    expect(logs).not.toContain(SENTINEL);
  });
});
