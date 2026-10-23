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
    const stray = randomUUID();
    await store.put(`${base}/${stray}/${ORPHAN}/notes.pdf`, new Uint8Array([1]));
    const withStray = () => ({ ownerId: OWNER, eligible: true, revisions: [{ id: REV, manifest }, { id: stray, manifest: null }] });
    await reconcileLesson({ jobs: jobsWith(withStray), store: recording(), graceMs: 0 }, { lessonId: LESSON, ownerId: OWNER }, fresh());
    expect(deletes).not.toContain(`${base}/${stray}`);
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
