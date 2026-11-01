import { expect, test } from "@playwright/test";

// Signed-out pages only: the cursor and user-select rules are global CSS plus a few classes, so no account is needed.

test("landing page: links feel clickable, headings are not selectable, FAQ answers are", async ({ page }) => {
  await page.goto("/");
  const getStarted = page.getByRole("link", { name: "Get started" }).first();
  await expect(getStarted).toHaveCSS("cursor", "pointer");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("user-select", "none");
  const faq = page.locator("#faq details").first();
  await expect(faq).toHaveJSProperty("open", true);
  await expect(faq.locator("p")).toHaveCSS("user-select", /^(text|auto)$/);
});

test("login: the Sign in button has the pointer cursor and the email field stays selectable", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCSS("cursor", "pointer");
  await expect(page.getByLabel("Email")).toHaveCSS("user-select", /^(text|auto)$/);
});
