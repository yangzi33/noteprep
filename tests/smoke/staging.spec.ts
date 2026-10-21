import { expect, test } from "@playwright/test";
import { smokeTarget } from "./target";

/*
 * Staging smoke. READ BEFORE RUNNING:
 * - Each run consumes ONE of the throwaway user's 3 lifetime free generations; use a dedicated staging user.
 * - It exercises the real worker, and a real LLM call if the staging worker runs with LESSON_PROSE=llm (real cost).
 * - The staging site needs CURRICULUM_ALLOW_SAMPLE=1 and the sample dataset loaded, or the topic page has no
 *   selectable course and "Generate lesson" cannot be reached.
 * Nothing is recorded (no trace/screenshot/video) and signed URLs are never printed.
 */
const { email, password } = smokeTarget(process.env);
const BASE = "sample-math@sample-1/level-a/course-1";
const TOPIC_URL = `/prepare?v=sample-math@sample-1&level=sample-math@sample-1/level-a&course=${BASE}&unit=${BASE}/equations&topic=${BASE}/equations/both-sides`;

test("staging: sign in, generate, preview, and every PDF downloads", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/lessons");
  const allowance = ((await page.getByTestId("allowance").textContent()) ?? "").trim();
  expect(Number(/^(\d+) of \d+ generations left/.exec(allowance)?.[1] ?? 0), "no free generations left: use a new throwaway staging user").toBeGreaterThan(0);
  await page.goto(TOPIC_URL);
  const generate = page.getByRole("button", { name: "Generate lesson" });
  if (!(await generate.isVisible())) {
    const body = (await page.locator("body").textContent()) ?? "";
    throw new Error(
      /No curriculum is available yet|nothing here is available yet|not available yet/.test(body)
        ? "staging has no sample curriculum: set CURRICULUM_ALLOW_SAMPLE=1 and load the sample dataset on staging"
        : "the Generate lesson button is not visible on the topic page (unexpected state)",
    );
  }
  await generate.click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  console.log(`job ${page.url().split("/").pop()}`);
  await expect(page).toHaveURL(/\/lessons\/[0-9a-f-]{36}\?rev=[0-9a-f-]{36}$/, { timeout: 240_000 });
  const [, lessonId, revisionId] = /\/lessons\/([0-9a-f-]{36})\?rev=([0-9a-f-]{36})/.exec(page.url())!;
  console.log(`lesson ${lessonId} revision ${revisionId}`);
  await expect(page.getByTestId("document-tabs").getByRole("link")).toHaveText(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
  for (const doc of ["notes", "worksheet", "solutions"]) {
    const res = await page.request.get(`/lessons/${lessonId}/documents/${doc}?rev=${revisionId}&download=1`, { maxRedirects: 0 });
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
