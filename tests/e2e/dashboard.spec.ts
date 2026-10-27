import { expect, test } from "@playwright/test";
import { createDraft, createUser, deleteCreatedUsers, exportDraft, signIn, startStorageWorker } from "./support/helpers";

test.afterAll(deleteCreatedUsers);

test("the dashboard greets a new account, shows the allowance and links to Create lesson pack", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A little less prep. More teaching.");
  await expect(page.getByTestId("allowance")).toHaveText("3 of 3 free lesson packs left.");
  await expect(page.getByRole("link", { name: "Create lesson pack" }).first()).toHaveAttribute("href", "/prepare");
  await expect(page.getByText("Your exported lesson packs will appear here.")).toBeVisible();
  await expect(page.getByTestId("drafts-section")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("a populated dashboard shows an export card that opens its lesson revision and a draft card, and never says nothing is here", async ({ page }) => {
  const user = await createUser();
  const worker = await startStorageWorker();
  try {
    await signIn(page, user);
    await createDraft(page);
    const exported = await exportDraft(page); // draft 1 becomes one exported lesson
    const secondDraft = await createDraft(page); // draft 2 stays a draft
    await page.goto("/dashboard");

    const recent = page.getByRole("region", { name: "Recent activity" });
    await expect(recent.getByRole("listitem")).toHaveCount(1);
    await expect(recent.getByRole("link", { name: "See all lesson packs" })).toHaveAttribute("href", "/lessons");
    await expect(recent.getByRole("listitem").getByRole("link")).toHaveAttribute("aria-label", /^(Open|View status): .+/);
    await expect(page.getByText("Your exported lesson packs will appear here.")).toHaveCount(0);

    const drafts = page.getByTestId("drafts-section");
    await expect(drafts.locator(`a[href="/drafts/${secondDraft}"]`)).toHaveAttribute("aria-label", /^Open draft: .+/);

    await recent.getByRole("listitem").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/lessons/${exported.lessonId}\\?rev=${exported.revisionId}`));
  } finally {
    await worker.stop();
  }
});
