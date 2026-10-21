import path from "node:path";
import { CAPABILITIES } from "@/lib/curriculum/capabilities";
import { readDatasetDir } from "@/lib/curriculum/files";
import type { DatasetKind } from "@/lib/curriculum/dataset-schema";
import { withContextHash, type CurriculumContext, type UnhashedContext } from "@/lib/curriculum/context";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { buildPackage, LINEAR_CONCEPT_ID } from "@/lib/package/build";
import type { LessonPackage } from "@/lib/package/schema";

/** A fictional curriculum context for tests: nothing here is real curriculum text or user data. */
export function testContext(kind: DatasetKind = "sample", overrides: Partial<UnhashedContext> = {}): CurriculumContext {
  const base: UnhashedContext = {
    curriculum: {
      id: "fiction-math",
      name: "Fictional Mathematics Programme",
      educationSystem: { id: "fiction", name: "Fictional system", regionCode: "XX" },
      version: { id: "fiction-math@v1", label: "Fiction Edition 7", kind, source: { title: "Invented", url: null, publisher: null, retrievedAt: null } },
    },
    level: { id: "l1", label: "Level A" },
    course: { id: "c1", code: "FIC-1", title: "Course One" },
    unit: { id: "u1", code: "E", title: "Equations" },
    topic: { id: "t1", title: "Solving with one unknown" },
    objectives: [
      { id: "o1", officialCode: "FIC-E.1", label: "Solve equations with one unknown", coverage: "full", note: null, source: { ref: "invented", page: null } },
      { id: "o2", officialCode: "FIC-E.2", label: "Check a solution by substitution", coverage: "partial", note: "substitution only", source: { ref: "invented", page: null } },
    ],
    prerequisites: [{ topicId: "t0", title: "Working with integers" }],
    concepts: [{ id: LINEAR_CONCEPT_ID, name: "Linear equations in one variable", coverage: "full", note: null, capability: CAPABILITIES[LINEAR_CONCEPT_ID]! }],
    alignmentClaimsAllowed: kind === "real",
  };
  return withContextHash({ ...base, ...overrides });
}

export function testRequest(overrides: Partial<LessonRequestV2> = {}): LessonRequestV2 {
  return {
    requestVersion: 2,
    curriculum: { versionId: "fiction-math@v1", topicId: "t1" },
    durationMinutes: 60,
    difficulty: "mixed",
    documents: ["notes", "worksheet", "solutions"],
    templateId: "classic",
    locale: "en",
    ...overrides,
  };
}

export function testPackage(overrides: Partial<LessonRequestV2> = {}, seed = "seed-1", kind: DatasetKind = "sample", context?: CurriculumContext): LessonPackage {
  return buildPackage({ request: testRequest(overrides), context: context ?? testContext(kind), seed });
}

/** The topic title a package's documents use as their running header. */
export function topicTitleOf(pkg: { context: unknown }): string {
  return (pkg.context as { topic: { title: string } }).topic.title;
}

/** A context shaped like the one the DAL resolves for the suggested fixture's supported topic (no objectives, no codes). */
export function suggestedTestContext(): CurriculumContext {
  const dataset = readDatasetDir(path.join(__dirname, "curricula/suggested-fixture/v1"));
  const topic = dataset.structure.topics[0]!;
  return testContext("suggested", {
    curriculum: {
      id: dataset.meta.curriculum.id,
      name: dataset.meta.curriculum.name,
      educationSystem: { id: dataset.meta.educationSystem.id, name: dataset.meta.educationSystem.name, regionCode: dataset.meta.educationSystem.regionCode },
      version: { id: dataset.meta.version.id, label: dataset.meta.version.label, kind: "suggested", source: { title: dataset.meta.version.source.title, url: null, publisher: null, retrievedAt: null } },
    },
    topic: { id: topic.id, title: topic.title },
    objectives: [],
    prerequisites: [],
  });
}
