import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CurriculumContext } from "@/lib/curriculum/context";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { AdjustmentNotApplicable } from "@/lib/domain/errors";
import { FAKE_PROSE } from "@/lib/llm/fake";
import { renderDocument } from "@/lib/latex/render";
import { adjustmentSeed, applyAdjustment, packageContentHash, type ApplicableChange } from "@/lib/package/adjust";
import { buildPackage } from "@/lib/package/build";
import type { DocumentKind, LessonPackage } from "@/lib/package/schema";
import { testContext, testRequest } from "../fixtures/package";

// M0 guard: the content-architecture extraction must not change one byte of any package. The fixture was generated
// from the code before the extraction; regenerate it only with UPDATE_M0_FIXTURE=1 and a deliberate decision.
const FIXTURE = new URL("../fixtures/m0-package-hashes.json", import.meta.url);

const NOT_APPLICABLE = { content: "not-applicable", inputs: "", tex: {} };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DIFFICULTIES = ["basic", "mixed", "challenge"] as const;
const DURATIONS = [15, 45, 60, 120] as const;
const DOCS: DocumentKind[] = ["notes", "worksheet", "solutions"];
const RETRY_CASES = [
  ["basic", 15, "m0-retry-905"],
  ["basic", 60, "m0-retry-657"],
  ["mixed", 45, "m0-retry-1283"],
  ["challenge", 120, "m0-retry-2296"],
] as const;
const SEEDS = Array.from({ length: 8 }, (_, i) => `m0-seed-${i}`);

function fingerprint(pkg: LessonPackage) {
  return {
    content: packageContentHash(pkg),
    inputs: sha(pkg.sections.map((s) => `${s.id}:${s.inputsHash}:${s.contentHash}`).join("\n")),
    tex: Object.fromEntries(DOCS.map((d) => [d, sha(renderDocument(pkg, d).tex)])),
  };
}

const build = (request: LessonRequestV2, seed: string, prose?: Parameters<typeof buildPackage>[0]["prose"]) =>
  buildPackage({ request, context: testContext(), seed, prose });

function computeAll(): Record<string, ReturnType<typeof fingerprint>> {
  const out: Record<string, ReturnType<typeof fingerprint>> = {};
  for (const difficulty of DIFFICULTIES)
    for (const durationMinutes of DURATIONS)
      for (const seed of SEEDS) out[`build/${difficulty}/${durationMinutes}/${seed}`] = fingerprint(build(testRequest({ difficulty, durationMinutes }), seed));

  for (const difficulty of DIFFICULTIES)
    for (const durationMinutes of [45, 120] as const) {
      const seed = SEEDS[0]!;
      out[`llm/${difficulty}/${durationMinutes}/${seed}`] = fingerprint(build(testRequest({ difficulty, durationMinutes }), seed, { draft: { ...FAKE_PROSE, explanation: [...FAKE_PROSE.explanation], derivation: [...FAKE_PROSE.derivation], teachingSequence: [...FAKE_PROSE.teachingSequence], commonMistakes: [...FAKE_PROSE.commonMistakes] }, model: "fake-model" }));
    }

  // Combinations whose exercise draw needs retry attempt 1 (found by instrumenting the unmodified builder).
  for (const [difficulty, durationMinutes, seed] of RETRY_CASES) out[`retry/${difficulty}/${durationMinutes}/${seed}`] = fingerprint(build(testRequest({ difficulty, durationMinutes }), seed));

  const changes: ApplicableChange[] = [{ action: "make_easier" }, { action: "make_harder" }, { action: "add_exercises", count: 2 }, { action: "add_worked_example" }];
  for (const difficulty of DIFFICULTIES)
    for (const durationMinutes of [45, 120] as const)
      for (const seed of SEEDS.slice(0, 2)) {
        const base = build(testRequest({ difficulty, durationMinutes }), seed);
        for (const change of changes) {
          const key = `adjust/${change.action}/${difficulty}/${durationMinutes}/${seed}`;
          try {
            out[key] = fingerprint(applyAdjustment(base, change, { seed: adjustmentSeed(base, packageContentHash(base), change), context: base.context as CurriculumContext }));
          } catch (error) {
            if (!(error instanceof AdjustmentNotApplicable)) throw error;
            out[key] = NOT_APPLICABLE;
          }
        }
      }
  return out;
}

describe("M0 content extraction keeps every package byte-identical", () => {
  it("matches the recorded hashes", () => {
    const actual = computeAll();
    if (process.env.UPDATE_M0_FIXTURE === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`);
      return;
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof actual;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(expected)) expect(actual[key], key).toEqual(expected[key]);
  });
});
