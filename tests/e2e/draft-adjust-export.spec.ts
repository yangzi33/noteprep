import { expect, test, type Page } from "@playwright/test";
import {
  allowanceText,
  chooseTopic,
  createDraft,
  createUser as createTestUser,
  deleteCreatedUsers,
  exportDraft,
  signIn,
  sql,
  startStorageWorker,
  type RunningWorker,
} from "./support/helpers";

/**
 * The single readable end-to-end journey of CLAUDE.md section 11, on the default server (3100: FLOW_MODE=draft, EXPORT_ENABLED=1):
 * sign in, select (only the chosen curriculum's options), free draft, preview the three documents, replace and remove, create another
 * version and switch back, confirm export (one reservation), success (one generation used), free re-download, free re-confirm
 * (`reused`), history; then trial exhaustion. Browser back and refresh at the key steps must change nothing, verified with SQL counts.
 *
 * Out of scope here: Stripe and subscriptions (Phase 3 work; nothing in S6 touches billing).
 * Covered elsewhere, not repeated: double submit, cancel, timeout, cross-user denial and signed-out redirects (skeleton-path.spec.ts);
 * the fourth-export refusal by itself (skeleton-path.spec.ts; test 2 here adds versions, re-export and free drafts at zero);
 * replace/undo/conflict details (draft-flow.spec.ts); a4 and settlement internals (export-flow.spec.ts).
 * Set E2E_COMPILER=docker (after `pnpm latex:image`) to make the downloads real PDFs.
 */
const userIds: string[] = [];
const createUser = async () => {
  const user = await createTestUser();
  userIds.push(user.id);
  return user;
};

test.afterAll(async () => {
  expect(await sql(`SELECT export_id FROM export_state_drift WHERE export_id IN (SELECT id FROM export WHERE owner_id = ANY($1::uuid[]))`, [userIds])).toEqual([]);
  expect(await sql(`SELECT bucket_id FROM usage_bucket_drift WHERE bucket_id IN (SELECT id FROM usage_bucket WHERE owner_id = ANY($1::uuid[]))`, [userIds])).toEqual([]);
  expect(await sql(`SELECT id FROM export WHERE state = 'pending' AND owner_id = ANY($1::uuid[])`, [userIds])).toEqual([]);
  await deleteCreatedUsers();
});

const SAMPLE = "sample-math@sample-1";
const DOCS = ["notes", "worksheet", "solutions"] as const;
const editing = (page: Page) => page.getByTestId("editing-version");
const equations = (page: Page) => page.getByTestId("draft-preview").locator(".katex-display annotation").allTextContents();
const historyItems = (page: Page) => page.getByTestId("history-list").locator("li");

/** Everything a stray click, back or refresh could change: reservations, exports, jobs and the bucket. */
async function ledger(userId: string) {
  const [reservations] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM usage_reservation WHERE owner_id = $1`, [userId]);
  const [exports] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM export WHERE owner_id = $1`, [userId]);
  const [jobs] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [userId]);
  const [bucket] = await sql<{ used: number; reserved: number }>(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [userId]);
  return { reservations: reservations!.n, exports: exports!.n, jobs: jobs!.n, used: bucket!.used, reserved: bucket!.reserved };
}

async function onWorksheet(page: Page) {
  await page.getByTestId("document-tabs").getByRole("link", { name: "Student Practice Worksheet" }).click();
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "worksheet");
}

test("journey: select, free draft, preview, adjust, versions, export once, free re-download and re-confirm, history", async ({ page }) => {
  test.setTimeout(150_000);
  const user = await createUser();
  const worker: RunningWorker = await startStorageWorker();
  try {
    // 1. sign in
    await signIn(page, user);
    expect(await allowanceText(page, "/prepare")).toBe("3 of 3 generations left.");

    // 2. select: each dependent dropdown offers only options of the chosen curriculum version
    await chooseTopic(page);
    for (const id of ["select-level", "select-course", "select-unit", "select-topic"]) {
      const values = await page.getByTestId(id).locator('option:not([value=""])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      expect(values.length, id).toBeGreaterThan(0);
      for (const value of values) expect(value.startsWith(SAMPLE), `${id}: ${value}`).toBe(true);
    }

    // 3. a free draft: the allowance is unchanged and nothing was reserved
    await page.getByRole("button", { name: "Create draft preview" }).click();
    await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
    const draftUrl = page.url();
    const draftId = draftUrl.split("/").pop()!;
    const empty = { reservations: 0, exports: 0, jobs: 0, used: 0, reserved: 0 };
    expect(await ledger(user.id)).toEqual(empty);
    expect(await sql(`SELECT count(*)::int AS n FROM usage_reservation WHERE owner_id = $1`, [user.id])).toEqual([{ n: 0 }]);
    expect(await allowanceText(page, "/prepare")).toBe("3 of 3 generations left.");
    await page.goto(draftUrl);

    // 4. preview Notes, Worksheet (no answers to the exercises), Solutions
    const preview = page.getByTestId("draft-preview");
    await expect(preview).toHaveAttribute("data-document", "notes");
    await expect(preview).toContainText("Teaching sequence");
    await onWorksheet(page);
    await expect(preview).toContainText("Solve each equation");
    await expect(preview).not.toContainText("Answer:");
    await expect(preview).not.toContainText("Worked solutions");
    await page.getByTestId("document-tabs").getByRole("link", { name: "Solutions / Answer Key" }).click();
    await expect(preview).toHaveAttribute("data-document", "solutions");
    await expect(preview).toContainText("Worked solutions");

    // back and refresh keep the draft and add nothing
    await page.goBack();
    await expect(preview).toHaveAttribute("data-document", "worksheet");
    await page.reload();
    await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "worksheet");
    expect(await ledger(user.id)).toEqual(empty);

    // 5. adjust: replace question 3 and accept it, remove question 1
    const original = await equations(page);
    await page.getByRole("button", { name: "Replace question 3" }).click();
    await expect(page.getByTestId("candidate-panel")).toBeVisible();
    await page.getByTestId("accept-candidate").click();
    await expect(page.getByTestId("changes-indicator")).toHaveText("1 question replaced");
    await page.getByRole("button", { name: "Remove question 1" }).click();
    await expect(page.getByTestId("changes-indicator")).toHaveText("1 question replaced · 1 removed");
    const v1 = await equations(page);
    expect(v1).toHaveLength(original.length - 1);
    await page.reload();
    expect(await equations(page)).toEqual(v1);
    expect(await ledger(user.id)).toEqual(empty);

    // 6. another version, then back to version 1 exactly as it was
    await page.getByTestId("create-version-btn").click();
    await expect(editing(page)).toHaveText("You are editing Version 2");
    expect(await equations(page)).not.toEqual(v1);
    await page.getByTestId("version-link").first().click();
    await expect(editing(page)).toHaveText("You are editing Version 1");
    expect(await equations(page)).toEqual(v1);
    await expect(page.getByTestId("version-link").first()).toHaveAttribute("aria-current", "page");
    await page.reload();
    expect(await equations(page)).toEqual(v1);
    expect(await ledger(user.id)).toEqual(empty);

    // 7. confirm: the promise is shown; back and refresh on the confirmation page reserve nothing
    await page.getByTestId("draft-export").click();
    await expect(page.getByTestId("export-confirm")).toBeVisible();
    await expect(page.getByTestId("export-promise")).toHaveText("This will use 1 generation when your PDFs are ready. If export fails, no generation is used.");
    await page.reload();
    await expect(page.getByTestId("export-confirm")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("draft-export")).toBeVisible();
    await page.goForward();
    expect(await ledger(user.id)).toEqual(empty);

    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}/);
    const exportUrl = new URL(page.url()).pathname;
    const exportId = exportUrl.split("/").pop()!;
    // exactly one reservation exists as soon as the export is created
    expect((await ledger(user.id)).reservations).toBe(1);

    // 8. success: exactly one generation used
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 60_000 });
    await expect(page.getByTestId("export-charge")).toHaveText("This used 1 generation.");
    const charged = { reservations: 1, exports: 1, jobs: 1, used: 1, reserved: 0 };
    expect(await ledger(user.id)).toEqual(charged);
    expect(await sql(`SELECT state FROM usage_reservation WHERE owner_id = $1`, [user.id])).toEqual([{ state: "consumed" }]);

    // refresh and back on the result page change nothing
    await page.reload();
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded");
    await page.goBack();
    await page.goForward();
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded");
    expect(await ledger(user.id)).toEqual(charged);

    // 9. free re-download of all three PDFs, as often as wanted
    for (let round = 0; round < 2; round++) {
      await page.goto(exportUrl);
      for (const doc of DOCS) {
        const href = await page.getByTestId("export-files").getByTestId(`export-download-${doc}`).getAttribute("href");
        const redirect = await page.request.get(href!, { maxRedirects: 0 });
        expect(redirect.status()).toBe(302);
        const signed = redirect.headers()["location"]!;
        expect(signed).not.toContain(".tex");
        const file = await fetch(signed);
        expect(file.status).toBe(200);
        const bytes = Buffer.from(await file.arrayBuffer());
        expect(bytes.byteLength).toBeGreaterThan(0);
        if (process.env.E2E_COMPILER === "docker") expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      }
    }
    expect(await ledger(user.id)).toEqual(charged);

    // 10. confirming the same version again is `reused`: the same export, nothing charged
    await page.goto(draftUrl);
    await expect(editing(page)).toHaveText("You are editing Version 1");
    await page.getByTestId("draft-export").click();
    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(new RegExp(`/exports/${exportId}\\?outcome=reused$`));
    await expect(page.getByTestId("export-charge")).toHaveText("An export with the same content and page format already used 1 generation. This one used none.");
    expect(await ledger(user.id)).toEqual(charged);
    await page.reload();
    expect(await ledger(user.id)).toEqual(charged);

    // 11. history lists the lesson and the allowance reads 2 of 3
    expect(await allowanceText(page)).toBe("2 of 3 generations left.");
    await expect(historyItems(page)).toHaveCount(1);
    await expect(historyItems(page).first()).toHaveAttribute("data-state", "succeeded");
    await page.goBack();
    expect(await ledger(user.id)).toEqual(charged);
    expect(await sql(`SELECT count(*)::int AS n FROM draft WHERE id = $1`, [draftId])).toEqual([{ n: 1 }]);
  } finally {
    await worker.stop();
  }
});

test("exhausting the trial: three different versions are charged, the fourth is refused, an identical re-export and drafts stay free", async ({ page }) => {
  test.setTimeout(200_000);
  const user = await createUser();
  const worker: RunningWorker = await startStorageWorker();
  try {
    await signIn(page, user);
    const draftId = await createDraft(page);
    const draftUrl = `/drafts/${draftId}?doc=worksheet`;
    await page.goto(draftUrl);
    const exportedUrls: string[] = [];
    const exportCurrent = async () => {
      const { exportId } = await exportDraft(page);
      exportedUrls.push(`/exports/${exportId}`);
      return exportId;
    };

    // versions 1, 2 and 3 have different questions: each export is its own charge
    const first = await exportCurrent();
    expect((await ledger(user.id)).used).toBe(1);
    for (const n of [2, 3]) {
      await page.goto(draftUrl);
      await page.getByTestId("create-version-btn").click();
      await expect(editing(page)).toHaveText(`You are editing Version ${n}`);
      await exportCurrent();
      expect((await ledger(user.id)).used).toBe(n);
    }
    const spent = { reservations: 3, exports: 3, jobs: 3, used: 3, reserved: 0 };
    expect(await ledger(user.id)).toEqual(spent);
    expect(await allowanceText(page, "/prepare")).toBe("0 of 3 generations left.");

    // a fourth version can still be drafted for free, but exporting it is refused and reserves nothing
    await page.goto(draftUrl);
    await page.getByTestId("create-version-btn").click();
    await expect(editing(page)).toHaveText("You are editing Version 4");
    await page.getByTestId("draft-export").click();
    await expect(page.getByTestId("export-free-note")).toContainText("You have no generations left");
    await page.getByTestId("export-confirm").click();
    await expect(page.getByTestId("export-error")).toContainText("no generations left");
    await expect(page).not.toHaveURL(/\/exports\//);
    expect(await ledger(user.id)).toEqual(spent);

    // an identical earlier version is still free: back to version 1 and confirm again
    await page.goto(draftUrl);
    await page.getByTestId("version-link").first().click();
    await expect(editing(page)).toHaveText("You are editing Version 1");
    await page.getByTestId("draft-export").click();
    await page.getByTestId("export-confirm").click();
    await expect(page).toHaveURL(new RegExp(`${first}\\?outcome=reused$`));
    expect(await ledger(user.id)).toEqual(spent);

    // and at zero remaining a brand new draft is still free
    await createDraft(page);
    await expect(page.getByTestId("draft-notice")).toHaveText("Draft preview. Nothing has been used from your allowance.");
    expect(await ledger(user.id)).toEqual(spent);
    expect(await allowanceText(page, "/prepare")).toBe("0 of 3 generations left.");
  } finally {
    await worker.stop();
  }
});
