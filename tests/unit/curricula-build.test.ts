/* eslint-disable @typescript-eslint/no-explicit-any -- the error tests deliberately corrupt the config shape */
import { describe, expect, it } from "vitest";
import { isValidId } from "@/lib/curriculum/dataset-schema";
import { buildSuggestedDatasets, ConfigError, slugify } from "@/lib/curriculum/suggested-build";
import { validateDataset } from "@/lib/curriculum/validate-dataset";
import type { Dataset } from "@/lib/curriculum/dataset-schema";

const TOPICS = {
  "one-step-equations": {
    title: "Solving one-step equations",
    summary: "Undo one operation to find the unknown.",
    concept: "linear-equations-one-variable",
    conceptCoverage: "partial",
    conceptNote: "Questions come from the general linear-equations generator and do not yet differ by topic.",
  },
  "full-topic": { title: "A full topic", summary: "Fully covered.", concept: "linear-equations-one-variable" },
  "quadratic-formula": { title: "The quadratic formula", summary: "Solve quadratics with the formula." },
  "slope": { title: "Slope", summary: "Rate of change of a line." },
};

const CURRICULA = {
  templates: {
    grades: {
      levelKind: "Grade",
      courses: [
        { code: "G9-MATH", title: "Grade 9 Mathematics", level: "Grade 9", ordinal: 1, units: [{ title: "Algebra", topics: ["one-step-equations", "full-topic"] }, { title: "Functions", topics: ["slope"] }] },
        { code: "G10-MATH", title: "Grade 10 Mathematics", level: "Grade 10", units: [{ title: "Algebra", topics: ["quadratic-formula"] }] },
      ],
    },
  },
  curricula: [
    { id: "ontario", name: "Ontario", country: { regionCode: "CA", name: "Canada" }, template: "grades" },
    {
      id: "alberta",
      name: "Alberta",
      country: { regionCode: "CA", name: "Canada" },
      template: "grades",
      removeCourses: ["G10-MATH"],
      courses: [{ code: "G9-MATH", title: "Grade 9 Mathematics (Alberta)", level: "Grade 9", units: [{ title: "Algebra", topics: ["slope"] }] }],
    },
    {
      id: "ib-math",
      name: "IB Mathematics",
      country: { regionCode: "INT", name: "International" },
      version: 2,
      courses: [{ code: "AA-SL", title: "Analysis and Approaches SL", units: [{ title: "Functions", topics: ["slope", "quadratic-formula"] }] }],
    },
  ],
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const build = (topics: unknown = TOPICS, curricula: unknown = CURRICULA) => buildSuggestedDatasets({ topics, curricula });
const parse = (files: Record<string, string>): Dataset => ({
  meta: JSON.parse(files["dataset.json"]!),
  structure: JSON.parse(files["structure.json"]!),
  objectives: JSON.parse(files["objectives.json"]!),
  mappings: JSON.parse(files["mappings.json"]!),
});
const problems = (topics: unknown, curricula: unknown): string[] => {
  try {
    build(topics, curricula);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
};
const byId = (id: string) => build().find((d) => d.curriculumId === id)!;

describe("template expansion and overrides", () => {
  it("expands a template into levels, courses, units and topics in config order", () => {
    const d = parse(byId("ontario").files);
    expect(d.structure.levels.map((l) => [l.label, l.kind, l.ordinal])).toEqual([["Grade 9", "Grade", 1], ["Grade 10", "Grade", 2]]);
    expect(d.structure.courses.map((c) => [c.code, c.title, c.ordinal])).toEqual([["NP-G9-MATH", "Grade 9 Mathematics", 1], ["NP-G10-MATH", "Grade 10 Mathematics", 1]]);
    expect(d.structure.units.map((u) => [u.title, u.ordinal])).toEqual([["Algebra", 1], ["Functions", 2], ["Algebra", 1]]);
    expect(d.structure.topics.map((t) => t.title)).toEqual(["Solving one-step equations", "A full topic", "Slope", "The quadratic formula"]);
  });
  it("lets a curriculum remove and replace template courses", () => {
    const d = parse(byId("alberta").files);
    expect(d.structure.courses.map((c) => c.title)).toEqual(["Grade 9 Mathematics (Alberta)"]);
    expect(d.structure.topics.map((t) => t.title)).toEqual(["Slope"]);
  });
  it("supports a curriculum with its own courses and no levels", () => {
    const d = parse(byId("ib-math").files);
    expect(d.structure.levels).toEqual([]);
    expect(d.structure.courses.every((c) => c.levelId === undefined)).toBe(true);
  });
});

describe("ids, kind, labels, codes", () => {
  it("builds ids from curriculum, version, level, course, unit and topic", () => {
    const d = parse(byId("ontario").files);
    expect(d.structure.topics[0]!.id).toBe("ontario@suggested-1/grade-9/g9-math/algebra/one-step-equations");
    expect(d.structure.levels[0]!.id).toBe("ontario@suggested-1/grade-9");
    expect(parse(byId("ib-math").files).structure.topics[0]!.id).toBe("ib-math@suggested-2/aa-sl/functions/slope");
    for (const t of d.structure.topics) expect(isValidId(t.id)).toBe(true);
  });
  it("is kind suggested with the required wording and no objectives", () => {
    const g = byId("ontario");
    const d = parse(g.files);
    expect(g.dir).toBe("ontario/suggested-1");
    expect(d.meta.version).toMatchObject({ id: "ontario@suggested-1", kind: "suggested", label: "Ontario suggested topics v1 (unofficial)" });
    expect(d.meta.curriculum).toEqual({ id: "ontario", name: "Ontario (suggested topics)", subject: "math" });
    expect(d.objectives).toEqual({ objectives: [] });
    expect(d.mappings.topicObjectives).toEqual([]);
    expect(d.meta.version.source.title).toMatch(/unofficial/i);
    expect(d.meta.version.licenseNote).toMatch(/NotePrep/);
    expect(JSON.stringify(d)).not.toMatch(/align/i);
    expect(d.structure.courses.every((c) => c.code.startsWith("NP-"))).toBe(true);
  });
  it("the version drives the version id and the directory", () => {
    const c: any = clone(CURRICULA);
    c.curricula[0].version = 3;
    const g = build(TOPICS, c).find((x) => x.curriculumId === "ontario")!;
    expect(g.dir).toBe("ontario/suggested-3");
    const d = parse(g.files);
    expect(d.meta.version.id).toBe("ontario@suggested-3");
    expect(d.meta.version.label).toBe("Ontario suggested topics v3 (unofficial)");
    expect(d.structure.topics.every((t) => t.id.startsWith("ontario@suggested-3/"))).toBe(true);
  });
  it("every generated dataset passes the real validator", () => {
    for (const g of build()) expect(validateDataset(parse(g.files)), g.curriculumId).toEqual([]);
  });
});

describe("concept mapping", () => {
  it("maps topics with a concept, keeps coverage and note, defaults to full, and skips unsupported topics", () => {
    const d = parse(byId("ontario").files);
    const [first, second] = d.structure.topics;
    expect(d.mappings.topicConcepts).toEqual([
      { topicId: first!.id, conceptId: "linear-equations-one-variable", coverage: "partial", note: "Questions come from the general linear-equations generator and do not yet differ by topic." },
      { topicId: second!.id, conceptId: "linear-equations-one-variable", coverage: "full" },
    ]);
  });
});

describe("country consistency", () => {
  it("gives every curriculum of one country the same education system", () => {
    const [a, b] = ["ontario", "alberta"].map((id) => parse(byId(id).files).meta.educationSystem);
    expect(a).toEqual({ id: "canada", name: "Canada", regionCode: "CA" });
    expect(b).toEqual(a);
    expect(parse(byId("ib-math").files).meta.educationSystem).toEqual({ id: "international", name: "International", regionCode: "INT" });
  });
  it("refuses one region code under two names", () => {
    const c: any = clone(CURRICULA);
    c.curricula[1].country = { regionCode: "CA", name: "Kanada" };
    expect(problems(TOPICS, c).join("\n")).toMatch(/CA.*Canada.*Kanada/s);
  });
});

describe("determinism", () => {
  it("gives byte-identical output for identical input, as 2-space JSON with a trailing newline", () => {
    const a = build();
    const b = build(clone(TOPICS), clone(CURRICULA));
    expect(a).toEqual(b);
    for (const g of a) {
      expect(Object.keys(g.files)).toEqual(["dataset.json", "structure.json", "objectives.json", "mappings.json"]);
      for (const text of Object.values(g.files)) {
        expect(text.endsWith("}\n")).toBe(true);
        expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
      }
    }
  });
  it("orders the output by curriculum id", () => {
    expect(build().map((g) => g.curriculumId)).toEqual(["alberta", "ib-math", "ontario"]);
  });
});

describe("config errors", () => {
  const mutate = (fn: (c: any, t: any) => void) => {
    const c: any = clone(CURRICULA);
    const t: any = clone(TOPICS);
    fn(c, t);
    return problems(t, c).join("\n");
  };
  it("a valid config has no problems", () => expect(problems(TOPICS, CURRICULA)).toEqual([]));
  it("names an unknown topic key and where it was used", () => {
    expect(mutate((c) => c.templates.grades.courses[0].units[0].topics.push("no-such-topic"))).toMatch(/G9-MATH.*unknown topic "no-such-topic"/s);
  });
  it("refuses an unknown concept id", () => {
    expect(mutate((_c, t) => (t.slope.concept = "calculus"))).toMatch(/slope.*unknown concept "calculus"/s);
  });
  it("refuses a partial concept without a note", () => {
    expect(mutate((_c, t) => delete t["one-step-equations"].conceptNote)).toMatch(/partial.*conceptNote/s);
  });
  it("refuses over-length text", () => {
    expect(mutate((_c, t) => (t.slope.title = "x".repeat(121)))).toMatch(/slope.*title.*120/s);
    expect(mutate((_c, t) => (t.slope.summary = "x".repeat(201)))).toMatch(/slope.*summary.*200/s);
  });
  it("refuses duplicates: curriculum ids, course codes, unit titles, topics in a unit", () => {
    expect(mutate((c) => c.curricula.push(clone(c.curricula[0])))).toMatch(/duplicate curriculum id "ontario"/);
    expect(mutate((c) => (c.templates.grades.courses[1].code = "G9-MATH"))).toMatch(/duplicate course code "G9-MATH"/);
    expect(mutate((c) => c.templates.grades.courses[0].units.push({ title: "Algebra", topics: ["slope"] }))).toMatch(/duplicate unit "Algebra"/);
    expect(mutate((c) => c.templates.grades.courses[0].units[0].topics.push("full-topic"))).toMatch(/duplicate topic "full-topic"/);
  });
  it("refuses a missing country, an unknown template, and a curriculum without courses", () => {
    expect(mutate((c) => delete c.curricula[0].country)).toMatch(/country/);
    expect(mutate((c) => (c.curricula[0].template = "nope"))).toMatch(/unknown template "nope"/);
    expect(mutate((c) => (c.curricula[0].removeCourses = ["G9-MATH", "G10-MATH"]))).toMatch(/ontario.*no courses/);
    expect(mutate((c) => delete c.curricula[2].courses)).toMatch(/ib-math.*no courses/);
  });
  it("refuses removing a course the template does not have, a bad version, mixed levels and unknown fields", () => {
    expect(mutate((c) => (c.curricula[1].removeCourses = ["G11-MATH"]))).toMatch(/removeCourses.*"G11-MATH"/);
    expect(mutate((c) => (c.curricula[0].version = 0))).toMatch(/version/);
    expect(mutate((c) => delete c.templates.grades.courses[1].level)).toMatch(/level/);
    expect(mutate((c) => (c.curricula[0].nmae = "x"))).toMatch(/nmae/);
  });
  it("reports every problem, not just the first", () => {
    const t: any = clone(TOPICS);
    t.slope.title = "";
    const c: any = clone(CURRICULA);
    c.curricula[0].template = "nope";
    expect(problems(t, c).length).toBeGreaterThanOrEqual(2);
  });
});

describe("slugify", () => {
  it("makes safe id segments", () => expect(slugify("Geometry and measurement")).toBe("geometry-and-measurement"));
});
