import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Sandbox tests that run ON THE WORKER HOST inside the hosttest image (runbook section 10), with the worker's identity and
// docker socket mount but no secrets. There is no globalSetup because there is no database on the host. The full-chain test
// (tests/latex/pipeline.test.ts) needs Postgres, so it is excluded here and covered by CI and the staging smoke test.
export default defineConfig({
  cacheDir: "/tmp/vitest-cache",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // The image root is read-only and only /tmp is writable (vitest 5 would otherwise write under node_modules).
    fsModuleCachePath: "/tmp/vitest-cache",
    include: ["tests/latex/**/*.test.ts"],
    exclude: ["tests/latex/pipeline.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
