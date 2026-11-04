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
  await expect(page.getByTestId("saved-status")).toContainText(/GMT\+9$/);
  await expect(page.getByTestId("saved-status")).not.toContainText("UTC");
  const draftUrl = page.url();

  // Override in Account.
  await page.goto("/account");
  await expect(page.getByTestId("timezone-current")).toContainText("Asia/Tokyo (detected from your browser)");
  // Our own dropdown, not the browser's datalist.
  await expect(page.locator("datalist")).toHaveCount(0);
  const picker = page.getByRole("combobox", { name: "Time zone" });
  await picker.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await picker.fill("toronto");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: "America/Toronto" }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(picker).toHaveValue("America/Toronto");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page).toHaveURL(/\/account\?notice=timezone-saved$/);
  await expect(page.getByTestId("timezone-current")).toContainText("America/Toronto (your setting)");
  await page.goto(draftUrl);
  await expect(page.getByTestId("saved-status")).toContainText(/E[SD]T$/);

  // Persists across a reload.
  await page.reload();
  await expect(page.getByTestId("saved-status")).toContainText(/E[SD]T$/);

  // Keyboard: arrows move, Enter picks, Escape closes.
  await page.goto("/account");
  const keyboard = page.getByRole("combobox", { name: "Time zone" });
  await keyboard.fill("tokyo");
  await keyboard.press("ArrowDown");
  await keyboard.press("Enter");
  await expect(keyboard).toHaveValue("Asia/Tokyo");
  await keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  // Reopening with a chosen zone shows the whole list, and the active option exists.
  await keyboard.press("ArrowDown");
  expect(await page.getByRole("option").count()).toBeGreaterThan(100);
  // Dragging the native list scrollbar must not dismiss the dropdown.
  const listbox = page.getByRole("listbox");
  const listboxBounds = await listbox.boundingBox();
  expect(listboxBounds).not.toBeNull();
  await page.mouse.move(listboxBounds!.x + listboxBounds!.width - 3, listboxBounds!.y + listboxBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(listboxBounds!.x + listboxBounds!.width - 3, listboxBounds!.y + listboxBounds!.height - 8);
  await expect(listbox).toBeVisible();
  await page.mouse.up();
  const activeId = await keyboard.getAttribute("aria-activedescendant");
  await expect(page.locator(`[id="${activeId}"]`)).toHaveText("Asia/Tokyo");
  await keyboard.press("End");
  await expect(page.getByRole("option").last()).toHaveAttribute("id", (await keyboard.getAttribute("aria-activedescendant"))!);
  await keyboard.press("Home");
  await keyboard.press("Escape");
  // Enter with no highlighted option submits the form as typed.
  await keyboard.fill("Europe/London");
  await page.getByRole("listbox").waitFor();
  await keyboard.press("Enter");
  await expect(page).toHaveURL(/notice=timezone-saved$/);
  await expect(page.getByTestId("timezone-current")).toContainText("Europe/London (your setting)");
  await page.goto("/account");

  // A name that is not in the list is refused and changes nothing.
  await page.goto("/account");
  await page.getByRole("combobox", { name: "Time zone" }).fill("Mars/Olympus");
  await expect(page.getByText("No matching time zone")).toBeVisible();
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Pick a time zone from the list" })).toBeVisible();
  await expect(page.getByTestId("timezone-current")).toContainText("Europe/London (your setting)");

  // Reset to Auto.
  await page.getByRole("button", { name: "Auto (detect)" }).click();
  await expect(page.getByTestId("timezone-current")).toContainText("Asia/Tokyo (detected from your browser)");
  await page.goto(draftUrl);
  await expect(page.getByTestId("saved-status")).toContainText(/GMT\+9$/);
});
