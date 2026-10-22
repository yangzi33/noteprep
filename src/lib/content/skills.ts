/** The closed list of skills a linear-equation blueprint may name (docs/content-architecture.md section C). */
export const LINEAR_SKILLS = [
  "undo-add-subtract",
  "undo-multiply-divide",
  "inverse-order",
  "negative-coefficient",
  "divide-form",
  "unknown-on-right",
  "collect-unknowns",
  "combine-like-terms",
  "fraction-answer",
  "special-outcomes",
  "distribute",
] as const;

export type SkillId = (typeof LINEAR_SKILLS)[number];

/** Plain-word labels: no digits, so they can appear in generated wording. */
export const SKILL_LABELS: Record<SkillId, string> = {
  "undo-add-subtract": "Undo addition and subtraction",
  "undo-multiply-divide": "Undo multiplication and division",
  "inverse-order": "Undo operations in the right order",
  "negative-coefficient": "Handle a negative coefficient",
  "divide-form": "Solve when the unknown is divided",
  "unknown-on-right": "Solve when the unknown is on the right",
  "collect-unknowns": "Collect the unknown terms on one side",
  "combine-like-terms": "Combine like terms",
  "fraction-answer": "Recognise a fractional answer",
  "special-outcomes": "Recognise no solution and every value",
  distribute: "Expand a bracket",
};
