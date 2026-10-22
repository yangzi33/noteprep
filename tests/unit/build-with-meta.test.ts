import { describe, expect, it } from "vitest";
import { exampleLevel } from "@/lib/content/compose";
import { difficultyRamp } from "@/lib/math/generator";
import { buildPackage, buildPackageWithMeta, planOutline } from "@/lib/package/build";
import { packageContentHash } from "@/lib/package/adjust";
import { testContext, testRequest } from "../fixtures/package";

const DIFFICULTIES = ["basic", "mixed", "challenge"] as const;
const DURATIONS = [15, 45, 60, 120, 180] as const;

describe("buildPackageWithMeta", () => {
  it("returns exactly the package buildPackage returns (same bytes, same hash)", () => {
    for (const difficulty of DIFFICULTIES)
      for (const durationMinutes of DURATIONS) {
        const args = { request: testRequest({ difficulty, durationMinutes }), context: testContext(), seed: `meta-${difficulty}-${durationMinutes}` };
        const withMeta = buildPackageWithMeta(args).pkg;
        const plain = buildPackage(args);
        expect(JSON.stringify(withMeta)).toBe(JSON.stringify(plain));
        expect(packageContentHash(withMeta)).toBe(packageContentHash(plain));
      }
  });

  it("records the level of every drawn question, and the levels follow the ramp", () => {
    for (const difficulty of DIFFICULTIES)
      for (const durationMinutes of DURATIONS) {
        const request = testRequest({ difficulty, durationMinutes });
        const { pkg, levels } = buildPackageWithMeta({ request, context: testContext(), seed: "meta-ramp" });
        const plan = planOutline(durationMinutes);

        const exerciseIds = pkg.sections.find((s) => s.kind === "exercises")!.blocks.flatMap((b) => (b.type === "question" ? [b.questionId] : []));
        const exampleIds = pkg.sections.find((s) => s.kind === "worked_examples")!.blocks.flatMap((b) => (b.type === "worked_example" ? [b.questionId] : []));
        expect(exerciseIds).toHaveLength(plan.exerciseCount);

        // exercises: the lesson difficulty, ramped for "mixed"
        expect(exerciseIds.map((id) => levels[id])).toEqual(difficultyRamp(plan.exerciseCount, difficulty));
        // examples: exampleLevel(difficulty), ramped; a non-basic lesson ends with the no-solution example, drawn at "mixed"
        const ordinary = exampleIds.slice(0, plan.exampleCount);
        expect(ordinary.map((id) => levels[id])).toEqual(difficultyRamp(plan.exampleCount, exampleLevel(difficulty)));
        expect(exampleIds.length).toBe(plan.exampleCount + (difficulty === "basic" ? 0 : 1));
        if (difficulty !== "basic") expect(levels[exampleIds.at(-1)!]).toBe("mixed");

        // nothing else is recorded, and nothing is missing
        expect(Object.keys(levels).sort()).toEqual([...exerciseIds, ...exampleIds].sort());
      }
  });
});
