import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Dataset as DatasetSchema, DatasetMeta, type Dataset } from "@/lib/curriculum/dataset-schema";
import { findDatasetDirs, readDatasetDir } from "@/lib/curriculum/files";
import { ACTIVE_SUBJECTS, isActiveSubject, SUBJECTS } from "@/lib/curriculum/subjects";
import { scaleBreadth, scaleDepth } from "@/lib/curriculum/synthetic-scale";
import { crossJurisdictionDuplicates, provenanceReport, SIZE_BUDGET, sumCounts, validateCatalogue } from "@/lib/curriculum/validate-catalogue";
import { datasetHash, validateDataset, type DatasetIssue } from "@/lib/curriculum/validate-dataset";

const root = path.join(__dirname, "../..");
const load = (rel: string): Dataset => readDatasetDir(path.join(root, rel));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const codes = (d: Dataset) => validateDataset(d).map((i) => i.code);

const SUGGESTED = "tests/fixtures/curricula/suggested-fixture/v1";
const WITH_LEVELS = "tests/fixtures/curricula/synthetic-levels/v1";

const CITE = { sourceUrl: "https://example.test/doc", sourceSection: "section 2", confidence: "high", retrievedAt: "2026-11-01" };

describe("subject dimension", () => {
  it("existing datasets keep the stored id math, and mathematics is read as math", () => {
    expect(load(SUGGESTED).meta.curriculum.subject).toBe("math");
    const meta = clone(load(SUGGESTED).meta) as unknown as { curriculum: { subject: string } };
    meta.curriculum.subject = "mathematics";
    expect(DatasetMeta.parse(meta).curriculum.subject).toBe("math");
  });
  it("accepts the planned science subjects and rejects anything else", () => {
    const meta = clone(load(SUGGESTED).meta) as unknown as { curriculum: { subject: string } };
    for (const subject of SUBJECTS) {
      meta.curriculum.subject = subject;
      expect(DatasetMeta.safeParse(meta).success).toBe(true);
    }
    meta.curriculum.subject = "astrology";
    expect(DatasetMeta.safeParse(meta).success).toBe(false);
  });
  it("only math is active", () => {
    expect([...ACTIVE_SUBJECTS]).toEqual(["math"]);
    expect(isActiveSubject("math")).toBe(true);
    expect(isActiveSubject("physics")).toBe(false);
    expect(isActiveSubject("mathematics")).toBe(false);
  });
});

describe("per-record citation fields", () => {
  it("a record with a complete citation is valid", () => {
    const d = clone(load(SUGGESTED));
    Object.assign(d.structure.topics[0]!, CITE);
    Object.assign(d.structure.units[0]!, CITE);
    Object.assign(d.structure.courses[0]!, CITE);
    expect(validateDataset(d)).toEqual([]);
    expect(DatasetSchema.parse(d).structure.topics[0]).toMatchObject(CITE);
  });
  it("citation fields do not change the hash of a dataset that has none", () => {
    const d = load(SUGGESTED);
    expect(Object.keys(d.structure.topics[0]!)).not.toContain("sourceUrl");
    const cited = clone(d);
    cited.structure.topics[0]!.sourceUrl = CITE.sourceUrl;
    expect(datasetHash(cited)).not.toBe(datasetHash(d));
  });
  type Case = [string, DatasetIssue["code"], (d: Dataset) => void];
  const cases: Case[] = [
    ["a citation missing its url", "SOURCE_INCOMPLETE", (d) => void Object.assign(d.structure.topics[0]!, { ...CITE, sourceUrl: undefined })],
    ["a citation missing its confidence", "SOURCE_INCOMPLETE", (d) => void Object.assign(d.structure.units[0]!, { ...CITE, confidence: undefined })],
    ["a citation missing retrievedAt", "SOURCE_INCOMPLETE", (d) => void Object.assign(d.structure.courses[0]!, { ...CITE, retrievedAt: undefined })],
    ["only a confidence", "SOURCE_INCOMPLETE", (d) => void (d.structure.topics[0]!.confidence = "high")],
    ["a blank url", "SOURCE_INCOMPLETE", (d) => void Object.assign(d.structure.topics[0]!, { ...CITE, sourceUrl: " " })],
    ["an http url", "SOURCE_URL", (d) => void Object.assign(d.structure.topics[0]!, { ...CITE, sourceUrl: "http://example.test/doc" })],
    ["a javascript url", "SOURCE_URL", (d) => void Object.assign(d.structure.topics[0]!, { ...CITE, sourceUrl: "javascript:alert(1)" })],
    ["an unknown confidence", "CONFIDENCE_INVALID", (d) => void Object.assign(d.structure.topics[0]!, { ...CITE, confidence: "certain" })],
    ["an invalid retrievedAt", "DATE_INVALID", (d) => void Object.assign(d.structure.topics[0]!, { ...CITE, retrievedAt: "yesterday" })],
    ["an over-long url", "TEXT_TOO_LONG", (d) => void Object.assign(d.structure.topics[0]!, { ...CITE, sourceUrl: `https://example.test/${"x".repeat(500)}` })],
    ["an over-long section", "TEXT_TOO_LONG", (d) => void Object.assign(d.structure.topics[0]!, { ...CITE, sourceSection: "x".repeat(201) })],
    ["an official code in a suggested dataset (D-75)", "SUGGESTED_OFFICIAL_CODE", (d) => void (d.structure.courses[0]!.officialCode = "MATH 9")],
  ];
  it.each(cases)("%s", (_name, code, mutate) => {
    const d = clone(load(SUGGESTED));
    mutate(d);
    expect(codes(d)).toContain(code);
  });

  it("requireSources makes a missing citation on a course, unit or topic an error, and a complete one passes", () => {
    const d = clone(load(SUGGESTED));
    d.meta.version.requireSources = true;
    const missing = validateDataset(d).filter((i) => i.code === "SOURCE_REQUIRED");
    expect(missing.length).toBe(d.structure.courses.length + d.structure.units.length + d.structure.topics.length);
    for (const r of [...d.structure.courses, ...d.structure.units, ...d.structure.topics]) Object.assign(r, CITE);
    expect(validateDataset(d)).toEqual([]);
  });

  it("official course codes are allowed outside suggested datasets and must be unique", () => {
    const d = clone(load(WITH_LEVELS));
    d.structure.courses[0]!.officialCode = "MTH1W";
    expect(codes(d)).not.toContain("SUGGESTED_OFFICIAL_CODE");
    d.structure.courses[1]!.officialCode = " mth1w ";
    expect(codes(d)).toContain("OFFICIAL_COURSE_CODE_DUPLICATE");
  });
});

describe("catalogue-wide checks", () => {
  const a = () => clone(load(SUGGESTED));
  it("the shipped data and fixtures pass", () => {
    const dirs = findDatasetDirs(path.join(root, "data/curricula"));
    expect(dirs.length).toBeGreaterThan(40);
    expect(validateCatalogue(dirs.map(readDatasetDir))).toEqual([]);
  });
  it("two directories declaring one version id are refused", () => {
    expect(validateCatalogue([a(), a()]).map((i) => i.code)).toContain("VERSION_ID_DUPLICATE");
  });
  it("one curriculum id described differently in two versions is refused", () => {
    const b = a();
    b.meta.version.id = "suggested-fixture@v2";
    b.meta.curriculum.name = "Suggested topics for Another Course (unofficial)";
    expect(validateCatalogue([a(), b]).map((i) => i.code)).toContain("CURRICULUM_CONFLICT");
    const c = a();
    c.meta.version.id = "suggested-fixture@v2";
    c.meta.educationSystem.name = "Renamed";
    expect(validateCatalogue([a(), c]).map((i) => i.code)).toContain("CURRICULUM_CONFLICT");
  });
  it("the same jurisdiction, subject and name under two curriculum ids is a duplicate", () => {
    const b = a();
    b.meta.curriculum.id = "suggested-fixture-two";
    b.meta.version.id = "suggested-fixture-two@v1";
    expect(validateCatalogue([a(), b]).map((i) => i.code)).toContain("CURRICULUM_DUPLICATE");
    b.meta.educationSystem.id = "other-system";
    b.meta.educationSystem.name = "Other";
    expect(validateCatalogue([a(), b]).map((i) => i.code)).not.toContain("CURRICULUM_DUPLICATE");
  });
  it("a version over the size budget is refused", () => {
    const d = a();
    const t = d.structure.topics[0]!;
    d.structure.topics = Array.from({ length: SIZE_BUDGET.topicsPerVersion + 1 }, (_, i) => ({ ...t, id: `${t.id}-${i}`, ordinal: i }));
    expect(validateCatalogue([d]).map((i) => i.code)).toContain("VERSION_TOO_LARGE");
  });
  it("identical courses in different curricula are reported, not refused", () => {
    const b = a();
    b.meta.curriculum.id = "suggested-fixture-two";
    b.meta.educationSystem.id = "other-system";
    b.meta.version.id = "suggested-fixture-two@v1";
    expect(validateCatalogue([a(), b])).toEqual([]);
    const groups = crossJurisdictionDuplicates([a(), b]);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]!.curricula).toEqual(["suggested-fixture", "suggested-fixture-two"]);
    expect(crossJurisdictionDuplicates([a()])).toEqual([]);
  });
});

describe("citation report", () => {
  it("counts unsourced, rated and low-confidence records and lists the low ones", () => {
    const d = clone(load(SUGGESTED));
    const [t0, t1] = d.structure.topics;
    Object.assign(t0!, { ...CITE, confidence: "high" });
    Object.assign(t1!, { ...CITE, confidence: "low" });
    Object.assign(d.structure.units[0]!, { ...CITE, confidence: "unknown-value" });
    const report = provenanceReport(d);
    const total = d.structure.levels.length + d.structure.courses.length + d.structure.units.length + d.structure.topics.length;
    expect(report.records).toMatchObject({ total, sourced: 3, unsourced: total - 3, high: 1, low: 1, unrated: 1, medium: 0 });
    expect(report.lowConfidence).toEqual([{ kind: "topic", id: t1!.id, title: t1!.title, sourceUrl: CITE.sourceUrl }]);
    expect(sumCounts([report, report]).sourced).toBe(6);
  });
  it("the shipped data is entirely unsourced today", () => {
    const dirs = findDatasetDirs(path.join(root, "data/curricula"));
    const totals = sumCounts(dirs.map((d) => provenanceReport(readDatasetDir(d))));
    expect(totals.sourced).toBe(0);
    expect(totals.unsourced).toBe(totals.total);
  });
});

describe("synthetic scaling", () => {
  const real = () => {
    const dir = path.join(root, "data/curricula/ontario");
    const versions = readdirSync(dir).filter((v) => existsSync(path.join(dir, v, "dataset.json")));
    return readDatasetDir(path.join(dir, versions.sort().at(-1)!));
  };
  it("breadth copies are valid, distinct, and hidden unless asked to stay selectable", () => {
    const base = real();
    const copies = scaleBreadth([base], 3);
    expect(copies).toHaveLength(3);
    expect(new Set(copies.map((c) => c.meta.version.id)).size).toBe(3);
    for (const c of copies) {
      expect(validateDataset(c)).toEqual([]);
      expect(c.mappings.topicConcepts).toEqual([]);
      expect(c.structure.topics).toHaveLength(base.structure.topics.length);
    }
    expect(validateCatalogue([base, ...copies]).filter((i) => i.code !== "VERSION_TOO_LARGE")).toEqual([]);
    expect(scaleBreadth([base], 1, true)[0]!.mappings.topicConcepts.length).toBe(base.mappings.topicConcepts.length);
  });
  it("depth multiplies courses, units and topics and stays valid", () => {
    const base = real();
    const deep = scaleDepth(base, 5);
    expect(validateDataset(deep)).toEqual([]);
    expect(deep.structure.courses).toHaveLength(base.structure.courses.length * 5);
    expect(deep.structure.units).toHaveLength(base.structure.units.length * 5);
    expect(deep.structure.topics).toHaveLength(base.structure.topics.length * 5);
    expect(deep.mappings.topicConcepts).toEqual([]);
  });
});
