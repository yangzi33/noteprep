import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LandingPage } from "@/components/marketing/landing-page";
import { PublicHeader } from "@/components/app/public-header";
import { landingContent } from "@/lib/marketing/content";

const html = renderToStaticMarkup(createElement(LandingPage));

describe("landing page markup", () => {
  it("has exactly one h1 and no main element of its own", () => {
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).not.toMatch(/<main[ >]/);
  });

  it("has Get started to /login and a secondary anchor", () => {
    expect(html).toMatch(/<a [^>]*href="\/login"[^>]*>[^<]*Get started/);
    expect(html).toMatch(/<a [^>]*href="#how-it-works"[^>]*>[^<]*See how it works/);
    expect(html).toContain('id="how-it-works"');
  });

  it("renders every FAQ entry as a details element", () => {
    expect(html.match(/<details[ >]/g)).toHaveLength(landingContent.faq.length);
    expect(html.match(/<summary[ >]/g)).toHaveLength(landingContent.faq.length);
  });

  it("only links to /, /login or in-page anchors that exist", () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      expect(h === "/" || h === "/login" || /^#[a-z][a-z-]*$/.test(h), h).toBe(true);
      if (h.startsWith("#")) expect(html).toContain(`id="${h.slice(1)}"`);
    }
    expect(html).not.toMatch(/(href|src|action)="https?:/);
  });

  it("has no footer links to missing pages and no role=status", () => {
    expect(html).not.toMatch(/privacy|terms of/i);
    expect(html).not.toMatch(/role="status"/);
  });
});

describe("public header", () => {
  const header = renderToStaticMarkup(createElement(PublicHeader));
  it("links the logo home and offers Sign in as a link, not a button", () => {
    expect(header).toMatch(/<a [^>]*href="\/"/);
    expect(header).toMatch(/<a [^>]*href="\/login"[^>]*>Sign in<\/a>/);
    expect(header).not.toMatch(/<button/);
  });
});
