import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LessonDraft } from "@/components/app/lesson-draft";
import { MathView } from "@/components/app/math";
import { htmlDocument, type HtmlBlock, type HtmlDocument } from "@/lib/package/html-view";
import { testPackage } from "../fixtures/package";

type Alignment = Extract<HtmlBlock, { type: "alignment" }>;

const HOSTILE = '"><img src=x onerror=alert(1)><script>alert(2)</script> javascript:alert(3) $\\input{/etc/passwd}$ $x+1$';
const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const aligned: Alignment = {
  type: "alignment",
  claim: "aligned",
  curriculumName: "Test Curriculum",
  versionLabel: "v1",
  datasetKind: "real",
  objectives: [
    { officialCode: "A1.1", label: "Solve linear equations", partial: false, note: null },
    { officialCode: null, label: "Model situations", partial: true, note: "only one step" },
  ],
};

// Replaces every alignment block (adding one to the first section when the document has none).
function withAlignment(doc: HtmlDocument, block: Alignment): HtmlDocument {
  const copy = structuredClone(doc);
  let found = false;
  for (const s of copy.sections)
    s.blocks = s.blocks.map((b) => {
      if (b.type !== "alignment") return b;
      found = true;
      return structuredClone(block);
    });
  if (!found) copy.sections[0]!.blocks.push(structuredClone(block));
  return copy;
}

function hostileCopy(base: HtmlDocument): HtmlDocument {
  const doc = withAlignment(base, {
    ...aligned,
    curriculumName: HOSTILE,
    versionLabel: HOSTILE,
    objectives: [{ officialCode: HOSTILE, label: HOSTILE, partial: true, note: HOSTILE }],
  });
  doc.title = HOSTILE;
  doc.subtitle = HOSTILE;
  doc.meta = HOSTILE;
  const done = new Set<string>();
  const first = (kind: string) => !done.has(kind) && done.add(kind);
  const titled = doc.sections.find((s) => s.kind !== "alignment");
  if (titled) titled.title = HOSTILE;
  for (const b of doc.sections.flatMap((s) => s.blocks)) {
    if ((b.type === "paragraph" || b.type === "note") && first(b.type)) b.text = HOSTILE;
    if ((b.type === "list" || b.type === "steps") && first(b.type) && b.items.length > 0) b.items[0] = HOSTILE;
    if (b.type === "timing" && first(b.type) && b.items.length > 0) b.items[0]!.label = HOSTILE;
  }
  return doc;
}

// Math nodes the draft typesets: only tex fields and "math" inline parts, never $..$ inside plain text.
function mathNodeCount(doc: HtmlDocument): number {
  let n = 0;
  const parts = (ps: { kind: string }[]) => ps.filter((p) => p.kind === "math").length;
  for (const b of doc.sections.flatMap((s) => s.blocks)) {
    if (b.type === "question") n += 2;
    if (b.type === "worked" || b.type === "solution") {
      n += (b.type === "worked" ? 2 : 1) + parts(b.answer);
      for (const st of b.steps) n += 1 + parts(st.parts);
    }
  }
  return n;
}

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

  it("never emits markup from hostile text in any document, and does not typeset $..$ found in text", () => {
    for (const base of [notes, worksheet, solutions]) {
      const doc = hostileCopy(base);
      const html = render(doc);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;img");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toMatch(/<[^>]*onerror=/);
      expect(html.match(/onerror=/g)?.length).toBe(html.match(/&lt;img src=x onerror=/g)?.length);
      expect(html.match(/class="katex"/g)?.length ?? 0).toBe(mathNodeCount(doc));
      expect(html).not.toContain("<h1");
      expect(html).not.toContain("<a ");
    }
  });

  it("labels every answer line like the PDF does", () => {
    for (const doc of [notes, solutions]) {
      const blocks = doc.sections.flatMap((s) => s.blocks);
      const answered = blocks.filter((b) => (doc.document === "notes" ? b.type === "worked" : b.type === "solution"));
      expect(answered.length).toBeGreaterThan(0);
      const html = render(doc);
      expect(html.match(/<strong>Answer:<\/strong>/g)?.length).toBe(answered.length);
      // Each label is directly followed by the answer's own content (math answers are KaTeX nodes).
      expect(html.match(/<strong>Answer:<\/strong> <span/g)?.length).toBe(answered.length);
      for (const b of answered) {
        if (b.type !== "worked" && b.type !== "solution") continue;
        const first = b.answer[0]!;
        const start = first.kind === "text" ? `<span>${escapeHtml(first.value)}</span>` : '<span><span class="katex">';
        expect(html).toContain(`<strong>Answer:</strong> ${start}`);
      }
    }
    expect(render(worksheet)).not.toContain("Answer:");
  });

  it("words questions like the PDF: 'Solve for' on worksheet questions and worked examples, not on solutions", () => {
    const count = (html: string) => html.match(/Solve for /g)?.length ?? 0;
    const questions = worksheet.sections.flatMap((s) => s.blocks).filter((b) => b.type === "question").length;
    const worked = notes.sections.flatMap((s) => s.blocks).filter((b) => b.type === "worked").length;
    expect(questions).toBeGreaterThan(0);
    expect(worked).toBeGreaterThan(0);
    expect(count(render(worksheet))).toBe(questions);
    expect(count(render(notes))).toBe(worked);
    expect(render(solutions)).not.toContain("Solve for");
  });

  it("notes: aligned claim lists objectives with codes and partial notes", () => {
    const doc = withAlignment(notes, aligned);
    const html = render(doc);
    expect(html).toContain("This lesson addresses objectives from Test Curriculum (v1):");
    expect(html).toContain("<li>A1.1: Solve linear equations</li>");
    expect(html).toContain("<li>Model situations<em> (partly covered: only one step)</em></li>");
    expect(html).not.toContain("No curriculum alignment is claimed");
  });

  it("notes: no claim says so in full and names the sample origin", () => {
    const html = render(withAlignment(notes, { ...aligned, claim: "none", datasetKind: "sample" }));
    expect(html).toContain(
      "<p>No curriculum alignment is claimed for this material. It was prepared from sample data (Test Curriculum (v1)) that is not a real curriculum.</p>",
    );
  });

  it("notes: a suggested dataset is called an unofficial NotePrep suggestion", () => {
    const html = render(withAlignment(notes, { ...aligned, claim: "none", datasetKind: "suggested", objectives: [] }));
    expect(html).toContain("The topic list comes from an unofficial NotePrep suggestion for Test Curriculum (v1). It is not an official curriculum and is not endorsed by any curriculum authority.");
    expect(html).not.toMatch(/test data|sample data|This lesson addresses/);
  });

  it("worksheet and solutions: compact alignment wording matches the PDF exactly", () => {
    for (const base of [worksheet, solutions]) {
      const yes = render(withAlignment(base, aligned));
      expect(yes).toContain("<p>Curriculum: Test Curriculum (v1).</p>");
      expect(yes).not.toContain("This lesson addresses");
      expect(yes).not.toContain("A1.1");
      const none = render(withAlignment(base, { ...aligned, claim: "none", datasetKind: "sample" }));
      expect(none).toContain("<p>No curriculum alignment is claimed.</p>");
      expect(none).not.toContain("It was prepared from");
      expect(none).not.toContain("for this material");
    }
  });

  it("has no h1 and renders section titles as h2", () => {
    for (const doc of [notes, worksheet, solutions]) {
      const html = render(doc);
      expect(html).not.toContain("<h1");
      const titled = doc.sections.filter((s) => s.kind !== "alignment");
      expect(titled.length).toBeGreaterThan(0);
      for (const s of titled) expect(html).toMatch(new RegExp(`<h2[^>]*>${escapeHtml(s.title)}</h2>`));
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
