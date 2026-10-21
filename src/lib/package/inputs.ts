import type { CurriculumContext } from "@/lib/curriculum/context";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { EDGES, sectionInputsParams } from "./build";
import { sectionInputsHash } from "./hash";
import { PROSE_PROMPT_VERSION } from "./prose";
import type { LessonPackage, Section, SectionKind } from "./schema";

/**
 * The inputsHash a stored section must carry, rebuilt from the stored package. Seed and difficulty come from the
 * section's own provenance (a quick adjustment can change them for one section) and fall back to the package seed
 * and the request. Null when the inputs cannot be rebuilt (no outline entry, or an upstream section is missing).
 */
export function expectedInputsHash(pkg: LessonPackage, section: Section, request: Pick<LessonRequestV2, "difficulty">, context: Pick<CurriculumContext, "contextHash">): string | null {
  const minutes = pkg.outline.sections.find((o) => o.id === section.id)?.minutes;
  const upstreamKinds = EDGES.filter((e) => e.to === section.kind).map((e) => e.from);
  const upstream = upstreamKinds.map((kind) => pkg.sections.find((s) => s.kind === kind)?.contentHash);
  if (minutes === undefined || upstream.some((h) => h === undefined)) return null;
  const countBlocks = (kind: SectionKind, type: string) => pkg.sections.filter((s) => s.kind === kind).reduce((n, s) => n + s.blocks.filter((b) => b.type === type).length, 0);
  const params = sectionInputsParams(section.kind, {
    seed: section.provenance.seed ?? pkg.seed,
    difficulty: section.provenance.difficulty ?? request.difficulty,
    exampleCount: countBlocks("worked_examples", "worked_example"),
    exerciseCount: countBlocks("exercises", "question"),
    llm: section.provenance.method === "llm" ? { promptVersion: PROSE_PROMPT_VERSION, model: section.provenance.model ?? null } : null,
  });
  return sectionInputsHash({ kind: section.kind, params: { ...params, contextHash: context.contextHash, minutes }, upstreamContentHashes: upstream as string[] });
}

/** The package with every section's inputsHash recomputed from its provenance; content hashes are left as they are. */
export function rehashPackage(pkg: LessonPackage, request: Pick<LessonRequestV2, "difficulty">, context: Pick<CurriculumContext, "contextHash">): LessonPackage {
  return {
    ...pkg,
    sections: pkg.sections.map((section) => {
      const inputsHash = expectedInputsHash(pkg, section, request, context);
      return inputsHash === null ? section : ({ ...section, inputsHash } as Section);
    }),
  };
}
