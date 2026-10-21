import { describe, expect, it } from "vitest";
import { alignmentClaimsAllowedFor } from "@/lib/curriculum/context";
import { DATASET_KINDS } from "@/lib/curriculum/dataset-schema";
import { AlignmentBlock, StoredContextShape } from "@/lib/package/schema";
import { createCurriculumDal, visibleKinds } from "@/lib/server/dal/curriculum";

const block = (datasetKind: string) => ({ type: "alignment", claim: "none", curriculumName: "n", versionLabel: "v", datasetKind, objectives: [] });
const context = (kind: string) => ({
  curriculum: { name: "n", version: { label: "v", kind } },
  objectives: [],
  prerequisites: [],
  alignmentClaimsAllowed: false,
  contextHash: "sha256:x",
});

describe("dataset kinds", () => {
  it("lists suggested alongside the old kinds", () => {
    expect([...DATASET_KINDS]).toEqual(["real", "sample", "synthetic", "suggested"]);
  });
  it("only a real dataset can ever allow an alignment claim", () => {
    for (const kind of DATASET_KINDS) expect(alignmentClaimsAllowedFor(kind)).toBe(kind === "real");
  });
});

describe("stored lesson packages", () => {
  it("old kinds still parse, and suggested parses too", () => {
    for (const kind of ["real", "sample", "synthetic", "suggested"]) {
      expect(AlignmentBlock.safeParse(block(kind)).success, kind).toBe(true);
      expect(StoredContextShape.safeParse(context(kind)).success, kind).toBe(true);
    }
  });
  it("an unknown kind is still refused", () => {
    expect(AlignmentBlock.safeParse(block("official")).success).toBe(false);
    expect(StoredContextShape.safeParse(context("official")).success).toBe(false);
  });
});

describe("which dataset kinds the application can see", () => {
  it("suggested is visible everywhere, with no flag; sample and synthetic still need theirs", () => {
    expect(visibleKinds({})).toEqual(["real", "suggested"]);
    expect(visibleKinds({ allowSample: true })).toEqual(["real", "suggested", "sample"]);
    expect(visibleKinds({ allowSynthetic: true })).toEqual(["real", "suggested", "synthetic"]);
    expect(visibleKinds({ allowSample: true, allowSynthetic: true })).toEqual(["real", "suggested", "sample", "synthetic"]);
  });
  it("the queries use that filter", async () => {
    const seen: unknown[] = [];
    const db = { curriculum: { findMany: async (args: { where: unknown }) => (seen.push(args.where), []) } };
    await createCurriculumDal(db as never).listCurricula();
    expect(JSON.stringify(seen[0])).toContain('"in":["real","suggested"]');
  });
});
