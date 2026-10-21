import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkProse, PACKAGE_VALIDATOR_VERSION, validatePackage } from "@/lib/package/validate";
import { expectedInputsHash, rehashPackage } from "@/lib/package/inputs";
import { LessonRequestV2 } from "@/lib/domain/lesson-request";
import type { CurriculumContext } from "@/lib/curriculum/context";
import { PackageSchema, type LessonPackage } from "@/lib/package/schema";
import { VALIDATOR_VERSION } from "@/lib/math/validate";
import { testPackage } from "../fixtures/package";

type Stored = { seed: string; kind: "real" | "sample"; request: { difficulty: "basic" | "mixed" | "challenge"; durationMinutes: number; documents: ("notes" | "worksheet" | "solutions")[] }; package: LessonPackage };
const FIXTURE_PATH = "tests/fixtures/stored-package-v1.json";
const fixtureText = readFileSync(FIXTURE_PATH, "utf8");
const stored = JSON.parse(fixtureText) as Stored[];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const reqOf = (pkg: LessonPackage) => LessonRequestV2.parse(pkg.request);
const ctxOf = (pkg: LessonPackage) => pkg.context as CurriculumContext;

describe("stored v1 packages", () => {
  it("holds several packages", () => {
    expect(stored).toHaveLength(6);
  });
  it("all validate as verified under the current validator", () => {
    for (const s of stored) {
      expect(PackageSchema.safeParse(s.package).success).toBe(true);
      const report = validatePackage(s.package);
      expect(report.overall, `${s.seed}: ${JSON.stringify([report.structure.issues, report.prose.issues])}`).toBe("verified");
      expect(report.validatorVersion).toBe(PACKAGE_VALIDATOR_VERSION);
    }
  });
  it("are reproduced byte for byte by buildPackage", () => {
    const rebuilt = stored.map((s) => ({ seed: s.seed, kind: s.kind, request: s.request, package: testPackage(s.request, s.seed, s.kind) }));
    expect(JSON.stringify(rebuilt)).toBe(fixtureText);
  });
});

describe("validator version", () => {
  it("is package/2", () => {
    expect(PACKAGE_VALIDATOR_VERSION).toBe(`package/2+${VALIDATOR_VERSION}`);
  });
});

describe("expectedInputsHash", () => {
  it("equals the stored inputsHash for every section of every built package", () => {
    for (const difficulty of ["basic", "mixed", "challenge"] as const)
      for (const durationMinutes of [15, 45, 60, 120, 180]) {
        const pkg = testPackage({ difficulty, durationMinutes }, `h-${difficulty}-${durationMinutes}`);
        for (const section of pkg.sections) expect(expectedInputsHash(pkg, section, reqOf(pkg), ctxOf(pkg)), `${difficulty}/${durationMinutes}/${section.kind}`).toBe(section.inputsHash);
      }
    for (const s of stored) for (const section of s.package.sections) expect(expectedInputsHash(s.package, section, reqOf(s.package), ctxOf(s.package))).toBe(section.inputsHash);
  });

  function reseeded(): LessonPackage {
    const pkg = clone(testPackage({ difficulty: "basic", durationMinutes: 60 }, "seed-1"));
    for (const s of pkg.sections) if (s.kind === "exercises") s.provenance = { ...s.provenance, seed: "other-seed", difficulty: "challenge" };
    return pkg;
  }

  it("reads the section's own seed and difficulty", () => {
    const pkg = reseeded();
    const ex = pkg.sections.find((s) => s.kind === "exercises")!;
    expect(expectedInputsHash(pkg, ex, reqOf(pkg), ctxOf(pkg))).not.toBe(ex.inputsHash);
    const sol = pkg.sections.find((s) => s.kind === "solutions")!;
    expect(expectedInputsHash(pkg, sol, reqOf(pkg), ctxOf(pkg))).toBe(sol.inputsHash);
  });

  it("reports INPUTS_HASH_MISMATCH without rehash and verifies after rehashPackage", () => {
    const pkg = reseeded();
    const bad = validatePackage(pkg);
    expect(bad.structure.issues).toEqual([{ code: "INPUTS_HASH_MISMATCH", where: "sec-exercises" }]);
    expect(bad.overall).toBe("failed");
    const fixed = rehashPackage(pkg, reqOf(pkg), ctxOf(pkg));
    expect(validatePackage(fixed).overall).toBe("verified");
    expect(fixed.sections.find((s) => s.kind === "exercises")!.inputsHash).not.toBe(pkg.sections.find((s) => s.kind === "exercises")!.inputsHash);
    expect(fixed.sections.filter((s) => s.kind !== "exercises")).toEqual(pkg.sections.filter((s) => s.kind !== "exercises"));
  });

  it("rehashPackage leaves an unmodified package unchanged and does not mutate its input", () => {
    const pkg = testPackage({}, "seed-9");
    const before = JSON.stringify(pkg);
    expect(JSON.stringify(rehashPackage(pkg, reqOf(pkg), ctxOf(pkg)))).toBe(before);
    expect(JSON.stringify(pkg)).toBe(before);
  });
});

describe("schema additions", () => {
  it("accepts adjustments and provenance.difficulty, strictly", () => {
    const pkg = clone(testPackage());
    const adj = { action: "set_difficulty", method: "deterministic", seed: "s", sourceContentHash: `sha256:${"a".repeat(64)}` };
    expect(PackageSchema.safeParse({ ...pkg, adjustments: [adj] }).success).toBe(true);
    expect(PackageSchema.safeParse({ ...pkg, adjustments: [{ ...adj, extra: 1 }] }).success).toBe(false);
    expect(PackageSchema.safeParse({ ...pkg, adjustments: [{ ...adj, method: "magic" }] }).success).toBe(false);
    expect(PackageSchema.safeParse({ ...pkg, adjustments: [{ ...adj, sourceContentHash: "x" }] }).success).toBe(false);
    expect(PackageSchema.safeParse({ ...pkg, adjustments: Array(201).fill(adj) }).success).toBe(false);
    const withDiff = clone(pkg);
    withDiff.sections[7]!.provenance = { ...withDiff.sections[7]!.provenance, difficulty: "challenge" };
    expect(PackageSchema.safeParse(withDiff).success).toBe(true);
    withDiff.sections[7]!.provenance = { ...withDiff.sections[7]!.provenance, difficulty: "hard" as never };
    expect(PackageSchema.safeParse(withDiff).success).toBe(false);
  });
});

describe("section titles are prose-checked", () => {
  const withTitle = (kind: string, title: string) => {
    const pkg = clone(testPackage());
    pkg.sections.find((s) => s.kind === kind)!.title = title;
    return checkProse(pkg, ctxOf(pkg));
  };
  it("passes every title the builder produces", () => {
    for (const kind of ["sample", "real"] as const) for (const difficulty of ["basic", "mixed", "challenge"] as const) {
      const pkg = testPackage({ difficulty }, "t", kind);
      expect(checkProse(pkg, ctxOf(pkg))).toEqual({ overall: "pass", issues: [] });
    }
  });
  it("rejects curriculum words, digits and markup in a non-alignment title", () => {
    expect(withTitle("explanation", "Our curriculum ideas").issues).toEqual([{ code: "PROSE_MAKES_CURRICULUM_CLAIM", where: "sec-explanation" }]);
    expect(withTitle("exercises", "Practice 2").issues).toEqual([{ code: "PROSE_HAS_MATH_OR_MARKUP", where: "sec-exercises" }]);
    expect(withTitle("objectives", "<b>Goals</b>").issues).toEqual([{ code: "PROSE_HAS_MATH_OR_MARKUP", where: "sec-objectives" }]);
    expect(withTitle("prerequisites", "Prerequisites").overall).toBe("pass");
  });
  it("exempts the alignment title", () => {
    expect(withTitle("alignment", "Curriculum information")).toEqual({ overall: "pass", issues: [] });
  });
});
