import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/curriculum/capabilities";
import { withContextHash, type CurriculumContext, type UnhashedContext } from "@/lib/curriculum/context";
import { canonicalJson } from "@/lib/domain/hash";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { buildPackage, dependentsOf, LINEAR_CONCEPT_ID, PackageBuildError, planOutline } from "@/lib/package/build";
import { sectionContentHash } from "@/lib/package/hash";
import { PackageSchema, type LessonPackage, type Section } from "@/lib/package/schema";
import { checkProse, validatePackage } from "@/lib/package/validate";
import { documentView, type WorksheetView } from "@/lib/package/views";

const capability = CAPABILITIES[LINEAR_CONCEPT_ID]!;

function makeContext(kind: "real" | "sample" = "sample", overrides: Partial<UnhashedContext> = {}): CurriculumContext {
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
      { id: "o1", officialCode: "FIC-E.1", label: "Solve equations with one unknown", coverage: "full" as const, note: null, source: { ref: "invented", page: null } },
      { id: "o2", officialCode: "FIC-E.2", label: "Check a solution by substitution", coverage: "full" as const, note: null, source: { ref: "invented", page: null } },
    ],
    prerequisites: [{ topicId: "t0", title: "Working with integers" }],
    concepts: [{ id: LINEAR_CONCEPT_ID, name: "Linear equations in one variable", coverage: "full" as const, note: null, capability }],
    alignmentClaimsAllowed: kind === "real",
  };
  return withContextHash({ ...base, ...overrides });
}

const request = (overrides: Partial<LessonRequestV2> = {}): LessonRequestV2 => ({
  requestVersion: 2,
  curriculum: { versionId: "fiction-math@v1", topicId: "t1" },
  durationMinutes: 60,
  difficulty: "mixed",
  documents: ["notes", "worksheet", "solutions"],
  templateId: "classic",
  locale: "en",
  ...overrides,
});
const build = (o: Partial<LessonRequestV2> = {}, seed = "seed-1", ctx = makeContext()) => buildPackage({ request: request(o), context: ctx, seed });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const kindOf = (pkg: LessonPackage, kind: string) => pkg.sections.find((s) => s.kind === kind)!;

describe("a built package", () => {
  it("is valid and fully verified for every difficulty and a range of lesson lengths", () => {
    for (const difficulty of ["basic", "mixed", "challenge"] as const) {
      for (const durationMinutes of [15, 30, 45, 60, 90, 120, 180]) {
        const pkg = build({ difficulty, durationMinutes }, `s-${difficulty}-${durationMinutes}`);
        expect(PackageSchema.safeParse(pkg).success, `${difficulty}/${durationMinutes}`).toBe(true);
        const report = validatePackage(pkg);
        expect(report, `${difficulty}/${durationMinutes}: ${JSON.stringify([report.structure.issues, report.prose.issues])}`).toMatchObject({ overall: "verified", structure: { overall: "pass" }, prose: { overall: "pass" }, math: { overall: "verified" } });
      }
    }
  });

  it("contains every required kind of section, with the curriculum context snapshot", () => {
    const pkg = build();
    expect(pkg.sections.map((s) => s.kind)).toEqual(["objectives", "prerequisites", "explanation", "derivation", "worked_examples", "teaching_sequence", "common_mistakes", "exercises", "solutions", "alignment"]);
    expect(pkg.context).toEqual(makeContext());
    expect(pkg.schemaVersion).toBe("lesson-package/1");
  });

  it("is byte-identical for the same seed, request and context, and different for another seed", () => {
    expect(canonicalJson(build())).toBe(canonicalJson(build()));
    expect(canonicalJson(build({}, "other-seed"))).not.toBe(canonicalJson(build()));
  });

  it("budgets the requested time exactly, with sensible counts", () => {
    for (let minutes = 15; minutes <= 180; minutes++) {
      const plan = planOutline(minutes);
      expect(plan.explanation + plan.examples + plan.review + plan.exercises, `${minutes}`).toBe(minutes);
      expect(plan.exerciseCount).toBeGreaterThanOrEqual(3);
      expect(plan.exerciseCount).toBeLessThanOrEqual(12);
      expect(plan.exercises).toBeGreaterThan(0);
    }
    const pkg = build({ durationMinutes: 90 });
    expect(pkg.outline.sections.reduce((n, s) => n + s.minutes, 0)).toBe(90);
  });

  it("draws exercises that differ from each other and from the worked examples", () => {
    for (let i = 0; i < 25; i++) {
      const pkg = build({ difficulty: i % 2 ? "mixed" : "challenge", durationMinutes: 120 }, `distinct-${i}`);
      const equations = pkg.sections.flatMap((s) => s.blocks.flatMap((b) => ("problem" in b ? [JSON.stringify(b.problem.equation)] : [])));
      expect(new Set(equations).size).toBe(equations.length);
    }
  });

  it("includes a no-solution example for mixed and challenge lessons only", () => {
    const hasNoSolution = (pkg: LessonPackage) => (kindOf(pkg, "worked_examples") as Extract<Section, { kind: "worked_examples" }>).blocks.some((b) => b.type === "worked_example" && b.solution.kind === "no_solution");
    expect(hasNoSolution(build({ difficulty: "basic" }))).toBe(false);
    expect(hasNoSolution(build({ difficulty: "mixed" }))).toBe(true);
    expect(hasNoSolution(build({ difficulty: "challenge" }))).toBe(true);
  });

  it("passes the curriculum context's objectives and prerequisites through unchanged", () => {
    const pkg = build();
    const objectives = kindOf(pkg, "objectives").blocks.flatMap((b) => (b.type === "list" ? b.items : []));
    expect(objectives).toEqual(["Solve equations with one unknown", "Check a solution by substitution"]);
    expect(kindOf(pkg, "prerequisites").blocks.flatMap((b) => (b.type === "list" ? b.items : []))).toEqual(["Working with integers"]);
    const none = build({}, "s", makeContext("sample", { prerequisites: [] }));
    expect(JSON.stringify(kindOf(none, "prerequisites").blocks)).toContain("No earlier topics");
  });
});

describe("the engine only builds what its capability allows", () => {
  it("refuses a context with no generatable concept", () => {
    expect(() => build({}, "s", makeContext("sample", { concepts: [] }))).toThrow(PackageBuildError);
  });
  it("refuses a difficulty the capability does not list", () => {
    const narrowed = makeContext("sample", { concepts: [{ id: LINEAR_CONCEPT_ID, name: "x", coverage: "full", note: null, capability: { ...capability, difficulties: ["basic"] } }] });
    expect(() => build({ difficulty: "challenge" }, "s", narrowed)).toThrow(PackageBuildError);
    expect(() => build({ difficulty: "basic" }, "s", narrowed)).not.toThrow();
  });
});

describe("documents", () => {
  const pkg = build();
  it("the worksheet has exercises and the curriculum note, and no answer anywhere", () => {
    const view = documentView(pkg, "worksheet");
    expect(view.sections.map((s) => s.kind)).toEqual(["exercises", "alignment"]);
    const text = JSON.stringify(view);
    expect(text).not.toContain('"solution"');
    expect(text).not.toContain('"steps"');
    expect(text).not.toContain("worked_example");
    for (const answered of kindOf(pkg, "solutions").blocks) if (answered.type === "solution" && answered.solution.value) expect(text).not.toContain(`"value":"${answered.solution.value}"`);
  });
  it("cannot be built with a solutions section: it does not type-check", () => {
    const solutions = kindOf(pkg, "solutions") as Extract<Section, { kind: "solutions" }>;
    // @ts-expect-error a solutions section is not a worksheet section
    const bad: WorksheetView = { document: "worksheet", sections: [solutions] };
    expect(bad.sections).toHaveLength(1); // only here to use the value; the point is the compile-time error above
  });
  it("the notes carry the worked examples and none of the exercise questions", () => {
    const text = JSON.stringify(documentView(pkg, "notes"));
    expect(text).toContain("worked_example");
    expect(text).not.toContain('"type":"question"');
    expect(documentView(pkg, "notes").sections.map((s) => s.kind)).toEqual(["objectives", "prerequisites", "explanation", "derivation", "worked_examples", "teaching_sequence", "common_mistakes", "alignment"]);
  });
  it("the solutions document answers every exercise, in order", () => {
    const asked = kindOf(pkg, "exercises").blocks.flatMap((b) => (b.type === "question" ? [b.questionId] : []));
    const answered = documentView(pkg, "solutions").sections[0]!.blocks.flatMap((b) => (b.type === "solution" ? [b.questionId] : []));
    expect(answered).toEqual(asked);
  });
  it("only the requested documents are listed; asking for an absent one is an error", () => {
    const only = build({ documents: ["worksheet"] });
    expect(only.documents.map((d) => d.id)).toEqual(["worksheet"]);
    expect(() => documentView(only, "solutions")).toThrow(RangeError);
  });
});

describe("hashes and dependencies", () => {
  it("each section's content hash is the hash of its content", () => {
    for (const s of build().sections) expect(s.contentHash).toBe(sectionContentHash(s));
  });
  it("a new seed changes exactly the generated sections and what depends on them", () => {
    const a = build({}, "one");
    const b = build({}, "two");
    const changed = a.sections.filter((s, i) => s.contentHash !== b.sections[i]!.contentHash).map((s) => s.kind);
    expect(changed).toEqual(["worked_examples", "exercises", "solutions"]);
    const inputsChanged = a.sections.filter((s, i) => s.inputsHash !== b.sections[i]!.inputsHash).map((s) => s.kind);
    expect(inputsChanged).toEqual(["worked_examples", "exercises", "solutions"]);
  });
  it("changing a section's content changes the inputs hash of what depends on it, and nothing else", () => {
    const a = build();
    const ctx = makeContext("sample", { objectives: [{ id: "o1", officialCode: "FIC-E.1", label: "A different objective", coverage: "full", note: null, source: { ref: "invented", page: null } }] });
    const b = build({}, "seed-1", ctx);
    const differs = (kind: string) => kindOf(a, kind).inputsHash !== kindOf(b, kind).inputsHash;
    expect(differs("explanation")).toBe(true); // downstream of objectives, and the context hash changed
    expect(kindOf(a, "common_mistakes").contentHash).toBe(kindOf(b, "common_mistakes").contentHash); // same words
  });
  it("exercises -> solutions is a derive edge, and dependents follow edges transitively", () => {
    const pkg = build();
    expect(pkg.deps).toContainEqual({ from: "sec-exercises", to: "sec-solutions", kind: "derives" });
    expect(dependentsOf(pkg, "sec-exercises")).toEqual(["sec-solutions"]);
    expect(dependentsOf(pkg, "sec-explanation")).toEqual(["sec-worked-examples"]);
    expect(dependentsOf(pkg, "sec-objectives")).toEqual(["sec-exercises", "sec-explanation", "sec-solutions", "sec-worked-examples"]);
    expect(dependentsOf(pkg, "sec-solutions")).toEqual([]);
    expect(dependentsOf(pkg, "sec-alignment")).toEqual([]);
  });
});

describe("curriculum statements", () => {
  it("sample data never produces an alignment claim", () => {
    const block = kindOf(build(), "alignment").blocks[0]!;
    expect(block).toMatchObject({ type: "alignment", claim: "none", datasetKind: "sample" });
  });
  it("a claim appears only for a dataset that allows it, and lists the dataset's objectives exactly", () => {
    const pkg = build({}, "s", makeContext("real"));
    const block = kindOf(pkg, "alignment").blocks[0]!;
    expect(block).toMatchObject({ claim: "aligned", curriculumName: "Fictional Mathematics Programme", versionLabel: "Fiction Edition 7" });
    expect(block.type === "alignment" && block.objectives.map((o) => o.officialCode)).toEqual(["FIC-E.1", "FIC-E.2"]);
    expect(validatePackage(pkg).overall).toBe("verified");
  });
});

describe("validation catches defects", () => {
  const codes = (r: { structure: { issues: { code: string }[] }; prose: { issues: { code: string }[] } }) => [...r.structure.issues, ...r.prose.issues].map((i) => i.code);

  it("a wrong answer fails the math", () => {
    const pkg = clone(build());
    const solutions = kindOf(pkg, "solutions") as Extract<Section, { kind: "solutions" }>;
    const first = solutions.blocks.find((b) => b.type === "solution")!;
    if (first.type === "solution") first.solution = { kind: "unique", value: "12345" };
    solutions.contentHash = sectionContentHash(solutions); // hashes kept consistent: only the mathematics is wrong
    const report = validatePackage(pkg);
    expect(report.overall).toBe("failed");
    expect(report.math?.overall).toBe("failed");
  });
  it("a missing or reordered solution is caught", () => {
    const pkg = clone(build());
    const solutions = kindOf(pkg, "solutions") as Extract<Section, { kind: "solutions" }>;
    solutions.blocks = solutions.blocks.filter((b, i) => !(b.type === "solution" && i === 1));
    solutions.contentHash = sectionContentHash(solutions);
    expect(codes(validatePackage(pkg))).toContain("EXERCISES_SOLUTIONS_MISMATCH");
  });
  it("editing a section without updating its hash is caught", () => {
    const pkg = clone(build());
    const s = kindOf(pkg, "common_mistakes") as Extract<Section, { kind: "common_mistakes" }>;
    s.title = "Edited title";
    expect(codes(validatePackage(pkg))).toContain("CONTENT_HASH_MISMATCH");
  });
  it("a tampered curriculum snapshot is caught", () => {
    const pkg = clone(build());
    (pkg.context as CurriculumContext).topic.title = "Changed";
    expect(codes(validatePackage(pkg))).toContain("CONTEXT_HASH_MISMATCH");
  });
  it("wrong outline minutes, dangling or cyclic dependencies, and a stray section in a document are caught", () => {
    const a = clone(build());
    a.outline.sections[0]!.minutes += 3;
    expect(codes(validatePackage(a))).toContain("OUTLINE_MINUTES_MISMATCH");
    const b = clone(build());
    b.deps.push({ from: "sec-nope", to: "sec-exercises", kind: "references" });
    expect(codes(validatePackage(b))).toContain("DEP_DANGLING");
    const c = clone(build());
    c.deps.push({ from: "sec-solutions", to: "sec-exercises", kind: "references" });
    expect(codes(validatePackage(c))).toContain("DEP_CYCLE");
    const d = clone(build());
    d.documents.find((doc) => doc.id === "worksheet")!.sectionIds.push("sec-solutions");
    expect(codes(validatePackage(d))).toContain("DOCUMENT_SECTION_KIND");
  });
  it("an unknown field or malformed package fails the schema", () => {
    expect(validatePackage({ nonsense: true })).toMatchObject({ overall: "failed", structure: { issues: [{ code: "SCHEMA_INVALID" }] } });
    const extra = { ...clone(build()), extra: 1 };
    expect(validatePackage(extra).overall).toBe("failed");
  });
});

describe("validation of identity, hashes, edges and required content", () => {
  const codes = (r: { structure: { issues: { code: string }[] }; prose: { issues: { code: string }[] } }) => [...r.structure.issues, ...r.prose.issues].map((i) => i.code);
  type AlignmentSection = Extract<Section, { kind: "alignment" }>;
  const alignment = (pkg: LessonPackage) => {
    const section = kindOf(pkg, "alignment") as AlignmentSection;
    const block = section.blocks[0]!;
    if (block.type !== "alignment") throw new Error("no alignment block");
    return { section, block };
  };

  it("a tampered alignment block fails even when the section hash is recomputed", () => {
    const mutations: Record<string, (b: ReturnType<typeof alignment>["block"]) => void> = {
      curriculumName: (b) => void (b.curriculumName = "Totally Official Ministry Curriculum"),
      versionLabel: (b) => void (b.versionLabel = "2099"),
      datasetKind: (b) => void (b.datasetKind = "real"),
      claim: (b) => void (b.claim = "aligned"),
      coverage: (b) => void (b.objectives[0]!.coverage = "partial"),
      note: (b) => void (b.objectives[0]!.note = "Added note"),
      label: (b) => void (b.objectives[0]!.label = "Something else"),
      officialCode: (b) => void (b.objectives[0]!.officialCode = "XX-9"),
      id: (b) => void (b.objectives[0]!.id = "o-other"),
      dropped: (b) => void b.objectives.pop(),
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const pkg = clone(build());
      const { section, block } = alignment(pkg);
      mutate(block);
      section.contentHash = sectionContentHash(section);
      expect(codes(validatePackage(pkg)), name).toContain("ALIGNMENT_NOT_IN_DATASET");
      expect(validatePackage(pkg).overall, name).toBe("failed");
    }
  });
  it("a package whose claim is weaker than the snapshot allows also fails", () => {
    const pkg = clone(build({}, "s", makeContext("real")));
    const { section, block } = alignment(pkg);
    expect(block.claim).toBe("aligned");
    block.claim = "none";
    section.contentHash = sectionContentHash(section);
    expect(codes(validatePackage(pkg))).toContain("ALIGNMENT_NOT_IN_DATASET");
  });

  it("a wrong or missing inputsHash is caught", () => {
    const pkg = clone(build());
    kindOf(pkg, "explanation").inputsHash = `sha256:${"0".repeat(64)}`;
    expect(codes(validatePackage(pkg))).toContain("INPUTS_HASH_MISMATCH");
    // an upstream edit that is rehashed on its own section leaves the dependents' inputsHash stale
    const upstream = clone(build());
    const objectives = kindOf(upstream, "objectives") as Extract<Section, { kind: "objectives" }>;
    objectives.title = "Renamed objectives";
    objectives.contentHash = sectionContentHash(objectives);
    const report = validatePackage(upstream);
    expect(report.structure.issues.filter((i) => i.code === "INPUTS_HASH_MISMATCH").map((i) => i.where).sort()).toEqual(["sec-exercises", "sec-explanation"]);
  });
  it("inputsHash verifies for packages with model-written prose and with fewer documents", () => {
    for (const documents of [["worksheet"], ["solutions"], ["notes", "worksheet"]] as const) {
      expect(validatePackage(build({ documents: [...documents] })).overall, documents.join()).toBe("verified");
    }
  });

  it("missing, extra or wrong dependency edges are caught", () => {
    const missing = clone(build());
    missing.deps = [];
    expect(codes(validatePackage(missing))).toContain("DEP_EDGES_MISMATCH");
    const dropped = clone(build());
    dropped.deps.pop();
    expect(codes(validatePackage(dropped))).toContain("DEP_EDGES_MISMATCH");
    const extra = clone(build());
    extra.deps.push({ from: "sec-objectives", to: "sec-solutions", kind: "references" });
    expect(codes(validatePackage(extra))).toContain("DEP_EDGES_MISMATCH");
    const wrongKind = clone(build());
    wrongKind.deps[3]!.kind = "references";
    expect(codes(validatePackage(wrongKind))).toContain("DEP_EDGES_MISMATCH");
    const duplicated = clone(build());
    duplicated.deps.push(duplicated.deps[0]!);
    expect(codes(validatePackage(duplicated))).toContain("DEP_EDGES_MISMATCH");
  });

  it("a package without exercises, solutions or worked examples fails", () => {
    const empty = (kind: "exercises" | "solutions" | "worked_examples") => {
      const pkg = clone(build());
      const s = kindOf(pkg, kind) as { blocks: { type: string }[]; contentHash: string; title: string; kind: string };
      s.blocks = s.blocks.filter((b) => b.type === "paragraph").slice(0, 1);
      s.contentHash = sectionContentHash(s as never);
      return validatePackage(pkg);
    };
    expect(codes(empty("exercises"))).toContain("SECTION_EMPTY");
    expect(codes(empty("solutions"))).toContain("SECTION_EMPTY");
    expect(codes(empty("worked_examples"))).toContain("SECTION_EMPTY");
    expect(empty("exercises").overall).toBe("failed");
  });
  it("a package missing a section kind that a requested document needs fails; one a document does not need may be absent", () => {
    for (const kind of ["derivation", "teaching_sequence", "common_mistakes", "alignment", "objectives"] as const) {
      const pkg = clone(build());
      const gone = kindOf(pkg, kind).id;
      pkg.sections = pkg.sections.filter((s) => s.id !== gone);
      expect(codes(validatePackage(pkg)), kind).toContain("SECTION_KIND_MISSING");
    }
    const worksheetOnly = clone(build({ documents: ["worksheet"] }));
    worksheetOnly.sections = worksheetOnly.sections.filter((s) => ["exercises", "alignment"].includes(s.kind));
    worksheetOnly.deps = [];
    worksheetOnly.outline.sections = worksheetOnly.outline.sections.filter((s) => ["exercises", "alignment"].includes(s.kind));
    expect(codes(validatePackage(worksheetOnly))).not.toContain("SECTION_KIND_MISSING");
  });

  it("malformed stored request or context is reported, never thrown", () => {
    for (const patch of [{ context: { contextHash: "x" } }, { context: null }, { context: "text" }, { request: null }, { request: { requestVersion: 2 } }, { context: {} }]) {
      const pkg = { ...clone(build()), ...patch };
      let report: ReturnType<typeof validatePackage> | undefined;
      expect(() => (report = validatePackage(pkg))).not.toThrow();
      expect(report!.overall).toBe("failed");
      expect(report!.structure.issues.length).toBeGreaterThan(0);
      expect(report!.structure.issues[0]!.code).toMatch(/^(CONTEXT|REQUEST)_INVALID$/);
    }
  });
});

describe("prose rules", () => {
  const tweak = (text: string, ctx = makeContext()) => {
    const pkg = clone(build({}, "s", ctx));
    const s = kindOf(pkg, "explanation") as Extract<Section, { kind: "explanation" }>;
    s.blocks = [{ type: "paragraph", text }];
    return checkProse(pkg, ctx).issues.map((i) => i.code);
  };
  it("accepts plain words", () => {
    expect(tweak("Undo the addition on both sides, then divide.")).toEqual([]);
  });
  it("rejects numbers, symbols, markup and links", () => {
    for (const text of ["Add 5 to both sides.", "Solve x = 4.", "Use $x$ here.", "See https://example.com now.", "Use \\frac here.", "Try <b>bold</b> text."]) {
      expect(tweak(text), text).toContain("PROSE_HAS_MATH_OR_MARKUP");
    }
  });
  it("rejects curriculum claims and names in generated prose", () => {
    expect(tweak("This lesson is aligned with the expectations.")).toContain("PROSE_MAKES_CURRICULUM_CLAIM");
    expect(tweak("This follows the curriculum closely.")).toContain("PROSE_MAKES_CURRICULUM_CLAIM");
    expect(tweak("This comes from Fictional Mathematics Programme notes.")).toContain("PROSE_NAMES_CURRICULUM");
    expect(tweak("Use the Fiction Edition 7 wording.")).toContain("PROSE_NAMES_CURRICULUM");
  });
  it("rejects an alignment claim the dataset does not allow, and objectives that are not the dataset's", () => {
    const ctx = makeContext();
    const pkg = clone(build({}, "s", ctx));
    const block = kindOf(pkg, "alignment").blocks[0]!;
    if (block.type === "alignment") block.claim = "aligned";
    expect(checkProse(pkg, ctx).issues.map((i) => i.code)).toContain("ALIGNMENT_CLAIM_NOT_ALLOWED");
    if (block.type === "alignment") {
      block.claim = "none";
      block.objectives[0]!.label = "Invented requirement";
    }
    expect(checkProse(pkg, ctx).issues.map((i) => i.code)).toContain("ALIGNMENT_NOT_IN_DATASET");
  });
  it("rejects objective text that differs from the dataset's", () => {
    const ctx = makeContext();
    const pkg = clone(build({}, "s", ctx));
    const s = kindOf(pkg, "objectives") as Extract<Section, { kind: "objectives" }>;
    const list = s.blocks.find((b) => b.type === "list");
    if (list && list.type === "list") list.items[0] = "Something the dataset never said";
    expect(checkProse(pkg, ctx).issues.map((i) => i.code)).toContain("DATASET_TEXT_ALTERED");
  });
});
