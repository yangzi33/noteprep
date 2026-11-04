import { expect, test, type Page } from "@playwright/test";
import { createDraft, createUser, deleteCreatedUsers, exportDraft, signIn, sql, startStorageWorker, type RunningWorker } from "./support/helpers";

// Default "chromium" project (FLOW_MODE=draft, EXPORT_ENABLED=1). Drafts are free; the export at the end needs the storage worker.
test.afterAll(deleteCreatedUsers);

const CAP = 30;
const equations = (page: Page) => page.getByTestId("draft-preview").locator(".katex-display annotation").allTextContents();
const count = async (page: Page) => Number(((await page.getByTestId("question-count").textContent()) ?? "").match(/^\s*(\d+) of /)![1]);

async function add(page: Page, n: number) {
  const before = await count(page);
  await page.getByTestId("add-count").selectOption(String(n));
  await page.getByTestId("add-btn").click();
  await expect(page.getByTestId("question-count")).toContainText(`${before + n} of ${CAP}`);
}

async function ledger(userId: string) {
  const [r] = await sql<{ n: number }>(`SELECT (SELECT count(*) FROM usage_reservation WHERE owner_id = $1)::int AS n`, [userId]);
  const [b] = await sql<{ used: number; reserved: number }>(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [userId]);
  return { reservations: r!.n, used: b!.used, reserved: b!.reserved };
}

test("generate, add questions, preview, undo, reach the cap, then export the full worksheet", async ({ page }) => {
  test.setTimeout(180_000);
  const user = await createUser();
  const worker: RunningWorker = await startStorageWorker();
  try {
    await signIn(page, user);
    const draftId = await createDraft(page);
    await page.goto(`/drafts/${draftId}?doc=worksheet`);
    const start = await count(page);
    expect(start).toBeGreaterThanOrEqual(3);
    const original = await equations(page);
    expect(original).toHaveLength(start);
    await expect(page.getByTestId("practice-minutes")).toHaveText(`about ${start * 5} min`);

    // add 2: the worksheet shows start + 2 questions, the originals unchanged and first
    await add(page, 2);
    const added = await equations(page);
    expect(added).toHaveLength(start + 2);
    expect(added.slice(0, start)).toEqual(original);
    await expect(page.getByTestId("changes-indicator")).toHaveText("2 questions added");
    await expect(page.getByTestId("undo-btn")).toHaveText("Undo: Added 2 questions");
    await expect(page.getByTestId("practice-minutes")).toHaveText(`about ${(start + 2) * 5} min`);
    await page.reload();
    expect(await equations(page)).toEqual(added);

    // the answer key has the same number of solutions, paired in order
    await page.getByTestId("document-tabs").getByRole("link", { name: "Solutions / Answer Key" }).click();
    await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "solutions");
    await expect(page.getByTestId("question-count")).toContainText(`${start + 2} of ${CAP}`);
    const [stored] = await sql<{ solutions: number; questions: number }>(
      `SELECT (SELECT count(*) FROM jsonb_array_elements(s.blocks) b WHERE b->>'type' = 'solution')::int AS solutions,
              (SELECT count(*) FROM jsonb_array_elements(q.blocks) b WHERE b->>'type' = 'question')::int AS questions
         FROM draft_version v,
              LATERAL (SELECT sec->'blocks' AS blocks FROM jsonb_array_elements(v.content->'sections') sec WHERE sec->>'kind' = 'solutions') s,
              LATERAL (SELECT sec->'blocks' AS blocks FROM jsonb_array_elements(v.content->'sections') sec WHERE sec->>'kind' = 'exercises') q
        WHERE v.draft_id = $1`,
      [draftId],
    );
    expect(stored).toEqual({ solutions: start + 2, questions: start + 2 });

    // undo returns to the original; add again
    await page.getByTestId("document-tabs").getByRole("link", { name: "Student Practice Worksheet" }).click();
    await page.getByTestId("undo-btn").click();
    await expect(page.getByTestId("question-count")).toContainText(`${start} of ${CAP}`);
    expect(await equations(page)).toEqual(original);
    await add(page, 3);

    // another version keeps the larger count
    await page.getByTestId("create-version-btn").click();
    await expect(page.getByTestId("editing-version")).toHaveText("You are editing Version 2");
    expect(await count(page)).toBe(start + 3);
    await page.getByTestId("version-link").first().click();
    await expect(page.getByTestId("editing-version")).toHaveText("You are editing Version 1");

    // fill up to the cap: the control is disabled and says why
    while ((await count(page)) < CAP) await add(page, Math.min(5, CAP - (await count(page))));
    await expect(page.getByTestId("question-count")).toContainText(`${CAP} of ${CAP}`);
    await expect(page.getByTestId("add-btn")).toBeDisabled();
    await expect(page.getByTestId("add-reason")).toContainText(`maximum of ${CAP} questions`);
    await expect(page.getByTestId("practice-warning")).toBeVisible();
    expect(await ledger(user.id)).toEqual({ reservations: 0, used: 0, reserved: 0 });

    // removing one re-enables adding exactly one
    await page.getByRole("button", { name: "Remove question 1", exact: true }).click();
    await expect(page.getByTestId("add-btn")).toBeEnabled();
    await page.getByTestId("undo-btn").click();
    await expect(page.getByTestId("add-btn")).toBeDisabled();

    // export the full worksheet: one generation, the PDFs download, the worksheet has no answers
    await exportDraft(page);
    await expect(page.getByTestId("export-charge")).toHaveText("This used 1 lesson pack.");
    expect(await ledger(user.id)).toEqual({ reservations: 1, used: 1, reserved: 0 });
    const [snap] = await sql<{ n: number }>(
      `SELECT (SELECT count(*) FROM jsonb_array_elements(s.content->'sections') sec, jsonb_array_elements(sec->'blocks') b WHERE sec->>'kind' = 'exercises' AND b->>'type' = 'question')::int AS n
         FROM export_snapshot s WHERE s.owner_id = $1`,
      [user.id],
    );
    expect(snap!.n).toBe(CAP);
    for (const doc of ["notes", "worksheet", "solutions"]) {
      const href = await page.getByTestId("export-files").getByTestId(`export-download-${doc}`).getAttribute("href");
      const redirect = await page.request.get(href!, { maxRedirects: 0 });
      expect(redirect.status()).toBe(302);
    }
  } finally {
    await worker.stop();
  }
});
