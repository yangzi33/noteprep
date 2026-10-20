import { expect, test } from "@playwright/test";
import { smokeTarget } from "./target";

const { email, password } = smokeTarget(process.env);
const BASE = "sample-math@sample-1/level-a/course-1";
const TOPIC_URL = `/prepare?v=sample-math@sample-1&level=sample-math@sample-1/level-a&course=${BASE}&unit=${BASE}/equations&topic=${BASE}/equations/both-sides`;

test("staging: sign in, generate, preview, and every PDF downloads", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.goto("/lessons");
  const allowance = ((await page.getByTestId("allowance").textContent()) ?? "").trim();
  expect(Number(/^(\d+) of \d+ generations left/.exec(allowance)?.[1] ?? 0), "no free generations left: use a new throwaway staging user").toBeGreaterThan(0);
  await page.goto(TOPIC_URL);
  await page.getByRole("button", { name: "Generate lesson" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  console.log(`job ${page.url().split("/").pop()}`);
  await expect(page).toHaveURL(/\/lessons\/[0-9a-f-]{36}\?rev=[0-9a-f-]{36}$/, { timeout: 240_000 });
  const [, lessonId, revisionId] = /\/lessons\/([0-9a-f-]{36})\?rev=([0-9a-f-]{36})/.exec(page.url())!;
  console.log(`lesson ${lessonId} revision ${revisionId}`);
  await expect(page.getByTestId("document-tabs").getByRole("link")).toHaveText(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
  for (const doc of ["notes", "worksheet", "solutions"]) {
    const res = await page.request.get(`/lessons/${lessonId}/documents/${doc}?rev=${revisionId}&download=1`, { maxRedirects: 0 });
    expect(res.status(), `${doc}: expected a redirect to the file`).toBe(302);
    const file = await fetch(res.headers()["location"] ?? "about:blank"); // a signed URL: never print it
    expect(file.status, `${doc}: download status`).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString("latin1"), `${doc}: not a PDF`).toBe("%PDF-");
    console.log(`${doc}: ok`);
  }
});
