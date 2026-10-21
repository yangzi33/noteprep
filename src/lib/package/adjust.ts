import type { CurriculumContext } from "@/lib/curriculum/context";
import { methodOf, type AdjustmentChange, type AdjustmentMethod, type TextEdit } from "@/lib/domain/adjustment";
import { AdjustmentNotApplicable } from "@/lib/domain/errors";
import type { Difficulty } from "@/lib/math/generator";
import { LINEAR_CONCEPT_ID, planOutline } from "./build";
import { effectiveSettings } from "./effective";
import type { LessonPackage, Section, SectionKind } from "./schema";

/** Most exercises a package may hold (the block cap is 60 and each exercise takes two blocks: 1 + 2n <= 60). */
export const MAX_EXERCISES = 20;
/** Most unique-solution worked examples a package may hold. */
export const MAX_EXAMPLES = 4;

/** unchanged: the whole section is kept; rehash: only inputsHash is recomputed; regenerate: the section is rebuilt. */
export type Disposition = "unchanged" | "rehash" | "regenerate";

export interface AdjustmentPlan {
  action: AdjustmentChange["action"];
  method: AdjustmentMethod;
  /** Every section of the package, in package order. `method` is null unless the section is regenerated. */
  sections: { id: string; disposition: Disposition; method: "deterministic" | "llm" | "tutor_edit" | null }[];
  /** Sections the change edits or regenerates directly. */
  changed: string[];
  /** Sections regenerated or re-derived only because they derive from a changed section. */
  dependents: string[];
  /** Sections whose readable content stays identical but whose inputsHash must be recomputed. */
  rehashed: string[];
  unchanged: string[];
  outlineChanged: boolean;
}

type Deps = Pick<LessonPackage, "deps">;

/** Sections that derive (transitively, over `derives` edges only) from `ids`, excluding `ids` themselves. */
export function derivesClosure(pkg: Deps, ids: readonly string[]): string[] {
  const start = new Set(ids);
  const out = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of pkg.deps) {
      if (edge.kind === "derives" && edge.from === current && !out.has(edge.to)) {
        out.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  for (const id of start) out.delete(id);
  return [...out].sort();
}

/**
 * Sections one `references` edge downstream of `ids`, excluding `ids` themselves. A reference only reads the upstream
 * contentHash, so these sections keep their content and need a rehash, never a regeneration.
 */
export function referencesDownstream(pkg: Deps, ids: readonly string[]): string[] {
  const from = new Set(ids);
  const out = new Set<string>();
  for (const edge of pkg.deps) if (edge.kind === "references" && from.has(edge.from)) out.add(edge.to);
  for (const id of from) out.delete(id);
  return [...out].sort();
}

const notApplicable = (reason: string): never => {
  throw new AdjustmentNotApplicable(reason);
};

const LADDER: readonly Difficulty[] = ["basic", "mixed", "challenge"];

function idOf(pkg: LessonPackage, kind: SectionKind): string {
  const section = pkg.sections.find((s) => s.kind === kind);
  if (!section) return notApplicable("target_not_found");
  return section.id;
}

const countBlocks = (pkg: LessonPackage, kind: SectionKind, pred: (b: Section["blocks"][number]) => boolean) =>
  pkg.sections.filter((s) => s.kind === kind).reduce((n, s) => n + (s.blocks as Section["blocks"]).filter(pred).length, 0);

const uniqueExamples = (pkg: LessonPackage) =>
  countBlocks(pkg, "worked_examples", (b) => b.type === "worked_example" && b.solution.kind === "unique");
const exerciseCount = (pkg: LessonPackage) => countBlocks(pkg, "exercises", (b) => b.type === "question");

/** Is `edit` allowed on this package? Throws `target_not_found` or `not_editable` (plan section 2.6). */
function checkEditTarget(pkg: LessonPackage, edit: TextEdit): void {
  const section = pkg.sections.find((s) => s.id === edit.sectionId);
  if (!section) return notApplicable("target_not_found");
  const { target } = edit;
  if (target.field === "title") {
    if (section.kind === "alignment") notApplicable("not_editable");
    return;
  }
  const block = (section.blocks as Section["blocks"])[target.blockIndex];
  if (!block) return notApplicable("target_not_found");
  if (target.field === "block_text") {
    if (block.type !== "paragraph" && block.type !== "note") notApplicable("not_editable");
    return;
  }
  // block_item: only the lists and step lists that hold prose; the dataset's objective and prerequisite lists are fixed.
  if (block.type !== "list" && block.type !== "step_list") return notApplicable("not_editable");
  if (section.kind === "objectives" || section.kind === "prerequisites") return notApplicable("not_editable");
  const items = block.type === "list" ? block.items : block.steps;
  if (target.itemIndex >= items.length) notApplicable("target_not_found");
}

const NEW_MINUTES_KEYS: Partial<Record<SectionKind, "explanation" | "examples" | "review" | "exercises">> = {
  explanation: "explanation",
  worked_examples: "examples",
  teaching_sequence: "review",
  exercises: "exercises",
};

interface Draft {
  changed: string[];
  changedMethod: "deterministic" | "llm" | "tutor_edit";
  rehash?: string[];
  outlineChanged?: boolean;
}

/**
 * What an adjustment would touch, without touching anything. Pure: the package is never modified. Regeneration follows
 * only the `derives` closure; `references` downstream sections are rehashed (plan section 1.5 item 10).
 */
export function planAdjustment(pkg: LessonPackage, change: AdjustmentChange): AdjustmentPlan {
  const draft = draftFor(pkg, change);
  const changed = new Set(draft.changed);
  const dependents = new Set(derivesClosure(pkg, draft.changed).filter((id) => !changed.has(id)));
  const rehash = new Set((draft.rehash ?? referencesDownstream(pkg, draft.changed)).filter((id) => !changed.has(id) && !dependents.has(id)));

  const sections = pkg.sections.map((s) => {
    if (changed.has(s.id)) return { id: s.id, disposition: "regenerate" as const, method: draft.changedMethod };
    if (dependents.has(s.id)) return { id: s.id, disposition: "regenerate" as const, method: "deterministic" as const };
    if (rehash.has(s.id)) return { id: s.id, disposition: "rehash" as const, method: null };
    return { id: s.id, disposition: "unchanged" as const, method: null };
  });
  const ids = (d: Disposition, pred: (id: string) => boolean = () => true) => sections.filter((s) => s.disposition === d && pred(s.id)).map((s) => s.id);
  return {
    action: change.action,
    method: methodOf(change),
    sections,
    changed: sections.filter((s) => changed.has(s.id)).map((s) => s.id),
    dependents: ids("regenerate", (id) => dependents.has(id)),
    rehashed: ids("rehash"),
    unchanged: ids("unchanged"),
    outlineChanged: draft.outlineChanged ?? false,
  };
}

function draftFor(pkg: LessonPackage, change: AdjustmentChange): Draft {
  switch (change.action) {
    case "make_easier":
    case "make_harder": {
      const current = effectiveSettings(pkg).difficulty;
      const index = LADDER.indexOf(current);
      const harder = change.action === "make_harder";
      if (harder && index >= LADDER.length - 1) notApplicable("at_hardest");
      if (!harder && index <= 0) notApplicable("at_easiest");
      const target = LADDER[index + (harder ? 1 : -1)]!;
      const concept = (pkg.context as CurriculumContext).concepts?.find((c) => c.id === LINEAR_CONCEPT_ID);
      if (!concept || !concept.capability.difficulties.includes(target)) notApplicable("unsupported_difficulty");
      return { changed: [idOf(pkg, "exercises")], changedMethod: "deterministic" };
    }
    case "add_exercises": {
      const total = exerciseCount(pkg) + change.count;
      if (total > MAX_EXERCISES || 1 + 2 * total > 60) notApplicable("max_exercises");
      return { changed: [idOf(pkg, "exercises")], changedMethod: "deterministic" };
    }
    case "add_worked_example": {
      if (uniqueExamples(pkg) >= MAX_EXAMPLES) notApplicable("max_examples");
      return { changed: [idOf(pkg, "worked_examples")], changedMethod: "deterministic" };
    }
    case "change_duration": {
      if (change.durationMinutes === pkg.outline.totalMinutes) notApplicable("same_duration");
      const next = planOutline(change.durationMinutes);
      const changed: SectionKind[] = [];
      if (next.exerciseCount !== exerciseCount(pkg)) changed.push("exercises");
      if (next.exampleCount !== uniqueExamples(pkg)) changed.push("worked_examples");
      changed.push("teaching_sequence");
      // A section that is not rebuilt but whose minutes moved has a different inputsHash (minutes are hashed in).
      const regenerated = new Set<string>(changed.map((k) => idOf(pkg, k)));
      const rehash = pkg.outline.sections
        .filter((o) => {
          const key = NEW_MINUTES_KEYS[o.kind];
          return !regenerated.has(o.id) && o.minutes !== (key ? next[key] : 0);
        })
        .map((o) => o.id);
      return { changed: changed.map((k) => idOf(pkg, k)), changedMethod: "deterministic", rehash, outlineChanged: true };
    }
    case "correct_text": {
      for (const edit of change.edits) checkEditTarget(pkg, edit);
      const edited = new Set(change.edits.map((e) => e.sectionId));
      return { changed: pkg.sections.filter((s) => edited.has(s.id)).map((s) => s.id), changedMethod: "tutor_edit" };
    }
    case "reduce_theory":
      return { changed: [idOf(pkg, "explanation"), idOf(pkg, "derivation")], changedMethod: "llm" };
  }
}
