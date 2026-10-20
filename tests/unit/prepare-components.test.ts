import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GenerateButtonView } from "@/components/app/generate-button";
import { PackageOption } from "@/components/app/package-option";
import { StepIndicator } from "@/components/app/step-indicator";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("StepIndicator", () => {
  const html = render(createElement(StepIndicator, { steps: ["Select", "Generate", "Refine", "Export"], current: 1 }));
  it("renders a labelled list with one item per step", () => {
    expect(html).toMatch(/<ol[^>]*aria-label="Progress"/);
    expect(html.match(/<li[ >]/g)).toHaveLength(4);
  });
  it("marks only the current step", () => {
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/<li[^>]*aria-current="step"[^>]*>2 Generate<\/li>/);
  });
  it("is not navigation", () => {
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
  });
});

describe("PackageOption", () => {
  const props = { id: "doc-notes", name: "documents", value: "notes", label: "Tutor Lesson Notes", description: "For you" };
  const html = render(createElement(PackageOption, { ...props, defaultChecked: true }));
  it("renders a native checkbox with name and value", () => {
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toMatch(/<input[^>]*name="documents"/);
    expect(html).toMatch(/<input[^>]*value="notes"/);
  });
  it("labels the input with exactly the label text", () => {
    expect(html).toMatch(/<input[^>]*id="doc-notes"/);
    expect(html).toMatch(/<label[^>]*for="doc-notes"[^>]*>Tutor Lesson Notes<\/label>/);
  });
  it("describes the input by the description element", () => {
    expect(html).toMatch(/<input[^>]*aria-describedby="doc-notes-desc"/);
    expect(html).toMatch(/<p[^>]*id="doc-notes-desc"[^>]*>For you<\/p>/);
  });
  it("stacks the real checkbox above the label overlay", () => {
    expect(html).toMatch(/<input[^>]*class="[^"]*\brelative\b[^"]*"/);
    expect(html).toMatch(/<input[^>]*class="[^"]*\bz-10\b/);
  });
  it("honours defaultChecked and disabled", () => {
    expect(html).toMatch(/<input[^>]*checked=""/);
    const plain = render(createElement(PackageOption, props));
    expect(plain).not.toMatch(/<input[^>]*checked/);
    expect(plain).not.toMatch(/<input[^>]*disabled/);
    expect(render(createElement(PackageOption, { ...props, disabled: true }))).toMatch(/<input[^>]*disabled=""/);
  });
});

describe("GenerateButtonView", () => {
  const view = (props: { exhausted: boolean; pending: boolean }) => render(createElement(GenerateButtonView, props));
  it("is an enabled submit button with the exact text", () => {
    const html = view({ exhausted: false, pending: false });
    expect(html).toMatch(/<button[^>]*\stype="submit"[^>]*>Generate lesson<\/button>/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).not.toMatch(/aria-busy/);
  });
  it("is disabled when the allowance is exhausted", () => {
    expect(view({ exhausted: true, pending: false })).toMatch(/<button[^>]*\sdisabled=""/);
  });
  it("is disabled and busy while a selection navigation is pending", () => {
    const html = view({ exhausted: false, pending: true });
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toMatch(/<button[^>]*\saria-busy="true"/);
  });
});
