import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("Notice", () => {
  it("uses role alert for error", () => {
    expect(render(createElement(Notice, { intent: "error" }, "x"))).toContain('role="alert"');
  });
  it("uses role status for success and progress", () => {
    expect(render(createElement(Notice, { intent: "success" }, "x"))).toContain('role="status"');
    expect(render(createElement(Notice, { intent: "progress" }, "x"))).toContain('role="status"');
  });
  it("uses role note for info", () => {
    expect(render(createElement(Notice, { intent: "info" }, "x"))).toContain('role="note"');
  });
  it("lets the caller override the default role", () => {
    const html = render(createElement(Notice, { intent: "info", role: "status" }, "x"));
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="note"');
  });
  it("passes through data-testid", () => {
    const html = render(createElement(Notice, { intent: "error", "data-testid": "x" } as never, "m"));
    expect(html).toContain('data-testid="x"');
  });
  it("hides the icon from assistive technology", () => {
    expect(render(createElement(Notice, { intent: "error" }, "x"))).toContain('aria-hidden="true"');
  });
  it("spins the progress icon only", () => {
    expect(render(createElement(Notice, { intent: "progress" }, "x"))).toContain("animate-spin");
    expect(render(createElement(Notice, { intent: "info" }, "x"))).not.toContain("animate-spin");
  });
});

describe("Badge", () => {
  it("defaults to the accent tone", () => {
    expect(render(createElement(Badge, null, "x"))).toContain("bg-accent");
  });
  it("supports the neutral tone", () => {
    expect(render(createElement(Badge, { tone: "neutral" }, "x"))).toContain("bg-secondary");
  });
});

describe("Card", () => {
  it("uses the card radius", () => {
    expect(render(createElement(Card, null, "x"))).toContain("rounded-card");
  });
});

describe("Button", () => {
  it("default size is 48px high with the control radius", () => {
    const html = render(createElement(Button, null, "x"));
    expect(html).toContain("min-h-12");
    expect(html).toContain("rounded-control");
  });
  it("sm size keeps a 44px target", () => {
    expect(render(createElement(Button, { size: "sm" }, "x"))).toContain("min-h-11");
  });
  it("outline uses the input border", () => {
    expect(render(createElement(Button, { variant: "outline" }, "x"))).toContain("border-input");
  });
  it("renders the disabled attribute", () => {
    expect(render(createElement(Button, { disabled: true }, "x"))).toContain("disabled");
  });
});
