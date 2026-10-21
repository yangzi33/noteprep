import { expect, test } from "@playwright/test";
import { createUser, deleteCreatedUsers, signIn, startWorker, submitLesson } from "./support/helpers";

test.afterAll(deleteCreatedUsers);

test("the dashboard greets a new account, shows the allowance and links to Create material", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A little less prep. More teaching.");
  await expect(page.getByTestId("allowance")).toHaveText("3 of 3 generations left.");
  await expect(page.getByRole("link", { name: "Create material" }).first()).toHaveAttribute("href", "/prepare");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

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
    await expect(recent.getByRole("link", { name: "See all materials" })).toHaveAttribute("href", "/lessons");
    await expect(recent.getByRole("listitem").getByRole("link")).toHaveAttribute("aria-label", /^(Open|View status): .+/);
  } finally {
    await worker.stop();
  }
});
