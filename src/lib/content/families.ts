import { chooseBasic, chooseChallenge, chooseDegenerate, chooseMixed, type Chosen, type Form, type Outcome } from "@/lib/math/generator";
import type { Rng } from "@/lib/math/rng";
import type { SkillId } from "./skills";

export type FamilyId = `${string}@${number}`;

export interface FamilyFeatures {
  steps: 1 | 2 | 3 | 4;
  negatives: boolean;
  fractions: "none" | "answer" | "coefficient";
  xBothSides: boolean;
  likeTerms: boolean;
  outcome: Outcome;
}

export interface QuestionFamily {
  id: FamilyId;
  conceptId: "linear-equations-one-variable";
  /** Must be a form the validator supports; the validator, not the family, decides whether a question is verified. */
  form: Form;
  /** The first skill is the primary one. */
  skills: readonly [SkillId, ...SkillId[]];
  features: FamilyFeatures;
  rung: 1 | 2 | 3;
  paceMinutes: number;
  easier?: FamilyId;
  harder?: FamilyId;
  /** Parameters only; the equation and steps come from the generator's form builders. */
  draw(rng: Rng): Record<string, string>;
}

const asStrings = (chosen: Chosen): Record<string, string> => Object.fromEntries(Object.entries(chosen.params).map(([k, v]) => [k, v.toString()]));

const ONE_SIDED = "ax+b=c";
const TWO_SIDED = "ax+b=cx+d";
const CONCEPT = "linear-equations-one-variable";
const unique = { likeTerms: false, outcome: "unique" } as const;

/** Today's parameter choosers, wrapped unchanged. The general blueprint still draws through generateExerciseSet. */
export const LEGACY_FAMILIES: readonly QuestionFamily[] = [
  {
    id: "legacy.basic@1",
    conceptId: CONCEPT,
    form: ONE_SIDED,
    skills: ["undo-add-subtract", "undo-multiply-divide"],
    features: { steps: 2, negatives: false, fractions: "none", xBothSides: false, ...unique },
    rung: 1,
    paceMinutes: 5,
    draw: (rng) => asStrings(chooseBasic(rng)),
  },
  {
    id: "legacy.mixed.one-sided@1",
    conceptId: CONCEPT,
    form: ONE_SIDED,
    skills: ["undo-add-subtract", "undo-multiply-divide", "negative-coefficient"],
    features: { steps: 2, negatives: true, fractions: "none", xBothSides: false, ...unique },
    rung: 2,
    paceMinutes: 5,
    draw: (rng) => asStrings(chooseMixed(rng, ONE_SIDED)),
  },
  {
    id: "legacy.mixed.two-sided@1",
    conceptId: CONCEPT,
    form: TWO_SIDED,
    skills: ["collect-unknowns", "undo-add-subtract", "undo-multiply-divide"],
    features: { steps: 3, negatives: true, fractions: "none", xBothSides: true, ...unique },
    rung: 2,
    paceMinutes: 5,
    draw: (rng) => asStrings(chooseMixed(rng, TWO_SIDED)),
  },
  {
    id: "legacy.challenge.one-sided@1",
    conceptId: CONCEPT,
    form: ONE_SIDED,
    skills: ["fraction-answer", "undo-add-subtract", "undo-multiply-divide"],
    features: { steps: 2, negatives: true, fractions: "answer", xBothSides: false, ...unique },
    rung: 3,
    paceMinutes: 5,
    draw: (rng) => asStrings(chooseChallenge(rng, ONE_SIDED)),
  },
  {
    id: "legacy.challenge.two-sided@1",
    conceptId: CONCEPT,
    form: TWO_SIDED,
    skills: ["fraction-answer", "collect-unknowns"],
    features: { steps: 3, negatives: true, fractions: "answer", xBothSides: true, ...unique },
    rung: 3,
    paceMinutes: 5,
    draw: (rng) => asStrings(chooseChallenge(rng, TWO_SIDED)),
  },
  {
    id: "legacy.degenerate@1",
    conceptId: CONCEPT,
    form: TWO_SIDED,
    skills: ["special-outcomes", "collect-unknowns"],
    features: { steps: 1, negatives: true, fractions: "none", xBothSides: true, likeTerms: false, outcome: "no_solution" },
    rung: 3,
    paceMinutes: 5,
    draw: (rng) => asStrings(chooseDegenerate(rng, "no_solution")),
  },
];

/** The legacy family that produced a question, from the metadata the generator records. */
export function legacyFamilyId(meta: { difficulty: string; form: Form; outcome: Outcome }): FamilyId {
  if (meta.outcome !== "unique") return "legacy.degenerate@1";
  if (meta.difficulty === "basic") return "legacy.basic@1";
  return `legacy.${meta.difficulty}.${meta.form === ONE_SIDED ? "one-sided" : "two-sided"}@1`;
}
