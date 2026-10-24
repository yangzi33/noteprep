import { expect, test } from "@playwright/test";
import { createUser, deleteCreatedUsers, signIn, sql } from "./support/helpers";

// Runs in the "chromium-paused" project: the server on port 3102 (FLOW_MODE=draft, EXPORT_ENABLED=0, see playwright.config.ts).
// This is the documented pause and rollback state: drafts work, export is switched off. No worker is needed.
test.afterAll(deleteCreatedUsers);

const COURSE = "sample-math@sample-1/level-a/course-1";

test("with export paused, the draft page says so with a disabled button and the confirm page has no form", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await page.goto("/prepare");
  await expect(page.getByTestId("selection-fields")).toHaveAttribute("data-hydrated", "true");
  await page.getByTestId("select-v").selectOption({ label: "Sample Mathematics (not a real curriculum)" });
  await expect(page.getByTestId("select-level")).toBeEnabled();
  await page.getByTestId("select-level").selectOption({ label: "Sample Level A" });
  await expect(page.getByTestId("select-course")).toBeEnabled();
  await page.getByTestId("select-course").selectOption(COURSE);
  await expect(page.getByTestId("select-unit")).toBeEnabled();
  await page.getByTestId("select-unit").selectOption({ label: "Sample unit: Equations" });
  await expect(page.getByTestId("select-topic")).toBeEnabled();
  await page.getByTestId("select-topic").selectOption({ label: "Sample topic: Unknown on both sides" });
  await expect(page).toHaveURL(/topic=/);
  await page.getByRole("button", { name: "Create draft preview" }).click();
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  const draftId = page.url().split("/").pop()!;

  await expect(page.getByTestId("draft-export-disabled")).toBeDisabled();
  await expect(page.getByText("PDF export is paused right now. Your draft is saved.")).toBeVisible();
  await expect(page.getByTestId("draft-export")).toHaveCount(0);

  await page.goto(`/drafts/${draftId}/export`);
  await expect(page.getByTestId("export-disabled")).toBeVisible();
  await expect(page.getByTestId("export-confirm")).toHaveCount(0);
  await expect(page.locator("input[name=expectedRev]")).toHaveCount(0);

  const exports = await sql(`SELECT e.id FROM export e JOIN export_snapshot s ON s.id = e.snapshot_id WHERE s.draft_id = $1`, [draftId]);
  expect(exports).toHaveLength(0);
  expect(await sql(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [user.id])).toEqual([{ used: 0, reserved: 0 }]);
});
