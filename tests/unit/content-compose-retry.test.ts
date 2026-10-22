import { describe, expect, it, vi } from "vitest";
import { LINEAR_GENERAL } from "@/lib/content/blueprints/linear-general";
import { composeLesson, EXERCISE_DRAW_FAILED } from "@/lib/content/compose";
import { PackageBuildError } from "@/lib/content/errors";

// Every draw returns the same question, so exercises always repeat the example's equation.
const calls = vi.hoisted(() => ({ seeds: [] as string[] }));
vi.mock("@/lib/math/generator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/math/generator")>();
  return {
    ...actual,
    generateExerciseSet: (args: Parameters<typeof actual.generateExerciseSet>[0]) => {
      calls.seeds.push(args.jobSeed);
      return actual.generateExerciseSet({ ...args, jobSeed: "same", count: 1, idPrefix: "q" });
    },
  };
});

describe("composeLesson retry rule", () => {
  it("tries 20 exercise draws, then fails with the pinned message", () => {
    expect(EXERCISE_DRAW_FAILED).toBe("could not draw exercises that differ from the worked examples");
    expect(() => composeLesson(LINEAR_GENERAL, { difficulty: "basic" }, "s", { exampleCount: 1, exerciseCount: 1, noSolutionExample: false })).toThrow(new PackageBuildError(EXERCISE_DRAW_FAILED));
    expect(calls.seeds).toEqual(["s:examples", ...Array.from({ length: 20 }, (_, i) => `s:exercises:${i}`)]);
  });
});
