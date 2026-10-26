import { expect, test, type Page } from "@playwright/test";
import { createUser, deleteCreatedUsers, signIn, sql } from "./support/helpers";

// Runs in the default "chromium" project: the server on port 3100 (FLOW_MODE=draft, EXPORT_ENABLED=1, see playwright.config.ts).
// No worker is needed or started: a draft is created and previewed without any job.
test.afterAll(deleteCreatedUsers);

const SAMPLE = "sample-math@sample-1";
const COURSE = `${SAMPLE}/level-a/course-1`;
const TOPIC = `${COURSE}/equations/both-sides`;
const ALLOWANCE = "3 of 3 free lesson packs left.";

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

test("choose a topic, create a free draft preview, and it survives a refresh without touching the allowance", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await chooseTopic(page);

  // Prepare says what this flow costs
  await expect(page.getByTestId("allowance")).toHaveText(ALLOWANCE);
  await expect(page.getByTestId("cost-note")).toHaveText("Creating a draft is free. A lesson pack is used only when you export PDFs.");
  await expect(page.getByRole("button", { name: "Generate lesson" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create draft preview" }).click();

  // the draft page: HTML preview, notice, expiry, no content hash, a live export link
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  const draftUrl = page.url();
  await expect(page.getByTestId("draft-title")).toHaveText("Sample topic: Unknown on both sides");
  await expect(page.getByTestId("draft-notice")).toHaveText("Draft preview. Nothing has been used from your allowance. AI-assisted material can contain mistakes. Read everything before you use it with a student.");
  await expect(page.getByTestId("draft-expiry")).toContainText(/^Draft expires (today|tomorrow|in \d+ days) \(.+\)$/);
  // export is on here (the paused state is covered in draft-paused.spec.ts); this spec starts no export
  await expect(page.getByTestId("draft-export")).toHaveText("Export PDFs");
  await expect(page.getByTestId("draft-export-disabled")).toHaveCount(0);
  await expect(page.getByTestId("document-tabs").getByRole("link")).toHaveText(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
  const preview = page.getByTestId("draft-preview");
  await expect(preview).toHaveAttribute("data-document", "notes");
  await expect(preview.getByRole("heading").first()).toBeVisible();
  await expect(preview.locator(".katex").first()).toBeVisible(); // the math is rendered, not raw TeX
  expect(await page.content()).not.toMatch(/sha256:[0-9a-f]{16}/); // the content hash is not shown

  // tabs: the worksheet has questions and no answers; the answer key has them
  await page.getByTestId("document-tabs").getByRole("link", { name: "Student Practice Worksheet" }).click();
  await expect(page).toHaveURL(/\?doc=worksheet$/);
  await expect(preview).toHaveAttribute("data-document", "worksheet");
  await expect(preview).toContainText("Solve each equation");
  await expect(preview).not.toContainText("Worked solutions");
  await page.getByTestId("document-tabs").getByRole("link", { name: "Solutions / Answer Key" }).click();
  await expect(preview).toHaveAttribute("data-document", "solutions");
  await expect(preview).toContainText("Worked solutions");

  // refresh keeps the same draft, version and text
  const version = await preview.getAttribute("data-version");
  const text = await preview.innerText();
  await page.reload();
  await expect(page).toHaveURL(`${draftUrl}?doc=solutions`);
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-version", version!);
  expect(await page.getByTestId("draft-preview").innerText()).toBe(text);

  // the allowance is exactly what it was, and nothing was reserved or queued
  await page.goto("/prepare");
  await expect(page.getByTestId("allowance")).toHaveText(ALLOWANCE);
  expect(await sql(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [user.id])).toEqual([{ n: 0 }]);
  expect(await sql(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [user.id])).toEqual([{ used: 0, reserved: 0 }]);
  expect(await sql(`SELECT count(*)::int AS n FROM draft WHERE owner_id = $1`, [user.id])).toEqual([{ n: 1 }]);
});

test("an expired draft says so and offers to start again with the same choices; other accounts see nothing", async ({ page, browser }) => {
  const user = await createUser();
  await signIn(page, user);
  await chooseTopic(page);
  await page.getByRole("button", { name: "Create draft preview" }).click();
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  const draftUrl = page.url();
  const draftId = draftUrl.split("/").pop()!;

  // another signed-in account gets the ordinary not-found page, as for a draft that never existed
  const other = await createUser();
  const otherContext = await browser.newContext({ baseURL: new URL(draftUrl).origin });
  const otherPage = await otherContext.newPage();
  await signIn(otherPage, other);
  await otherPage.goto(draftUrl);
  await expect(otherPage.getByText("Page not found")).toBeVisible();
  await otherPage.goto(`/drafts/00000000-0000-4000-8000-000000000000`);
  await expect(otherPage.getByText("Page not found")).toBeVisible();
  await otherContext.close();

  await sql(`UPDATE draft SET expires_at = now() - interval '1 hour' WHERE id = $1`, [draftId]);
  await page.reload();
  await expect(page.getByTestId("draft-expired")).toContainText("This draft has expired");
  await expect(page.getByTestId("draft-preview")).toHaveCount(0);
  const again = page.getByTestId("draft-start-again");
  await expect(again).toHaveText("Start again");
  await again.click();
  await expect(page).toHaveURL(new RegExp(`/prepare\\?.*topic=${encodeURIComponent(TOPIC).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await expect(page.getByTestId("select-topic")).toHaveValue(TOPIC);
  await expect(page.getByRole("button", { name: "Create draft preview" })).toBeEnabled();
});

// --- question-level adjustment (S2) ---------------------------------------------------------------------------

async function openWorksheetDraft(page: Page) {
  await chooseTopic(page);
  await page.getByRole("button", { name: "Create draft preview" }).click();
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  const draftUrl = page.url();
  await page.getByTestId("document-tabs").getByRole("link", { name: "Student Practice Worksheet" }).click();
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "worksheet");
  return draftUrl;
}
// The TeX of every display equation in the preview, in order (questions and the candidate panel's equation).
const equations = (page: Page) => page.getByTestId("draft-preview").locator(".katex-display annotation").allTextContents();

test("replace keeps the original visible, try another, accept, remove and undo, all surviving a refresh", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  const draftUrl = await openWorksheetDraft(page);
  const controls = page.getByTestId("question-controls");
  const count = await controls.count();
  expect(count).toBeGreaterThanOrEqual(4);
  const indicator = page.getByTestId("changes-indicator");
  await expect(indicator).toHaveText("No changes yet");
  await expect(page.getByTestId("undo-btn")).toBeDisabled();
  await expect(page.getByTestId("undo-reason")).toHaveText("Nothing to undo yet");
  // always-visible real buttons with a 44px target and a name that says which question
  const replace3 = page.getByRole("button", { name: "Replace question 3" });
  await expect(replace3).toBeVisible();
  expect((await replace3.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: "Remove question 3" })).toBeVisible();

  const original = await equations(page);
  expect(original).toHaveLength(count);

  // Replace: the candidate appears under question 3 and the original stays visible
  await replace3.click();
  const panel = page.getByTestId("candidate-panel");
  await expect(panel).toBeVisible();
  const withCandidate = await equations(page);
  expect(withCandidate).toHaveLength(count + 1);
  for (const eq of original) expect(withCandidate).toContain(eq);
  const first = (await panel.getByTestId("candidate-equation").locator("annotation").textContent())!;
  expect(original).not.toContain(first);
  await expect(indicator).toHaveText("No changes yet");

  // the candidate survives a refresh; Try another gives a different one
  await page.reload();
  await expect(page.getByTestId("candidate-panel").getByTestId("candidate-equation").locator("annotation")).toHaveText(first);
  await page.getByTestId("try-another").click();
  await expect(page.getByTestId("candidate-equation").locator("annotation")).not.toHaveText(first);
  const second = (await page.getByTestId("candidate-equation").locator("annotation").textContent())!;
  expect(second).not.toBe(first);
  expect(original).not.toContain(second);

  // Keep original clears it, the content is as before
  await page.getByTestId("keep-original").click();
  await expect(page.getByTestId("candidate-panel")).toHaveCount(0);
  expect(await equations(page)).toEqual(original);

  // Replace again and Accept: same count, same position, indicator and badge
  await page.getByRole("button", { name: "Replace question 3" }).click();
  await expect(page.getByTestId("candidate-panel")).toBeVisible();
  const chosen = (await page.getByTestId("candidate-equation").locator("annotation").textContent())!;
  await page.getByTestId("accept-candidate").click();
  await expect(page.getByTestId("candidate-panel")).toHaveCount(0);
  await expect(indicator).toHaveText("1 question replaced");
  await expect(page.getByTestId("replaced-badge")).toHaveCount(1);
  const accepted = await equations(page);
  expect(accepted).toHaveLength(count);
  expect(accepted[2]).toBe(chosen);
  expect(accepted.filter((_, i) => i !== 2)).toEqual(original.filter((_, i) => i !== 2));
  await expect(page.getByTestId("undo-btn")).toHaveText("Undo: Replaced question 3");

  // the answer key shows the paired answer for the new question, marked as replaced
  const draftId = draftUrl.split("/").pop()!;
  await page.getByTestId("document-tabs").getByRole("link", { name: "Solutions / Answer Key" }).click();
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "solutions");
  await expect(page.getByTestId("replaced-badge")).toHaveCount(1);
  expect(await page.getByTestId("draft-preview").locator(".katex-display annotation").allTextContents()).toContain(chosen);
  await page.getByTestId("document-tabs").getByRole("link", { name: "Student Practice Worksheet" }).click();

  // Remove question 1: positional numbering, the count goes down, the indicator counts both
  await page.getByRole("button", { name: "Remove question 1" }).click();
  await expect(controls).toHaveCount(count - 1);
  await expect(indicator).toHaveText("1 question replaced · 1 removed");
  await expect(page.getByTestId("undo-btn")).toHaveText("Undo: Removed question 1");
  expect(await equations(page)).toEqual(accepted.slice(1));
  await expect(page.getByTestId("draft-preview").locator("strong", { hasText: /^1\.$/ })).toHaveCount(1);

  // a refresh keeps everything
  await page.reload();
  await expect(controls).toHaveCount(count - 1);
  await expect(indicator).toHaveText("1 question replaced · 1 removed");

  // undo the removal, then the replacement: back to the generated draft
  await page.getByTestId("undo-btn").click();
  await expect(controls).toHaveCount(count);
  await expect(indicator).toHaveText("1 question replaced");
  await page.getByTestId("undo-btn").click();
  await expect(indicator).toHaveText("No changes yet");
  await expect(page.getByTestId("undo-btn")).toBeDisabled();
  expect(await equations(page)).toEqual(original);

  // every step was free
  expect(await sql(`SELECT history, rev FROM draft_version WHERE draft_id = $1`, [draftId])).toEqual([{ history: [], rev: expect.any(Number) }]);
  await page.goto("/prepare");
  await expect(page.getByTestId("allowance")).toHaveText(ALLOWANCE);
  expect(await sql(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [user.id])).toEqual([{ used: 0, reserved: 0 }]);
  expect(await sql(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [user.id])).toEqual([{ n: 0 }]);
});

// The screen must stay where the tutor was: the adjust controls update the page in place instead of navigating to a fragment.
const MAX_JUMP_PX = 4;
async function viewport(page: Page, anchor: ReturnType<Page["locator"]>) {
  // boundingBox() is already relative to the viewport, which is what the tutor sees
  return { scrollY: await page.evaluate(() => window.scrollY), top: (await anchor.boundingBox())!.y };
}
async function expectStill(page: Page, anchor: ReturnType<Page["locator"]>, before: { scrollY: number; top: number }, what: string) {
  await page.waitForTimeout(600); // let any (unwanted) scroll-to-fragment happen before measuring
  const after = await viewport(page, anchor);
  const jump = { scroll: Math.abs(after.scrollY - before.scrollY), anchor: Math.abs(after.top - before.top) };
  console.log(`[scroll-stability] ${what}: scrollY ${before.scrollY} -> ${after.scrollY}, anchor top ${before.top} -> ${after.top}`);
  // What the tutor sees is the anchored control's position in the viewport. scrollY alone can legitimately change when the
  // page above the viewport changes height (the browser compensates), so it is logged, not asserted.
  expect(jump.anchor, `${what}: anchored control moved in the viewport`).toBeLessThanOrEqual(MAX_JUMP_PX);
}

test("adjust controls do not move the screen: replace, try another, keep, accept, remove and undo keep scroll and position", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await openWorksheetDraft(page);
  await page.setViewportSize({ width: 1280, height: 500 });
  const q = (n: number) => page.getByRole("button", { name: `Replace question ${n}` });
  const centre = (n: number) => q(n).evaluate((el) => el.scrollIntoView({ block: "center" }));
  const panel = page.getByTestId("candidate-panel");
  await centre(3);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(300); // the page scrolls

  let before = await viewport(page, q(3));
  expect(before.scrollY).toBeGreaterThan(100);
  await q(3).click();
  await expect(panel).toBeVisible();
  await expectStill(page, q(3), before, "replace");

  before = await viewport(page, q(3));
  const first = await page.getByTestId("candidate-equation").locator("annotation").textContent();
  await page.getByTestId("try-another").click();
  await expect(page.getByTestId("candidate-equation").locator("annotation")).not.toHaveText(first!);
  await expectStill(page, q(3), before, "try another");

  before = await viewport(page, q(3));
  await page.getByTestId("keep-original").click();
  await expect(panel).toHaveCount(0);
  await expectStill(page, q(3), before, "keep original");

  await q(3).click();
  await expect(panel).toBeVisible();
  before = await viewport(page, q(3));
  await page.getByTestId("accept-candidate").click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question replaced");
  await expectStill(page, q(3), before, "accept");

  // Remove a question other than the replaced one: removing question 3 would drop its "replaced" mark too.
  // Bring the button into the middle of the viewport first: Playwright scrolls a button that is cut off at the edge into view
  // before clicking it, and that scroll is the test's own, not the page's.
  const remove4 = page.getByRole("button", { name: "Remove question 4" });
  await remove4.evaluate((el) => el.scrollIntoView({ block: "center" }));
  before = await viewport(page, q(3)); // a control that stays on screen and keeps its number
  await remove4.click();
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question replaced · 1 removed");
  await expectStill(page, q(3), before, "remove");

  // Undo sits above the questions: bring it into the middle of the viewport first
  await page.getByTestId("undo-btn").evaluate((el) => el.scrollIntoView({ block: "center" }));
  before = await viewport(page, page.getByTestId("undo-btn"));
  await page.getByTestId("undo-btn").click();
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question replaced");
  await expectStill(page, page.getByTestId("undo-btn"), before, "undo");
});

test("switching the document tab keeps the tab row where it was and keeps ?doc=, back and refresh", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await openWorksheetDraft(page);
  await page.setViewportSize({ width: 1280, height: 500 });
  const tabs = page.getByTestId("document-tabs");
  const tab = (name: string) => tabs.getByRole("link", { name });
  await tabs.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.evaluate(() => window.scrollBy(0, 40)); // some distance from the top, so a jump to the top is visible
  let before = await viewport(page, tabs);
  expect(before.scrollY).toBeGreaterThan(100);
  await tab("Solutions / Answer Key").click();
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "solutions");
  await expectStill(page, tabs, before, "tab to solutions");
  await expect(page).toHaveURL(/\?doc=solutions$/);
  before = await viewport(page, tabs);
  await tab("Tutor Lesson Notes").click();
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "notes");
  await expectStill(page, tabs, before, "tab to notes");
  await page.goBack();
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "solutions");
  await page.reload();
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "solutions");
});

test("a second tab with an older page gets a conflict notice and can reload", async ({ page, context }) => {
  const user = await createUser();
  await signIn(page, user);
  const draftUrl = await openWorksheetDraft(page);
  const second = await context.newPage();
  await second.goto(`${draftUrl}?doc=worksheet`);
  await expect(second.getByTestId("question-controls").first()).toBeVisible();

  await page.getByRole("button", { name: "Remove question 1" }).click(); // the first tab moves the draft on
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question removed");

  await second.getByRole("button", { name: "Remove question 2" }).click(); // the second tab still holds the old revision
  const conflict = second.getByTestId("draft-conflict");
  await expect(conflict).toContainText("This draft changed in another tab or window. Reload to see the latest.");
  await expect(second).toHaveURL(/doc=worksheet.*error=DRAFT_CONFLICT.*#question-2$/); // doc, error and the place survive the error redirect
  await conflict.getByTestId("draft-reload").click();
  await expect(second.getByTestId("draft-conflict")).toHaveCount(0);
  await expect(second.getByTestId("changes-indicator")).toHaveText("1 question removed");
});

// --- versions (S3) ------------------------------------------------------------------------------------------------

const editing = (page: Page) => page.getByTestId("editing-version");

test("create another version keeps the first, switch back shows the earlier replace, refresh keeps the selected version, all free", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  const draftUrl = await openWorksheetDraft(page);
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs += 1;
    await d.dismiss();
  });
  await expect(editing(page)).toHaveText("You are editing Version 1");
  await expect(page.getByTestId("saved-status")).toContainText("Last saved");
  await expect(page.getByTestId("version-link")).toHaveCount(1);
  await expect(page.getByTestId("version-link")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("create-version-btn")).toBeEnabled();
  await expect(page.getByText("Your current version is kept. You can switch back any time.")).toBeVisible();

  // a replace on version 1
  await page.getByRole("button", { name: "Replace question 3" }).click();
  await page.getByTestId("accept-candidate").click();
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question replaced");
  const v1Equations = await equations(page);

  // create another version: no dialog, now editing version 2 (new questions), version 1 kept with its badge
  await page.getByTestId("create-version-btn").click();
  await expect(editing(page)).toHaveText("You are editing Version 2");
  await expect(page.getByTestId("version-link")).toHaveCount(2);
  await expect(page.getByTestId("version-link").nth(1)).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("version-link").first()).toContainText("1 replaced");
  await expect(page.getByTestId("changes-indicator")).toHaveText("No changes yet");
  await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "worksheet");
  const v2Equations = await equations(page);
  expect(v2Equations).not.toEqual(v1Equations);
  expect(dialogs).toBe(0);

  // edit version 2, then refresh: still version 2
  await page.getByRole("button", { name: "Remove question 1" }).click();
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question removed");
  await page.reload();
  await expect(editing(page)).toHaveText("You are editing Version 2");
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question removed");

  // switch back: version 1 exactly as it was, with its replacement
  await page.getByTestId("version-link").first().click();
  await expect(editing(page)).toHaveText("You are editing Version 1");
  await expect(page.getByTestId("changes-indicator")).toHaveText("1 question replaced");
  expect(await equations(page)).toEqual(v1Equations);
  await page.reload();
  await expect(editing(page)).toHaveText("You are editing Version 1");
  await page.goto(draftUrl); // the draft opens on the version last selected
  await expect(editing(page)).toHaveText("You are editing Version 1");
  await page.getByTestId("version-link").nth(1).click();
  await expect(editing(page)).toHaveText("You are editing Version 2");
  await expect(page.getByTestId("version-link").nth(1)).toContainText("1 removed");

  // nothing was charged
  await page.goto("/prepare");
  await expect(page.getByTestId("allowance")).toHaveText(ALLOWANCE);
  expect(await sql(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [user.id])).toEqual([{ used: 0, reserved: 0 }]);
  expect(await sql(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [user.id])).toEqual([{ n: 0 }]);
});

test("a stale second tab gets the conflict notice for a version action, and its reload link works", async ({ page, context }) => {
  const user = await createUser();
  await signIn(page, user);
  const draftUrl = await openWorksheetDraft(page);
  const second = await context.newPage();
  await second.goto(`${draftUrl}?doc=worksheet`);
  await expect(editing(second)).toHaveText("You are editing Version 1");

  await page.getByTestId("create-version-btn").click(); // the first tab moves the draft pointer on
  await expect(editing(page)).toHaveText("You are editing Version 2");

  await second.getByTestId("create-version-btn").click(); // the second tab still holds the old draft revision
  const conflict = second.getByTestId("draft-conflict");
  await expect(conflict).toContainText("This draft changed in another tab or window. Reload to see the latest.");
  await expect(second).toHaveURL(/#draft-error$/); // the notice is the redirect anchor
  await expect(conflict).toBeInViewport();
  expect(await sql(`SELECT count(*)::int AS n FROM draft_version WHERE owner_id = $1`, [user.id])).toEqual([{ n: 2 }]); // the stale create made nothing
  await conflict.getByTestId("draft-reload").click();
  await expect(second.getByTestId("draft-conflict")).toHaveCount(0);
  await expect(second.getByTestId("version-link")).toHaveCount(2);
  expect(await sql(`SELECT count(*)::int AS n FROM draft_version WHERE owner_id = $1`, [user.id])).toEqual([{ n: 2 }]);
});

test("at the version limit the button is disabled and a visible note says why", async ({ page }) => {
  const user = await createUser();
  await signIn(page, user);
  await openWorksheetDraft(page);
  const limit = 5; // the default MAX_VERSIONS_PER_DRAFT
  for (let n = 2; n <= limit; n++) {
    await page.getByTestId("create-version-btn").click();
    await expect(editing(page)).toHaveText(`You are editing Version ${n}`);
  }
  const button = page.getByTestId("create-version-btn");
  await expect(button).toBeDisabled();
  const note = page.getByTestId("version-limit-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("the most allowed (5)");
  await expect(button).toHaveAttribute("aria-describedby", "version-limit-note");
  await expect(page.getByTestId("version-link")).toHaveCount(limit);
});
