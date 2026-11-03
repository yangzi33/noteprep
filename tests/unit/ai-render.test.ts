import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/domain/hash";
import { RENDER_VERSION, renderForExport } from "@/lib/domain/export-spec";
import { RenderError } from "@/lib/latex/escape";
import { renderDocument, TEMPLATE_VERSION } from "@/lib/latex/render";
import { htmlDocument } from "@/lib/package/html-view";
import { aiTestPackage } from "../fixtures/ai-package";
import { testPackage } from "../fixtures/package";

const MARK = "\\textbf{*}";
const ITEM_MARK = "\\textbf{*}\\quad";
const LEGEND = "Marked items are AI-generated and were not checked by code";
const count = (s: string, needle: string) => s.split(needle).length - 1;
const texOf = (pkg: ReturnType<typeof aiTestPackage>["pkg"], doc: "notes" | "worksheet" | "solutions") => renderDocument(pkg, doc).tex;

describe("TeX for model items", () => {
  it("marks only the items not checked by code, in the Solutions (the Notes example is code-checked)", () => {
    const { pkg } = aiTestPackage();
    expect(count(texOf(pkg, "solutions"), ITEM_MARK)).toBe(1);
    expect(count(texOf(pkg, "notes"), ITEM_MARK)).toBe(0);
  });

  it("puts a one-line legend in a document that has a marked item, never in the worksheet", () => {
    const { pkg } = aiTestPackage();
    expect(texOf(pkg, "solutions")).toContain(LEGEND);
    expect(texOf(pkg, "notes")).not.toContain(LEGEND);
    expect(texOf(pkg, "worksheet")).not.toContain(LEGEND);
    expect(count(texOf(pkg, "solutions"), LEGEND)).toBe(1);
  });

  it("the worksheet has no marker and no answer or steps", () => {
    const { pkg, items } = aiTestPackage();
    const worksheet = texOf(pkg, "worksheet");
    expect(worksheet).not.toContain(MARK);
    expect(worksheet).not.toContain("\\answerline");
    expect(worksheet).toContain("2x+3=11");
    expect(worksheet).not.toContain("x=4");
    expect(worksheet).not.toContain("commutative");
    expect(items.unchecked.status).toBe("unchecked");
  });

  it("the solutions document pairs each answer with its own question text", () => {
    const { pkg } = aiTestPackage();
    const solutions = texOf(pkg, "solutions");
    const first = solutions.indexOf("2x+3=11");
    const answer = solutions.indexOf("x=4", first);
    const second = solutions.indexOf("5x-2=13");
    expect(first).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(answer);
  });

  it("refuses an answer whose item hash is not its question's", () => {
    const { pkg } = aiTestPackage();
    const broken = JSON.parse(JSON.stringify(pkg)) as typeof pkg;
    for (const s of broken.sections) for (const b of s.blocks as { type: string; questionId?: string; itemHash?: string }[]) if (b.type === "ai_solution" && b.questionId === "ex-1") b.itemHash = "f".repeat(64);
    expect(() => renderDocument(broken, "solutions")).toThrow(RenderError);
  });

  it("renders only from the AST: a hostile source never reaches the output as a command", () => {
    const { pkg } = aiTestPackage();
    for (const doc of ["notes", "worksheet", "solutions"] as const) {
      const tex = texOf(pkg, doc);
      expect(tex).not.toContain("\\input");
      expect(tex).not.toContain("<script");
    }
  });

  it("changing a stored status changes the export identity (the marker is part of what is exported)", () => {
    const { pkg } = aiTestPackage();
    const before = renderForExport(pkg);
    const flipped = JSON.parse(JSON.stringify(pkg)) as typeof pkg;
    for (const s of flipped.sections) for (const b of s.blocks as { type: string; questionId?: string; status?: string }[]) if (b.questionId === "ex-2" && b.status) b.status = "cross_checked";
    // cross_checked is still marked (second label), so the exported source is the same
    expect(renderForExport(flipped)).toEqual(before);
    for (const s of flipped.sections) for (const b of s.blocks as { type: string; questionId?: string; status?: string }[]) if (b.questionId === "ex-2" && b.status) b.status = "code_checked";
    expect(renderForExport(flipped).solutions).not.toBe(before.solutions);
  });
});

describe("deterministic packs are unchanged", () => {
  it("a /1 package has no marker, no legend, and the same golden hashes", () => {
    const pkg = testPackage();
    for (const doc of ["notes", "worksheet", "solutions"] as const) {
      const tex = renderDocument(pkg, doc).tex;
      expect(tex).not.toContain(LEGEND);
      expect(tex).not.toContain(MARK);
    }
    expect([TEMPLATE_VERSION, RENDER_VERSION]).toEqual(["classic/2", "render/1"]);
    expect(sha256Hex(renderDocument(pkg, "notes").tex)).toBe("98f31213827c7b6fb10800d9db7a05507fdef26f801ede4dbcd1b1713674f0ed");
  });
});

describe("HTML preview labels", () => {
  it("shows the two labels from the same statuses and never an answer before the answer key", () => {
    const { pkg } = aiTestPackage();
    const labels = (id: "notes" | "worksheet" | "solutions") =>
      htmlDocument(pkg, id).sections.flatMap((sec) => sec.blocks.flatMap((b) => (b.type === "ai_question" || b.type === "ai_solution" || b.type === "ai_worked" ? [b.label] : [])));
    expect(labels("solutions")).toEqual(["checked", "review", "checked"]);
    expect(labels("notes")).toEqual(["checked"]);
    expect(JSON.stringify(htmlDocument(pkg, "worksheet"))).not.toContain("commutative");
    expect(htmlDocument(pkg, "worksheet").sections.flatMap((sec) => sec.blocks).some((b) => b.type === "ai_solution" || b.type === "ai_worked")).toBe(false);
  });
});
