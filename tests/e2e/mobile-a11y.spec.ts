import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  chooseTopic,
  createDraft,
  createUser as createTestUser,
  deleteCreatedUsers,
  exportDraft,
  signIn,
  startStorageWorker,
  type RunningWorker,
} from "./support/helpers";

/**
 * Mobile layout, keyboard use, labels/roles and automated WCAG checks at 390x844, on the default server (3100).
 * Why axe: colour contrast and ARIA validity cannot be asserted by hand with Playwright locators, so @axe-core/playwright runs the
 * wcag2a + wcag2aa rules on every page and the test fails on serious or critical violations. Axe is a floor, not proof of
 * accessibility: it does not judge reading order, focus order beyond what the keyboard tests here check, or screen reader output.
 * Known issues: none excluded (see KNOWN_ISSUES below, which must stay empty or carry a narrowly scoped, commented entry).
 */
test.describe.configure({ mode: "serial" });

const VIEWPORT = { width: 390, height: 844 };
const FOCUS_ATTEMPTS = 60;

// Each entry must name one axe rule id, the page path pattern it applies to, and why. Never a blanket disable.
const KNOWN_ISSUES: { rule: string; page: RegExp; reason: string }[] = [];

interface Fixture {
  draftId: string;
  exportPath: string;
  lessonPath: string;
}

let worker: RunningWorker;
let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let fixture: Fixture;
const userIds: string[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  const user = await createTestUser();
  userIds.push(user.id);
  worker = await startStorageWorker();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await signIn(page, user);
  const draftId = await createDraft(page);
  const { exportId, lessonId, revisionId } = await exportDraft(page);
  fixture = { draftId, exportPath: `/exports/${exportId}`, lessonPath: `/lessons/${lessonId}?rev=${revisionId}` };
  storageState = await context.storageState();
  await context.close();
});

test.afterAll(async () => {
  await worker?.stop();
  await deleteCreatedUsers();
});

async function mobile(browser: Browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, storageState });
  return { context, page: await context.newPage() };
}

/** The confirmation page URL for the draft's current revision (an edit changes the revision, so it is looked up each time). */
async function confirmPathOf(page: Page): Promise<string> {
  await page.goto(`/drafts/${fixture.draftId}?doc=worksheet`);
  await page.getByTestId("draft-export").click();
  await expect(page).toHaveURL(/\/export\?v=/);
  const url = new URL(page.url());
  return url.pathname + url.search;
}

async function expectTouchTarget(locator: Locator, label: string) {
  await expect(locator, label).toBeVisible();
  const box = await locator.boundingBox();
  expect(box?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(44);
}

async function noHorizontalScroll(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${label}: scrollWidth ${scrollWidth} vs innerWidth ${innerWidth}`).toBeLessThanOrEqual(innerWidth);
}

/** Tab until `isFocused` (evaluated in the page) is true; returns how many presses it took. Fails if it is never reached. */
async function tabTo(page: Page, isFocused: () => boolean, what: string): Promise<number> {
  for (let n = 1; n <= FOCUS_ATTEMPTS; n++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(isFocused)) return n;
  }
  throw new Error(`Tab never reached ${what} in ${FOCUS_ATTEMPTS} presses`);
}

async function focusRing(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0, shadow: s.boxShadow !== "none" };
  });
}

// --- layout -----------------------------------------------------------------------------------------------------------

test("no horizontal scroll, reachable nav and tall primary controls on every page", async ({ browser }) => {
  const { context, page } = await mobile(browser);
  try {
    const pages: { path: string; label: string; primary: (p: Page) => Locator[] }[] = [
      { path: "/dashboard", label: "dashboard", primary: (p) => [p.getByRole("link", { name: "Create lesson pack" }).last()] },
      { path: "/lessons", label: "lessons", primary: (p) => [p.getByTestId("history-list").getByRole("link").first()] },
      { path: fixture.lessonPath, label: "lesson", primary: (p) => [p.getByTestId("export-notes")] },
      { path: fixture.exportPath, label: "export result", primary: (p) => [p.getByTestId("export-download-notes")] },
      { path: await confirmPathOf(page), label: "export confirm", primary: (p) => [p.getByTestId("export-confirm"), p.getByTestId("export-back")] },
      { path: `/drafts/${fixture.draftId}?doc=worksheet`, label: "draft", primary: (p) => [p.getByTestId("draft-export"), p.getByRole("button", { name: "Replace question 1" }), p.getByRole("button", { name: "Remove question 1" })] },
    ];
    for (const entry of pages) {
      await page.goto(entry.path);
      await noHorizontalScroll(page, entry.label);
      for (const control of entry.primary(page)) await expectTouchTarget(control, `${entry.label} primary control`);
      for (const name of ["Dashboard", "Create lesson pack", "My lesson packs", "Account"]) {
        await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name }), `${entry.label} nav ${name}`).toBeVisible();
      }
    }
    // /prepare with a chosen topic, including the primary button
    await chooseTopic(page);
    await noHorizontalScroll(page, "prepare");
    await expectTouchTarget(page.getByRole("button", { name: "Create draft preview" }), "prepare primary control");
    for (const id of ["select-v", "select-level", "select-course", "select-unit", "select-topic"]) await expectTouchTarget(page.getByTestId(id), id);
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My lesson packs" })).toBeVisible();
  } finally {
    await context.close();
  }
});

// --- keyboard ---------------------------------------------------------------------------------------------------------

test("keyboard: Tab to Create draft preview and Enter creates the draft; the focused control shows a ring", async ({ browser }) => {
  const { context, page } = await mobile(browser);
  try {
    await chooseTopic(page);
    await page.getByTestId("select-topic").focus();
    await tabTo(page, () => (document.activeElement?.textContent ?? "").trim() === "Create draft preview", "Create draft preview");
    const ring = await focusRing(page);
    expect(ring.outline || ring.shadow, "visible focus indicator on the primary button").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  } finally {
    await context.close();
  }
});

test("keyboard: Tab reaches Replace then Export PDFs; Replace moves focus to the candidate panel", async ({ browser }) => {
  const { context, page } = await mobile(browser);
  try {
    await page.goto(`/drafts/${fixture.draftId}?doc=worksheet`);
    await expect(page.getByTestId("draft-preview")).toHaveAttribute("data-document", "worksheet");
    const sequence: string[] = [];
    let replaceAt = -1;
    let exportAt = -1;
    for (let n = 1; n <= 200 && exportAt < 0; n++) {
      await page.keyboard.press("Tab");
      const name = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40) : "";
      });
      sequence.push(name);
      if (replaceAt < 0 && name === "Replace question 1") {
        replaceAt = n;
        const ring = await focusRing(page);
        expect(ring.outline || ring.shadow, "visible focus indicator on Replace").toBe(true);
        // activate with the keyboard: focus moves into the candidate panel
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("candidate-panel")).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.activeElement?.id), { message: "focus is on the candidate panel" }).toBe("candidate-panel-1");
        // leave the draft as it was: Keep original is a free, reversible choice
        await page.getByTestId("keep-original").click();
        await expect(page.getByTestId("candidate-panel")).toHaveCount(0);
      }
      if (name === "Export PDFs") exportAt = n;
    }
    expect(replaceAt, `Replace was never focused: ${sequence.join(" | ")}`).toBeGreaterThan(0);
    expect(exportAt, `Export PDFs was never focused: ${sequence.join(" | ")}`).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("keyboard: the confirmation page is submittable by keyboard alone", async ({ browser }) => {
  const { context, page } = await mobile(browser);
  try {
    await confirmPathOf(page);
    await expect(page.getByTestId("export-confirm")).toBeVisible();
    await tabTo(page, () => document.activeElement?.getAttribute("data-testid") === "export-confirm", "Export confirm button");
    const ring = await focusRing(page);
    expect(ring.outline || ring.shadow, "visible focus indicator on the confirm button").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}/);
    await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 60_000 });
  } finally {
    await context.close();
  }
});

// --- labels and roles -------------------------------------------------------------------------------------------------

test("labels and roles: form controls have labels, one h1 per page, live regions and aria-current", async ({ browser }) => {
  const { context, page } = await mobile(browser);
  try {
    await chooseTopic(page);
    // every select and checkbox has an associated label with text, and the named ones are found by label
    const unlabeled = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("main select, main input:not([type=hidden])")]
        .filter((el) => ![...(el.labels ?? [])].some((l) => (l.textContent ?? "").trim().length > 0))
        .map((el) => `${el.tagName}[name=${el.getAttribute("name")}]`),
    );
    expect(unlabeled).toEqual([]);
    await expect(page.getByLabel("Lesson length")).toBeVisible();
    await expect(page.getByLabel("Difficulty")).toBeVisible();
    await expect(page.getByLabel("Tutor Lesson Notes")).toBeChecked();

    const confirmPath = await confirmPathOf(page);
    const paths = ["/dashboard", "/lessons", "/prepare", `/drafts/${fixture.draftId}?doc=worksheet`, confirmPath, fixture.exportPath, fixture.lessonPath];
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }), path).toHaveCount(1);
    }

    // draft: role=status regions exist and the version list marks the current version
    await page.goto(`/drafts/${fixture.draftId}?doc=worksheet`);
    await expect(page.getByTestId("saved-status")).toHaveAttribute("role", "status");
    await expect(page.getByTestId("draft-notice")).toHaveAttribute("role", "status");
    await expect(page.getByTestId("changes-indicator")).toHaveAttribute("role", "status");
    await expect(page.locator('[data-testid="version-link"][aria-current="page"]')).toHaveCount(1);
    // changing the draft updates the status region's text (so a screen reader announces it)
    await page.getByRole("button", { name: "Remove question 1" }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 question removed" })).toHaveCount(1);
    await page.getByTestId("undo-btn").click();
    await expect(page.getByTestId("changes-indicator")).toHaveText("No changes yet");

    // the export result page announces its state through a polite live region
    await page.goto(fixture.exportPath);
    await expect(page.getByTestId("export-live")).toHaveAttribute("aria-live", "polite");
  } finally {
    await context.close();
  }
});

// --- automated WCAG 2 A/AA ----------------------------------------------------------------------------------------------

test("axe (wcag2a, wcag2aa): no serious or critical violations on any page", async ({ browser }) => {
  const { context, page } = await mobile(browser);
  try {
    const confirmPath = await confirmPathOf(page);
    const paths = ["/dashboard", "/lessons", "/prepare", fixture.lessonPath, fixture.exportPath, confirmPath, `/drafts/${fixture.draftId}?doc=worksheet`, `/drafts/${fixture.draftId}?doc=notes`, `/drafts/${fixture.draftId}?doc=solutions`];
    const failures: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      // guard against a silently empty run: colour contrast must have been evaluated (as passed, violated or needs-review)
      const evaluated = [...results.passes, ...results.violations, ...results.incomplete].map((r) => r.id);
      expect(evaluated, `${path}: axe evaluated colour contrast`).toContain("color-contrast");
      for (const v of results.violations) {
        if (v.impact !== "serious" && v.impact !== "critical") continue;
        if (KNOWN_ISSUES.some((k) => k.rule === v.id && k.page.test(path))) continue;
        failures.push(`${path}: ${v.id} (${v.impact}) ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("; ")}`);
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});
