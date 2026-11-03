import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as string) }));
vi.mock("@/app/globals.css", () => ({}));

import ErrorPage from "@/app/error";
import GlobalError from "@/app/global-error";

const SECRET = "Unique constraint failed on tutor@example.com at /srv/app/db.ts";
const failure = (digest?: string) => Object.assign(new Error(SECRET), digest ? { digest } : {});

describe.each([
  ["app/error.tsx", ErrorPage],
  ["app/global-error.tsx", GlobalError],
])("%s", (_name, Page) => {
  const render = (error: Error & { digest?: string }) => renderToStaticMarkup(createElement(Page, { error, reset: () => {} }));

  it("says the drafts are saved, not that the work is", () => {
    const html = render(failure());
    expect(html).toContain("Your drafts are saved");
    expect(html).not.toContain("Your work is saved");
  });

  it("shows the digest as a reference the tutor can quote", () => {
    expect(render(failure("1234567890"))).toContain("Reference: 1234567890");
  });

  it("shows no reference line when there is no digest", () => {
    expect(render(failure())).not.toContain("Reference");
  });

  it("never renders the error message", () => {
    const html = render(failure("1234567890"));
    expect(html).not.toContain("tutor@example.com");
    expect(html).not.toContain("Unique constraint");
    expect(html).not.toContain("/srv/app");
  });

  it("offers a way to retry", () => {
    expect(render(failure())).toContain("Try again");
  });
});

describe("app/global-error.tsx", () => {
  it("brings its own html and body, because it replaces the root layout", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: failure(), reset: () => {} }));
    expect(html).toMatch(/^<html[^>]*lang="en"/);
    expect(html).toContain("<body");
  });
});
