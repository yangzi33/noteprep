import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDatasetDirs, readDatasetDir } from "@/lib/curriculum/files";
import { validateDataset } from "@/lib/curriculum/validate-dataset";

const root = path.join(__dirname, "../..");
const researchDirs = findDatasetDirs(path.join(root, "data/curricula-research"));

describe("researched datasets under data/curricula-research", () => {
  it("finds the Wales year-banded pilot", () => {
    expect(researchDirs.map((d) => path.relative(root, d))).toContain(path.join("data/curricula-research/uk-wales/suggested-2"));
  });

  for (const dir of researchDirs) {
    const name = path.relative(path.join(root, "data/curricula-research"), dir);
    const dataset = readDatasetDir(dir);
    const { levels, courses } = dataset.structure;

    it(`${name} passes every dataset rule and requires sources`, () => {
      expect(dataset.meta.version.requireSources).toBe(true);
      expect(validateDataset(dataset)).toEqual([]);
    });

    it(`${name} is not a shipped dataset`, () => {
      expect(existsSync(path.join(root, "data/curricula", ...name.split(path.sep)))).toBe(false);
    });

    it(`${name} places every course in a year band`, () => {
      expect(levels.length).toBeGreaterThan(1);
      for (const c of courses) expect(levels.some((l) => l.id === c.levelId), c.code).toBe(true);
    });
  }

  it("keeps the Wales GCSE tiers as separate courses with their own tier label", () => {
    const wales = readDatasetDir(path.join(root, "data/curricula-research/uk-wales/suggested-2"));
    const gcse = wales.structure.courses.filter((c) => c.tier);
    expect(gcse.map((c) => c.tier).sort()).toEqual(["Foundation", "Higher"]);
    const topicCount = (courseId: string) => wales.structure.topics.filter((t) => t.unitId.startsWith(`${courseId}/`)).length;
    const foundation = gcse.find((c) => c.tier === "Foundation")!;
    const higher = gcse.find((c) => c.tier === "Higher")!;
    expect(topicCount(higher.id)).toBeGreaterThan(topicCount(foundation.id));
  });
});
