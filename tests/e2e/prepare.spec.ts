import { expect, test } from "@playwright/test";
import { allowanceText, createUser, deleteCreatedUsers, signIn, startWorker } from "./support/helpers";

test.afterAll(deleteCreatedUsers);

const SAMPLE = "sample-math@sample-1";
const LEVEL = `${SAMPLE}/level-a`;
const COURSE = `${LEVEL}/course-1`;
// Real choices only: the "" placeholder option is excluded.
const choices = (page: import("@playwright/test").Page, testId: string) => page.getByTestId(testId).locator('option:not([value=""])');

test("choose a curriculum topic with the dropdowns, generate, and see the lesson finish", async ({ page }) => {
  const user = await createUser();
  const worker = await startWorker();
  try {
    await signIn(page, user);
    await page.goto("/prepare");
    await expect(page.getByTestId("selection-fields")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByTestId("allowance")).toHaveText("3 of 3 generations left.");

    await expect(page.getByTestId("select-v")).toHaveValue(""); // nothing is chosen yet
    await page.getByTestId("select-v").selectOption({ label: "Sample Mathematics (not a real curriculum)" });
    await expect(page.getByTestId("sample-banner")).toBeVisible(); // sample data is always labelled
    await expect(page.getByTestId("select-level")).toBeEnabled();
    await expect(page.getByTestId("select-course")).toBeDisabled();

    await page.getByTestId("select-level").selectOption({ label: "Sample Level A" });
    await expect(page).toHaveURL(/level=/);
    await expect(page.getByTestId("select-course")).toBeEnabled();
    await expect(page.getByTestId("select-unit")).toBeDisabled();

    await page.getByTestId("select-course").selectOption(COURSE); // label is "Sample Course 1 (SAMPLE-1)"
    await expect(page.getByTestId("select-course").locator("option:checked")).toHaveText(/Sample Course 1/);
    await expect(page).toHaveURL(/course=/);
    await expect(page.getByTestId("select-unit")).toBeEnabled();
    await expect(page.getByTestId("select-topic")).toBeDisabled();

    await page.getByTestId("select-unit").selectOption({ label: "Sample unit: Equations" });
    await expect(page).toHaveURL(/unit=/);

    // topics: two supported ones, one partly covered
    await expect(page.getByTestId("select-topic")).toBeEnabled();
    await expect(choices(page, "select-topic")).toHaveCount(3);
    await expect(choices(page, "select-topic").nth(2)).toContainText("(partly covered)");

    await page.getByTestId("select-topic").selectOption({ label: "Sample topic: Unknown on both sides" });
    await expect(page).toHaveURL(/topic=/);
    await expect(page.getByTestId("topic-summary")).toContainText("Sample objective: solve one-unknown equations");
    await expect(page.getByTestId("topic-summary")).toContainText("Solving equations with one unknown"); // prerequisite

    await page.getByRole("button", { name: "Generate lesson" }).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    // the placeholder worker here does not store files in Storage, but the lesson is complete and opens on its preview page
    await expect(page).toHaveURL(/\/lessons\/[0-9a-f-]{36}\?rev=[0-9a-f-]{36}$/, { timeout: 45_000 });
    await expect(page.getByTestId("lesson-title")).toBeVisible();
    expect(await allowanceText(page)).toBe("2 of 3 generations left.");
  } finally {
    await worker.stop();
  }
});

test("topics we cannot verify are shown as unavailable and cannot be chosen, even by editing the URL", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  const base = COURSE;
  // the unit with nothing verifiable is listed but cannot be chosen
  await page.goto(`/prepare?v=${SAMPLE}&level=${LEVEL}&course=${base}`);
  const shapes = page.getByTestId("select-unit").locator(`option[value="${base}/shapes"]`);
  await expect(shapes).toBeDisabled();
  await expect(shapes).toContainText("nothing here is available yet");
  // and so is its only topic
  await page.goto(`/prepare?v=${SAMPLE}&level=${LEVEL}&course=${base}&unit=${base}/shapes`);
  await expect(choices(page, "select-topic")).toHaveCount(1);
  await expect(choices(page, "select-topic").first()).toBeDisabled();
  await expect(choices(page, "select-topic").first()).toContainText("not available yet");
  await expect(page.getByTestId("topic-hint")).toBeVisible();

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

test("refreshing and going back keep the selection where it was, because the URL is the state", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await page.goto("/prepare");
  await expect(page.getByTestId("selection-fields")).toHaveAttribute("data-hydrated", "true");
  await page.getByTestId("select-v").selectOption({ label: "Sample Mathematics (not a real curriculum)" });
  await expect(page.getByTestId("select-level")).toBeEnabled();
  await page.getByTestId("select-level").selectOption({ label: "Sample Level A" });
  await expect(page).toHaveURL(/level=/); // let the navigation finish before reloading
  await page.reload();
  await expect(page.getByTestId("select-level")).toHaveValue(LEVEL);
  await expect(page.getByTestId("select-course")).toBeEnabled();
  await page.goBack();
  await expect(page.getByTestId("select-level")).toHaveValue("");
  await expect(page.getByTestId("select-course")).toBeDisabled();
});

test("a signed-out visitor is sent to sign in", async ({ page }) => {
  await page.goto("/prepare");
  await expect(page).toHaveURL(/\/login/);
});
