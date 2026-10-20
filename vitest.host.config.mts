import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const DIGEST_PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

// With HOST_SANDBOX_STRICT=1 (the runbook sets it on the worker host) the run must name the compile image by digest, so a
// moving tag can never be what the host sandbox tests exercise. Without it (local runs, CI) any LATEX_IMAGE is accepted.
export function assertHostSandboxEnv(env: Record<string, string | undefined>): void {
  if (env.HOST_SANDBOX_STRICT !== "1") return;
  const image = env.LATEX_IMAGE;
  if (!image) throw new Error("HOST_SANDBOX_STRICT=1 requires LATEX_IMAGE to be set");
  if (!DIGEST_PINNED.test(image)) throw new Error("HOST_SANDBOX_STRICT=1 requires LATEX_IMAGE pinned by digest (name@sha256:<64 hex>)");
}

// Per-user, per-run cache location so concurrent runs and different users never share (or pre-plant) a fixed /tmp path.
export function hostCacheDir(tmp: string, uid: number, pid: number): string {
  return join(tmp, `noteprep-vitest-${uid}-${pid}`);
}

assertHostSandboxEnv(process.env);
const cache = hostCacheDir(tmpdir(), process.getuid?.() ?? 0, process.pid);

// Sandbox tests that run ON THE WORKER HOST inside the hosttest image (runbook section 10), with the worker's identity and
// docker socket mount but no secrets. There is no globalSetup because there is no database on the host. The full-chain test
// (tests/latex/pipeline.test.ts) needs Postgres, so it is excluded here and covered by CI and the staging smoke test.
// Mounting the host's /var/run/docker.sock and running with --user 0 (as ci.yml does) is a LOCAL/CI-only convenience on a
// throwaway runner. It is NEVER the production arrangement: on the worker host use the dedicated runner socket and uid 10001.
export default defineConfig({
  cacheDir: cache,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // The image root is read-only and only /tmp is writable (vitest 5 would otherwise write under node_modules).
    fsModuleCachePath: cache,
    include: ["tests/latex/**/*.test.ts"],
    exclude: ["tests/latex/pipeline.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
