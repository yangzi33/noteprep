import { defineConfig, devices } from "@playwright/test";
import { e2eEnv } from "./tests/e2e/support/env";

const env = e2eEnv();

// Real browser, real local Supabase (Auth + Postgres), a production build of the app and, inside the
// tests, a real worker process. Run `pnpm supabase:start` first.
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/support/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: env.webUrl, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm build && pnpm exec next start -p 3100",
    url: `${env.webUrl}/healthz`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: env.apiUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.publishableKey,
      NEXT_PUBLIC_SITE_URL: env.webUrl,
      DATABASE_URL: env.webDatabaseUrl,
    },
  },
});
