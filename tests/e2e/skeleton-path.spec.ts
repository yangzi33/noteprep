import { expect, test } from "@playwright/test";
import {
  allowanceText,
  createUser,
  deleteCreatedUsers,
  signIn,
  signedInPage,
  sql,
  startWorker,
  submitLesson,
} from "./support/helpers";

test.afterAll(deleteCreatedUsers);

const jobStatus = (page: import("@playwright/test").Page) => page.getByTestId("job-status");
const historyItems = (page: import("@playwright/test").Page) => page.getByTestId("history-list").locator("li");

test("sign in, generate a lesson, watch it finish, find it in the history", async ({ page }) => {
  const user = await createUser();
  const worker = await startWorker();
  try {
    await signIn(page, user);
    expect(await allowanceText(page, "/lessons/new")).toBe("3 of 3 generations left.");

    await submitLesson(page);
    await expect(jobStatus(page)).toHaveAttribute("data-state", "succeeded"); // reached by polling, no reload
    await expect(page.getByTestId("job-state")).toHaveText("Complete");

    expect(await allowanceText(page)).toBe("2 of 3 generations left.");
    await expect(historyItems(page)).toHaveCount(1);
    await expect(historyItems(page).first()).toHaveAttribute("data-state", "succeeded");
  } finally {
    await worker.stop();
  }
});

test("a double submit and a page refresh never create or consume a second generation", async ({ page }) => {
  const user = await createUser();
  const worker = await startWorker();
  try {
    await signIn(page, user);
    await page.goto("/lessons/new");
    await page.evaluate(() => {
      const form = document.querySelector("form[action], main form") as HTMLFormElement;
      form.requestSubmit(); // two submissions of the same form instance, carrying the same idempotency key
      form.requestSubmit();
    });
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await expect(jobStatus(page)).toHaveAttribute("data-state", "succeeded");

    await page.reload(); // state comes from the server, not from the browser
    await expect(jobStatus(page)).toHaveAttribute("data-state", "succeeded");

    expect(await allowanceText(page)).toBe("2 of 3 generations left.");
    await expect(historyItems(page)).toHaveCount(1);
  } finally {
    await worker.stop();
  }
});

test("canceling a waiting job returns its allowance", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user); // no worker: the job stays queued
  await submitLesson(page);
  await expect(jobStatus(page)).toHaveAttribute("data-state", "queued");
  await expect(page.getByTestId("job-state")).toHaveText("Waiting to start");
  expect(await allowanceText(page)).toBe("2 of 3 generations left (1 in progress).");

  await page.goBack(); // /lessons -> job page
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(jobStatus(page)).toHaveAttribute("data-state", "canceled");
  await expect(jobStatus(page)).toContainText("did not use one of your generations");
  expect(await allowanceText(page)).toBe("3 of 3 generations left.");
});

test("a job that cannot finish in time fails clearly and gives the allowance back", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  const jobId = await submitLesson(page);
  await sql(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = $1`, [jobId]);

  const worker = await startWorker(); // its sweeper ends the overdue job
  try {
    await expect(jobStatus(page)).toHaveAttribute("data-state", "failed"); // polling picks it up
    await expect(jobStatus(page)).toContainText("took too long");
    await expect(jobStatus(page)).toContainText("did not use one of your generations");
    expect(await allowanceText(page)).toBe("3 of 3 generations left.");
  } finally {
    await worker.stop();
  }
});

test("after three complete generations the fourth is refused, in the page and on the server", async ({ page }) => {
  const user = await createUser();
  const worker = await startWorker();
  try {
    await signIn(page, user);
    for (let i = 1; i <= 3; i++) {
      await submitLesson(page);
      await expect(jobStatus(page)).toHaveAttribute("data-state", "succeeded");
    }
    expect(await allowanceText(page, "/lessons/new")).toBe("0 of 3 generations left.");
    await expect(page.getByRole("button", { name: "Generate lesson" })).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("used all of your free generations");

    // The disabled button is only a convenience: submitting anyway is refused by the server.
    await page.evaluate(() => (document.querySelector("main form") as HTMLFormElement).requestSubmit());
    await expect(page.locator("p[role=alert]")).toContainText("no generations left"); // not Next's route announcer
    await page.goto("/lessons");
    await expect(historyItems(page)).toHaveCount(3);
  } finally {
    await worker.stop();
  }
});

test("one user cannot see or touch another user's job", async ({ browser }) => {
  const [alice, mallory] = [await createUser(), await createUser()];
  const a = await signedInPage(browser, alice);
  const m = await signedInPage(browser, mallory);
  try {
    const jobId = await submitLesson(a.page); // queued: no worker needed

    const response = await m.page.goto(`/jobs/${jobId}`);
    expect(response?.status()).toBe(404);
    expect((await m.context.request.get(`/api/jobs/${jobId}`)).status()).toBe(404);
    const anonymous = await browser.newContext();
    expect((await anonymous.request.get(`/api/jobs/${jobId}`, { failOnStatusCode: false })).status()).toBe(401);
    await anonymous.close();

    await m.page.goto("/lessons");
    await expect(m.page.getByTestId("history-list")).toHaveCount(0);
    expect(await sql(`SELECT state FROM generation_job WHERE id = $1`, [jobId])).toEqual([{ state: "queued" }]);
    expect((await a.context.request.get(`/api/jobs/${jobId}`)).status()).toBe(200);
  } finally {
    await a.context.close();
    await m.context.close();
  }
});

test("signed-out visitors are sent to sign in", async ({ page }) => {
  for (const path of ["/lessons", "/lessons/new", "/account"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});
