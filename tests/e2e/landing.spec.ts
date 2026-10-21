import { expect, test } from "@playwright/test";

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
