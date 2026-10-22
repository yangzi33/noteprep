import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { code, createHarness, freshKey, request, type Harness } from "./export-helpers";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.expectNoDrift();
  await h.abandonPending();
});
afterAll(async () => {
  await h.close();
});

describe("export owner isolation", () => {
  it("another user's confirm of a foreign draft or version, and status of a foreign export, are NOT_FOUND and change nothing", async () => {
    const alice = await h.account();
    const mallory = await h.account();
    const d = await h.newDraft(alice);
    const mine = await h.newDraft(mallory);
    const exp = await h.confirm(alice, d);

    const before = { a: await h.bucket(alice.userId), m: await h.bucket(mallory.userId) };
    // alice's draft with alice's rev and hash, but mallory's identity
    expect(await code(h.confirm(mallory, d))).toBe("NOT_FOUND");
    // mallory's draft id combined with alice's version id, and the reverse
    expect(await code(h.confirm(mallory, { ...mine, versionId: d.versionId }))).toBe("NOT_FOUND");
    expect(await code(h.confirm(alice, { ...d, versionId: mine.versionId }))).toBe("NOT_FOUND");
    expect(await code(h.confirm(mallory, { ...d, draftId: randomUUID() }))).toBe("NOT_FOUND");
    expect(await code(h.web.exports.getExportStatus(mallory, exp.exportId))).toBe("NOT_FOUND");
    expect(await code(h.web.exports.getExportStatus(mallory, "nope"))).toBe("NOT_FOUND");
    expect(await code(h.web.exports.getExportStatus(mallory, randomUUID()))).toBe("NOT_FOUND");
    expect(await h.bucket(alice.userId)).toEqual(before.a);
    expect(await h.bucket(mallory.userId)).toEqual(before.m);
    expect(await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1`, [mallory.userId])).toBe(0);
    // the owner is unaffected
    expect((await h.web.exports.getExportStatus(alice, exp.exportId)).state).toBe("pending");
    expect(await h.web.history.listJobs(mallory)).toEqual([]);
  });

  it("idempotency keys are scoped by user: the same key text means two independent requests", async () => {
    const alice = await h.account();
    const bob = await h.account();
    const [a, b] = [await h.newDraft(alice), await h.newDraft(bob)];
    const key = freshKey();
    const [ra, rb] = await Promise.all([h.confirm(alice, a, key), h.confirm(bob, b, key)]);
    expect([ra.outcome, rb.outcome]).toEqual(["created", "created"]);
    expect(ra.exportId).not.toBe(rb.exportId);
  });

  it("equivalent content of two users is never joined or reused across accounts", async () => {
    const same = await createHarness({ fixedSeed: "shared-seed" });
    try {
      const [alice, bob] = [await same.account(), await same.account()];
      const [a, b] = [await same.newDraft(alice), await same.newDraft(bob)];
      expect(a.contentHash).toBe(b.contentHash);
      const ra = await same.confirm(alice, a);
      await same.complete(ra.jobId);
      const rb = await same.confirm(bob, b);
      expect(rb.outcome).toBe("created");
      expect(rb.exportId).not.toBe(ra.exportId);
      expect(await same.bucket(bob.userId)).toMatchObject({ reserved: 1 });
    } finally {
      await same.close();
    }
  });

  it("exports of one account never use another account's allowance", async () => {
    const poor = await h.account(1);
    const rich = await h.account(5);
    await h.confirm(poor, await h.newDraft(poor));
    expect(await code(h.confirm(poor, await h.newDraft(poor)))).toBe("ALLOWANCE_EXHAUSTED");
    expect(await h.bucket(rich.userId)).toMatchObject({ used: 0, reserved: 0 });
    // and the legacy flow is unaffected
    await h.web.generation.createGeneration(rich, request(), freshKey());
    expect(await h.bucket(rich.userId)).toMatchObject({ reserved: 1 });
  });
});
