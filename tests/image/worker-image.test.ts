import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, describe, expect, inject, it } from "vitest";

const run = promisify(execFile);
const IMAGE = process.env.WORKER_IMAGE;
if (!IMAGE) throw new Error("set WORKER_IMAGE (build it with pnpm worker:image)"); // never skip
const PIN = `registry.example.test/noteprep-latex@sha256:${"a".repeat(64)}`;
const SENTINEL = `sentinel-${randomBytes(8).toString("hex")}`;
const started: string[] = [];
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
  it("runs as 10001 with no dev tooling, no package managers, no .env and no secrets baked in", async () => {
    const r = await docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
      "id -u; test ! -e /app/.env && echo noenv; test ! -e /app/node_modules/vitest && test ! -e /app/node_modules/tsx && test ! -e /app/node_modules/prisma && echo nodev; command -v npm || command -v pnpm || echo nopm"]);
    expect(r.out.trim().split("\n")).toEqual(["10001", "noenv", "nodev", "nopm"]);
    const env = JSON.parse((await docker(["image", "inspect", "--format", "{{json .Config.Env}}", IMAGE])).out) as string[];
    expect(env.filter((e) => /KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(e.split("=")[0]!))).toEqual([]);
  });
  it("contains no .env file and no copy of a runtime secret anywhere in the image filesystem", async () => {
    // The sentinel only exists in this container's environment; finding it on disk would mean the image (or the entrypoint) wrote it.
    const r = await docker(["run", "--rm", "--entrypoint", "sh", ...envArgs({ LLM_API_KEY: SENTINEL }), IMAGE, "-c",
      'find / -xdev \\( -name ".env" -o -name ".env.*" \\) -not -path "/proc/*" 2>/dev/null; grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -- "$LLM_API_KEY" / 2>/dev/null; echo done']);
    expect(r.out.trim()).toBe("done");
    expect(r.out).not.toContain(SENTINEL);
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
