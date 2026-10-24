import { defineConfig, devices } from "@playwright/test";
import { E2E_URLS, e2eEnv } from "./tests/e2e/support/env";

const env = e2eEnv();
// Three servers from one production build, each with both flags pinned (so a developer's own .env cannot change what they do):
//   3100  FLOW_MODE=draft,  EXPORT_ENABLED=1  project "chromium" (default): everything except the specs below
//   3101  FLOW_MODE=legacy, EXPORT_ENABLED=0  project "chromium-legacy": legacy-*.spec.ts (the old generate flow, kept as a kill switch)
//   3102  FLOW_MODE=draft,  EXPORT_ENABLED=0  project "chromium-paused": *-paused.spec.ts (the documented export pause / rollback state)
const LEGACY_SPEC = /legacy-[^/]*\.spec\.ts$/;
const PAUSED_SPEC = /[^/]*-paused\.spec\.ts$/;
const serverEnv = {
  NEXT_PUBLIC_SUPABASE_URL: env.apiUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.publishableKey,
  NEXT_PUBLIC_SITE_URL: env.webUrl,
  DATABASE_URL: env.webDatabaseUrl,
  CURRICULUM_ALLOW_SAMPLE: "1",
  // Pinned so a developer's own .env (for example EXPORT_ENABLED=0 for manual testing) cannot change what these servers do.
  FLOW_MODE: "draft",
  EXPORT_ENABLED: "1",
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
    { name: "chromium", testIgnore: [LEGACY_SPEC, PAUSED_SPEC], use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-legacy", testMatch: LEGACY_SPEC, use: { ...devices["Desktop Chrome"], baseURL: E2E_URLS.legacy } },
    { name: "chromium-paused", testMatch: PAUSED_SPEC, use: { ...devices["Desktop Chrome"], baseURL: E2E_URLS.paused } },
  ],
  webServer: [
    {
      command: "pnpm build && pnpm exec next start -p 3100",
      url: `${E2E_URLS.default}/healthz`,
      timeout: 240_000,
      reuseExistingServer: false,
      env: serverEnv,
    },
    {
      // Started after the build above has finished (Playwright starts web servers one after another).
      command: "pnpm exec next start -p 3101",
      url: `${E2E_URLS.legacy}/healthz`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...serverEnv, FLOW_MODE: "legacy", EXPORT_ENABLED: "0" },
    },
    {
      command: "pnpm exec next start -p 3102",
      url: `${E2E_URLS.paused}/healthz`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...serverEnv, EXPORT_ENABLED: "0" },
    },
  ],
});
