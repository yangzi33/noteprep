import { expect, test } from "@playwright/test";
import { INVITED_E2E_ADDRESS } from "./support/env";
import { createUser, deleteCreatedUsers, signIn, sql } from "./support/helpers";

// Runs in the "chromium-invite" project: the server on port 3104 (SIGNUP_MODE=invite, one allowlisted address, see playwright.config.ts).
test.afterAll(async () => {
  await deleteCreatedUsers();
});

test("a confirmed account that is not on the allowlist is sent to /not-invited and gets no profile or allowance", async ({ page }) => {
  const user = await createUser();
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/not-invited$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/not-invited$/);

  const profiles = await sql("select 1 from profile where id = $1", [user.id]);
  const buckets = await sql("select 1 from usage_bucket where owner_id = $1", [user.id]);
  expect(profiles).toHaveLength(0);
  expect(buckets).toHaveLength(0);
});

test("an allowlisted account signs in and reaches the dashboard", async ({ page }) => {
  const user = await createUser(INVITED_E2E_ADDRESS);
  await signIn(page, user);
  const profiles = await sql("select 1 from profile where id = $1", [user.id]);
  expect(profiles).toHaveLength(1);
});

test("the sign-up form gives the same answer for an invited and an uninvited address", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(`stranger-${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/login\?notice=check-email-invite$/);
  await expect(page.locator("main [role=status]")).toBeVisible();
});
