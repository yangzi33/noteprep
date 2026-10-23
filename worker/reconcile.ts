import type { JobsDal } from "@/lib/server/dal/jobs";
import { StorageError, type ObjectStore } from "@/lib/storage/store";
import { log } from "./log";

/**
 * Orphan object reconciler (S5-7). A crash after an upload and before the commit leaves objects no manifest references.
 * This sweeps them. It only ever DELETES OBJECTS: it writes no database row and never touches allowance or billing.
 *
 * Layout under the bucket: <ownerId>/<lessonId>/<revisionId>/<attemptId>/<document>.<pdf|tex> (v1 packs use the same four levels).
 *  - A revision folder is deleted only when no lesson_revision row of that lesson has that id.
 *  - An attempt folder inside an existing revision is deleted only when no manifest of the lesson (v1 list, v2, v3: every
 *    string in it is read as a possible path) names a path under it.
 *  - Order matters: the folders are LISTED first, then the database is read again immediately before EACH delete. An upload
 *    that starts after the listing uses fresh random ids, so it is never in the list; an attempt that finished after the
 *    listing has a revision row and a manifest by the time of the re-read, so it is kept; a live job makes the lesson
 *    ineligible and nothing is deleted.
 *  - Objects of deleted lessons are out of scope (deferred; the lesson-delete path owns them).
 * - Bounded: a step has a wall-clock budget (an AbortSignal stops every further storage call and delete once it passes) and a
 *   cap on deletes; the loop runs it on its own timer, so a slow or hung storage call never delays job recovery.
 * Logs carry counts and lesson ids only, never a path or content.
 */

export interface ReconcileReport {
  lessons: number;
  revisionsDeleted: number;
  attemptsDeleted: number;
  skipped: number;
  errors: number;
}

export type ReconcileJobs = Pick<JobsDal, "listReconcileCandidates" | "readLessonForReconcile">;

export interface ReconcileDeps {
  jobs: ReconcileJobs;
  store: ObjectStore;
  graceMs: number;
  /** Stops the reconcile as soon as it aborts: checked before every database read, storage call and delete. */
  signal?: AbortSignal;
  /** Hard cap on folders deleted in one step (default MAX_DELETES_PER_STEP). */
  maxDeletes?: number;
}

/** Thrown inside a step when the delete cap is reached; the step stops normally (not an error). */
class WorkCapReached extends Error {
  constructor() {
    super("work cap reached");
    this.name = "WorkCapReached";
  }
}

export const MAX_DELETES_PER_STEP = 200;
export const DEFAULT_STEP_BUDGET_MS = 60_000;

/** Thrown BEFORE a delete when the prefix is, contains or sits inside a path a manifest references. */
export class ReferencedPathError extends Error {
  constructor() {
    super("refusing to delete a path referenced by a manifest");
    this.name = "ReferencedPathError";
  }
}

// Lowercase only: every id we write is a lowercase uuid, so any other spelling is not ours and is never touched.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE = 100;
const MAX_PAGES = 20; // per level; a longer listing is a safe abort for that lesson (treated like MAX_FOLDERS)
const MAX_FOLDERS = 500; // per level; a lesson with more is left alone (counted as skipped)

/** Every string anywhere in a stored manifest (a v1 list, a v2 or v3 object, or anything unknown). */
export function manifestStrings(manifest: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof manifest === "string") into.add(manifest);
  else if (Array.isArray(manifest)) for (const v of manifest) manifestStrings(v, into);
  else if (manifest && typeof manifest === "object") for (const v of Object.values(manifest)) manifestStrings(v, into);
  return into;
}

/** Throws unless `prefix` is entirely unreferenced: equal to, above or below any referenced path counts as a reference. */
export function assertUnreferenced(prefix: string, referenced: ReadonlySet<string>): void {
  for (const ref of referenced) {
    if (ref === prefix || ref.startsWith(`${prefix}/`) || prefix.startsWith(`${ref}/`)) throw new ReferencedPathError();
  }
}

async function folders(store: ObjectStore, prefix: string, signal?: AbortSignal): Promise<string[] | null> {
  const out: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    if (++pages > MAX_PAGES) return null;
    signal?.throwIfAborted();
    const page = await store.list(prefix, { limit: PAGE, cursor, signal });
    for (const e of page.entries) if (e.kind === "folder" && UUID.test(e.name)) out.push(e.name);
    if (out.length > MAX_FOLDERS) return null;
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** Reconciles one lesson. Exported for tests; the loop calls it through `createReconciler`. */
export async function reconcileLesson(deps: ReconcileDeps, lesson: { lessonId: string; ownerId: string }, report: ReconcileReport): Promise<void> {
  const { jobs, store, graceMs, signal } = deps;
  const maxDeletes = deps.maxDeletes ?? MAX_DELETES_PER_STEP;
  const base = `${lesson.ownerId}/${lesson.lessonId}`;
  report.lessons++;

  // 1. List first.
  const revisionNames = await folders(store, base, signal);
  if (revisionNames === null) return void report.skipped++;
  const attemptsOf = new Map<string, string[]>();
  for (const rev of revisionNames) {
    const attempts = await folders(store, `${base}/${rev}`, signal);
    if (attempts === null) return void report.skipped++;
    attemptsOf.set(rev, attempts);
  }

  // 2. Re-read the database before each delete; delete only what that fresh read still shows as orphaned.
  const deleteIfOrphan = async (prefix: string, revisionId: string, attemptId: string | null): Promise<boolean> => {
    signal?.throwIfAborted();
    const state = await jobs.readLessonForReconcile(lesson.lessonId, graceMs);
    if (!state || !state.eligible || state.ownerId !== lesson.ownerId) return false; // deleted, live job, recent activity or other owner
    const revisionExists = state.revisions.some((r) => r.id === revisionId);
    if (attemptId === null ? revisionExists : !revisionExists) return false; // a revision row appeared (or vanished) since the listing
    const referenced = new Set<string>();
    for (const r of state.revisions) manifestStrings(r.manifest, referenced);
    assertUnreferenced(prefix, referenced); // throws before any delete
    if (report.revisionsDeleted + report.attemptsDeleted >= maxDeletes) throw new WorkCapReached();
    signal?.throwIfAborted();
    await store.deletePrefix(prefix, { signal });
    return true;
  };

  for (const rev of revisionNames) {
    const revPrefix = `${base}/${rev}`;
    signal?.throwIfAborted();
    const state = await jobs.readLessonForReconcile(lesson.lessonId, graceMs);
    if (!state || !state.eligible) return void report.skipped++;
    if (!state.revisions.some((r) => r.id === rev)) {
      if (await deleteIfOrphan(revPrefix, rev, null)) report.revisionsDeleted++;
      else report.skipped++;
      continue;
    }
    for (const attempt of attemptsOf.get(rev) ?? []) {
      const prefix = `${revPrefix}/${attempt}`;
      signal?.throwIfAborted();
      const fresh = await jobs.readLessonForReconcile(lesson.lessonId, graceMs);
      if (!fresh || !fresh.eligible) return void report.skipped++;
      const referenced = new Set<string>();
      for (const r of fresh.revisions) manifestStrings(r.manifest, referenced);
      if ([...referenced].some((p) => p.startsWith(`${prefix}/`))) continue; // published: keep
      if (await deleteIfOrphan(prefix, rev, attempt)) report.attemptsDeleted++;
      else report.skipped++;
    }
  }
}

export interface Reconciler {
  /** `signal` (the worker's shutdown) aborts the step early. Never throws; always returns within the budget. */
  step: (signal?: AbortSignal) => Promise<ReconcileReport>;
}

/**
 * A batch-at-a-time reconciler that walks the lessons by id and wraps around; one `step` is bounded by `batchSize` lessons,
 * `maxDeletes` deletes and `budgetMs` of wall-clock time. When the budget passes, the step aborts its signal (no further
 * storage call or delete starts), counts one error and returns what it did. A call stuck inside the storage client cannot be
 * cancelled, so a later step is skipped until the stuck one settles: there is never more than one step's work in flight.
 */
export function createReconciler(deps: ReconcileDeps & { batchSize: number; budgetMs?: number }): Reconciler {
  let after: string | null = null;
  let inFlight: Promise<void> | null = null;
  const budgetMs = deps.budgetMs ?? DEFAULT_STEP_BUDGET_MS;

  async function run(report: ReconcileReport, signal: AbortSignal): Promise<void> {
    try {
      const candidates = await deps.jobs.listReconcileCandidates(deps.batchSize, deps.graceMs, after);
      after = candidates.length < deps.batchSize ? null : candidates[candidates.length - 1]!.lessonId;
      for (const candidate of candidates) {
        if (signal.aborted) return;
        try {
          await reconcileLesson({ ...deps, signal }, candidate, report);
        } catch (error) {
          if (error instanceof WorkCapReached) return void log("reconcile_work_cap", { deletes: report.revisionsDeleted + report.attemptsDeleted });
          if (signal.aborted) return; // the budget or shutdown, not a lesson failure
          report.errors++;
          log("reconcile_lesson_error", { lessonId: candidate.lessonId, code: error instanceof Error ? error.name : "unknown", ...(error instanceof StorageError && error.detail?.status ? { storageStatus: error.detail.status } : {}) });
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        report.errors++;
        log("reconcile_step_error", { code: error instanceof Error ? error.name : "unknown" });
      }
    }
  }

  return {
    async step(outer) {
      const report: ReconcileReport = { lessons: 0, revisionsDeleted: 0, attemptsDeleted: 0, skipped: 0, errors: 0 };
      if (inFlight) {
        log("reconcile_busy", {});
        return report;
      }
      const ctl = new AbortController();
      const onOuter = () => ctl.abort();
      if (outer?.aborted) return report;
      outer?.addEventListener("abort", onOuter, { once: true });
      const work = run(report, ctl.signal);
      const tracked: Promise<void> = work.finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
      inFlight = tracked;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<"budget">((resolve) => {
        timer = setTimeout(() => resolve("budget"), budgetMs);
      });
      try {
        const winner = await Promise.race([work.then(() => "done" as const), budget]);
        if (winner === "budget") {
          ctl.abort();
          report.errors++;
          log("reconcile_budget_exceeded", { budgetMs, lessons: report.lessons, deleted: report.revisionsDeleted + report.attemptsDeleted });
        }
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onOuter);
      }
      return report;
    },
  };
}
