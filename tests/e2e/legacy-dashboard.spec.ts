import { expect, test } from "@playwright/test";
import { createUser, deleteCreatedUsers, signIn, startWorker, submitLesson } from "./support/helpers";

// Runs in the "chromium-legacy" project (FLOW_MODE=legacy): the lesson is made through the legacy generate form.
test.afterAll(deleteCreatedUsers);

test("a populated dashboard shows one recent card whose link names its title", async ({ page }) => {
  const user = await createUser();
  const worker = await startWorker();
  try {
    await signIn(page, user);
    await submitLesson(page);
    await expect(page.getByTestId("job-status")).toHaveAttribute("data-state", "succeeded");
    await page.goto("/dashboard");

    const recent = page.getByRole("region", { name: "Recent activity" });
    await expect(recent.getByRole("listitem")).toHaveCount(1);
    await expect(recent.getByRole("link", { name: "See all lesson packs" })).toHaveAttribute("href", "/lessons");
    await expect(recent.getByRole("listitem").getByRole("link")).toHaveAttribute("aria-label", /^(Open|View status): .+/);
  } finally {
    await worker.stop();
  }
});
