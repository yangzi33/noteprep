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
  const signIn = page.getByRole("banner").getByRole("link", { name: "Login" });
  await expect(signIn).toHaveAttribute("href", "/login");
  await signIn.click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("the landing page shows the real sample previews and its section anchors work", async ({ page }) => {
  await page.goto("/");
  const worksheet = page.getByRole("img", { name: /Student Practice Worksheet PDF/ });
  await expect(worksheet).toBeVisible();
  expect(await worksheet.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "Solutions / Answer Key" }).click();
  await expect(page.getByRole("img", { name: /Solutions and Answer Key PDF/ }).first()).toBeVisible();
  const open = page.getByRole("link", { name: /Open the sample PDF/ }).first();
  await expect(open).toHaveAttribute("href", "/samples/solutions.pdf");
  await expect(open).toHaveAttribute("target", "_blank");
  await page.getByRole("banner").getByRole("link", { name: "Pricing" }).click();
  await expect(page).toHaveURL(/#pricing$/);
  await expect(page.getByRole("heading", { name: "Start free, subscribe later" })).toBeInViewport();
});
