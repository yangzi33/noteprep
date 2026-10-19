import { describe, expect, it } from "vitest";
import { artifactPathV2, parseManifestV2 } from "@/lib/domain/manifest";
import { alignmentNotice, DOCUMENT_LABELS, succeededLessonLink } from "@/lib/ui/lesson-view";

const file = (n: number) => ({ path: `o/l/r/a/${n}`, sha256: "a".repeat(64), bytes: 10 });
const manifest = (over: Record<string, unknown> = {}) => ({
  manifestVersion: 2,
  templateVersion: "classic/1",
  documents: [{ document: "notes", pdf: { ...file(1), pages: 2 }, tex: file(2) }],
  ...over,
});

describe("reading a stored manifest", () => {
  it("accepts a version 2 manifest", () => {
    expect(parseManifestV2(manifest())?.documents[0]?.pdf.pages).toBe(2);
  });
  it("is null for a legacy manifest, a missing one, and anything damaged", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "x",
      { manifestVersion: 1, files: [] },
      manifest({ manifestVersion: 3 }),
      manifest({ documents: [] }),
      manifest({ documents: [{ document: "answers", pdf: { ...file(1), pages: 1 }, tex: file(2) }] }),
      manifest({ documents: [{ document: "notes", pdf: { ...file(1), pages: 0 }, tex: file(2) }] }),
      manifest({ documents: [{ document: "notes", pdf: { ...file(1), sha256: "xyz", pages: 1 }, tex: file(2) }] }),
      manifest({ documents: [{ document: "notes", pdf: { ...file(1), pages: 1, extra: true }, tex: file(2) }] }),
    ];
    for (const value of bad) expect(parseManifestV2(value), JSON.stringify(value)).toBeNull();
  });
  it("round-trips what the worker publishes", () => {
    const scope = { ownerId: "o", lessonId: "l", revisionId: "r", attemptId: "a" };
    const pdf = { path: artifactPathV2(scope, "worksheet", "pdf"), sha256: "b".repeat(64), bytes: 5, pages: 1 };
    const tex = { path: artifactPathV2(scope, "worksheet", "tex"), sha256: "c".repeat(64), bytes: 5 };
    expect(parseManifestV2({ manifestVersion: 2, templateVersion: "classic/1", documents: [{ document: "worksheet", pdf, tex }] })).not.toBeNull();
  });
});

describe("the curriculum notice", () => {
  const base = { curriculumName: "Sample Mathematics (not a real curriculum)", versionLabel: "sample-1" };
  it("never claims alignment for a sample or test dataset, even if the stored claim says aligned", () => {
    for (const datasetKind of ["sample", "synthetic"] as const) {
      const text = alignmentNotice({ ...base, claim: "aligned", datasetKind });
      expect(text).toContain("makes no claim of alignment");
      expect(text).not.toMatch(/aligned with|built from/i);
    }
  });
  const NAME = "Sample Mathematics (not a real curriculum)";
  const SAMPLE_TEXT = `Based on the sample dataset “${NAME}” (sample-1). This is not a real curriculum and makes no claim of alignment.`;
  it("says exactly this for each combination of dataset kind and claim", () => {
    expect(alignmentNotice({ ...base, claim: "none", datasetKind: "sample" })).toBe(SAMPLE_TEXT);
    expect(alignmentNotice({ ...base, claim: "none", datasetKind: "synthetic" })).toBe(`Based on the test dataset “${NAME}” (sample-1). This is not a real curriculum and makes no claim of alignment.`);
    expect(alignmentNotice({ curriculumName: "Ontario Mathematics", versionLabel: "2021", claim: "none", datasetKind: "real" })).toBe("Built from Ontario Mathematics (2021). This lesson makes no claim of alignment.");
    expect(alignmentNotice({ curriculumName: "Ontario Mathematics", versionLabel: "2021", claim: "aligned", datasetKind: "real" })).toBe("Built from Ontario Mathematics (2021).");
  });
  it("never calls a real dataset a sample or not a real curriculum", () => {
    const text = alignmentNotice({ curriculumName: "Ontario Mathematics", versionLabel: "2021", claim: "none", datasetKind: "real" });
    expect(text).not.toMatch(/sample|not a real curriculum|test dataset/i);
  });
  it("links a finished job to its revision, or says the pack was saved without a preview", () => {
    expect(succeededLessonLink({ lessonId: "L", revisionId: "R" })).toEqual({ href: "/lessons/L?rev=R", text: "The lesson pack is ready." });
    expect(succeededLessonLink({ lessonId: "L", revisionId: null })).toEqual({ href: null, text: "The lesson pack was saved, but it has no preview." });
    expect(JSON.stringify([succeededLessonLink({ lessonId: "L", revisionId: "R" }), succeededLessonLink({ lessonId: "L", revisionId: null })])).not.toMatch(/placeholder/i);
  });
  it("names the three documents the way the tutor knows them", () => {
    expect(Object.values(DOCUMENT_LABELS)).toEqual(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
  });
});
