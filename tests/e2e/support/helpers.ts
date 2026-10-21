import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { e2eEnv } from "./env";

export const PASSWORD = "correct horse battery staple";

export interface TestUser {
  id: string;
  email: string;
}

const created: string[] = [];

/** A confirmed account created through the Auth admin API (the email round trip is covered elsewhere). */
export async function createUser(): Promise<TestUser> {
  const env = e2eEnv();
  const admin = createClient(env.apiUrl, env.secretKey, { auth: { persistSession: false } });
  const email = `e2e-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  created.push(data.user.id);
  return { id: data.user.id, email };
}

export async function deleteCreatedUsers() {
  const env = e2eEnv();
  const admin = createClient(env.apiUrl, env.secretKey, { auth: { persistSession: false } });
  await Promise.all(created.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
}

/** Signs in through the real form. */
export async function signIn(page: Page, user: TestUser) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

export async function signedInPage(browser: Browser, user: TestUser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user);
  return { context, page };
}

/** Fills and submits the new-lesson form; returns the job id from the resulting URL. */
export async function submitLesson(page: Page): Promise<string> {
  await page.goto("/lessons/new");
  await page.getByRole("button", { name: "Generate lesson" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop()!;
}

export async function allowanceText(page: Page, path: "/lessons" | "/lessons/new" = "/lessons") {
  await page.goto(path);
  return (await page.getByTestId("allowance").textContent())?.trim() ?? "";
}

export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: e2eEnv().dbUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

export interface RunningWorker {
  stop(): Promise<void>;
  logs(): string;
}

/** A real worker process (tsx worker/main.ts) with fast polling and sweeping. */
export async function startWorker(overrides: Record<string, string> = {}): Promise<RunningWorker> {
  const env = e2eEnv();
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-e2e-store-"));
  const child: ChildProcess = spawn(path.resolve("node_modules/.bin/tsx"), ["--conditions=react-server", "worker/main.ts"], {
    env: {
      ...process.env,
      WORKER_DATABASE_URL: env.workerDatabaseUrl,
      ALLOW_FAKE_COMPILER: "1",
      OBJECT_STORE_DIR: storeDir,
      POLL_INTERVAL_MS: "200",
      SWEEP_INTERVAL_SECONDS: "1",
      LEASE_SECONDS: "10",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  await expect.poll(() => output, { timeout: 30_000 }).toContain("worker_started");
  return {
    logs: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/**
 * A worker that stores its files in the local Supabase Storage bucket, as the preview and download pages need.
 * Placeholder compiler by default; E2E_COMPILER=docker uses the real sandbox image (pnpm latex:image first).
 */
export async function startStorageWorker(): Promise<RunningWorker> {
  const env = e2eEnv();
  const real = process.env.E2E_COMPILER === "docker";
  return startWorker({
    OBJECT_STORE: "supabase",
    SUPABASE_URL: env.apiUrl,
    SUPABASE_SECRET_KEY: env.secretKey,
    ...(real ? { COMPILER: "docker", ALLOW_FAKE_COMPILER: "0" } : {}),
  });
}
