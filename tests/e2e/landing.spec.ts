import { expect, test } from "@playwright/test";
import { createUser, deleteCreatedUsers, signIn } from "./support/helpers";

test.afterAll(deleteCreatedUsers);

test("a signed-in visitor on / is redirected to the dashboard", async ({ page }) => {
  await signIn(page, await createUser());
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("signed-out visitors see the landing page with working entry links", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get started" }).first()).toHaveAttribute("href", "/login");
  const signIn = page.getByRole("banner").getByRole("link", { name: "Sign in" });
  await expect(signIn).toHaveAttribute("href", "/login");
  await signIn.click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
