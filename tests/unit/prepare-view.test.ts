import { describe, expect, it } from "vitest";
import type { SelectionOption, SelectionStep } from "@/lib/server/dal/curriculum";
import { readPrepareParams } from "@/lib/ui/prepare-url";
import { buildSelectFields, countryLabel, countryOptions, curriculaForCountry, datasetBanner, changeSelection, resolveCountry, selectionHref } from "@/lib/ui/prepare-view";

const full = { v: "a", level: "l", course: "c", unit: "u", topic: "t" };
const curricula = [{ id: "cur1", name: "Sample Curriculum", latestVersionId: "ver1" }];
const allSteps: SelectionStep[] = ["level", "course", "unit", "topic"];

describe("changeSelection", () => {
  it("clears every value after the changed field", () => {
    expect(changeSelection(full, "course", "c2")).toEqual({ v: "a", level: "l", course: "c2" });
    expect(Object.entries(changeSelection(full, "course", "c2")).filter(([, v]) => v !== undefined).map(([k]) => k)).toEqual(["v", "level", "course"]);
  });
  it("keeps only the new v when the curriculum changes", () => {
    const next = changeSelection(full, "v", "b");
    expect(next).toEqual({ v: "b" });
    expect(next.level).toBeUndefined();
    expect(next.topic).toBeUndefined();
  });
  it("maps an empty value to undefined", () => {
    const next = changeSelection(full, "unit", "");
    expect(next.unit).toBeUndefined();
    expect(next.topic).toBeUndefined();
    expect(next).toEqual({ v: "a", level: "l", course: "c" });
  });
});

describe("selectionHref", () => {
  it("builds the URL in fixed key order", () => {
    expect(selectionHref(full, "course", "c2")).toBe("/prepare?v=a&level=l&course=c2");
    expect(selectionHref(full, "v", "b")).toBe("/prepare?v=b");
    expect(selectionHref(full, "level", "")).toBe("/prepare?v=a");
  });
});

describe("buildSelectFields", () => {
  const stepOptions: Partial<Record<SelectionStep, SelectionOption[]>> = {
    level: [{ id: "l", label: "Grade 9", supported: true }],
    course: [{ id: "c", label: "Math", supported: true }],
    unit: [
      { id: "u", label: "Algebra", supported: true },
      { id: "u2", label: "Geometry", supported: false },
    ],
    topic: [
      { id: "t", label: "Linear equations", supported: true, coverage: "full" },
      { id: "t2", label: "Systems", supported: true, coverage: "partial" },
      { id: "t3", label: "Quadratics", supported: false, unsupportedReason: "no_verified_generator" },
    ],
  };

  it("returns five fields in fixed order with labels when levels exist", () => {
    const fields = buildSelectFields({ curricula, params: full, steps: allSteps, stepOptions });
    expect(fields.map((f) => f.key)).toEqual(["v", "level", "course", "unit", "topic"]);
    expect(fields.map((f) => f.label)).toEqual(["Curriculum", "Level", "Course", "Unit", "Topic"]);
    expect(fields.map((f) => f.placeholder)).toEqual(["Choose a curriculum", "Choose a level", "Choose a course", "Choose a unit", "Choose a topic"]);
  });

  it("omits the level field when the dataset has no levels", () => {
    const fields = buildSelectFields({ curricula, params: {}, steps: ["course", "unit", "topic"], stepOptions });
    expect(fields.map((f) => f.key)).toEqual(["v", "course", "unit", "topic"]);
  });

  it("disables every field after the first empty one", () => {
    const fields = buildSelectFields({ curricula, params: {}, steps: allSteps, stepOptions });
    expect(fields.map((f) => f.disabled)).toEqual([false, true, true, true, true]);
    const partial = buildSelectFields({ curricula, params: { v: "ver1", level: "l" }, steps: allSteps, stepOptions });
    expect(partial.map((f) => f.disabled)).toEqual([false, false, false, true, true]);
    const none = buildSelectFields({ curricula, params: { v: "ver1", course: "c" }, steps: allSteps, stepOptions });
    expect(none.map((f) => f.disabled)).toEqual([false, false, true, true, true]);
  });

  it("takes values from params and the curriculum options from curricula", () => {
    const fields = buildSelectFields({ curricula, params: { v: "ver1", level: "l" }, steps: allSteps, stepOptions });
    expect(fields.map((f) => f.value)).toEqual(["ver1", "l", "", "", ""]);
    expect(fields[0]!.options).toEqual([{ value: "ver1", label: "Sample Curriculum", disabled: false }]);
  });

  it("marks unsupported units disabled with a reason", () => {
    const unit = buildSelectFields({ curricula, params: full, steps: allSteps, stepOptions }).find((f) => f.key === "unit")!;
    expect(unit.options).toEqual([
      { value: "u", label: "Algebra", disabled: false },
      { value: "u2", label: "Geometry — nothing here is available yet", disabled: true },
    ]);
  });

  it("annotates topics by coverage and support", () => {
    const topic = buildSelectFields({ curricula, params: full, steps: allSteps, stepOptions }).find((f) => f.key === "topic")!;
    expect(topic.options).toEqual([
      { value: "t", label: "Linear equations", disabled: false },
      { value: "t2", label: "Systems (partly covered)", disabled: false },
      { value: "t3", label: "Quadratics — not available yet", disabled: true },
    ]);
  });

  it("gives an empty option list when a step has no options loaded", () => {
    const fields = buildSelectFields({ curricula, params: {}, steps: allSteps, stepOptions: {} });
    expect(fields[1]!.options).toEqual([]);
  });
});

describe("datasetBanner", () => {
  it("chooses the banner by dataset kind: sample and synthetic say sample, suggested says unofficial, real has none", () => {
    expect(datasetBanner("sample")).toBe("sample");
    expect(datasetBanner("synthetic")).toBe("sample");
    expect(datasetBanner("suggested")).toBe("suggested");
    expect(datasetBanner("real")).toBeNull();
  });
});

const cur = (id: string, name: string, sys: string, region: string, versions = [`${id}@1`]) => ({
  id,
  name,
  educationSystem: { id: sys, name: `${sys} system`, regionCode: region },
  versions: versions.map((v) => ({ id: v, label: v, kind: "real" as const })),
  latestVersionId: versions[0]!,
});
const ontario = cur("on", "Ontario Math", "ontario", "CA");
const bc = cur("bc", "BC Math", "bc", "ca", ["bc@2", "bc@1"]);
const uk = cur("gcse", "GCSE Maths", "england", "GB");
const intl = { ...cur("ib", "IB Math", "intl", "INT"), educationSystem: { id: "intl", name: "International", regionCode: "INT" } };

describe("countryLabel", () => {
  it("uses the English region name for a clean ISO code, and the system name otherwise", () => {
    expect(countryLabel("CA", "Ontario system")).toBe("Canada");
    expect(countryLabel("gb", "England system")).toBe("United Kingdom");
    expect(countryLabel("INT", "International")).toBe("International");
    expect(countryLabel("XX", "Sample Education System (not real)")).toBe("Sample Education System (not real)");
    expect(countryLabel("ZZ", "Synthetic System A")).toBe("Synthetic System A");
    expect(countryLabel("CA-ON", "Ontario")).toBe("Ontario");
  });
});

describe("countryOptions", () => {
  it("groups curricula by region (case-insensitive), sorts by label and is stable", () => {
    const options = countryOptions([uk, ontario, intl, bc]);
    expect(options).toEqual([
      { value: "CA", label: "Canada" },
      { value: "GB", label: "United Kingdom" },
      { value: "INT", label: "International" },
    ].sort((a, b) => a.label.localeCompare(b.label)));
    expect(countryOptions([bc, intl, ontario, uk])).toEqual(options);
  });
  it("is empty without curricula", () => {
    expect(countryOptions([])).toEqual([]);
  });
});

describe("curriculaForCountry", () => {
  it("keeps only the curricula of that country", () => {
    expect(curriculaForCountry([ontario, bc, uk], "CA").map((c) => c.id)).toEqual(["on", "bc"]);
    expect(curriculaForCountry([ontario, uk], "FR")).toEqual([]);
  });
});

describe("resolveCountry", () => {
  const many = [ontario, bc, uk];
  it("single country: auto-selects it, shows no step, and ignores nothing valid", () => {
    expect(resolveCountry({ curricula: [ontario, bc], params: {} })).toEqual({ ok: true, country: "CA", showStep: false });
    expect(resolveCountry({ curricula: [ontario, bc], params: { v: "bc@1" } })).toEqual({ ok: true, country: "CA", showStep: false });
    expect(resolveCountry({ curricula: [ontario], params: { country: "ca" } })).toEqual({ ok: true, country: "CA", showStep: false });
  });
  it("several countries: shows the step and starts empty", () => {
    expect(resolveCountry({ curricula: many, params: {} })).toEqual({ ok: true, country: undefined, showStep: true });
  });
  it("keeps a valid country, and derives it from the version (also an older version)", () => {
    expect(resolveCountry({ curricula: many, params: { country: "GB" } })).toEqual({ ok: true, country: "GB", showStep: true });
    expect(resolveCountry({ curricula: many, params: { v: "gcse@1" } })).toEqual({ ok: true, country: "GB", showStep: true });
    expect(resolveCountry({ curricula: many, params: { v: "bc@1" } })).toEqual({ ok: true, country: "CA", showStep: true });
  });
  it("rejects an unknown country, or a version that is not in the chosen country", () => {
    expect(resolveCountry({ curricula: many, params: { country: "FR" } })).toEqual({ ok: false });
    expect(resolveCountry({ curricula: [ontario], params: { country: "FR" } })).toEqual({ ok: false });
    expect(resolveCountry({ curricula: many, params: { country: "GB", v: "on@1" } })).toEqual({ ok: false });
  });
  it("leaves an unknown version to the normal curriculum lookup", () => {
    expect(resolveCountry({ curricula: many, params: { v: "nope" } })).toEqual({ ok: true, country: undefined, showStep: true });
  });
});

describe("country field", () => {
  const many = [ontario, bc, uk];
  const base = { steps: allSteps, stepOptions: {} };
  it("is absent when the step is hidden", () => {
    expect(buildSelectFields({ curricula: many, params: {}, ...base, country: { showStep: false, country: "CA" } }).map((f) => f.key)).toEqual(["v", "level", "course", "unit", "topic"]);
  });
  it("comes first, and the curriculum list is filtered to it and disabled until a country is chosen", () => {
    const none = buildSelectFields({ curricula: many, params: {}, ...base, country: { showStep: true, country: undefined } });
    expect(none.map((f) => f.key)).toEqual(["country", "v", "level", "course", "unit", "topic"]);
    expect(none[0]).toMatchObject({ label: "Country", placeholder: "Choose a country", value: "", disabled: false });
    expect(none[0]!.options.map((o) => o.label)).toEqual(["Canada", "United Kingdom"]);
    expect(none[1]!.disabled).toBe(true);
    expect(none[1]!.options).toEqual([]);
    const ca = buildSelectFields({ curricula: many, params: { country: "CA" }, ...base, country: { showStep: true, country: "CA" } });
    expect(ca[0]!.value).toBe("CA");
    expect(ca[1]!.disabled).toBe(false);
    expect(ca[1]!.options.map((o) => o.label)).toEqual(["Ontario Math", "BC Math"]);
  });
});

describe("country in the URL cascade", () => {
  it("changing the country clears everything after it", () => {
    expect(selectionHref({ country: "CA", ...full }, "country", "GB")).toBe("/prepare?country=GB");
    expect(selectionHref({ country: "CA", ...full }, "v", "b")).toBe("/prepare?country=CA&v=b");
    expect(selectionHref({ country: "CA", ...full }, "country", "")).toBe("/prepare");
  });
});

describe("readPrepareParams", () => {
  it("reads country like the other params and ignores unusable values", () => {
    expect(readPrepareParams({ country: "CA", v: "x" })).toMatchObject({ country: "CA", v: "x" });
    expect(readPrepareParams({ country: ["CA", "GB"] }).country).toBeUndefined();
    expect(readPrepareParams({ country: "x".repeat(201) }).country).toBeUndefined();
  });
});
