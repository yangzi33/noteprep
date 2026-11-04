import { z } from "zod";
import { SUBJECTS } from "./subjects";

/** Ids are stable, lowercase, and safe to use in URLs and file names. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9@._/-]{0,199}$/;

/** True for a well-formed id whose "/"-separated segments are all non-empty and not "." or "..". */
export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id) && id.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Database bounds for ordinals (INTEGER column with a CHECK of 0..1_000_000). */
export const ORDINAL_MAX = 1_000_000;
const Id = z.string();
const Text = z.string();

export const DATASET_KINDS = ["real", "sample", "synthetic", "suggested"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];

export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** `mathematics` is accepted as an alias of the stored id `math`, so research output maps directly. */
const SubjectField = z.enum(SUBJECTS).or(z.literal("mathematics").transform(() => "math" as const));

/**
 * Optional citation carried by levels, courses, units and topics. All fields are plain strings here so the validator can
 * report every problem with a code; a record that carries any of them must carry the required ones (see validate-dataset).
 */
const Provenance = {
  sourceUrl: z.string().optional(),
  sourceSection: z.string().optional(),
  confidence: z.string().optional(),
  retrievedAt: z.string().optional(),
};

/**
 * Optional description of how a level or course is supported by its source: `sourceName` is the name or code exactly as
 * the source prints it, `placement` says whether the source itself states the grade or year ("stated") or NotePrep
 * inferred it ("inferred"). Lenient strings so the validator can report every problem with a code.
 */
const Basis = {
  sourceName: z.string().optional(),
  placement: z.string().optional(),
};

export const PLACEMENTS = ["stated", "inferred"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const COVERAGE = ["full", "partial"] as const;
export type Coverage = (typeof COVERAGE)[number];

// Shapes are deliberately lenient about content (plain strings): the validator reports every problem
// with a code and a location instead of failing on the first parse error.

export const DatasetMeta = z.object({
  schemaVersion: z.literal(1),
  educationSystem: z.object({ id: Id, name: Text, regionCode: Text }),
  curriculum: z.object({ id: Id, name: Text, subject: SubjectField }),
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
    /** When true every course, unit and topic must carry a citation (new researched datasets set this). */
    requireSources: z.boolean().optional(),
    review: z.object({ by: Text, at: z.string(), scope: Text }).optional(),
  }),
});

export const Structure = z.object({
  // A level is a grade, a year, or a band of years (a key stage, a two-year qualification); `yearFrom`/`yearTo` give the school
  // years a band covers, so the data never has to copy one band's content into each of its years.
  levels: z.array(
    z.object({ id: Id, label: Text, kind: Text, ordinal: z.number().int(), yearFrom: z.number().optional(), yearTo: z.number().optional(), ...Basis, ...Provenance }),
  ),
  // `code` is NotePrep's internal slug; `officialCode` is the jurisdiction's own code, kept for provenance only. A level can
  // hold any number of courses; `tier` and `pathway` tell parallel courses of one level apart.
  courses: z.array(
    z.object({
      id: Id,
      levelId: Id.optional(),
      code: Text,
      officialCode: Text.optional(),
      title: Text,
      ordinal: z.number().int(),
      tier: Text.optional(),
      pathway: Text.optional(),
      ...Basis,
      ...Provenance,
    }),
  ),
  units: z.array(z.object({ id: Id, courseId: Id, code: Text.optional(), title: Text, ordinal: z.number().int(), ...Provenance })),
  topics: z.array(z.object({ id: Id, unitId: Id, title: Text, summary: Text, ordinal: z.number().int(), ...Provenance })),
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

export const LIMITS = {
  title: 120,
  summary: 200,
  label: 200,
  note: 300,
  name: 200, // version label, curriculum / education system name, source title / publisher
  licenseNote: 500,
  scope: 300, // review scope
  code: 60, // unit code, level kind, official course code
  sourceUrl: 500,
  sourceSection: 200,
  sourceName: 120,
  tier: 60, // course tier and pathway labels
} as const;
