import { expect, test } from "@playwright/test";
import { smokeTarget } from "./target";

/*
 * Staging smoke for the draft and export flow. READ BEFORE RUNNING:
 * - Each run consumes ONE of the throwaway user's 3 lifetime free generations (the export). Creating the draft is free.
 *   Use a dedicated staging user and a new one when its allowance is gone.
 * - It exercises the real worker, and a real compile. Staging must run FLOW_MODE=draft and EXPORT_ENABLED=1 (set explicitly).
 * - The staging site needs CURRICULUM_ALLOW_SAMPLE=1 and the sample dataset loaded, or the topic page has no selectable course.
 * - Refuses any target except https://noteprep.app (see ./target.ts), and is never run by CI (separate config, no CI job).
 * Nothing is recorded (no trace, screenshot or video). Signed URLs, tokens and cookies are never printed: downloads are
 * checked by HTTP status and the first bytes (%PDF-) only, and every assertion on a URL is a boolean so a failure cannot echo it.
 */
const { email, password } = smokeTarget(process.env);
const BASE = "sample-math@sample-1/level-a/course-1";
const TOPIC_URL = `/prepare?v=sample-math@sample-1&level=sample-math@sample-1/level-a&course=${BASE}&unit=${BASE}/equations&topic=${BASE}/equations/both-sides`;
const DOCS = ["notes", "worksheet", "solutions"] as const;

test("staging: sign in, draft, export, and every PDF downloads", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/prepare");
  const allowance = ((await page.getByTestId("allowance").textContent()) ?? "").trim();
  expect(Number(/^(\d+) of \d+ generations left/.exec(allowance)?.[1] ?? 0), "no free generations left: use a new throwaway staging user").toBeGreaterThan(0);

  await page.goto(TOPIC_URL);
  const create = page.getByRole("button", { name: "Create draft preview" });
  if (!(await create.isVisible())) {
    const body = (await page.locator("body").textContent()) ?? "";
    throw new Error(
      /No curriculum is available yet|nothing here is available yet|not available yet/.test(body)
        ? "staging has no sample curriculum: set CURRICULUM_ALLOW_SAMPLE=1 and load the sample dataset on staging"
        : "the Create draft preview button is not visible (staging may still run FLOW_MODE=legacy: set FLOW_MODE=draft explicitly)",
    );
  }
  await create.click();
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  console.log(`draft ${page.url().split("/").pop()}`);

  const exportButton = page.getByTestId("draft-export");
  if ((await exportButton.count()) === 0) throw new Error("export is off on staging: set EXPORT_ENABLED=1 explicitly");
  await exportButton.click();
  await page.getByTestId("export-confirm").click();
  await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}/);
  console.log(`export ${new URL(page.url()).pathname.split("/").pop()}`);
  await expect(page.getByTestId("export-status")).toHaveAttribute("data-phase", "succeeded", { timeout: 240_000 });
  await expect(page.getByTestId("export-charge")).toHaveText("This used 1 generation.");

  for (const doc of DOCS) {
    const href = await page.getByTestId("export-files").getByTestId(`export-download-${doc}`).getAttribute("href");
    expect(href !== null, `${doc}: no download link`).toBe(true);
    const res = await page.request.get(href!, { maxRedirects: 0 });
    expect(res.status(), `${doc}: expected a redirect to the file`).toBe(302);
    const location = res.headers()["location"] ?? "";
    // Never print the signed URL: assert on its shape only.
    expect(/^https:\/\/[^/?#@]+\/storage\/v1\/object\/sign\/lesson-artifacts\//.test(location), `${doc}: redirect is not a signed lesson-artifacts URL`).toBe(true);
    const file = await fetch(location, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    expect(file.status, `${doc}: download status`).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString("latin1"), `${doc}: not a PDF`).toBe("%PDF-");
    console.log(`${doc}: ok`);
  }
});
