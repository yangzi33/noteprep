import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { findDatasetDirs, readDatasetDir } from "@/lib/curriculum/files";
import { crossJurisdictionTopicSets, validateCatalogue } from "@/lib/curriculum/validate-catalogue";
import { validateDataset, type DatasetIssue } from "@/lib/curriculum/validate-dataset";
import { buildSourceIndex, findCopiedWording, longestSharedRun, MAX_SHARED_RUN } from "@/lib/curriculum/wording-overlap";

const root = path.join(__dirname, "../..");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const codes = (d: Dataset) => validateDataset(d).map((i) => i.code);
const where = (d: Dataset, code: DatasetIssue["code"]) => validateDataset(d).filter((i) => i.code === code).map((i) => i.where);

const V = "eng-maths@suggested-1";
const SRC = "https://example.test/programme-of-study";
const cite = (section: string, confidence = "high") => ({ sourceUrl: SRC, sourceSection: section, confidence, retrievedAt: "2026-11-03" });

/** A distinct-wording topic list of `n` titles for a course, so two courses only overlap when a test makes them. */
const topicTitles = (stem: string, n: number) => Array.from({ length: n }, (_, i) => `${stem} idea ${i + 1}`);

interface CourseSpec {
  key: string;
  level: string;
  title: string;
  topics: string[];
  tier?: string;
  pathway?: string;
  officialCode?: string;
  placement?: "stated" | "inferred";
  confidence?: string;
}

interface LevelSpec {
  key: string;
  label: string;
  kind: string;
  from: number;
  to: number;
}

function defaultLevels(): LevelSpec[] {
  return [
    { key: "ks3", label: "Key Stage 3", kind: "Key stage", from: 7, to: 9 },
    { key: "ks4", label: "Key Stage 4", kind: "Key stage", from: 10, to: 11 },
    { key: "ks5", label: "Years 12 to 13", kind: "Qualification years", from: 12, to: 13 },
  ];
}

/** A researched dataset (kind suggested, requireSources) shaped like an England-style key-stage system. */
function researched(courses: CourseSpec[], levels: LevelSpec[] = defaultLevels()): Dataset {
  const d: Dataset = {
    meta: {
      schemaVersion: 1,
      educationSystem: { id: "eng", name: "England", regionCode: "GB-ENG" },
      curriculum: { id: "eng-maths", name: "England maths (suggested topics)", subject: "math" },
      version: {
        id: V,
        label: "Suggested topics, researched",
        kind: "suggested",
        source: { title: "Pipeline fixture" },
        licenseNote: "NotePrep wording; fictional fixture.",
        requireSources: true,
      },
    },
    structure: { levels: [], courses: [], units: [], topics: [] },
    objectives: { objectives: [] },
    mappings: { topicObjectives: [], topicConcepts: [], prerequisites: [] },
  };
  levels.forEach((l, i) =>
    d.structure.levels.push({ id: `${V}/${l.key}`, label: l.label, kind: l.kind, ordinal: i + 1, yearFrom: l.from, yearTo: l.to, sourceName: l.label, placement: "stated", ...cite(`${l.label} programme of study`) }),
  );
  const ordinalInLevel = new Map<string, number>();
  for (const c of courses) {
    const ordinal = (ordinalInLevel.get(c.level) ?? 0) + 1;
    ordinalInLevel.set(c.level, ordinal);
    const courseId = `${V}/${c.level}/${c.key}`;
    d.structure.courses.push({
      id: courseId,
      levelId: `${V}/${c.level}`,
      code: `NP-${c.key.toUpperCase()}`,
      title: c.title,
      ordinal,
      ...(c.tier ? { tier: c.tier } : {}),
      ...(c.pathway ? { pathway: c.pathway } : {}),
      ...(c.officialCode ? { officialCode: c.officialCode } : { sourceName: [c.title, c.tier, c.pathway].filter(Boolean).join(" ") }),
      placement: c.placement ?? "stated",
      ...cite(c.officialCode ? `Subject content ${c.officialCode} ${[c.tier, c.pathway].filter(Boolean).join(" ")}` : `${c.title} subject content`, c.confidence ?? "high"),
    });
    const unitId = `${courseId}/u1`;
    d.structure.units.push({ id: unitId, courseId, title: "Main strand", ordinal: 1, ...cite("Subject content, main strand") });
    c.topics.forEach((t, i) =>
      d.structure.topics.push({ id: `${unitId}/t${i + 1}`, unitId, title: t, summary: "A short NotePrep summary.", ordinal: i + 1, ...cite("Subject content, main strand") }),
    );
  }
  return d;
}

const goodCourses = (): CourseSpec[] => [
  { key: "ks3", level: "ks3", title: "Key Stage 3 mathematics", topics: topicTitles("alpha", 12) },
  { key: "gcse-f", level: "ks4", title: "GCSE mathematics", tier: "Foundation", topics: topicTitles("beta", 12) },
  { key: "gcse-h", level: "ks4", title: "GCSE mathematics", tier: "Higher", topics: [...topicTitles("beta", 12), ...topicTitles("gamma", 6)] },
  { key: "alevel", level: "ks5", title: "A level mathematics", officialCode: "A-MATH-7357", pathway: "Pure and applied", topics: topicTitles("delta", 15) },
  { key: "furthermaths", level: "ks5", title: "A level further mathematics", pathway: "Further", topics: topicTitles("epsilon", 10) },
  { key: "core", level: "ks5", title: "Core Maths", pathway: "Applied", topics: topicTitles("zeta", 8) },
];

describe("a key-stage / multi-year / tiered / pathway structure", () => {
  it("is valid: bands as levels, several courses on one level, tiers and pathways", () => {
    const d = researched(goodCourses());
    expect(validateDataset(d)).toEqual([]);
    const perLevel = new Map<string, number>();
    for (const c of d.structure.courses) perLevel.set(c.levelId!, (perLevel.get(c.levelId!) ?? 0) + 1);
    expect(Math.max(...perLevel.values())).toBeGreaterThan(1);
    expect(d.structure.levels.some((l) => (l.yearTo ?? 0) > (l.yearFrom ?? 0))).toBe(true);
  });
  it("does not need a level at all (qualification-only systems)", () => {
    const d = researched([{ key: "a", level: "x", title: "Course A", topics: topicTitles("a", 6) }], []);
    d.structure.courses.forEach((c) => delete c.levelId);
    expect(validateDataset(d)).toEqual([]);
  });
});

describe("duplicate topic sets", () => {
  it("fails an England-style structure that copies one key-stage list into several years", () => {
    const levels = [7, 8, 9].map((y) => ({ key: `y${y}`, label: `Year ${y}`, kind: "Year", from: y, to: y }));
    const same = topicTitles("ks three", 20);
    const d = researched(levels.map((l) => ({ key: l.key, level: l.key, title: `${l.label} mathematics`, topics: same })), levels);
    const issues = validateDataset(d).filter((i) => i.code === "COURSE_TOPIC_SET_DUPLICATE");
    expect(issues).toHaveLength(3); // every pair of the three years
    expect(issues[0]!.detail).toMatch(/100%/);
  });
  it("fails a qualification copied into both of its years even when the titles differ", () => {
    const levels = [12, 13].map((y) => ({ key: `y${y}`, label: `Year ${y}`, kind: "Year", from: y, to: y }));
    const alevel = topicTitles("a level", 30);
    const d = researched(
      [
        { key: "alm-y12", level: "y12", title: "A level mathematics, Year 12", topics: alevel },
        { key: "alm-y13", level: "y13", title: "A level mathematics, Year 13", topics: alevel.map((t) => t.toUpperCase()) },
      ],
      levels,
    );
    expect(codes(d)).toContain("COURSE_TOPIC_SET_DUPLICATE");
  });
  it("fails a near copy at or above 80% overlap and accepts clearly different lists", () => {
    const base = topicTitles("base", 10);
    const near = [...base.slice(0, 9), "one new idea"]; // 9 shared of 11 distinct = 82%
    const d = researched([
      { key: "a", level: "ks3", title: "Course A", topics: base },
      { key: "b", level: "ks4", title: "Course B", topics: near },
    ]);
    expect(codes(d)).toContain("COURSE_TOPIC_SET_DUPLICATE");
    const half = [...base.slice(0, 5), ...topicTitles("other", 5)]; // 5 shared of 15 = 33%
    d.structure.topics.filter((t) => t.id.includes("/b/")).forEach((t, i) => (t.title = half[i]!));
    expect(codes(d)).not.toContain("COURSE_TOPIC_SET_DUPLICATE");
  });
  it("ignores very small courses, which can overlap by chance", () => {
    const small = topicTitles("tiny", 3);
    const d = researched([
      { key: "a", level: "ks3", title: "Course A", topics: small },
      { key: "b", level: "ks4", title: "Course B", topics: small },
    ]);
    expect(codes(d)).not.toContain("COURSE_TOPIC_SET_DUPLICATE");
  });
  it("allows parallel tiers of one level to share content, but not the same tier twice or different levels", () => {
    const shared = topicTitles("gcse", 12);
    const tiers = researched([
      { key: "f", level: "ks4", title: "GCSE mathematics", tier: "Foundation", topics: shared },
      { key: "h", level: "ks4", title: "GCSE mathematics", tier: "Higher", topics: shared },
    ]);
    expect(codes(tiers)).not.toContain("COURSE_TOPIC_SET_DUPLICATE");
    const sameTier = clone(tiers);
    sameTier.structure.courses[1]!.tier = "Foundation";
    expect(codes(sameTier)).toContain("COURSE_TOPIC_SET_DUPLICATE");
    const otherLevel = clone(tiers);
    otherLevel.structure.courses[1]!.levelId = `${V}/ks3`;
    expect(codes(otherLevel)).toContain("COURSE_TOPIC_SET_DUPLICATE");
    const untiered = clone(tiers);
    delete untiered.structure.courses[1]!.tier;
    expect(codes(untiered)).toContain("COURSE_TOPIC_SET_DUPLICATE");
  });
  it("identical title, tier and pathway on one level is the same course entered twice", () => {
    const d = researched([
      { key: "a", level: "ks4", title: "GCSE mathematics", tier: "Higher", topics: topicTitles("one", 8) },
      { key: "b", level: "ks4", title: " GCSE  Mathematics ", tier: "higher", topics: topicTitles("two", 8) },
    ]);
    expect(codes(d)).toContain("COURSE_IDENTITY_DUPLICATE");
    d.structure.courses[1]!.pathway = "Applied";
    expect(codes(d)).not.toContain("COURSE_IDENTITY_DUPLICATE");
  });
  it("catches a copy with a few retitled topics, but not a course that merely contains another", () => {
    const base = topicTitles("base", 20);
    const reworded = base.map((t, i) => (i < 3 ? `reworded ${i}` : t)); // 17 shared of 20 = 85%
    const copy = researched([
      { key: "a", level: "ks3", title: "Course A", topics: base },
      { key: "b", level: "ks4", title: "Course B", topics: reworded },
    ]);
    expect(where(copy, "COURSE_TOPIC_SET_DUPLICATE")).toEqual(["courses[1]"]);
    const superset = researched([
      { key: "a", level: "ks3", title: "Course A", topics: topicTitles("base", 12) },
      { key: "b", level: "ks4", title: "Course B", topics: [...topicTitles("base", 12), ...topicTitles("more", 6)] }, // 12 of 18 = 67%
    ]);
    expect(codes(superset)).not.toContain("COURSE_TOPIC_SET_DUPLICATE");
  });
  it("lets parallel pathways overlap when the source prints each pathway, and not when the label is invented", () => {
    const shared = topicTitles("ib", 11);
    const sl = { key: "sl", level: "ks5", title: "Mathematics analysis", pathway: "SL", topics: shared };
    const hl = { key: "hl", level: "ks5", title: "Mathematics analysis", pathway: "HL", topics: [...shared.slice(0, 10), "one more idea"] }; // 10 of 11 = 91%
    const only = (c: typeof sl[]) => researched(c, defaultLevels().filter((l) => l.key === "ks5"));
    expect(validateDataset(only([sl, hl]))).toEqual([]);
    const invented = only([sl, hl]);
    invented.structure.courses[1]!.pathway = "Extended";
    expect(where(invented, "VARIANT_NOT_IN_SOURCE")).toEqual(["courses[1].pathway"]);
    expect(where(invented, "COURSE_TOPIC_SET_DUPLICATE")).toEqual(["courses[1]"]);
  });
  it("a tier that the source does not print cannot excuse identical lists", () => {
    const shared = topicTitles("same", 10);
    const d = researched(
      [
        { key: "a", level: "ks4", title: "GCSE mathematics", tier: "Standard", topics: shared },
        { key: "b", level: "ks4", title: "GCSE mathematics", tier: "Enhanced", topics: shared },
      ],
      defaultLevels().filter((l) => l.key === "ks4"),
    );
    d.structure.courses.forEach((c) => (c.sourceName = "GCSE mathematics")); // neither tier is in the source
    expect(codes(d)).toContain("COURSE_TOPIC_SET_DUPLICATE");
    expect(where(d, "VARIANT_NOT_IN_SOURCE")).toEqual(["courses[0].tier", "courses[1].tier"]);
  });
  it("does not trip on the shipped data (existing valid datasets still pass)", () => {
    const dirs = findDatasetDirs(path.join(root, "data/curricula"));
    expect(dirs.length).toBeGreaterThan(40);
    for (const dir of dirs) expect(validateDataset(readDatasetDir(dir)), dir).toEqual([]);
  });
  it("is reported across curricula as a warning by topic set, not by title", () => {
    const a = researched([{ key: "a", level: "ks3", title: "Course A", topics: topicTitles("shared", 8) }]);
    const b = clone(a);
    b.meta.curriculum.id = "wal-maths";
    b.meta.curriculum.name = "Wales maths (suggested topics)";
    b.meta.educationSystem.id = "wal";
    b.meta.educationSystem.name = "Wales";
    b.meta.version.id = "wal-maths@suggested-1";
    b.structure.courses[0]!.title = "A differently named course";
    const groups = crossJurisdictionTopicSets([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.curricula).toEqual(["eng-maths", "wal-maths"]);
    expect(crossJurisdictionTopicSets([a])).toEqual([]);
    expect(validateCatalogue([a, b])).toEqual([]);
  });
});

describe("level structure", () => {
  const withLevels = (mutate: (levels: Dataset["structure"]["levels"]) => void) => {
    const d = researched(goodCourses());
    mutate(d.structure.levels);
    return d;
  };
  it("rejects year ranges that are half set, reversed, fractional or out of range", () => {
    expect(codes(withLevels((l) => void delete l[0]!.yearTo))).toContain("LEVEL_YEARS_INVALID");
    expect(codes(withLevels((l) => void delete l[0]!.yearFrom))).toContain("LEVEL_YEARS_INVALID");
    expect(codes(withLevels((l) => void Object.assign(l[0]!, { yearFrom: 9, yearTo: 7 })))).toContain("LEVEL_YEARS_INVALID");
    expect(codes(withLevels((l) => void Object.assign(l[0]!, { yearFrom: 7.5, yearTo: 9 })))).toContain("LEVEL_YEARS_INVALID");
    expect(codes(withLevels((l) => void Object.assign(l[0]!, { yearFrom: -1, yearTo: 9 })))).toContain("LEVEL_YEARS_INVALID");
    expect(codes(withLevels((l) => void Object.assign(l[0]!, { yearFrom: 7, yearTo: 40 })))).toContain("LEVEL_YEARS_INVALID");
  });
  it("rejects a year that is also inside a band, which would allow the same content twice", () => {
    const d = researched(goodCourses());
    d.structure.levels.push({ id: `${V}/y8`, label: "Year 8", kind: "Year", ordinal: 9, yearFrom: 8, yearTo: 8, sourceName: "Year 8", placement: "stated", ...cite("Year 8 programme of study") });
    d.structure.courses.push({ id: `${V}/y8/c`, levelId: `${V}/y8`, code: "NP-Y8", title: "Year 8 maths", ordinal: 1, sourceName: "Year 8", placement: "stated", ...cite("Year 8 programme of study") });
    expect(where(d, "LEVEL_YEARS_OVERLAP")).toHaveLength(1);
  });
  it("accepts neighbouring bands, and levels without years", () => {
    expect(codes(withLevels(() => undefined))).toEqual([]);
    expect(codes(withLevels((l) => l.forEach((x) => { delete x.yearFrom; delete x.yearTo; })))).toEqual([]);
  });
  it("bounds tier and pathway text", () => {
    const d = researched(goodCourses());
    d.structure.courses[1]!.tier = " ";
    d.structure.courses[3]!.pathway = "x".repeat(61);
    const found = codes(d);
    expect(found).toContain("EMPTY_TEXT");
    expect(found).toContain("TEXT_TOO_LONG");
  });
});

describe("sourced level, course names and codes (requireSources)", () => {
  it("requires every level to be cited", () => {
    const d = researched(goodCourses());
    const level = d.structure.levels[0]!;
    for (const k of ["sourceUrl", "sourceSection", "confidence", "retrievedAt"] as const) delete level[k];
    expect(where(d, "SOURCE_REQUIRED")).toEqual(["levels[0]"]);
  });
  it("requires a level to say which name the source uses for it", () => {
    const d = researched(goodCourses());
    delete d.structure.levels[1]!.sourceName;
    expect(where(d, "SOURCE_NAME_REQUIRED")).toEqual(["levels[1]"]);
  });
  it("requires a course to be findable in its source by name or by official code", () => {
    const d = researched(goodCourses());
    delete d.structure.courses[0]!.sourceName;
    expect(where(d, "SOURCE_NAME_REQUIRED")).toEqual(["courses[0]"]);
    d.structure.courses[0]!.sourceName = "  ";
    expect(codes(d)).toContain("EMPTY_TEXT");
    d.structure.courses[0]!.sourceName = "x".repeat(121);
    expect(codes(d)).toContain("TEXT_TOO_LONG");
  });
  it("accepts a course identified only by an official code that its cited section contains", () => {
    const d = researched(goodCourses());
    const alevel = d.structure.courses.find((c) => c.officialCode)!;
    expect(alevel.sourceName).toBeUndefined();
    expect(codes(d)).toEqual([]);
  });
  it("requires the placement basis, and an inferred placement cannot claim high confidence", () => {
    const d = researched(goodCourses());
    delete d.structure.levels[2]!.placement;
    delete d.structure.courses[0]!.placement;
    expect(where(d, "PLACEMENT_REQUIRED").sort()).toEqual(["courses[0]", "levels[2]"]);
    d.structure.levels[2]!.placement = "guessed";
    expect(where(d, "PLACEMENT_INVALID")).toEqual(["levels[2]"]);
    const e = researched(goodCourses());
    e.structure.levels[2]!.placement = "inferred";
    e.structure.courses[0]!.placement = "inferred";
    expect(where(e, "PLACEMENT_INFERRED_HIGH_CONFIDENCE").sort()).toEqual(["courses[0]", "levels[2]"]);
    e.structure.levels[2]!.confidence = "medium";
    e.structure.courses[0]!.confidence = "low";
    expect(codes(e)).toEqual([]);
  });
  it("leaves datasets without requireSources untouched by these rules", () => {
    const d = researched(goodCourses());
    delete d.meta.version.requireSources;
    d.structure.courses.forEach((c) => delete c.officialCode); // suggested datasets carry none unless researched
    for (const l of d.structure.levels) {
      delete l.sourceName;
      delete l.placement;
    }
    for (const c of d.structure.courses) {
      delete c.sourceName;
      delete c.placement;
    }
    expect(validateDataset(d)).toEqual([]);
  });
});

describe("internal slugs versus official codes", () => {
  it("allows an official code for provenance in a researched suggested dataset only", () => {
    const d = researched(goodCourses());
    expect(codes(d)).not.toContain("SUGGESTED_OFFICIAL_CODE");
    delete d.meta.version.requireSources;
    expect(codes(d)).toContain("SUGGESTED_OFFICIAL_CODE");
  });
  it("keeps the internal code NP-prefixed in every researched dataset, whatever its kind", () => {
    const d = researched(goodCourses());
    d.structure.courses[0]!.code = "KS3-MATHS";
    expect(codes(d)).toContain("SUGGESTED_CODE_PREFIX");
    const real = researched(goodCourses());
    real.meta.version.kind = "real";
    real.meta.version.source = { title: "t", url: "https://example.test/x", retrievedAt: "2026-11-03" };
    real.meta.version.review = { by: "R", at: "2026-11-03", scope: "fixture" };
    real.structure.courses[0]!.code = "KS3-MATHS";
    expect(codes(real)).toContain("INTERNAL_CODE_PREFIX");
    real.structure.courses[0]!.code = "NP-KS3";
    expect(codes(real)).not.toContain("INTERNAL_CODE_PREFIX");
  });
  it("refuses an official code that is just the internal slug (an invented code)", () => {
    for (const invented of ["NP-ALEVEL", "alevel", "np-alevel", "NP-A-LEVEL"]) {
      const d = researched(goodCourses());
      const c = d.structure.courses[3]!;
      c.officialCode = invented;
      c.sourceSection = `Subject content ${invented}`;
      expect(codes(d), invented).toContain("OFFICIAL_CODE_IS_SLUG");
    }
  });
  it("refuses an official code that its cited section does not contain, or that has no citation", () => {
    const d = researched(goodCourses());
    const c = d.structure.courses.find((x) => x.officialCode)!;
    c.sourceSection = "A level subject content";
    expect(codes(d)).toContain("OFFICIAL_CODE_NOT_IN_SECTION");
    c.sourceSection = "subject content a-math 7357"; // case and punctuation do not matter
    expect(codes(d)).not.toContain("OFFICIAL_CODE_NOT_IN_SECTION");
    for (const k of ["sourceUrl", "sourceSection", "confidence", "retrievedAt", "placement"] as const) delete c[k];
    expect(codes(d)).toContain("OFFICIAL_CODE_UNSOURCED");
  });
  it("outside requireSources an official code equal to the code is fine (a real dataset's own code)", () => {
    const d = researched(goodCourses());
    delete d.meta.version.requireSources;
    d.meta.version.kind = "sample";
    d.meta.version.label = "Sample";
    d.meta.curriculum.name = "Sample curriculum";
    const c = d.structure.courses.find((x) => x.officialCode)!;
    c.code = c.officialCode!;
    expect(codes(d)).not.toContain("OFFICIAL_CODE_IS_SLUG");
  });
  it("an official code needs a citation even outside requireSources", () => {
    const d = researched(goodCourses());
    delete d.meta.version.requireSources;
    d.meta.version.kind = "sample";
    d.meta.version.label = "Sample";
    d.meta.curriculum.name = "Sample curriculum";
    const c = d.structure.courses.find((x) => x.officialCode)!;
    for (const k of ["sourceUrl", "sourceSection", "confidence", "retrievedAt"] as const) delete c[k];
    expect(codes(d)).toContain("OFFICIAL_CODE_UNSOURCED");
  });
});

describe("human-resolvable source sections", () => {
  const section = (value: string | undefined) => {
    const d = researched(goodCourses());
    if (value === undefined) delete d.structure.topics[0]!.sourceSection;
    else d.structure.topics[0]!.sourceSection = value;
    return d;
  };
  it("requires a section on every record", () => {
    expect(where(section(undefined), "SOURCE_SECTION_REQUIRED")).toEqual(["topics[0]"]);
    expect(where(section("  "), "SOURCE_SECTION_REQUIRED")).toEqual(["topics[0]"]);
  });
  it.each(["(S9)", "S3", "[S2]", "(s12)", "§4", "x", "12", "tmp-7f3a", "sect0004", "doc-abcd-12", "A-MATH-7357"])("rejects the internal label %s", (value) => {
    expect(where(section(value), "SOURCE_SECTION_UNRESOLVABLE")).toEqual(["topics[0]"]);
  });
  it.each(["Key stage 3 programme of study, Number", "GCE AS and A level subject content, section C: algebra", "Outcome N1, page 12", "Section 2"])("accepts %s", (value) => {
    expect(codes(section(value))).toEqual([]);
  });
  it("is not enforced when requireSources is off", () => {
    const d = section("(S9)");
    delete d.meta.version.requireSources;
    d.structure.courses.forEach((c) => delete c.officialCode);
    expect(codes(d)).toEqual([]);
  });
});

describe("combined title and summary wording overlap", () => {
  const source = "Pupils should be taught to use unit pricing and currency exchange using proportional reasoning in context. Solve linear equations.";
  const oneTopic = (title: string, summary: string) => {
    const d = researched([{ key: "a", level: "ks3", title: "Course A", topics: ["placeholder"] }]);
    d.structure.topics[0]!.title = title;
    d.structure.topics[0]!.summary = summary;
    return d;
  };
  it("measures the longest run of words shared with the sources", () => {
    const index = buildSourceIndex([source]);
    expect(longestSharedRun("totally different words here today", index)).toBe(0);
    expect(longestSharedRun("Unit pricing, and currency exchange!", index)).toBe(5);
    expect(longestSharedRun("compare unit pricing and currency exchange using proportional reasoning quickly", index)).toBe(8);
  });
  it("flags a topic whose title and summary together copy more than five words, though each field alone does not", () => {
    const d = oneTopic("Unit pricing and currency exchange", "Using proportional reasoning.");
    const index = buildSourceIndex([source]);
    const hits = findCopiedWording(d, index);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: d.structure.topics[0]!.id, run: 8 });
    expect(longestSharedRun(d.structure.topics[0]!.title, index)).toBeLessThanOrEqual(MAX_SHARED_RUN);
    expect(longestSharedRun(d.structure.topics[0]!.summary, index)).toBeLessThanOrEqual(MAX_SHARED_RUN);
  });
  it("allows runs up to the limit and ignores case, punctuation and hyphenation", () => {
    expect(MAX_SHARED_RUN).toBe(5);
    const d = oneTopic("Unit-pricing and CURRENCY exchange", "Tasks.");
    expect(findCopiedWording(d, buildSourceIndex([source]))).toEqual([]); // 5 shared words is allowed
  });
  it("does not stitch a run together from different places in the sources", () => {
    const index = buildSourceIndex(["alpha beta gamma delta epsilon zeta", "gamma delta epsilon zeta eta theta"]);
    expect(longestSharedRun("alpha beta gamma delta epsilon zeta eta theta", index)).toBe(6);
    const joined = buildSourceIndex(["alpha beta gamma", "delta epsilon zeta"]);
    expect(longestSharedRun("alpha beta gamma delta epsilon zeta", joined)).toBe(3); // sources do not run into each other
  });
  it("indexes a very large source without overflowing the call stack", () => {
    const big = Array.from({ length: 300_000 }, (_, i) => `w${i}`).join(" ");
    expect(longestSharedRun("w10 w11 w12 w13", buildSourceIndex([big]))).toBe(4);
  });
  it("handles empty sources and empty text", () => {
    expect(longestSharedRun("", buildSourceIndex([source]))).toBe(0);
    expect(longestSharedRun("anything at all goes here today", buildSourceIndex([]))).toBe(0);
  });
});

describe("researched dataset read from files", () => {
  it("round-trips the new fields through the zod schema and validates the same", () => {
    const d = researched(goodCourses());
    const dir = mkdtempSync(path.join(tmpdir(), "researched-"));
    writeFileSync(path.join(dir, "dataset.json"), JSON.stringify(d.meta));
    writeFileSync(path.join(dir, "structure.json"), JSON.stringify(d.structure));
    writeFileSync(path.join(dir, "objectives.json"), JSON.stringify(d.objectives));
    writeFileSync(path.join(dir, "mappings.json"), JSON.stringify(d.mappings));
    const read = readDatasetDir(dir);
    expect(read.structure.levels[0]).toMatchObject({ yearFrom: 7, yearTo: 9, placement: "stated" });
    expect(read.structure.courses[1]).toMatchObject({ tier: "Foundation" });
    expect(validateDataset(read)).toEqual([]);
    const england = researched(goodCourses().map((c) => ({ ...c, topics: topicTitles("ks", 10) })));
    writeFileSync(path.join(dir, "structure.json"), JSON.stringify(england.structure));
    expect(validateDataset(readDatasetDir(dir)).some((i) => i.code === "COURSE_TOPIC_SET_DUPLICATE")).toBe(true);
  });
});

describe("pnpm curriculum:overlap-check", () => {
  const fixture = path.join(root, "tests/fixtures/curricula/suggested-fixture/v1");
  const run = (...args: string[]) => spawnSync("pnpm", ["exec", "tsx", "scripts/curriculum-overlap-check.ts", ...args], { cwd: root, encoding: "utf8" });
  const withSource = (text: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "overlap-"));
    writeFileSync(path.join(dir, "source.txt"), text);
    return dir;
  };
  it("exits 1 and names the topic when title and summary copy more than five consecutive words", () => {
    // topic t1: "Solving linear equations" + "A NotePrep topic that has verified practice."
    const sources = withSource("Pupils practise solving linear equations a noteprep topic that has verified practice daily.");
    const result = run("--sources", sources, fixture);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/COPY .*suggested-fixture@v1\/course\/u1\/t1/);
  });
  it("exits 0 when the wording is the dataset's own", () => {
    const result = run("--sources", withSource("Entirely unrelated programme text about geometry and trigonometry."), fixture);
    expect(result.status).toBe(0);
  });
  it("exits 1 when no sources are given or the path cannot be read", () => {
    expect(run(fixture).status).toBe(1);
    expect(run("--sources", "/nonexistent/path", fixture).status).toBe(1);
  });
});
