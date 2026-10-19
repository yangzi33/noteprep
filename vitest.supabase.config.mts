import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Needs the local Supabase stack: pnpm supabase:start
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/supabase/**/*.test.ts"],
    globalSetup: ["tests/supabase/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
