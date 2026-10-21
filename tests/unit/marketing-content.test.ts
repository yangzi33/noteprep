import { describe, expect, it } from "vitest";
import { landingContent } from "@/lib/marketing/content";

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("landing content", () => {
  const all = strings(landingContent);

  it("contains no forbidden claims, prices or .tex offers", () => {
    const forbidden = /zero errors|error[- ]free|guarantee|certified|complian|£|\$\d|€|\.tex\b/i;
    for (const s of all) expect(s, s).not.toMatch(forbidden);
  });

  it("does not promise student accounts, live teaching or team features", () => {
    const out = /student account|live teaching|team plan|studio|testimonial/i;
    for (const s of all) expect(s, s).not.toMatch(out);
  });

  it("tells tutors to review AI-assisted material before teaching", () => {
    expect(all.some((s) => /review/i.test(s) && /AI-assisted/i.test(s) && /before teaching/i.test(s))).toBe(true);
  });

  it("states that subscriptions are not available yet and has one subscription card", () => {
    expect(landingContent.pricing.subscription.note).toMatch(/not available yet/);
    expect(landingContent.pricing.free.title).toMatch(/free/i);
    expect(landingContent.pricing.free.points.join(" ")).toMatch(/3/);
  });

  it("has three benefits, four steps and the three documents", () => {
    expect(landingContent.benefits).toHaveLength(3);
    expect(landingContent.steps).toHaveLength(4);
    expect(landingContent.documents.map((d) => d.name)).toEqual([
      "Tutor Lesson Notes",
      "Student Practice Worksheet",
      "Solutions / Answer Key",
    ]);
  });
});
