import { defineConfig, devices } from "@playwright/test";
import { e2eEnv } from "./tests/e2e/support/env";

const env = e2eEnv();
// The draft flow (FLOW_MODE=draft, D-106) needs its own server: the flag is a server-side setting, and every other spec must
// keep running against the default "legacy" server. Both serve the same production build, on different ports.
const draftWebUrl = "http://127.0.0.1:3101";
const DRAFT_SPEC = /draft-flow\.spec\.ts$/;
const serverEnv = {
  NEXT_PUBLIC_SUPABASE_URL: env.apiUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.publishableKey,
  NEXT_PUBLIC_SITE_URL: env.webUrl,
  DATABASE_URL: env.webDatabaseUrl,
  CURRICULUM_ALLOW_SAMPLE: "1",
};

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
  projects: [
    { name: "chromium", testIgnore: DRAFT_SPEC, use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-draft", testMatch: DRAFT_SPEC, use: { ...devices["Desktop Chrome"], baseURL: draftWebUrl } },
  ],
  webServer: [
    {
      command: "pnpm build && pnpm exec next start -p 3100",
      url: `${env.webUrl}/healthz`,
      timeout: 240_000,
      reuseExistingServer: false,
      env: serverEnv,
    },
    {
      // Started after the build above has finished (Playwright starts web servers one after another).
      command: "pnpm exec next start -p 3101",
      url: `${draftWebUrl}/healthz`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...serverEnv, FLOW_MODE: "draft" },
    },
  ],
});
