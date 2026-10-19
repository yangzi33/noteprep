import { z } from "zod";

/** Ids are stable, lowercase, and safe to use in URLs and file names. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9@._/-]{0,199}$/;
const Id = z.string();
const Text = z.string();

export const DATASET_KINDS = ["real", "sample", "synthetic"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];

export const COVERAGE = ["full", "partial"] as const;
export type Coverage = (typeof COVERAGE)[number];

// Shapes are deliberately lenient about content (plain strings): the validator reports every problem
// with a code and a location instead of failing on the first parse error.

export const DatasetMeta = z.object({
  schemaVersion: z.literal(1),
  educationSystem: z.object({ id: Id, name: Text, regionCode: Text }),
  curriculum: z.object({ id: Id, name: Text, subject: z.literal("math") }),
  version: z.object({
    id: Id,
    label: Text,
    effectiveFrom: z.string().optional(),
    kind: z.enum(DATASET_KINDS),
    source: z.object({
      title: Text,
      url: z.string().optional(),
      publisher: z.string().optional(),
      retrievedAt: z.string().optional(),
    }),
    licenseNote: Text,
    supersedes: Id.optional(),
    review: z.object({ by: Text, at: z.string(), scope: Text }).optional(),
  }),
});

export const Structure = z.object({
  levels: z.array(z.object({ id: Id, label: Text, kind: Text, ordinal: z.number().int() })),
  courses: z.array(z.object({ id: Id, levelId: Id.optional(), code: Text, title: Text, ordinal: z.number().int() })),
  units: z.array(z.object({ id: Id, courseId: Id, code: Text.optional(), title: Text, ordinal: z.number().int() })),
  topics: z.array(z.object({ id: Id, unitId: Id, title: Text, summary: Text, ordinal: z.number().int() })),
});

export const Objectives = z.object({
  objectives: z.array(
    z.object({ id: Id, unitId: Id, officialCode: Text, label: Text, sourceRef: Text, sourcePage: Text.optional() }),
  ),
});

export const Mappings = z.object({
  topicObjectives: z.array(z.object({ topicId: Id, objectiveId: Id, coverage: z.enum(COVERAGE), note: Text.optional() })),
  topicConcepts: z.array(z.object({ topicId: Id, conceptId: Id, coverage: z.enum(COVERAGE), note: Text.optional() })),
  prerequisites: z.array(z.object({ topicId: Id, prerequisiteTopicId: Id, note: Text.optional() })),
});

export const Dataset = z.object({
  meta: DatasetMeta,
  structure: Structure,
  objectives: Objectives,
  mappings: Mappings,
});

export type DatasetMeta = z.infer<typeof DatasetMeta>;
export type Dataset = z.infer<typeof Dataset>;

export const LIMITS = { title: 120, summary: 200, label: 200, note: 300 } as const;
