import type { TextEditTarget } from "@/lib/domain/adjustment";
import type { LessonPackage, Section, SectionKind } from "./schema";

export type EditableBlockType = "paragraph" | "note" | "list" | "step_list";

/**
 * The single source of truth for what a tutor may correct by hand (plan section 2.6), per section kind: the block
 * types whose wording is editable. Paragraphs and notes are edited as a whole (`block_text`), lists and step lists one
 * item at a time (`block_item`). Every other block (questions, worked examples, solutions, writing space, timing,
 * alignment) is math or dataset content and never editable; neither are the dataset lists of objectives and
 * prerequisites, the derivation's paragraphs, notes and lists, or anything in the alignment section. A kind that
 * cannot hold a block type does not list it: section 2.6 names notes for teaching_sequence, exercises and solutions,
 * but the schema allows no note block in any of those three kinds.
 */
export const EDITABLE_BLOCKS: Readonly<Record<SectionKind, readonly EditableBlockType[]>> = Object.freeze({
  objectives: Object.freeze(["paragraph"] as const),
  prerequisites: Object.freeze(["paragraph"] as const),
  explanation: Object.freeze(["paragraph", "note", "list"] as const),
  derivation: Object.freeze(["step_list"] as const),
  worked_examples: Object.freeze(["paragraph", "note"] as const),
  teaching_sequence: Object.freeze(["paragraph", "list"] as const),
  common_mistakes: Object.freeze(["paragraph", "note", "list"] as const),
  exercises: Object.freeze(["paragraph"] as const),
  solutions: Object.freeze(["paragraph"] as const),
  alignment: Object.freeze([] as const),
});

/** Which edit field reaches the wording of each editable block type. */
export const EDIT_FIELD_OF: Readonly<Record<EditableBlockType, "block_text" | "block_item">> = Object.freeze({
  paragraph: "block_text",
  note: "block_text",
  list: "block_item",
  step_list: "block_item",
});

/** Section titles are editable everywhere except the alignment section, whose title is fixed by the builder. */
export const titleEditable = (kind: SectionKind): boolean => kind !== "alignment";

type Block = Section["blocks"][number];

/** What an edit target points at, or why it may not be edited. */
export type ResolvedTarget =
  | { ok: true; section: Section; current: string }
  | { ok: false; reason: "target_not_found" | "not_editable" };

/**
 * Resolves `target` in section `sectionId` of `pkg` against EDITABLE_BLOCKS: the current wording when it may be edited,
 * else `target_not_found` (no such section, block or item) or `not_editable`.
 */
export function resolveEditTarget(pkg: Pick<LessonPackage, "sections">, sectionId: string, target: TextEditTarget): ResolvedTarget {
  const section = pkg.sections.find((s) => s.id === sectionId);
  if (!section) return { ok: false, reason: "target_not_found" };
  if (target.field === "title") return titleEditable(section.kind) ? { ok: true, section, current: section.title } : { ok: false, reason: "not_editable" };
  const blocks = section.blocks as Block[];
  if (!Number.isInteger(target.blockIndex) || target.blockIndex < 0 || target.blockIndex >= blocks.length) return { ok: false, reason: "target_not_found" };
  const block = blocks[target.blockIndex]!;
  const allowed: readonly string[] = EDITABLE_BLOCKS[section.kind];
  if (!allowed.includes(block.type)) return { ok: false, reason: "not_editable" };
  const type = block.type as EditableBlockType;
  if (EDIT_FIELD_OF[type] !== target.field) return { ok: false, reason: "not_editable" };
  if (target.field === "block_text") return { ok: true, section, current: (block as { text: string }).text };
  const items = block.type === "list" ? block.items : (block as { steps: string[] }).steps;
  if (!Number.isInteger(target.itemIndex) || target.itemIndex < 0 || target.itemIndex >= items.length) return { ok: false, reason: "target_not_found" };
  return { ok: true, section, current: items[target.itemIndex]! };
}
