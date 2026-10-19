import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests that need Docker and the real compilation image (build it first: pnpm latex:image). They never skip: a missing
// image is a failure, because reading the Dockerfile does not show that the sandbox works.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/latex/**/*.test.ts"],
    // The full-chain test uses the same temporary Postgres as the integration tests (pnpm db:up locally).
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
