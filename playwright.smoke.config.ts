import { defineConfig, devices } from "@playwright/test";
import { smokeTarget } from "./tests/smoke/target";

// Real staging, no local servers. Nothing that could hold a cookie or a signed URL is recorded.
export default defineConfig({
  testDir: "tests/smoke",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: "list",
  use: { baseURL: smokeTarget(process.env).baseURL, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
