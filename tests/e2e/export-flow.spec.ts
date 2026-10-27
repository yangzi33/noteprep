import { expect, test, type Browser, type Page } from "@playwright/test";
import { allowanceText, createUser as createTestUser, deleteCreatedUsers, signIn, sql, startStorageWorker, type RunningWorker, type TestUser } from "./support/helpers";

// Runs in the default "chromium" project: the server on port 3100 (FLOW_MODE=draft, EXPORT_ENABLED=1, see playwright.config.ts),
// against a real worker process that shares the database. Only one worker runs at a time in this file.
const userIds: string[] = [];
const createUser = async () => {
  const user = await createTestUser();
  userIds.push(user.id);
  return user;
};

test.afterAll(async () => {
  // Every export these tests started must be settled consistently (the isolation test cancels its own), and no counter drifts.
  expect(await sql(`SELECT export_id FROM export_state_drift WHERE export_id IN (SELECT id FROM export WHERE owner_id = ANY($1::uuid[]))`, [userIds])).toEqual([]);
  expect(await sql(`SELECT bucket_id FROM usage_bucket_drift WHERE bucket_id IN (SELECT id FROM usage_bucket WHERE owner_id = ANY($1::uuid[]))`, [userIds])).toEqual([]);
  expect(await sql(`SELECT id FROM export WHERE state = 'pending' AND owner_id = ANY($1::uuid[])`, [userIds])).toEqual([]);
  await deleteCreatedUsers();
});

const SAMPLE = "sample-math@sample-1";
const COURSE = `${SAMPLE}/level-a/course-1`;
const FULL_ALLOWANCE = "3 of 3 free lesson packs left.";
const PROMISE = "This will use 1 lesson pack when your PDFs are ready. If export fails, no lesson pack is used.";
const DOCS = ["notes", "worksheet", "solutions"] as const;

async function chooseTopic(page: Page) {
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
}

/** Signs in, creates a draft on the worksheet tab, returns its id. */
async function newDraft(page: Page, user: TestUser) {
  await signIn(page, user);
  await chooseTopic(page);
  await page.getByRole("button", { name: "Create draft preview" }).click();
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  const draftId = page.url().split("/").pop()!;
  await page.getByTestId("document-tabs").getByRole("link", { name: "Student Practice Worksheet" }).click();
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "worksheet");
  return draftId;
}

async function replaceQuestion3(page: Page) {
  await page.getByRole("button", { name: "Replace question 3" }).click();
  await page.getByTestId("accept-candidate").click();
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question replaced");
}

async function openConfirm(page: Page) {
  await page.getByTestId("draft-export").click();
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}\/export\?v=[0-9a-f-]{36}&rev=\d+$/);
  await expect(page.getByTestId("export-confirm")).toBeVisible();
}

const exportsOf = (draftId: string) =>
  sql<{ id: string; state: string }>(`SELECT e.id, e.state FROM export e JOIN export_snapshot s ON s.id = e.snapshot_id WHERE s.draft_id = $1`, [draftId]);
const bucketOf = (userId: string) => sql(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [userId]);

async function withWorker<T>(run: () => Promise<T>, overrides: Record<string, string> = {}): Promise<T> {
  const worker: RunningWorker = await startStorageWorker(overrides);
  try {
    return await run();
  } finally {
    await worker.stop();
  }
}

async function otherUserPage(browser: Browser, baseURL: string) {
  const other = await createUser();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, other);
  return { context, page };
}

test("full flow: confirm, export, settle once, download all three PDFs, and re-export of the same draft is free", async ({ page }) => {
  const user = await createUser();
  await withWorker(async () => {
    const draftId = await newDraft(page, user);
    await replaceQuestion3(page);
    await openConfirm(page);

    // the confirmation page says exactly what this costs, and offers no way to skip it
    await expect(page.getByTestId("export-promise")).toHaveText(PROMISE);
    await expect(page.getByTestId("export-balance")).toHaveText(FULL_ALLOWANCE);
    await expect(page.getByTestId("export-back")).toHaveText("Back to editing");
    await expect(page.getByTestId("export-documents").getByRole("listitem")).toHaveText(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    expect((await page.content()).toLowerCase()).not.toContain("show again");

    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
    const exportUrl = page.url();
    const exportId = exportUrl.split("/").pop()!;
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 45_000 });
    await expect(page.getByTestId("export-charge")).toHaveText("This used 1 lesson pack.");

    // the allowance reads 2 of 3, in the database and on the history page
    expect(await bucketOf(user.id)).toEqual([{ used: 1, reserved: 0 }]);
    expect(await allowanceText(page)).toBe("2 of 3 free lesson packs left.");

    // each download is a signed redirect to a PDF file, never a .tex (the signed URL is not logged)
    await page.goto(exportUrl);
    const links = page.getByTestId("export-files");
    for (const doc of DOCS) {
      const href = await links.getByTestId(`export-download-${doc}`).getAttribute("href");
      const redirect = await page.request.get(href!, { maxRedirects: 0 });
      expect(redirect.status()).toBe(302);
      const signed = redirect.headers()["location"]!;
      expect(signed).not.toContain(".tex");
      expect(new URL(signed).searchParams.get("download")).toMatch(/^[A-Za-z0-9-]+\.pdf$/);
      const file = await fetch(signed);
      expect(file.status).toBe(200);
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(0);
      // the placeholder compiler writes labelled placeholder files; only the real image makes real PDFs (as in lesson-preview.spec.ts)
      if (process.env.E2E_COMPILER === "docker") expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    }

    // a reload keeps the state
    await page.reload();
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded");
    await expect(page.getByTestId("export-charge")).toHaveText("This used 1 lesson pack.");

    // the same unchanged draft again: no new charge, no new export
    await page.goto(`/drafts/${draftId}`);
    await openConfirm(page);
    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(new RegExp(`/exports/${exportId}\\?outcome=reused$`));
    await expect(page.getByTestId("export-outcome-note")).toContainText("Downloading again is free");
    await expect(page.getByTestId("export-charge")).toHaveText("An export with the same content and page format already used 1 lesson pack. This one used none.");
    expect(await page.content()).not.toContain("This used 1 lesson pack.");
    expect(await allowanceText(page)).toBe("2 of 3 free lesson packs left.");
    expect(await bucketOf(user.id)).toEqual([{ used: 1, reserved: 0 }]);
    expect(await exportsOf(draftId)).toHaveLength(1);
  });
});

test("double submit makes one export and one charge", async ({ page }) => {
  const user = await createUser();
  await withWorker(async () => {
    const draftId = await newDraft(page, user);
    await openConfirm(page);
    const confirmUrl = page.url();

    // two submits of the very same rendered form (same key) in the same tick
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("form:has([data-testid=export-confirm])")!;
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}/);

    // and a reload-and-resubmit of the confirmation page (a new key for the same draft)
    const second = await page.context().newPage();
    await second.goto(confirmUrl);
    await second.getByTestId("export-confirm").click();
    await expect(second).toHaveURL(/\/exports\/[0-9a-f-]{36}/);
    await second.close();

    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 45_000 });
    // The authoritative proof of "one request, one charge" under real concurrency is the 10-parallel integration test
    // (tests/integration/export-confirm.test.ts); this only shows the browser path does not defeat it.
    const rows = await exportsOf(draftId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("succeeded");
    expect(await bucketOf(user.id)).toEqual([{ used: 1, reserved: 0 }]);
  });
});

test("a4: the radio group defaults to letter; confirming a4 exports once and a letter export of the same draft is a separate one", async ({ page }) => {
  const user = await createUser();
  await withWorker(async () => {
    const draftId = await newDraft(page, user);
    await openConfirm(page);
    await expect(page.getByTestId("export-format-letter")).toBeChecked();
    await expect(page.getByTestId("export-format-a4")).not.toBeChecked();
    await page.getByTestId("export-format-a4").check();
    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
    const a4Url = page.url();
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 45_000 });
    expect(await bucketOf(user.id)).toEqual([{ used: 1, reserved: 0 }]);
    const snap = await sql<{ page_format: string }>(`SELECT s.spec->>'pageFormat' AS page_format FROM export e JOIN export_snapshot s ON s.id = e.snapshot_id WHERE s.draft_id = $1`, [draftId]);
    expect(snap).toEqual([{ page_format: "a4" }]);

    // download one PDF; with the real compiler it is a real PDF
    const href = await page.getByTestId("export-files").getByTestId("export-download-worksheet").getAttribute("href");
    const redirect = await page.request.get(href!, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    const file = await fetch(redirect.headers()["location"]!);
    expect(file.status).toBe(200);
    if (process.env.E2E_COMPILER === "docker") expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

    // the same draft in letter is another export and another charge; a4 again is free and reuses the first
    await page.goto(`/drafts/${draftId}`);
    await openConfirm(page);
    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
    expect(page.url()).not.toBe(a4Url);
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 45_000 });
    expect(await bucketOf(user.id)).toEqual([{ used: 2, reserved: 0 }]);
    expect(await exportsOf(draftId)).toHaveLength(2);

    await page.goto(`/drafts/${draftId}`);
    await openConfirm(page);
    await page.getByTestId("export-format-a4").check();
    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(new RegExp(`${a4Url.split("/").pop()}\\?outcome=reused$`));
    expect(await bucketOf(user.id)).toEqual([{ used: 2, reserved: 0 }]);
  });
});

test("a failed export releases the reservation, says so only after the server did, and the draft stays editable", async ({ page }) => {
  const user = await createUser();
  await withWorker(
    async () => {
      const draftId = await newDraft(page, user);
      await openConfirm(page);
      await page.getByTestId("export-confirm").click();
      await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "failed", { timeout: 45_000 });
      await expect(page.getByTestId("export-charge")).toHaveText("No lesson pack was used.");

      const rows = await exportsOf(draftId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe("failed");
      expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 0 }]);
      expect(await allowanceText(page)).toBe(FULL_ALLOWANCE);

      await page.goto(`/drafts/${draftId}?doc=worksheet`);
      await expect(page.getByTestId("draft-title")).toBeVisible();
      await expect(page.getByTestId("question-controls").first()).toBeVisible();
      await expect(page.getByTestId("draft-export")).toBeVisible();
    },
    { COMPILER: "skeleton", SKELETON_COMPILER_FAIL: "compile_failed" },
  );
});

test("a stale confirmation page is refused with a notice, creates nothing, and an old rev link shows no form", async ({ page, context }) => {
  const user = await createUser();
  const draftId = await newDraft(page, user);
  const draftUrl = page.url().split("?")[0]!;
  await openConfirm(page);
  const staleUrl = page.url();
  const tabA = page;

  const tabB = await context.newPage();
  await tabB.goto(`${draftUrl}?doc=worksheet`);
  await tabB.getByRole("button", { name: "Remove question 1" }).click();
  await expect(tabB.getByTestId("changes-indicator")).toHaveText("1 question removed");

  await tabA.getByTestId("export-confirm").click();
  await expect(tabA).toHaveURL(new RegExp(`/drafts/${draftId}\\?v=[0-9a-f-]{36}&error=EXPORT_CONFLICT`));
  await expect(tabA.getByTestId("draft-error")).toContainText("This draft changed after you opened the confirmation page");
  await expect(tabA.getByTestId("draft-error")).toContainText("Nothing was used.");
  expect(await exportsOf(draftId)).toHaveLength(0);
  expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 0 }]);
  expect(await allowanceText(tabA)).toBe(FULL_ALLOWANCE);

  // a link made for the older revision shows the conflict and offers no form
  await tabA.goto(staleUrl);
  await expect(tabA.getByTestId("export-conflict")).toContainText("This draft changed after you opened the confirmation page");
  await expect(tabA.getByTestId("export-confirm")).toHaveCount(0);
  await expect(tabA.locator("input[name=expectedRev]")).toHaveCount(0); // none of the confirm form's fields
});

test("canceling a queued export releases it: canceled, no generation used", async ({ page }) => {
  // no worker is running, so the export stays queued
  const user = await createUser();
  const draftId = await newDraft(page, user);
  await openConfirm(page);
  await page.getByTestId("export-confirm").click();
  await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "queued");
  await expect(page.getByTestId("export-charge")).toHaveCount(0); // nothing is claimed while it is unsettled
  expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 1 }]);

  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "canceled");
  await expect(page.getByTestId("export-charge")).toHaveText("No lesson pack was used.");
  expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 0 }]);
  expect(await allowanceText(page)).toBe(FULL_ALLOWANCE);
  expect((await exportsOf(draftId))[0]!.state).toBe("failed");
});

test("another account gets 404 for an export and its status, and an anonymous caller gets 401", async ({ page, browser }) => {
  const user = await createUser();
  await newDraft(page, user);
  await openConfirm(page);
  await page.getByTestId("export-confirm").click();
  await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
  const exportId = page.url().split("/").pop()!;

  const base = new URL(page.url()).origin;
  const { context, page: otherPage } = await otherUserPage(browser, base);
  expect((await otherPage.request.get(`/exports/${exportId}`)).status()).toBe(404);
  expect((await otherPage.request.get(`/api/exports/${exportId}`)).status()).toBe(404);
  await context.close();

  const anonymous = await browser.newContext({ baseURL: base });
  const response = await anonymous.request.get(`/api/exports/${exportId}`);
  expect(response.status()).toBe(401);
  await anonymous.close();

  expect((await page.request.get(`/api/exports/${exportId}`)).status()).toBe(200);

  // leave nothing pending: no worker runs here, so cancel the queued export through the app
  await page.goto(`/exports/${exportId}`);
  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "canceled");
  expect(await bucketOf(user.id)).toEqual([{ used: 0, reserved: 0 }]);
});
