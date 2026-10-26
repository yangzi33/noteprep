import { expect, test } from "@playwright/test";
import { createDraft, createUser, deleteCreatedUsers, signIn, startStorageWorker, type RunningWorker } from "./support/helpers";

// Runs in the "chromium-daily" project: the server on port 3103 (DAILY_REFRESH_ENABLED=1, DAILY_REFRESH_LIMIT=5, see playwright.config.ts),
// against a real worker process that shares the database. The perk-off journey is covered by the default-server specs.
test.afterAll(async () => {
  await deleteCreatedUsers();
});

const REMINDER = "5 of 5 left today";

test("daily refresh: the reminder shows the count once, an export uses one, the dashboard says 4 of 5", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);

  await page.goto("/dashboard");
  await expect(page.getByTestId("refresh-reminder")).toContainText(REMINDER);
  await expect(page.getByTestId("allowance")).not.toContainText("lesson packs left");

  await page.goto("/prepare");
  await expect(page.getByTestId("refresh-reminder")).toContainText(REMINDER);
  await expect(page.getByTestId("allowance")).not.toContainText("lesson packs left");

  const worker: RunningWorker = await startStorageWorker();
  try {
    await createDraft(page);
    await page.getByTestId("draft-export").click();
    await expect(page.getByTestId("export-confirm")).toBeVisible();
    await expect(page.getByTestId("refresh-reminder")).toContainText(REMINDER);
    await expect(page.getByTestId("export-after")).toHaveText("After this export you will have 4 left today.");

    // Same steps and waits as exportDraft in support/helpers.ts, minus its draft-export click (we are already on the confirm page).
    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 45_000 });
  } finally {
    await worker.stop();
  }

  await page.goto("/dashboard");
  await expect(page.getByTestId("refresh-reminder")).toContainText("4 of 5 left today");
});
