import { z } from "zod";
import { ProblemSchema, SolutionSchema, StepSchema } from "@/lib/math/schema";

export const PACKAGE_SCHEMA_VERSION = "lesson-package/1" as const;
/** `lesson_revision.schema_version` for this content model (1 is the Phase 1 skeleton content). */
export const PACKAGE_REVISION_SCHEMA_VERSION = 2;

const Id = z.string().min(1).max(200);
const Text = z.string().min(1).max(600);

// --- blocks ---------------------------------------------------------------------------------------------
// Math enters a document only through blocks that carry a validated question (problem / solution / steps).
// Prose blocks (paragraph, list, note, step_list) hold words only; the prose check enforces that.

export const ParagraphBlock = z.strictObject({ type: z.literal("paragraph"), text: Text });
export const NoteBlock = z.strictObject({ type: z.literal("note"), text: Text });
export const ListBlock = z.strictObject({ type: z.literal("list"), items: z.array(Text).min(1).max(20) });
export const StepListBlock = z.strictObject({ type: z.literal("step_list"), steps: z.array(Text).min(1).max(20) });
export const TimingBlock = z.strictObject({
  type: z.literal("timing"),
  items: z.array(z.strictObject({ label: Text, minutes: z.number().int().min(1).max(180) })).min(1).max(20),
});
export const WritingSpaceBlock = z.strictObject({ type: z.literal("writing_space"), lines: z.number().int().min(1).max(20) });
/** An exercise statement: the problem only, never the answer. */
export const QuestionBlock = z.strictObject({ type: z.literal("question"), questionId: Id, problem: ProblemSchema });
/** A worked example: statement, answer and steps together (allowed in the notes). */
export const WorkedExampleBlock = z.strictObject({
  type: z.literal("worked_example"),
  questionId: Id,
  problem: ProblemSchema,
  solution: SolutionSchema,
  steps: z.array(StepSchema).min(1),
});
/** The answer and worked steps of an exercise (answer-key edition only). */
export const SolutionBlock = z.strictObject({
  type: z.literal("solution"),
  questionId: Id,
  solution: SolutionSchema,
  steps: z.array(StepSchema).min(1),
});
/** Where the dataset's statement about this lesson goes; the renderer turns it into text. Never model-written. */
export const AlignmentBlock = z.strictObject({
  type: z.literal("alignment"),
  /** "aligned" only when the dataset kind allows alignment claims; otherwise "none" with a label. */
  claim: z.enum(["aligned", "none"]),
  curriculumName: Text,
  versionLabel: Text,
  datasetKind: z.enum(["real", "sample", "synthetic"]),
  objectives: z.array(
    z.strictObject({
      id: Id,
      officialCode: z.string().nullable(),
      label: Text,
      coverage: z.enum(["full", "partial"]),
      note: z.string().nullable(),
    }),
  ).max(40),
});

// --- sections: each kind allows only the blocks it needs, so a worksheet can never contain an answer -------

const provenance = z.strictObject({
  method: z.enum(["deterministic", "llm", "tutor_edit"]),
  seed: z.string().max(200).optional(),
  /** Set when a quick adjustment gave this section a difficulty other than the request's. */
  difficulty: z.enum(["basic", "mixed", "challenge"]).optional(),
  generatorVersion: z.string().optional(),
  promptVersion: z.string().optional(),
  model: z.string().max(100).optional(),
});
const common = {
  id: Id,
  title: z.string().min(1).max(120),
  provenance,
  inputsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  edited: z.boolean().optional(),
};
const section = <K extends string, B extends z.ZodType>(kind: K, block: B) =>
  z.strictObject({ ...common, kind: z.literal(kind), blocks: z.array(block).min(1).max(60) });

const ProseBlocks = z.discriminatedUnion("type", [ParagraphBlock, ListBlock, NoteBlock, StepListBlock]);

export const ObjectivesSection = section("objectives", z.discriminatedUnion("type", [ParagraphBlock, ListBlock]));
export const PrerequisitesSection = section("prerequisites", z.discriminatedUnion("type", [ParagraphBlock, ListBlock]));
export const ExplanationSection = section("explanation", ProseBlocks);
export const DerivationSection = section("derivation", ProseBlocks);
export const WorkedExamplesSection = section("worked_examples", z.discriminatedUnion("type", [ParagraphBlock, WorkedExampleBlock, NoteBlock]));
export const TeachingSequenceSection = section("teaching_sequence", z.discriminatedUnion("type", [ListBlock, TimingBlock, ParagraphBlock]));
export const CommonMistakesSection = section("common_mistakes", z.discriminatedUnion("type", [ListBlock, ParagraphBlock, NoteBlock]));
export const ExercisesSection = section("exercises", z.discriminatedUnion("type", [ParagraphBlock, QuestionBlock, WritingSpaceBlock]));
export const SolutionsSection = section("solutions", z.discriminatedUnion("type", [ParagraphBlock, SolutionBlock]));
export const AlignmentSection = section("alignment", AlignmentBlock);

export const SectionSchema = z.discriminatedUnion("kind", [
  ObjectivesSection,
  PrerequisitesSection,
  ExplanationSection,
  DerivationSection,
  WorkedExamplesSection,
  TeachingSequenceSection,
  CommonMistakesSection,
  ExercisesSection,
  SolutionsSection,
  AlignmentSection,
]);
export type Section = z.infer<typeof SectionSchema>;
export type SectionKind = Section["kind"];
export type SolutionsSection = z.infer<typeof SolutionsSection>;
export type ExercisesSection = z.infer<typeof ExercisesSection>;

export const SECTION_KINDS = [
  "objectives", "prerequisites", "explanation", "derivation", "worked_examples",
  "teaching_sequence", "common_mistakes", "exercises", "solutions", "alignment",
] as const satisfies readonly SectionKind[];

export const DOCUMENT_KINDS = ["notes", "worksheet", "solutions"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Which section kinds make up each document. The worksheet's list deliberately has no `solutions`. */
export const DOCUMENT_SECTION_KINDS = {
  notes: ["objectives", "prerequisites", "explanation", "derivation", "worked_examples", "teaching_sequence", "common_mistakes", "alignment"],
  worksheet: ["exercises", "alignment"],
  solutions: ["solutions", "alignment"],
} as const satisfies Record<DocumentKind, readonly SectionKind[]>;

export const PackageSchema = z.strictObject({
  schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
  /** The request that produced it and the immutable curriculum snapshot (validated by the context hash). */
  request: z.unknown(),
  context: z.unknown(),
  seed: z.string().min(1),
  outline: z.strictObject({
    totalMinutes: z.number().int().min(15).max(180),
    sections: z.array(z.strictObject({ id: Id, kind: z.enum(SECTION_KINDS), minutes: z.number().int().min(0).max(180), objectiveIds: z.array(Id) })),
  }),
  sections: z.array(SectionSchema).min(1),
  documents: z.array(z.strictObject({ id: z.enum(DOCUMENT_KINDS), sectionIds: z.array(Id).min(1), templateId: z.literal("classic") })).min(1).max(3),
  /** `from` is upstream: if it changes, `to` must be regenerated. */
  deps: z.array(z.strictObject({ from: Id, to: Id, kind: z.enum(["derives", "references"]) })),
  /** Quick adjustments applied since the package was first built (absent on a package that was never adjusted). */
  adjustments: z
    .array(
      z.strictObject({
        action: z.string().regex(/^[a-z][a-z_]{0,39}$/),
        method: z.enum(["deterministic", "llm", "tutor_edit"]),
        seed: z.string().max(200).optional(),
        sourceContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      }),
    )
    .max(200)
    .optional(),
});
export type LessonPackage = z.infer<typeof PackageSchema>;

/**
 * The parts of the stored curriculum snapshot that validation reads. `PackageSchema` keeps `context` opaque
 * (the context hash covers all of it); the validator checks this shape first so stored garbage is reported, not thrown on.
 */
export const StoredContextShape = z.looseObject({
  curriculum: z.looseObject({ name: z.string(), version: z.looseObject({ label: z.string(), kind: z.enum(["real", "sample", "synthetic"]) }) }),
  objectives: z.array(
    z.looseObject({ id: z.string(), officialCode: z.string().nullable(), label: z.string(), coverage: z.enum(["full", "partial"]), note: z.string().nullable() }),
  ),
  prerequisites: z.array(z.looseObject({ title: z.string() })),
  alignmentClaimsAllowed: z.boolean(),
  contextHash: z.string(),
});
