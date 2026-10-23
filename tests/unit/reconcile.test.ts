import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FsObjectStore } from "@/lib/storage/store";
import { assertUnreferenced, createReconciler, manifestStrings, reconcileLesson, ReferencedPathError, type ReconcileJobs, type ReconcileReport } from "../../worker/reconcile";

const OWNER = randomUUID();
const LESSON = randomUUID();
const REV = randomUUID();
const KEPT = randomUUID();
const ORPHAN = randomUUID();
const base = `${OWNER}/${LESSON}`;

let dir: string;
let store: FsObjectStore;
const deletes: string[] = [];
const recording = () => ({
  put: (p: string, d: Uint8Array) => store.put(p, d),
  stat: (p: string) => store.stat(p),
  list: (p: string, o: { limit: number; cursor?: string | null }) => store.list(p, o),
  deleteObject: (p: string) => store.deleteObject(p),
  deletePrefix: async (p: string) => (deletes.push(p), store.deletePrefix(p)),
});
const fresh = (): ReconcileReport => ({ lessons: 0, revisionsDeleted: 0, attemptsDeleted: 0, skipped: 0, errors: 0 });
const manifest = { manifestVersion: 2, templateVersion: "t", documents: [{ document: "notes", pdf: { path: `${base}/${REV}/${KEPT}/notes.pdf` }, tex: { path: `${base}/${REV}/${KEPT}/notes.tex` } }] };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "noteprep-reconcile-unit-"));
  store = new FsObjectStore(dir);
});
afterAll(() => rm(dir, { recursive: true, force: true }));
beforeEach(async () => {
  deletes.length = 0;
  await store.deletePrefix(OWNER);
  for (const p of [`${base}/${REV}/${KEPT}/notes.pdf`, `${base}/${REV}/${KEPT}/notes.tex`, `${base}/${REV}/${ORPHAN}/notes.pdf`]) await store.put(p, new Uint8Array([1]));
});

const jobsWith = (state: () => Awaited<ReturnType<ReconcileJobs["readLessonForReconcile"]>>): ReconcileJobs => ({
  listReconcileCandidates: async () => [{ lessonId: LESSON, ownerId: OWNER }],
  readLessonForReconcile: async () => state(),
});
const eligible = () => ({ ownerId: OWNER, eligible: true, revisions: [{ id: REV, manifest }] });

describe("the manifest-reference guard", () => {
  it("reads every string of a v1 list, a v2 and a v3-like object", () => {
    expect([...manifestStrings([{ edition: "student", path: "a/b/c" }])]).toContain("a/b/c");
    expect([...manifestStrings(manifest)]).toContain(`${base}/${REV}/${KEPT}/notes.tex`);
  });
  it("refuses a prefix equal to, above or below a referenced path, and allows a sibling with a similar name", () => {
    const refs = new Set(["o/l/r/a1/notes.pdf"]);
    for (const p of ["o/l/r/a1/notes.pdf", "o/l/r/a1", "o/l/r", "o/l", "o/l/r/a1/notes.pdf/x"]) expect(() => assertUnreferenced(p, refs)).toThrow(ReferencedPathError);
    expect(() => assertUnreferenced("o/l/r/a", refs)).not.toThrow();
    expect(() => assertUnreferenced("o/l/r/a2", refs)).not.toThrow();
  });
});

describe("reconcileLesson", () => {
  it("deletes only the unreferenced attempt of an existing revision", async () => {
    const report = fresh();
    await reconcileLesson({ jobs: jobsWith(eligible), store: recording(), graceMs: 0 }, { lessonId: LESSON, ownerId: OWNER }, report);
    expect(deletes).toEqual([`${base}/${REV}/${ORPHAN}`]);
    expect(report).toMatchObject({ attemptsDeleted: 1, revisionsDeleted: 0, errors: 0 });
    expect(await store.stat(`${base}/${REV}/${KEPT}/notes.pdf`)).not.toBeNull();
    expect(await store.stat(`${base}/${REV}/${ORPHAN}/notes.pdf`)).toBeNull();
  });

  it("deletes a revision folder no revision row names, and leaves non-uuid names alone", async () => {
    const stray = randomUUID();
    await store.put(`${base}/${stray}/${ORPHAN}/notes.pdf`, new Uint8Array([1]));
    await store.put(`${base}/not-a-uuid/${ORPHAN}/notes.pdf`, new Uint8Array([1]));
    const report = fresh();
    await reconcileLesson({ jobs: jobsWith(eligible), store: recording(), graceMs: 0 }, { lessonId: LESSON, ownerId: OWNER }, report);
    expect(deletes).toContain(`${base}/${stray}`);
    expect(deletes.some((d) => d.includes("not-a-uuid"))).toBe(false);
    expect(await store.stat(`${base}/not-a-uuid/${ORPHAN}/notes.pdf`)).not.toBeNull();
  });

  it("a job that became live after the listing stops every delete", async () => {
    let reads = 0;
    const report = fresh();
    await reconcileLesson({ jobs: jobsWith(() => (++reads === 1 ? eligible() : { ...eligible(), eligible: false })), store: recording(), graceMs: 0 }, { lessonId: LESSON, ownerId: OWNER }, report);
    expect(deletes).toEqual([]);
    expect(await store.stat(`${base}/${REV}/${ORPHAN}/notes.pdf`)).not.toBeNull();
    expect(report.skipped).toBeGreaterThan(0);
  });

  it("an ineligible lesson, a missing lesson and a different owner delete nothing", async () => {
    for (const state of [() => ({ ...eligible(), eligible: false }), () => null, () => ({ ...eligible(), ownerId: randomUUID() })]) {
      await reconcileLesson({ jobs: jobsWith(state), store: recording(), graceMs: 0 }, { lessonId: LESSON, ownerId: OWNER }, fresh());
    }
    expect(deletes).toEqual([]);
  });

  it("a revision row that appeared after the listing keeps its folder", async () => {
    // Folders are visited in name order. The stray id sorts before REV so its iteration holds the first read; with a random
    // id it came after REV about half the time and the row was already known, which made this test flaky.
    const stray = "00000000-0000-4000-8000-000000000000";
    expect(stray < REV).toBe(true);
    await store.put(`${base}/${stray}/${ORPHAN}/notes.pdf`, new Uint8Array([1]));
    let reads = 0;
    // The first read (before any delete is considered) does not know the revision; every later read (the re-read) does.
    const appearing = () => (++reads === 1 ? eligible() : { ownerId: OWNER, eligible: true, revisions: [{ id: REV, manifest }, { id: stray, manifest: null }] });
    await reconcileLesson({ jobs: jobsWith(appearing), store: recording(), graceMs: 0 }, { lessonId: LESSON, ownerId: OWNER }, fresh());
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(deletes).not.toContain(`${base}/${stray}`);
    expect(await store.stat(`${base}/${stray}/${ORPHAN}/notes.pdf`)).not.toBeNull();
  });

  it("never touches an uppercase uuid-like folder", async () => {
    const upper = randomUUID().toUpperCase();
    await store.put(`${base}/${upper}/${ORPHAN}/notes.pdf`, new Uint8Array([1]));
    await store.put(`${base}/${REV}/${randomUUID().toUpperCase()}/notes.pdf`, new Uint8Array([1]));
    await reconcileLesson({ jobs: jobsWith(eligible), store: recording(), graceMs: 0 }, { lessonId: LESSON, ownerId: OWNER }, fresh());
    expect(deletes.some((d) => d.includes(upper) || /[A-F]{2}/.test(d.split("/").slice(2).join("/")))).toBe(false);
    expect(await store.stat(`${base}/${upper}/${ORPHAN}/notes.pdf`)).not.toBeNull();
  });

  it("a listing that never ends is a safe abort for that lesson (page cap), deleting nothing", async () => {
    let calls = 0;
    const endless = { ...recording(), list: async () => (calls++, { entries: [{ name: "f.txt", kind: "file" as const }], nextCursor: "more" }) };
    const report = fresh();
    await reconcileLesson({ jobs: jobsWith(eligible), store: endless, graceMs: 0 }, { lessonId: LESSON, ownerId: OWNER }, report);
    expect(calls).toBe(20);
    expect(report.skipped).toBe(1);
    expect(deletes).toEqual([]);
  });
});

describe("the reconciler step", () => {
  it("a failing database read is counted, deletes nothing and never throws", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const jobs = jobsWith(() => {
      throw new Error("db down");
    });
    const r = createReconciler({ jobs, store: recording(), graceMs: 0, batchSize: 5 });
    expect(await r.step()).toMatchObject({ errors: 1, attemptsDeleted: 0, revisionsDeleted: 0 });
    expect(deletes).toEqual([]);
    vi.restoreAllMocks();
  });

  it("a hung storage call ends the step at the budget, stops further deletes, and a later step does not pile on", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let lists = 0;
    const hung = { ...recording(), list: (_p: string, o: { signal?: AbortSignal }) => (lists++, new Promise<never>(() => void o)) };
    const r = createReconciler({ jobs: jobsWith(eligible), store: hung, graceMs: 0, batchSize: 5, budgetMs: 30 });
    const started = Date.now();
    expect(await r.step()).toMatchObject({ errors: 1, attemptsDeleted: 0, revisionsDeleted: 0 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await r.step()).toMatchObject({ errors: 0, lessons: 0 }); // previous work still stuck: skipped
    expect(lists).toBe(1);
    expect(deletes).toEqual([]);
    vi.restoreAllMocks();
  });

  it("the budget signal reaches storage and an aborted step issues no further delete", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let seen: AbortSignal | undefined;
    const slow = {
      ...recording(),
      list: async (p: string, o: { limit: number; cursor?: string | null; signal?: AbortSignal }) => {
        seen = o.signal;
        await new Promise((res) => setTimeout(res, 60));
        return store.list(p, o);
      },
    };
    const r = createReconciler({ jobs: jobsWith(eligible), store: slow, graceMs: 0, batchSize: 5, budgetMs: 20 });
    await r.step();
    await new Promise((res) => setTimeout(res, 150));
    expect(seen?.aborted).toBe(true);
    expect(deletes).toEqual([]);
    vi.restoreAllMocks();
  });

  it("stops at the delete cap", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    for (let i = 0; i < 3; i++) await store.put(`${base}/${REV}/${randomUUID()}/notes.pdf`, new Uint8Array([1]));
    const r = createReconciler({ jobs: jobsWith(eligible), store: recording(), graceMs: 0, batchSize: 5, maxDeletes: 2 });
    expect(await r.step()).toMatchObject({ attemptsDeleted: 2, errors: 0 });
    vi.restoreAllMocks();
  });

  it("walks the keyset cursor and wraps to the start after a short page", async () => {
    const seen: (string | null | undefined)[] = [];
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const jobs: ReconcileJobs = {
      listReconcileCandidates: async (limit: number, _g: number, after?: string | null) => {
        seen.push(after);
        const rest = ids.filter((i) => !after || i > after).slice(0, limit);
        return rest.map((lessonId) => ({ lessonId, ownerId: OWNER }));
      },
      readLessonForReconcile: async () => null,
    };
    const r = createReconciler({ jobs, store: recording(), graceMs: 0, batchSize: 2 });
    await r.step();
    await r.step();
    await r.step();
    expect(seen).toEqual([null, ids[1], null]);
  });
});
