import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LandingFooter, LandingPage } from "@/components/marketing/landing-page";
import { PublicHeader } from "@/components/app/public-header";
import { landingContent } from "@/lib/marketing/content";

const html = renderToStaticMarkup(createElement(LandingPage)) + renderToStaticMarkup(createElement(LandingFooter));

describe("landing page markup", () => {
  it("has exactly one h1 and no main element of its own", () => {
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).not.toMatch(/<main[ >]/);
  });

  it("has Get started to /login and the section ids the navigation targets", () => {
    expect(html).toMatch(/<a [^>]*href="\/login"[^>]*>[^<]*Get started/);
    for (const id of ["features", "how-it-works", "pricing"]) expect(html).toContain(`id="${id}"`);
  });

  it("renders every FAQ entry as a details element", () => {
    expect(html.match(/<details[ >]/g)).toHaveLength(landingContent.faq.items.length);
    expect(html.match(/<summary[ >]/g)).toHaveLength(landingContent.faq.items.length);
  });

  it("only links to /, /login or in-page anchors that exist", () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) {
      expect(h === "/" || h === "/login" || /^#[a-z][a-z-]*$/.test(h) || /^\/samples\/[a-z]+(-1\.png|\.pdf)$/.test(h), h).toBe(true);
      if (h.startsWith("#")) expect(html).toContain(`id="${h.slice(1)}"`);
    }
    expect(html).not.toMatch(/(href|src|action)="https?:/);
  });

  it("shows the real compiled previews with alt text and intrinsic size, and opens PDFs safely", () => {
    const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBeGreaterThanOrEqual(3);
    for (const img of imgs) {
      expect(img).toMatch(/src="\/samples\/(notes|worksheet|solutions)-1\.png"/);
      expect(img).toMatch(/alt="[^"]{20,}"/);
      expect(img).toMatch(/width="\d+"/);
      expect(img).toMatch(/height="\d+"/);
    }
    // The default tab (worksheet) is server-rendered and eager; without JavaScript it is the visible one.
    expect(imgs.find((i) => i.includes("worksheet-1.png"))).toContain('loading="eager"');
    expect(html).toMatch(/role="tablist"/);
    expect(html.match(/role="tab"[^>]*aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    for (const a of html.matchAll(/<a [^>]*href="\/samples\/[a-z]+\.pdf"[^>]*>/g)) {
      expect(a[0]).toContain('target="_blank"');
      expect(a[0]).toContain('rel="noopener"');
    }
  });

  it("says the samples come from sample data and not a real curriculum", () => {
    expect(html).toMatch(/sample data/);
    expect(html).toMatch(/not a real curriculum/);
  });

  it("has no footer links to missing pages and no role=status", () => {
    expect(html).not.toMatch(/privacy|terms of/i);
    expect(html).not.toMatch(/role="status"/);
  });
});

describe("landing header", () => {
  const header = renderToStaticMarkup(createElement(PublicHeader, { variant: "landing" }));
  it("links the logo home, the three sections, Sign in and Get started", () => {
    expect(header).toMatch(/<a [^>]*href="\/"/);
    for (const [href, label] of [["#features", "Features"], ["#how-it-works", "How it works"], ["#pricing", "Pricing"]]) {
      expect(header).toMatch(new RegExp(`<a [^>]*href="${href}"[^>]*>${label}</a>`));
    }
    expect(header).toMatch(/<a [^>]*href="\/login"[^>]*>Sign in<\/a>/);
    expect(header).toMatch(/<a [^>]*href="\/login"[^>]*>Get started<\/a>/);
    expect(header).not.toMatch(/<button/);
  });
  it("keeps the section anchors out of the small-screen header", () => {
    expect(header).toMatch(/<nav [^>]*class="[^"]*\bhidden\b[^"]*md:flex/);
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
