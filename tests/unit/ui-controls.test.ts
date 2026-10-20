import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CheckboxRow } from "@/components/ui/checkbox-row";
import { SelectionFields } from "@/components/app/selection-fields";
import { SelectField } from "@/components/ui/select-field";
import type { SelectFieldView } from "@/lib/ui/prepare-view";
import { TextAction } from "@/components/ui/text-action";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
];

describe("SelectField", () => {
  it("renders a native select whose id matches the label for", () => {
    const html = render(createElement(SelectField, { label: "Level", name: "level", options }));
    expect(html).toContain("<select");
    const forId = /<label[^>]*\sfor="([^"]+)"/.exec(html)?.[1];
    const selectId = /<select[^>]*\sid="([^"]+)"/.exec(html)?.[1];
    expect(forId).toBeTruthy();
    expect(forId).toBe(selectId);
    expect(html).toMatch(/<select[^>]*\sname="level"/);
  });
  it("marks only disabled options as disabled", () => {
    const html = render(createElement(SelectField, { label: "L", name: "l", options }));
    expect(html).toMatch(/<option[^>]*\sdisabled=""[^>]*>Beta</);
    expect(html).not.toMatch(/<option[^>]*\sdisabled=""[^>]*>Alpha</);
  });
  it("points aria-describedby at the hint", () => {
    const html = render(createElement(SelectField, { label: "L", name: "l", options, hint: "hintText" }));
    const describedBy = /<select[^>]*\saria-describedby="([^"]+)"/.exec(html)?.[1];
    const hintId = /<p[^>]*\sid="([^"]+)"[^>]*>hintText</.exec(html)?.[1];
    expect(hintId).toBeTruthy();
    expect(describedBy).toBe(hintId);
    expect(html).not.toMatch(/<select[^>]*\saria-invalid/);
  });
  it("marks the error and references it (after the hint)", () => {
    const html = render(createElement(SelectField, { label: "L", name: "l", options, hint: "hintText", error: "errText" }));
    expect(html).toMatch(/<select[^>]*\saria-invalid="true"/);
    const describedBy = /<select[^>]*\saria-describedby="([^"]+)"/.exec(html)?.[1] ?? "";
    const hintId = /<p[^>]*\sid="([^"]+)"[^>]*>hintText</.exec(html)?.[1];
    const errorId = /<p[^>]*\sid="([^"]+)"[^>]*>errText</.exec(html)?.[1];
    expect(errorId).toBeTruthy();
    expect(describedBy.split(" ")).toContain(errorId);
    expect(describedBy).toBe(`${hintId} ${errorId}`);
  });
  it("selects the defaultValue option", () => {
    const html = render(createElement(SelectField, { label: "L", name: "l", options, defaultValue: "a" }));
    expect(html).toMatch(/<option[^>]*\sselected=""[^>]*>Alpha</);
    expect(html).not.toMatch(/<option[^>]*\sselected=""[^>]*>Beta</);
  });
});

describe("CheckboxRow", () => {
  it("wraps a native checkbox and its label text in one label", () => {
    const html = render(createElement(CheckboxRow, { name: "documents", value: "notes", label: "Tutor Lesson Notes", defaultChecked: true }));
    expect(html).toMatch(/<label[^>]*>\s*<input[^>]*type="checkbox"[\s\S]*Tutor Lesson Notes[\s\S]*<\/label>/);
    expect(html).toMatch(/<input[^>]*\sname="documents"/);
    expect(html).toMatch(/<input[^>]*\svalue="notes"/);
    expect(html).toMatch(/<input[^>]*\schecked=""/);
  });
  it("is unchecked and enabled by default", () => {
    const html = render(createElement(CheckboxRow, { name: "d", label: "X" }));
    expect(html).not.toMatch(/<input[^>]*\schecked=""/);
    expect(html).not.toMatch(/<input[^>]*\sdisabled=""/);
  });
  it("renders disabled on the input", () => {
    const html = render(createElement(CheckboxRow, { name: "d", label: "X", disabled: true }));
    expect(html).toMatch(/<input[^>]*\sdisabled=""/);
  });
});

describe("TextAction", () => {
  it("renders a link when href is given", () => {
    const html = render(createElement(TextAction, { href: "/x" }, "Go"));
    expect(html).toMatch(/^<a[^>]*\shref="\/x"/);
    expect(html).toMatch(/<a[^>]*class="[^"]*min-h-11/);
  });
  it("renders a type=button button without href", () => {
    const html = render(createElement(TextAction, null, "Go"));
    expect(html).toMatch(/^<button[^>]*\stype="button"/);
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-11/);
  });
  it("lets the caller override button type", () => {
    const html = render(createElement(TextAction, { type: "submit" }, "Go"));
    expect(html).toMatch(/<button[^>]*\stype="submit"/);
    expect(html).not.toMatch(/type="button"/);
  });
  it("renders the icon before the text in an aria-hidden container", () => {
    const html = render(createElement(TextAction, { icon: createElement("i", null, "ICON") }, "Label"));
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*><i>ICON<\/i><\/span>/);
    expect(html.indexOf("ICON")).toBeLessThan(html.indexOf("Label"));
  });
});

describe("SelectField disabled/placeholder/testId", () => {
  it("renders a real disabled attribute on the select only when disabled", () => {
    const on = render(createElement(SelectField, { label: "L", name: "l", options, disabled: true }));
    expect(on).toMatch(/<select[^>]*\sdisabled=""/);
    const off = render(createElement(SelectField, { label: "L", name: "l", options }));
    expect(off).not.toMatch(/<select[^>]*\sdisabled=""/);
  });
  it("renders an enabled placeholder option first", () => {
    const html = render(createElement(SelectField, { label: "L", name: "l", options, placeholder: "Choose a topic" }));
    expect(html).toMatch(/<option[^>]*\svalue=""[^>]*>Choose a topic<\/option>/);
    expect(html).not.toMatch(/<option[^>]*\sdisabled=""[^>]*>Choose a topic</);
    expect(html.indexOf("Choose a topic")).toBeLessThan(html.indexOf("Alpha"));
  });
  it("has no placeholder option when none is given", () => {
    const html = render(createElement(SelectField, { label: "L", name: "l", options }));
    expect(html).not.toMatch(/<option[^>]*\svalue=""/);
  });
  it("renders data-testid on the select only when given", () => {
    const on = render(createElement(SelectField, { label: "L", name: "l", options, testId: "select-x" }));
    expect(on).toMatch(/<select[^>]*\sdata-testid="select-x"/);
    const off = render(createElement(SelectField, { label: "L", name: "l", options }));
    expect(off).not.toMatch(/data-testid/);
  });
});

describe("SelectionFields", () => {
  const fields: SelectFieldView[] = [
    {
      key: "v",
      label: "Curriculum",
      value: "ver2",
      options: [
        { value: "ver1", label: "One", disabled: false },
        { value: "ver2", label: "Two", disabled: false },
      ],
      disabled: false,
      placeholder: "Choose a curriculum",
    },
    { key: "course", label: "Course", value: "", options: [], disabled: true, placeholder: "Choose a course" },
  ];
  it("renders a container with one select per field and real disabled only on the disabled one", () => {
    const html = render(createElement(SelectionFields, { fields, params: { v: "ver2" } }));
    expect(html).toMatch(/<div[^>]*\sdata-testid="selection-fields"/);
    expect(html.match(/<select/g)?.length).toBe(2);
    expect(html).toMatch(/<select[^>]*\sdata-testid="select-course"[^>]*\sdisabled=""|<select[^>]*\sdisabled=""[^>]*\sdata-testid="select-course"/);
    expect(html).not.toMatch(/<select[^>]*\sdata-testid="select-v"[^>]*\sdisabled=""/);
    expect(html).not.toMatch(/<select[^>]*\sdisabled=""[^>]*\sdata-testid="select-v"/);
  });
  it("selects the option matching the field value", () => {
    const html = render(createElement(SelectionFields, { fields, params: { v: "ver2" } }));
    expect(html).toMatch(/<option[^>]*\sselected=""[^>]*>Two</);
    expect(html).not.toMatch(/<option[^>]*\sselected=""[^>]*>One</);
  });
  it("uses 3 columns with a level field and 2 without", () => {
    const withLevel: SelectFieldView[] = [
      fields[0]!,
      { key: "level", label: "Level", value: "", options: [], disabled: true, placeholder: "Choose a level" },
      fields[1]!,
    ];
    expect(render(createElement(SelectionFields, { fields: withLevel, params: {} }))).toContain("sm:grid-cols-3");
    const without = render(createElement(SelectionFields, { fields, params: {} }));
    expect(without).toContain("sm:grid-cols-2");
    expect(without).not.toContain("sm:grid-cols-3");
  });
});
