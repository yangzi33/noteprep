import { expect, test } from "@playwright/test";
import { allowanceText, createUser, deleteCreatedUsers, signIn, startWorker } from "./support/helpers";

test.afterAll(deleteCreatedUsers);

const options = (page: import("@playwright/test").Page) => page.getByTestId("options").locator("li");

test("choose a curriculum topic step by step, generate, and see the lesson finish", async ({ page }) => {
  const user = await createUser();
  const worker = await startWorker();
  try {
    await signIn(page, user);
    await page.goto("/prepare");
    await expect(page.getByTestId("allowance")).toHaveText("3 of 3 generations left.");

    await page.getByRole("link", { name: "Sample Mathematics (not a real curriculum)" }).click();
    await expect(page.getByTestId("sample-banner")).toBeVisible(); // sample data is always labelled
    await expect(page.getByTestId("options")).toHaveAttribute("data-step", "level");
    await page.getByRole("link", { name: "Sample Level A" }).click();
    await expect(page.getByTestId("options")).toHaveAttribute("data-step", "course");
    await page.getByRole("link", { name: /Sample Course 1/ }).click();
    await expect(page.getByTestId("options")).toHaveAttribute("data-step", "unit");
    await page.getByRole("link", { name: "Sample unit: Equations" }).click();

    // topics: two supported ones, one partly covered
    await expect(page.getByTestId("options")).toHaveAttribute("data-step", "topic");
    await expect(options(page)).toHaveCount(3);
    await expect(options(page).nth(2)).toContainText("(partly covered)");

    await page.getByRole("link", { name: "Sample topic: Unknown on both sides" }).click();
    await expect(page.getByTestId("topic-summary")).toContainText("Sample objective: solve one-unknown equations");
    await expect(page.getByTestId("topic-summary")).toContainText("Solving equations with one unknown"); // prerequisite

    await page.getByRole("button", { name: "Generate lesson" }).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("job-status")).toHaveAttribute("data-state", "succeeded");
    expect(await allowanceText(page)).toBe("2 of 3 generations left.");
  } finally {
    await worker.stop();
  }
});

test("topics we cannot verify are shown as unavailable and cannot be chosen, even by editing the URL", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  const base = "sample-math@sample-1/level-a/course-1";
  await page.goto(`/prepare?v=sample-math@sample-1&level=sample-math@sample-1/level-a&course=${base}&unit=${base}/shapes`);
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute("data-unsupported", "true");
  await expect(options(page).first().getByRole("link")).toHaveCount(0);

  await page.goto(`/prepare?v=sample-math@sample-1&level=sample-math@sample-1/level-a&course=${base}&unit=${base}/shapes&topic=${base}/shapes/areas`);
  await expect(page.getByTestId("unsupported-topic")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate lesson" })).toHaveCount(0);
});

test("a selection that does not fit together is refused politely, not with an error page", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await page.goto("/prepare?v=sample-math@sample-1&course=sample-math@sample-1/level-a/course-1"); // a course without its level
  await expect(page.getByTestId("bad-selection")).toBeVisible();
  await page.goto("/prepare?v=no-such-version");
  await expect(page.getByTestId("bad-selection")).toBeVisible();
});

test("refreshing and going back keep the wizard where it was, because the URL is the state", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await page.goto("/prepare");
  await page.getByRole("link", { name: "Sample Mathematics (not a real curriculum)" }).click();
  await page.getByRole("link", { name: "Sample Level A" }).click();
  await expect(page).toHaveURL(/level=/); // let the navigation finish before reloading
  await page.reload();
  await expect(page.getByTestId("options")).toHaveAttribute("data-step", "course");
  await page.goBack();
  await expect(page.getByTestId("options")).toHaveAttribute("data-step", "level");
});

test("a signed-out visitor is sent to sign in", async ({ page }) => {
  await page.goto("/prepare");
  await expect(page).toHaveURL(/\/login/);
});
