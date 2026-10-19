import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createUser, deleteCreatedUsers, signIn, sql, startStorageWorker, type TestUser } from "./support/helpers";

test.afterAll(deleteCreatedUsers);

const BASE = "sample-math@sample-1/level-a/course-1";
const TOPIC_URL = `/prepare?v=sample-math@sample-1&level=sample-math@sample-1/level-a&course=${BASE}&unit=${BASE}/equations&topic=${BASE}/equations/both-sides`;
const sha256 = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

async function generate(page: Page, user: TestUser) {
  await signIn(page, user);
  await page.goto(TOPIC_URL);
  await page.getByRole("button", { name: "Generate lesson" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  // a finished lesson goes straight to its preview
  await expect(page).toHaveURL(/\/lessons\/[0-9a-f-]{36}\?rev=[0-9a-f-]{36}$/, { timeout: 45_000 });
  const [, lessonId, revisionId] = /\/lessons\/([0-9a-f-]{36})\?rev=([0-9a-f-]{36})/.exec(page.url())!;
  return { lessonId: lessonId!, revisionId: revisionId! };
}

test("a finished lesson opens on its preview, with all three documents from one revision, and the files are the stored ones", async ({ page, browser }) => {
  const user = await createUser();
  const worker = await startStorageWorker();
  try {
    const { lessonId, revisionId } = await generate(page, user);

    // the page: title, the review reminder, the three tabs, an honest curriculum notice
    await expect(page.getByTestId("lesson-title")).toBeVisible();
    await expect(page.getByTestId("review-reminder")).toContainText("Read everything before you use it");
    await expect(page.getByTestId("document-tabs").getByRole("link")).toHaveText(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
    await expect(page.getByTestId("alignment-notice")).toContainText("not a real curriculum");
    await expect(page.getByTestId("alignment-notice")).toContainText("no claim of alignment");
    const panel = page.getByTestId("document-panel");
    await expect(panel).toHaveAttribute("data-document", "notes");
    await expect(panel).toHaveAttribute("data-revision", revisionId);
    await expect(page.getByTestId("pdf-frame")).toHaveAttribute("src", `/lessons/${lessonId}/documents/notes?rev=${revisionId}`);

    // every tab and every file link names the revision being shown, so a newer revision can never slip in
    for (const [name, doc] of [["Tutor Lesson Notes", "notes"], ["Student Practice Worksheet", "worksheet"], ["Solutions / Answer Key", "solutions"]] as const) {
      await expect(page.getByTestId("document-tabs").getByRole("link", { name })).toHaveAttribute("href", `/lessons/${lessonId}?rev=${revisionId}&doc=${doc}`);
    }
    await expect(page.getByTestId("open-pdf")).toHaveAttribute("href", `/lessons/${lessonId}/documents/notes?rev=${revisionId}`);
    await expect(page.getByTestId("download-pdf")).toHaveAttribute("href", `/lessons/${lessonId}/documents/notes?rev=${revisionId}&download=1`);

    // switching tabs keeps the revision; the address bar is the state, so a reload stays put
    await page.getByTestId("document-tabs").getByRole("link", { name: "Student Practice Worksheet" }).click();
    await expect(page).toHaveURL(new RegExp(`doc=worksheet`));
    await expect(panel).toHaveAttribute("data-document", "worksheet");
    await page.reload();
    await expect(panel).toHaveAttribute("data-document", "worksheet");
    await expect(panel).toHaveAttribute("data-revision", revisionId);

    // each document: the file served is exactly the one the revision's manifest names, and it is a PDF and never a .tex
    const manifest = (await sql<{ artifact_manifest: { documents: { document: string; pdf: { sha256: string; bytes: number } }[] } }>(`SELECT artifact_manifest FROM lesson_revision WHERE id = $1`, [revisionId]))[0]!.artifact_manifest;
    expect(manifest.documents.map((d) => d.document)).toEqual(["notes", "worksheet", "solutions"]);
    for (const d of manifest.documents) {
      const url = `/lessons/${lessonId}/documents/${d.document}?rev=${revisionId}`;
      const redirect = await page.request.get(url, { maxRedirects: 0 });
      expect(redirect.status()).toBe(302);
      expect(redirect.headers()["cache-control"]).toContain("no-store");
      const signed = redirect.headers()["location"]!;
      expect(new URL(signed).pathname).toContain("/storage/v1/object/sign/lesson-artifacts/");
      expect(signed).not.toContain(".tex");
      const file = await fetch(signed);
      expect(file.status).toBe(200);
      const bytes = await file.arrayBuffer();
      expect(bytes.byteLength).toBe(d.pdf.bytes);
      expect(sha256(bytes)).toBe(d.pdf.sha256);
      if (process.env.E2E_COMPILER === "docker") expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");

      const download = await page.request.get(`${url}&download=1`, { maxRedirects: 0 });
      expect(new URL(download.headers()["location"]!).searchParams.get("download")).toMatch(/^[A-Za-z0-9-]+\.pdf$/);
    }

    // the job page and the history both lead to the same lesson
    await page.goto(`/lessons`);
    await page.getByTestId("history-list").getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/lessons/${lessonId}\\?rev=${revisionId}`));

    // someone else, and nobody, get nothing: the same answer as for a lesson that does not exist
    const other = await createUser();
    const ctx = await browser.newContext();
    const otherPage = await ctx.newPage();
    await signIn(otherPage, other);
    expect((await otherPage.request.get(`/lessons/${lessonId}?rev=${revisionId}`)).status()).toBe(404);
    expect((await otherPage.request.get(`/lessons/${lessonId}/documents/notes?rev=${revisionId}`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await otherPage.request.get(`/lessons/${lessonId}/documents/notes?rev=${revisionId}&download=1`, { maxRedirects: 0 })).status()).toBe(404);
    await ctx.close();
    const anonymous = await browser.newContext();
    expect((await anonymous.request.get(`/lessons/${lessonId}/documents/notes?rev=${revisionId}`, { maxRedirects: 0 })).status()).toBe(401);
    await anonymous.close();

    // there is no way to ask for the source, a missing revision, or a made-up document
    for (const bad of [`/lessons/${lessonId}/documents/notes.tex?rev=${revisionId}`, `/lessons/${lessonId}/documents/tex?rev=${revisionId}`, `/lessons/${lessonId}/documents/notes`, `/lessons/${lessonId}/documents/notes?rev=${lessonId}`, `/lessons/${lessonId}/documents/..%2Fnotes?rev=${revisionId}`]) {
      expect((await page.request.get(bad, { maxRedirects: 0 })).status(), bad).toBe(404);
    }
  } finally {
    await worker.stop();
  }
});

test("a pack of fewer documents shows only those tabs, and a document that was not made is not there", async ({ page }) => {
  const user = await createUser();
  const worker = await startStorageWorker();
  try {
    await signIn(page, user);
    await page.goto(TOPIC_URL);
    await page.getByLabel("Tutor Lesson Notes").uncheck();
    await page.getByLabel("Solutions / Answer Key").uncheck();
    await page.getByRole("button", { name: "Generate lesson" }).click();
    await expect(page).toHaveURL(/\/lessons\/[0-9a-f-]{36}\?rev=[0-9a-f-]{36}$/, { timeout: 45_000 });
    const [, lessonId, revisionId] = /\/lessons\/([0-9a-f-]{36})\?rev=([0-9a-f-]{36})/.exec(page.url())!;
    await expect(page.getByTestId("document-tabs").getByRole("link")).toHaveText(["Student Practice Worksheet"]);
    await expect(page.getByTestId("document-panel")).toHaveAttribute("data-document", "worksheet");
    expect((await page.request.get(`/lessons/${lessonId}/documents/notes?rev=${revisionId}`, { maxRedirects: 0 })).status()).toBe(404);
    // asking for a tab that does not exist falls back to the first one that does
    await page.goto(`/lessons/${lessonId}?rev=${revisionId}&doc=solutions`);
    await expect(page.getByTestId("document-panel")).toHaveAttribute("data-document", "worksheet");
  } finally {
    await worker.stop();
  }
});
