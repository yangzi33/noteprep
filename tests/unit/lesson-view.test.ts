import { describe, expect, it } from "vitest";
import { artifactPathV2, parseManifestV2 } from "@/lib/domain/manifest";
import { alignmentNotice, DOCUMENT_LABELS } from "@/lib/ui/lesson-view";

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
  it("states the source only for a real dataset that supports a claim", () => {
    expect(alignmentNotice({ ...base, claim: "aligned", datasetKind: "real" })).toBe("Built from Sample Mathematics (not a real curriculum) (sample-1).");
    expect(alignmentNotice({ ...base, claim: "none", datasetKind: "real" })).toContain("no claim of alignment");
  });
  it("names the three documents the way the tutor knows them", () => {
    expect(Object.values(DOCUMENT_LABELS)).toEqual(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
  });
});
