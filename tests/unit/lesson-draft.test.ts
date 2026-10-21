import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LessonDraft } from "@/components/app/lesson-draft";
import { Math as MathView } from "@/components/app/math";
import { htmlDocument, type HtmlDocument } from "@/lib/package/html-view";
import { testPackage } from "../fixtures/package";

const pkg = testPackage();
const render = (doc: HtmlDocument) => renderToStaticMarkup(createElement(LessonDraft, { doc }));
const notes = htmlDocument(pkg, "notes");
const worksheet = htmlDocument(pkg, "worksheet");
const solutions = htmlDocument(pkg, "solutions");

describe("LessonDraft", () => {
  it("is a draft root carrying the document kind, with KaTeX-rendered math", () => {
    const html = render(notes);
    expect(html).toMatch(/<article[^>]*data-testid="lesson-draft"[^>]*data-document="notes"/);
    expect(html).toMatch(/<span class="katex"/);
    expect(html).toMatch(/<h2[^>]*>/);
  });

  it("renders the worksheet without any answer text", () => {
    const stepTexts = solutions.sections
      .flatMap((s) => s.blocks)
      .flatMap((b) => (b.type === "solution" ? b.steps.flatMap((s) => s.parts.filter((p) => p.kind === "text").map((p) => p.value.trim())) : []))
      .filter((t) => t.length > 3);
    expect(stepTexts.length).toBeGreaterThan(0);
    const sheet = render(worksheet);
    const key = render(solutions);
    for (const t of stepTexts) {
      expect(key).toContain(t.replace(/&/g, "&amp;"));
      expect(sheet).not.toContain(t);
    }
    expect(sheet).not.toMatch(/<ol/);
    expect(sheet).toMatch(/data-document="worksheet"/);
  });

  it("escapes hostile text instead of emitting markup", () => {
    const doc: HtmlDocument = structuredClone(notes);
    const blocks = doc.sections.flatMap((s) => s.blocks);
    const p = blocks.find((b) => b.type === "paragraph");
    const l = blocks.find((b) => b.type === "list");
    if (p?.type !== "paragraph" || l?.type !== "list") throw new Error("fixture lacks paragraph or list");
    p.text = "<script>alert(1)</script>";
    l.items[0] = "</li><img src=x onerror=alert(1)>";
    const html = render(doc);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<[^>]*onerror=/);
  });

  it("states alignment in the same words as the PDF and adds no claim for sample data", () => {
    const html = render(notes);
    expect(html).toContain("No curriculum alignment is claimed for this material.");
    expect(html).not.toContain("This lesson addresses objectives");
  });

  it("emits only KaTeX markup through raw HTML", () => {
    for (const d of [notes, worksheet, solutions]) {
      const html = render(d);
      expect(html).not.toMatch(/onerror=|javascript:|<script/);
    }
  });
});

describe("Math", () => {
  it("falls back to escaped <code> when KaTeX refuses the input", () => {
    const html = renderToStaticMarkup(createElement(MathView, { tex: "\\href{javascript:alert(1)}{x}", mode: "inline" }));
    expect(html).toMatch(/<code>/);
    expect(html).not.toMatch(/<a /);
    expect(html).not.toContain('class="katex"');
  });

  it("renders valid TeX through KaTeX in display mode", () => {
    const html = renderToStaticMarkup(createElement(MathView, { tex: "x+1=2", mode: "display" }));
    expect(html).toMatch(/class="katex-display"/);
  });
});
