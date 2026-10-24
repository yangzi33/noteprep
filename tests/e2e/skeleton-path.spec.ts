import { expect, test, type Page } from "@playwright/test";
import {
  allowanceText,
  bucketOf,
  chooseTopic,
  createDraft,
  createUser as createTestUser,
  deleteCreatedUsers,
  exportDraft,
  signIn,
  signedInPage,
  sql,
  startStorageWorker,
  type RunningWorker,
} from "./support/helpers";

// The new flow end to end on the default server (3100: FLOW_MODE=draft, EXPORT_ENABLED=1): sign in, draft, export, history; one charge per
// export; cancel, timeout and exhaustion give or keep the allowance; ownership; signed-out redirects. Only one worker runs at a time.
const userIds: string[] = [];
const createUser = async () => {
  const user = await createTestUser();
  userIds.push(user.id);
  return user;
};

test.afterAll(async () => {
  // Every export these tests started is settled consistently and no counter drifts.
  expect(await sql(`SELECT export_id FROM export_state_drift WHERE export_id IN (SELECT id FROM export WHERE owner_id = ANY($1::uuid[]))`, [userIds])).toEqual([]);
  expect(await sql(`SELECT bucket_id FROM usage_bucket_drift WHERE bucket_id IN (SELECT id FROM usage_bucket WHERE owner_id = ANY($1::uuid[]))`, [userIds])).toEqual([]);
  expect(await sql(`SELECT id FROM export WHERE state = 'pending' AND owner_id = ANY($1::uuid[])`, [userIds])).toEqual([]);
  await deleteCreatedUsers();
});

const FULL = "3 of 3 generations left.";
const historyItems = (page: Page) => page.getByTestId("history-list").locator("li");

async function withWorker<T>(run: () => Promise<T>, overrides: Record<string, string> = {}): Promise<T> {
  const worker: RunningWorker = await startStorageWorker(overrides);
  try {
    return await run();
  } finally {
    await worker.stop();
  }
}

/** From a draft page: open the confirmation page and confirm (no waiting for the result). */
async function confirmExport(page: Page, pageFormat?: "letter" | "a4") {
  await page.getByTestId("draft-export").click();
  await expect(page.getByTestId("export-confirm")).toBeVisible();
  if (pageFormat) await page.getByTestId(`export-format-${pageFormat}`).check();
  await page.getByTestId("export-confirm").click();
}

test("sign in, select, draft, export, and find the lesson in the history", async ({ page }) => {
  const user = await createUser();
  await withWorker(async () => {
    await signIn(page, user);
    expect(await allowanceText(page, "/prepare")).toBe(FULL);
    const draftId = await createDraft(page);
    expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 0 }]);

    const { exportId, lessonId, revisionId } = await exportDraft(page);
    expect(await bucketOf(user.id)).toEqual([{ used: 1, reserved: 0 }]);
    expect(await allowanceText(page)).toBe("2 of 3 generations left.");
    await expect(historyItems(page)).toHaveCount(1);
    await expect(historyItems(page).first()).toHaveAttribute("data-state", "succeeded");
    await historyItems(page).first().getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/lessons/${lessonId}\\?rev=${revisionId}`));
    expect(await sql(`SELECT id FROM export WHERE id = $1 AND owner_id = $2`, [exportId, user.id])).toHaveLength(1);
    // the draft stays listed and free to reopen
    await page.goto("/lessons");
    await expect(page.getByTestId("drafts-section").locator(`a[href="/drafts/${draftId}"]`)).toHaveCount(1);
  });
});

test("a double submit and a refresh never create or charge a second export", async ({ page }) => {
  const user = await createUser();
  await withWorker(async () => {
    await signIn(page, user);
    await createDraft(page);
    await page.getByTestId("draft-export").click();
    await expect(page.getByTestId("export-confirm")).toBeVisible();
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("form:has([data-testid=export-confirm])")!;
      form.requestSubmit(); // two submissions of one rendered form, one idempotency key
      form.requestSubmit();
    });
    await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 45_000 });
    await page.reload();
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded");
    expect(await allowanceText(page)).toBe("2 of 3 generations left.");
    expect(await sql(`SELECT count(*)::int AS n FROM export WHERE owner_id = $1`, [user.id])).toEqual([{ n: 1 }]);
    expect(await bucketOf(user.id)).toEqual([{ used: 1, reserved: 0 }]);
  });
});

test("canceling a queued export keeps the allowance: nothing was used", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user); // no worker: the export stays queued
  await createDraft(page);
  await confirmExport(page);
  await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "queued");
  expect(await allowanceText(page)).toBe("2 of 3 generations left (1 in progress).");
  await page.goto(`/exports/${(await sql<{ id: string }>(`SELECT id FROM export WHERE owner_id = $1`, [user.id]))[0]!.id}`); // state survives leaving and returning
  await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "queued");
  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "canceled");
  await expect(page.getByTestId("export-charge")).toHaveText("No generation was used.");
  expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 0 }]);
  expect(await allowanceText(page)).toBe(FULL);
});

test("an export that cannot finish in time fails clearly and says no generation was used", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await createDraft(page);
  await confirmExport(page);
  await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
  const exportId = page.url().split("/").pop()!;
  await sql(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = (SELECT job_id FROM export WHERE id = $1)`, [exportId]);

  await withWorker(async () => {
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "failed", { timeout: 45_000 }); // polling picks it up
    await expect(page.getByTestId("export-status")).toContainText("took too long");
    await expect(page.getByTestId("export-charge")).toHaveText("No generation was used.");
    expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 0 }]);
    expect(await allowanceText(page)).toBe(FULL);
  });
});

test("after three charged exports the fourth is refused with a notice and reserves nothing", async ({ page }) => {
  test.setTimeout(150_000);
  const user = await createUser();
  await withWorker(async () => {
    await signIn(page, user);
    const draftId = await createDraft(page);
    await exportDraft(page, { pageFormat: "letter" }); // 1
    await page.goto(`/drafts/${draftId}`);
    await exportDraft(page, { pageFormat: "a4" }); // 2: another page format is another export
    await page.goto(`/drafts/${draftId}?doc=worksheet`);
    await page.getByRole("button", { name: "Remove question 1" }).click();
    await expect(page.getByTestId("changes-indicator")).toHaveText("1 question removed");
    await exportDraft(page, { pageFormat: "letter" }); // 3: changed content
    expect(await bucketOf(user.id)).toEqual([{ used: 3, reserved: 0 }]);
    expect(await allowanceText(page, "/prepare")).toBe("0 of 3 generations left.");

    // the confirmation page still opens (an unchanged re-export would be free) but a new charge is refused by the server
    await page.goto(`/drafts/${draftId}`);
    await confirmExport(page, "a4"); // changed content in a4 is a new identity
    await expect(page.getByTestId("export-error")).toContainText("no generations left");
    await expect(page).not.toHaveURL(/\/exports\//);
    expect(await bucketOf(user.id)).toEqual([{ used: 3, reserved: 0 }]);
    expect(await sql(`SELECT count(*)::int AS n FROM export WHERE owner_id = $1`, [user.id])).toEqual([{ n: 3 }]);
    expect(await sql(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1 AND state IN ('queued','running')`, [user.id])).toEqual([{ n: 0 }]);
  });
});

test("one user cannot reach another user's draft, export or status", async ({ browser }) => {
  const [alice, mallory] = [await createUser(), await createUser()];
  const a = await signedInPage(browser, alice);
  const m = await signedInPage(browser, mallory);
  try {
    const draftId = await createDraft(a.page);
    await confirmExport(a.page); // queued: no worker
    await expect(a.page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
    const exportId = a.page.url().split("/").pop()!;

    for (const path of [`/drafts/${draftId}`, `/drafts/${draftId}/export`, `/exports/${exportId}`]) {
      expect((await m.page.goto(path))?.status(), path).toBe(404);
    }
    expect((await m.context.request.get(`/api/exports/${exportId}`)).status()).toBe(404);
    const anonymous = await browser.newContext();
    expect((await anonymous.request.get(`/api/exports/${exportId}`, { failOnStatusCode: false })).status()).toBe(401);
    await anonymous.close();

    await m.page.goto("/lessons");
    await expect(m.page.getByTestId("history-list")).toHaveCount(0);
    await expect(m.page.getByTestId("drafts-section")).toHaveCount(0);
    expect(await bucketOf(mallory.id)).toEqual([{ used: 0, reserved: 0 }]);
    expect((await a.context.request.get(`/api/exports/${exportId}`)).status()).toBe(200);

    await a.page.getByRole("button", { name: "Cancel export" }).click(); // leave nothing pending
    await expect(a.page.getByTestId("export-status")).toHaveAttribute("data-phase", "canceled");
  } finally {
    await a.context.close();
    await m.context.close();
  }
});

test("signed-out visitors are sent to sign in, including drafts and exports", async ({ page }) => {
  for (const path of ["/dashboard", "/lessons", "/lessons/new", "/prepare", "/account", "/drafts/x", "/drafts/x/export", "/exports/x"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/login/);
  }
});

test("/lessons/new sends a signed-in tutor to /prepare and reserves nothing", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await page.goto("/lessons/new");
  await expect(page).toHaveURL(/\/prepare$/);
  await chooseTopic(page); // the selection flow is what is offered
  await expect(page.getByRole("button", { name: "Generate lesson" })).toHaveCount(0);
  expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 0 }]);
  expect(await sql(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [user.id])).toEqual([{ n: 0 }]);
});
