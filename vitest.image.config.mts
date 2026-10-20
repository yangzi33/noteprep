import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests that need Docker and the built worker image (pnpm worker:image, then set WORKER_IMAGE). A missing image is a failure, never a skip.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/image/**/*.test.ts"],
    // The boot test uses the same temporary Postgres as the integration tests (pnpm db:up locally).
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
