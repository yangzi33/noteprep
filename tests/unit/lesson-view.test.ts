import { describe, expect, it } from "vitest";
import { artifactPathV2, parseManifestV2 } from "@/lib/domain/manifest";
import { alignmentNotice, DOCUMENT_LABELS, succeededPanel } from "@/lib/ui/lesson-view";

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
  it("describes a suggested dataset as an unofficial NotePrep suggestion, never as aligned or built from a curriculum", () => {
    const text = alignmentNotice({ curriculumName: "Suggested topics for Test Course (unofficial)", versionLabel: "Suggested v1", claim: "aligned", datasetKind: "suggested" });
    expect(text).toContain("The topic list is an unofficial NotePrep suggestion (“Suggested topics for Test Course (unofficial) (Suggested v1)”).");
    expect(text).toMatch(/NotePrep/);
    expect(text).toMatch(/not an official curriculum/i);
    expect(text).toMatch(/not endorsed by any curriculum authority/i);
    expect(text).not.toMatch(/aligned with|built from|test dataset|sample dataset/i);
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
  describe("the panel of a succeeded job", () => {
    const job = { lessonId: "L", revisionId: "R" };
    it("links to the preview only once the server has confirmed one exists", () => {
      expect(succeededPanel(job, { serverConfirmed: true, hasPreview: true })).toEqual({ href: "/lessons/L?rev=R", text: "The lesson pack is ready." });
    });
    it("a legacy or unpreviewable pack gets no link, only an honest sentence", () => {
      expect(succeededPanel(job, { serverConfirmed: true, hasPreview: false })).toEqual({ href: null, text: "The lesson pack was saved; there is no preview for this one." });
      expect(succeededPanel({ ...job, revisionId: null }, { serverConfirmed: true, hasPreview: true })).toEqual({ href: null, text: "The lesson pack was saved; there is no preview for this one." });
    });
    it("a state that only the browser has seen (polling) shows no link and no verdict yet", () => {
      expect(succeededPanel(job, { serverConfirmed: false, hasPreview: false })).toEqual({ href: null, text: "Opening your lesson…" });
    });
    it("never mentions placeholder files", () => {
      for (const c of [{ serverConfirmed: true, hasPreview: true }, { serverConfirmed: true, hasPreview: false }, { serverConfirmed: false, hasPreview: false }]) expect(succeededPanel(job, c).text).not.toMatch(/placeholder/i);
    });
  });
  it("names the three documents the way the tutor knows them", () => {
    expect(Object.values(DOCUMENT_LABELS)).toEqual(["Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key"]);
  });
});
