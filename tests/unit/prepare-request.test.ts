import { describe, expect, it } from "vitest";
import { normalizeJobInput } from "@/lib/domain/job-input";
import { requestHash } from "@/lib/domain/hash";
import { parseLessonRequest } from "@/lib/domain/lesson-request";
import { prepareHref, readPrepareParams, upTo } from "@/lib/ui/prepare-url";

const v1 = { topic: "linear_equations_one_variable", level: "Grade 7-8 equivalent", objectives: ["Solve ax + b = c"], durationMinutes: 60, difficulty: "mixed", questionCount: 5, notes: "" };
const v2 = {
  requestVersion: 2,
  curriculum: { versionId: "v@1", topicId: "v@1/t" },
  durationMinutes: 60,
  difficulty: "mixed",
  documents: ["notes", "worksheet", "solutions"],
  templateId: "classic",
  locale: "en",
};

describe("parseLessonRequest", () => {
  it("treats a request as v2 only when it says so, and otherwise requires a valid v1", () => {
    expect(parseLessonRequest(v2).version).toBe(2);
    expect(parseLessonRequest(v1).version).toBe(1);
    expect(() => parseLessonRequest({ ...v1, requestVersion: 1 })).toThrow(); // not a v1 request and not a valid v2 one
    expect(() => parseLessonRequest(null)).toThrow();
    expect(() => parseLessonRequest("x")).toThrow();
  });
  it("a malformed v2 request never falls through as v1", () => {
    expect(() => parseLessonRequest({ ...v1, requestVersion: 2 })).toThrow();
    expect(() => parseLessonRequest({ ...v2, curriculum: {} })).toThrow();
  });
  it("rejects extra and out-of-range fields, including any free text", () => {
    for (const bad of [{ ...v2, notes: "hi" }, { ...v2, durationMinutes: 14 }, { ...v2, durationMinutes: 181 }, { ...v2, durationMinutes: 60.5 }, { ...v2, documents: ["notes", "notes"] }, { ...v2, documents: ["tex"] }, { ...v2, templateId: "x" }, { ...v2, locale: "fr" }]) {
      expect(() => parseLessonRequest(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("canonical set-valued fields", () => {
  const hashOf = (raw: unknown) => {
    const parsed = parseLessonRequest(raw);
    return requestHash("generate", 2, parsed.input);
  };
  it("orders documents canonically, so the same set in any order is the same request", () => {
    const a = parseLessonRequest({ ...v2, documents: ["solutions", "notes", "worksheet"] });
    const b = parseLessonRequest({ ...v2, documents: ["worksheet", "solutions", "notes"] });
    expect(a.input).toEqual(b.input);
    expect((a.input as { documents: string[] }).documents).toEqual(["notes", "worksheet", "solutions"]);
    expect(hashOf({ ...v2, documents: ["worksheet", "notes"] })).toBe(hashOf({ ...v2, documents: ["notes", "worksheet"] }));
    expect(hashOf({ ...v2, documents: ["notes"] })).not.toBe(hashOf({ ...v2, documents: ["notes", "worksheet"] }));
  });
  it("sorts objectiveIds, so the same set in any order is the same request", () => {
    expect(hashOf({ ...v2, objectiveIds: ["b", "a", "c"] })).toBe(hashOf({ ...v2, objectiveIds: ["c", "a", "b"] }));
    expect((parseLessonRequest({ ...v2, objectiveIds: ["b", "a"] }).input as { objectiveIds: string[] }).objectiveIds).toEqual(["a", "b"]);
    expect(hashOf({ ...v2, objectiveIds: ["a"] })).not.toBe(hashOf({ ...v2, objectiveIds: ["a", "b"] }));
  });
  it("rejects duplicates in objectiveIds and in documents instead of collapsing them", () => {
    expect(() => parseLessonRequest({ ...v2, objectiveIds: ["a", "a"] })).toThrow(/objectiveIds must not repeat/);
    expect(() => parseLessonRequest({ ...v2, documents: ["notes", "notes"] })).toThrow(/documents must not repeat/);
  });
});

describe("normalizeJobInput", () => {
  it("maps a v1 input unchanged", () => {
    expect(normalizeJobInput(v1)).toEqual({ topic: v1.topic, level: v1.level, objectives: v1.objectives, difficulty: "mixed", durationMinutes: 60 });
  });
  it("derives the pipeline input of a v2 job from its stored context", () => {
    const context = { contextHash: "sha256:x", topic: { id: "t", title: "Topic" }, level: { id: "l", label: "Level A" }, course: { id: "c", code: "C", title: "Course" }, objectives: [{ label: "Objective one" }] };
    const input = normalizeJobInput({ requestVersion: 2, request: v2, context });
    expect(input).toMatchObject({ topic: "Topic", level: "Level A", objectives: ["Objective one"], difficulty: "mixed", durationMinutes: 60 });
    expect(input.context?.contextHash).toBe("sha256:x"); // the snapshot travels with the input
    const noLevel = normalizeJobInput({ requestVersion: 2, request: v2, context: { ...context, level: null } });
    expect(noLevel.level).toBe("Course");
  });
  it("refuses a stored v2 input whose context has no hash, even if everything else is present", () => {
    const complete = { topic: { id: "t", title: "Topic" }, level: null, course: { id: "c", code: "C", title: "Course" }, objectives: [{ label: "Objective one" }] };
    expect(() => normalizeJobInput({ requestVersion: 2, request: v2, context: complete })).toThrow();
    expect(() => normalizeJobInput({ requestVersion: 2, request: v2, context: { ...complete, contextHash: "sha256:x" } })).not.toThrow();
  });
});

describe("prepare URL state", () => {
  it("round-trips only known params and omits empty ones", () => {
    expect(prepareHref()).toBe("/prepare");
    expect(prepareHref({ v: "a@1", level: "l" })).toBe("/prepare?v=a%401&level=l");
    expect(readPrepareParams({ v: "a@1", level: ["x", "y"], evil: "1", topic: "" })).toEqual({ v: "a@1", level: undefined, course: undefined, unit: undefined, topic: undefined, error: undefined });
  });
  it("ignores absurdly long values", () => {
    expect(readPrepareParams({ v: "x".repeat(201) }).v).toBeUndefined();
  });
  it("changing an earlier step drops every later choice", () => {
    const all = { v: "v", level: "l", course: "c", unit: "u", topic: "t" };
    expect(upTo(all, "course")).toEqual({ v: "v", level: "l", course: "c" });
    expect(upTo(all, "v")).toEqual({ v: "v" });
  });
});
