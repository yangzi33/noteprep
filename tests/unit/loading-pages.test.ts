import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DraftLoading from "@/app/drafts/[id]/loading";
import ExportLoading from "@/app/exports/[id]/loading";

describe("loading states", () => {
  it.each([
    ["the draft page", DraftLoading, "Loading your draft..."],
    ["the export page", ExportLoading, "Loading your export..."],
  ])("%s shows an announced status line", (_name, Page, text) => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain('role="status"');
    expect(html).toContain(text);
  });
});
