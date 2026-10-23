import { expect, test, type Page } from "@playwright/test";
import { createUser, deleteCreatedUsers, signIn, sql } from "./support/helpers";

// Runs in the "chromium-draft" project: a server started with FLOW_MODE=draft (see playwright.config.ts).
// No worker is needed or started: a draft is created and previewed without any job.
test.afterAll(deleteCreatedUsers);

const SAMPLE = "sample-math@sample-1";
const COURSE = `${SAMPLE}/level-a/course-1`;
const TOPIC = `${COURSE}/equations/both-sides`;
const ALLOWANCE = "3 of 3 generations left.";

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
  await expect(page.getByTestId("cost-note")).toHaveText("Creating a preview is free");
  await expect(page.getByRole("button", { name: "Generate lesson" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create draft preview" }).click();

  // the draft page: HTML preview, notice, expiry, no content hash, a disabled export
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  const draftUrl = page.url();
  await expect(page.getByTestId("draft-title")).toHaveText("Sample topic: Unknown on both sides");
  await expect(page.getByTestId("draft-notice")).toHaveText("Draft preview. Nothing has been used from your allowance.");
  await expect(page.getByTestId("draft-expiry")).toContainText(/^Draft expires .* UTC$/);
  await expect(page.getByTestId("draft-export-disabled")).toBeDisabled();
  await expect(page.getByTestId("draft-export-disabled")).toHaveText("Export is coming next");
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
