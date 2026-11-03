import { expect, test } from "@playwright/test";
import { createDraft, createUser, deleteCreatedUsers, signIn } from "./support/helpers";

test.afterAll(deleteCreatedUsers);

// A zone far from UTC and from the host, so a UTC or host-zone display cannot pass by accident.
test.use({ timezoneId: "Asia/Tokyo" });

test("times default to the browser zone, a saved zone overrides it, and Auto goes back", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await createDraft(page);

  // Default: the browser's zone (the first load may render UTC for a moment until the zone cookie arrives).
  await expect(page.getByTestId("saved-status")).toContainText(/JST$/);
  await expect(page.getByTestId("saved-status")).not.toContainText("UTC");
  const draftUrl = page.url();

  // Override in Account.
  await page.goto("/account");
  await expect(page.getByTestId("timezone-current")).toContainText("Asia/Tokyo (detected from your browser)");
  await page.getByLabel("Time zone").fill("america/toronto");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page).toHaveURL(/\/account\?notice=timezone-saved$/);
  await expect(page.getByTestId("timezone-current")).toContainText("America/Toronto (your setting)");
  await page.goto(draftUrl);
  await expect(page.getByTestId("saved-status")).toContainText(/E[SD]T$/);

  // Persists across a reload.
  await page.reload();
  await expect(page.getByTestId("saved-status")).toContainText(/E[SD]T$/);

  // A name that is not in the list is refused and changes nothing.
  await page.goto("/account");
  await page.getByLabel("Time zone").fill("Mars/Olympus");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByRole("alert")).toContainText("Pick a time zone from the list");
  await expect(page.getByTestId("timezone-current")).toContainText("America/Toronto (your setting)");

  // Reset to Auto.
  await page.getByRole("button", { name: "Auto (detect)" }).click();
  await expect(page.getByTestId("timezone-current")).toContainText("Asia/Tokyo (detected from your browser)");
  await page.goto(draftUrl);
  await expect(page.getByTestId("saved-status")).toContainText(/JST$/);
});
