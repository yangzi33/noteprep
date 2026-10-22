import { describe, expect, it } from "vitest";
import type { SelectionOption, SelectionStep } from "@/lib/server/dal/curriculum";
import { buildSelectFields, datasetBanner, changeSelection, selectionHref } from "@/lib/ui/prepare-view";

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
