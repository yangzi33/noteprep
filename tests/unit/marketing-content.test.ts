import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingFooter, LandingPage } from "@/components/marketing/landing-page";
import { PricingSection } from "@/components/marketing/sections";
import { landingContent } from "@/lib/marketing/content";

const FORBIDDEN =
  /zero errors|error[- ]free|errorless|flawless|guarantee|perfectly accurate|100\s?%|no mistakes|always correct|certif|accredit|complian|curriculum-aligned|aligned to|students can log in|team workspace|schedul|trusted by|save \d+ hours|\b(USD|GBP|CAD|EUR)\b|£|€|\$\s?\d|\d\s*\/\s*(month|mo)\b|\.tex\b/i;
const NOT_YET_BUILT = /quick adjust|adjustments|correct a line|easier|harder|more practice|in minutes/i;

function visibleText(html: string): string[] {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .split(/<[^>]+>/)
    .map((t) => t.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("landing content", () => {
  const all = strings(landingContent);

  it("contains no forbidden claims, prices or .tex offers", () => {
    for (const s of all) expect(s, s).not.toMatch(FORBIDDEN);
  });

  it("does not advertise adjustments or corrections that do not exist yet", () => {
    for (const s of all) expect(s, s).not.toMatch(NOT_YET_BUILT);
  });

  it("rendered landing text (including strings hard-coded in components) has no forbidden claims", () => {
    const html = renderToStaticMarkup(createElement(LandingPage)) + renderToStaticMarkup(createElement(LandingFooter));
    const text = visibleText(html);
    expect(text.length).toBeGreaterThan(30);
    for (const t of text) {
      expect(t, t).not.toMatch(FORBIDDEN);
      expect(t, t).not.toMatch(NOT_YET_BUILT);
    }
  });

  it("pricing shows exactly two plan cards and no amounts", () => {
    const html = renderToStaticMarkup(createElement(PricingSection));
    expect(html.match(/<h3[ >]/g)).toHaveLength(2);
    expect(visibleText(html).join(" ")).not.toMatch(/\d\s*[£€$]|[£€$]\s*\d|\d+\s*(usd|gbp|cad|eur)/i);
  });

  it("does not carry over placeholder or unsupported design copy", () => {
    const text = renderToStaticMarkup(createElement(LandingPage)) + renderToStaticMarkup(createElement(LandingFooter));
    expect([...all, ...visibleText(text)].join("\n")).not.toMatch(/quiz|graph|Jane Doe|Grade 12|Ontario|Derivative|worksheets, |save hours|share my|edit the wording|Refine/i);
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
    expect(landingContent.benefits.items).toHaveLength(3);
    expect(landingContent.steps).toHaveLength(4);
    expect(landingContent.documents.map((d) => d.pdf)).toEqual(["/samples/notes.pdf", "/samples/worksheet.pdf", "/samples/solutions.pdf"]);
    expect(landingContent.nav.map((n) => n.href)).toEqual(["#features", "#how-it-works", "#pricing"]);
    expect(landingContent.documents.map((d) => d.name)).toEqual([
      "Tutor Lesson Notes",
      "Student Practice Worksheet",
      "Solutions / Answer Key",
    ]);
  });
});
