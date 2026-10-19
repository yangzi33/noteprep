import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, capabilityFor, isSupportedConcept } from "@/lib/curriculum/capabilities";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir, DatasetFileError } from "@/lib/curriculum/files";
import { datasetHash, validateDataset, type DatasetIssue } from "@/lib/curriculum/validate-dataset";
import { generateLinearQuestion } from "@/lib/math/generator";
import { validateLinearQuestion } from "@/lib/math/validate";

const root = path.join(__dirname, "../..");
const load = (rel: string): Dataset => readDatasetDir(path.join(root, rel));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const codes = (d: Dataset) => validateDataset(d).map((i) => i.code);

const SAMPLE = "data/curricula/sample-math/sample-1";
const WITH_LEVELS = "tests/fixtures/curricula/synthetic-levels/v1";
const NO_LEVELS = "tests/fixtures/curricula/synthetic-nolevels/v1";

describe("shipped and fixture datasets are valid", () => {
  it.each([SAMPLE, WITH_LEVELS, NO_LEVELS])("%s", (dir) => {
    expect(validateDataset(load(dir))).toEqual([]);
  });
  it("the sample dataset announces itself as invented, everywhere it names itself", () => {
    const meta = load(SAMPLE).meta;
    expect(meta.version.kind).toBe("sample");
    expect(meta.curriculum.name).toMatch(/not a real curriculum/i);
    expect(meta.version.label).toMatch(/not a real curriculum/i);
    expect(meta.version.licenseNote).toMatch(/never be used for curriculum alignment claims/i);
    expect(meta.version.source.url).toBeUndefined();
  });
  it("covers both shapes: with levels and without (AP/IB-like)", () => {
    expect(load(WITH_LEVELS).structure.levels.length).toBeGreaterThan(0);
    expect(load(NO_LEVELS).structure.levels).toEqual([]);
    expect(load(NO_LEVELS).structure.courses.every((c) => c.levelId === undefined)).toBe(true);
  });
  it("reports a missing or malformed file with its path", () => {
    expect(() => readDatasetDir(path.join(root, "tests/fixtures/curricula/does-not-exist"))).toThrow(DatasetFileError);
  });
});

describe("each dataset rule is enforced", () => {
  type Case = [string, DatasetIssue["code"], (d: Dataset) => void];
  const cases: Case[] = [
    ["a malformed id", "ID_FORMAT", (d) => void (d.structure.topics[0]!.id = "Has Spaces!")],
    ["an id outside the version prefix", "VERSION_ID_MISMATCH", (d) => void (d.structure.topics[0]!.id = "other-version/t")],
    ["a duplicate id", "ID_DUPLICATE", (d) => void (d.structure.topics[1]!.id = d.structure.topics[0]!.id)],
    ["a topic pointing at a missing unit", "REF_DANGLING", (d) => void (d.structure.topics[0]!.unitId = `${d.meta.version.id}/nope`)],
    ["a mapping to a missing objective", "REF_DANGLING", (d) => void (d.mappings.topicObjectives[0]!.objectiveId = `${d.meta.version.id}/nope`)],
    ["a course using an undeclared level", "REF_DANGLING", (d) => void (d.structure.courses[0]!.levelId = `${d.meta.version.id}/nope`)],
    ["two sibling topics with the same ordinal", "ORDINAL_DUPLICATE", (d) => void (d.structure.topics[1]!.ordinal = d.structure.topics[0]!.ordinal)],
    ["an empty title", "EMPTY_TEXT", (d) => void (d.structure.topics[0]!.title = "  ")],
    ["a topic summary too long to be anything but copied text", "TEXT_TOO_LONG", (d) => void (d.structure.topics[0]!.summary = "x".repeat(201))],
    ["an objective without a source citation", "MISSING_SOURCE_REF", (d) => void (d.objectives.objectives[0]!.sourceRef = "")],
    ["a partial coverage mapping with no note", "PARTIAL_WITHOUT_NOTE", (d) => void delete d.mappings.topicConcepts.find((m) => m.coverage === "partial")!.note],
    ["a concept the engine cannot generate", "UNKNOWN_CONCEPT", (d) => void (d.mappings.topicConcepts[0]!.conceptId = "quantum-gravity")],
    ["a topic with no objective to trace alignment to", "TOPIC_WITHOUT_OBJECTIVE", (d) => void (d.mappings.topicObjectives = d.mappings.topicObjectives.filter((m) => m.topicId !== d.structure.topics[0]!.id))],
    ["a prerequisite on itself", "PREREQ_SELF", (d) => void d.mappings.prerequisites.push({ topicId: d.structure.topics[0]!.id, prerequisiteTopicId: d.structure.topics[0]!.id })],
    ["a prerequisite cycle", "PREREQ_CYCLE", (d) => void d.mappings.prerequisites.push({ topicId: d.structure.topics[0]!.id, prerequisiteTopicId: d.structure.topics[2]!.id })],
    ["a duplicate mapping", "DUPLICATE_MAPPING", (d) => void d.mappings.topicConcepts.push({ ...d.mappings.topicConcepts[0]! })],
    ["two courses sharing a code", "COURSE_CODE_DUPLICATE", (d) => void (d.structure.courses.push({ ...d.structure.courses[0]!, id: `${d.meta.version.id}/dup`, ordinal: 9 }))],
    ["two objectives sharing an official code in one unit", "OFFICIAL_CODE_DUPLICATE", (d) => void d.objectives.objectives.push({ ...d.objectives.objectives[0]!, id: `${d.meta.version.id}/obj/dup` })],
    ["a missing license note", "LICENSE_NOTE_MISSING", (d) => void (d.meta.version.licenseNote = " ")],
    ["a sample dataset that does not say it is a sample", "KIND_LABEL", (d) => void (d.meta.version.label = "Version 1")],
  ];
  it.each(cases)("%s", (_name, code, mutate) => {
    const d = clone(load(SAMPLE));
    mutate(d);
    expect(codes(d)).toContain(code);
  });

  it("an objective mapped from another course is rejected", () => {
    const d = clone(load(WITH_LEVELS));
    d.mappings.topicObjectives[0]!.objectiveId = d.objectives.objectives[1]!.id; // topic A1.1 -> objective of course B
    expect(codes(d)).toContain("OBJECTIVE_OTHER_COURSE");
  });
  it("levels are all-or-nothing and every declared level must be used", () => {
    const mixed = clone(load(WITH_LEVELS));
    delete mixed.structure.courses[0]!.levelId;
    expect(codes(mixed)).toContain("LEVELS_MIXED");
    const unused = clone(load(WITH_LEVELS));
    unused.structure.levels.push({ id: `${unused.meta.version.id}/g3`, label: "Synthetic Grade 3", kind: "grade", ordinal: 3 });
    expect(codes(unused)).toContain("LEVEL_UNUSED");
  });
  it("course ordinals only need to be unique within a level", () => {
    // Synthetic Course A (grade 1) and Course B (grade 2) both have ordinal 1: that is fine.
    const d = load(WITH_LEVELS);
    expect(d.structure.courses.filter((c) => c.ordinal === 1).length).toBeGreaterThan(1);
    expect(codes(d)).not.toContain("ORDINAL_DUPLICATE");
  });
  it("a real dataset needs a source URL, a retrieval date and a human review record", () => {
    const d = clone(load(SAMPLE));
    d.meta.version.kind = "real";
    d.meta.version.label = "2021";
    d.meta.curriculum.name = "Ontario Mathematics";
    expect(codes(d)).toEqual(expect.arrayContaining(["REAL_NEEDS_SOURCE", "REAL_NEEDS_REVIEW"]));
    d.meta.version.source = { title: "Official document", url: "https://example.test/doc", retrievedAt: "2026-01-01" };
    d.meta.version.review = { by: "Reviewer", at: "2026-01-02", scope: "all objectives" };
    expect(codes(d)).not.toContain("REAL_NEEDS_SOURCE");
    expect(codes(d)).not.toContain("REAL_NEEDS_REVIEW");
    expect(codes(d)).not.toContain("KIND_LABEL"); // real datasets are not forced to carry the sample label
  });
  it("reports every problem, not just the first", () => {
    const d = clone(load(SAMPLE));
    d.structure.topics[0]!.title = "";
    d.objectives.objectives[0]!.sourceRef = "";
    d.mappings.topicConcepts[0]!.conceptId = "nope";
    expect(new Set(codes(d)).size).toBeGreaterThanOrEqual(3);
  });
});

describe("dataset hash", () => {
  it("is stable, and changes with any content change", () => {
    const d = load(SAMPLE);
    expect(datasetHash(d)).toBe(datasetHash(clone(d)));
    const changed = clone(d);
    changed.structure.topics[0]!.summary += " ";
    expect(datasetHash(changed)).not.toBe(datasetHash(d));
    expect(datasetHash(d)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("capability registry only claims what the engine can verify", () => {
  it("knows its concepts and nothing else (including prototype names)", () => {
    expect(isSupportedConcept("linear-equations-one-variable")).toBe(true);
    for (const bad of ["nope", "", "constructor", "__proto__", "toString"]) {
      expect(isSupportedConcept(bad)).toBe(false);
      expect(capabilityFor(bad)).toBeNull();
    }
  });
  it("every declared form, difficulty and outcome generates verified questions", () => {
    for (const cap of Object.values(CAPABILITIES)) {
      for (const difficulty of cap.difficulties) {
        for (const form of cap.forms) {
          for (const outcome of cap.outcomes) {
            const impossible = (outcome !== "unique" && form === "ax+b=c") || (difficulty === "basic" && form === "ax+b=cx+d" && outcome === "unique");
            if (impossible) continue; // combinations the generator documents as not existing
            for (let i = 0; i < 25; i++) {
              const g = generateLinearQuestion({ id: "q", difficulty, form, outcome, seed: `cap-${i}` });
              expect(validateLinearQuestion({ id: "q", role: "exercise", problem: g.problem, solution: g.solution, steps: g.steps }).status).toBe("verified");
            }
          }
        }
      }
      expect(cap.generatorVersion).toMatch(/^linear-gen\//);
      expect(cap.validatorVersion).toMatch(/^linear-1var\//);
    }
  });
});
