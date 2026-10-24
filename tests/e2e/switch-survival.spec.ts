import { expect, test } from "@playwright/test";
import { E2E_URLS } from "./support/env";
import { SAMPLE_COURSE, SAMPLE_VERSION, createUser, deleteCreatedUsers, signIn, sql, startStorageWorker } from "./support/helpers";

// Runs in the default project (server 3100) but also uses the legacy server (3101, FLOW_MODE=legacy) to make the lesson, which is what a
// tutor's existing lesson looks like after the switch. Cookies are host-scoped, not port-scoped, but each server gets its own context
// and its own sign-in so the test does not depend on that.
test.afterAll(deleteCreatedUsers);

test("a lesson made with the legacy generate flow still opens, lists and downloads after the switch to the draft flow", async ({ browser }) => {
  const user = await createUser();
  const worker = await startStorageWorker();
  try {
    const legacy = await browser.newContext({ baseURL: E2E_URLS.legacy });
    const old = await legacy.newPage();
    await signIn(old, user);
    await old.goto(`/prepare?v=${SAMPLE_VERSION}&level=${SAMPLE_VERSION}/level-a&course=${SAMPLE_COURSE}&unit=${SAMPLE_COURSE}/equations&topic=${SAMPLE_COURSE}/equations/both-sides`);
    await old.getByRole("button", { name: "Generate lesson" }).click(); // the legacy charge-at-start button
    await expect(old).toHaveURL(/\/lessons\/[0-9a-f-]{36}\?rev=[0-9a-f-]{36}$/, { timeout: 45_000 });
    const [, lessonId, revisionId] = /\/lessons\/([0-9a-f-]{36})\?rev=([0-9a-f-]{36})/.exec(old.url())!;
    await legacy.close();

    const current = await browser.newContext({ baseURL: E2E_URLS.default });
    const page = await current.newPage();
    await signIn(page, user);

    // history row (a legacy job, not an export) and the allowance it used
    await page.goto("/lessons");
    await expect(page.getByTestId("allowance")).toHaveText("2 of 3 generations left.");
    await expect(page.getByTestId("history-list").locator("li")).toHaveCount(1);
    await page.getByTestId("history-list").getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/lessons/${lessonId}\\?rev=${revisionId}`));

    // preview and the three documents
    await expect(page.getByTestId("lesson-title")).toBeVisible();
    await expect(page.getByTestId("document-tabs").getByRole("link")).toHaveText(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
    for (const doc of ["notes", "worksheet", "solutions"]) {
      const redirect = await page.request.get(`/lessons/${lessonId}/documents/${doc}?rev=${revisionId}`, { maxRedirects: 0 });
      expect(redirect.status(), doc).toBe(302);
      const file = await fetch(redirect.headers()["location"]!);
      expect(file.status, doc).toBe(200);
      expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    // it is a lesson with no export row, and the switch changed nothing about it
    expect(await sql(`SELECT count(*)::int AS n FROM export WHERE owner_id = $1`, [user.id])).toEqual([{ n: 0 }]);
    await current.close();
  } finally {
    await worker.stop();
  }
});
