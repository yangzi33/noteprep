import { describe, expect, it, vi } from "vitest";
import { NotFound } from "@/lib/domain/errors";
import { PACKAGE_REVISION_SCHEMA_VERSION } from "@/lib/package/schema";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createLessonsDal } from "@/lib/server/dal/lessons";
import { testPackage } from "../fixtures/package";

const ctx = makeAuthedCtx("11111111-1111-4111-8111-111111111111");
const LESSON = { id: "lesson-1", title: "T", currentRevisionId: "rev-1" };

function setup(opts: { lesson?: unknown; revision?: unknown }) {
  const lessonFind = vi.fn().mockResolvedValue("lesson" in opts ? opts.lesson : LESSON);
  const revisionFind = vi.fn().mockResolvedValue(opts.revision ?? null);
  const dal = createLessonsDal({ lesson: { findFirst: lessonFind }, lessonRevision: { findFirst: revisionFind } } as never);
  return { dal, lessonFind, revisionFind };
}

const revision = (over: Record<string, unknown> = {}) => ({
  id: "rev-1",
  number: 1,
  schemaVersion: PACKAGE_REVISION_SCHEMA_VERSION,
  content: testPackage(),
  artifactManifest: { secret: "path" },
  ...over,
});

describe("lessons.getLessonPackage", () => {
  it("filters by owner, non-deleted lesson and finalized revision", async () => {
    const { dal, lessonFind, revisionFind } = setup({ revision: revision() });
    await dal.getLessonPackage(ctx, "lesson-1");
    expect(lessonFind.mock.calls[0]![0].where).toEqual({ id: "lesson-1", ownerId: ctx.userId, deletedAt: null });
    expect(revisionFind.mock.calls[0]![0].where).toEqual({ id: "rev-1", lessonId: "lesson-1", ownerId: ctx.userId, status: "finalized" });
  });

  it("uses an explicitly requested revision id in the same owner-scoped filter", async () => {
    const { dal, revisionFind } = setup({ revision: revision({ id: "rev-9" }) });
    await dal.getLessonPackage(ctx, "lesson-1", "rev-9");
    expect(revisionFind.mock.calls[0]![0].where).toEqual({ id: "rev-9", lessonId: "lesson-1", ownerId: ctx.userId, status: "finalized" });
  });

  it("is NotFound when the lesson is missing", async () => {
    const { dal } = setup({ lesson: null });
    await expect(dal.getLessonPackage(ctx, "lesson-1")).rejects.toBeInstanceOf(NotFound);
  });

  it("is NotFound when the revision is missing", async () => {
    const { dal } = setup({ revision: null });
    await expect(dal.getLessonPackage(ctx, "lesson-1")).rejects.toBeInstanceOf(NotFound);
  });

  it("is NotFound for a legacy schemaVersion", async () => {
    const { dal } = setup({ revision: revision({ schemaVersion: 1 }) });
    await expect(dal.getLessonPackage(ctx, "lesson-1")).rejects.toBeInstanceOf(NotFound);
  });

  it("is NotFound for content that is not a valid package", async () => {
    const { dal } = setup({ revision: revision({ content: { sections: "nope" } }) });
    await expect(dal.getLessonPackage(ctx, "lesson-1")).rejects.toBeInstanceOf(NotFound);
  });

  it("returns only ids and the parsed package", async () => {
    const pkg = testPackage();
    const { dal } = setup({ revision: revision({ content: pkg }) });
    const out = await dal.getLessonPackage(ctx, "lesson-1");
    expect(Object.keys(out).sort()).toEqual(["lessonId", "package", "revisionId"]);
    expect(out.lessonId).toBe("lesson-1");
    expect(out.revisionId).toBe("rev-1");
    expect(out.package.sections.length).toBe(pkg.sections.length);
    expect("artifactManifest" in out).toBe(false);
  });
});
