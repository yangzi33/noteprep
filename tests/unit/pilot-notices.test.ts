import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/auth/require-user", () => ({ getRequestUser: () => null }));

import { TestBanner } from "@/components/app/test-banner";
import { PrivacyContent, TermsContent } from "@/components/app/legal-content";
import { ANONYMOUS_NOTICE, SUBPROCESSORS } from "@/lib/ui/legal";

afterEach(() => vi.unstubAllEnvs());

describe("test banner", () => {
  it("says it is a test and links the notices", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "");
    const html = renderToStaticMarkup(createElement(TestBanner));
    expect(html).toMatch(/private test version/);
    expect(html).toMatch(/href="\/privacy"/);
    expect(html).toMatch(/href="\/terms"/);
    expect(html).not.toMatch(/mailto:/);
  });

  it("adds a feedback mailto link when a support address is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "help@example.test");
    expect(renderToStaticMarkup(createElement(TestBanner))).toMatch(/href="mailto:help@example\.test\?subject=NotePrep%20feedback"[^>]*>Send feedback/);
  });
});

describe("privacy and terms notices", () => {
  it("name every subprocessor and say OpenAI is switched off in this test", () => {
    expect(SUBPROCESSORS.map((s) => s.name)).toEqual(["Vercel", "Supabase", "DigitalOcean", "Resend", "OpenAI"]);
    const html = renderToStaticMarkup(createElement(PrivacyContent));
    for (const s of SUBPROCESSORS) expect(html).toContain(`<strong>${s.name}.</strong>`);
    expect(html).toMatch(/Switched off in this test: nothing is sent to OpenAI/);
    expect(html).toMatch(/do not promise zero retention/);
  });

  it("asks for anonymous examples and offers deletion on both pages", () => {
    const text = (html: string) => html.replace(/&#x27;/g, "'");
    const privacy = text(renderToStaticMarkup(createElement(PrivacyContent)));
    const terms = text(renderToStaticMarkup(createElement(TermsContent)));
    expect(privacy).toContain(ANONYMOUS_NOTICE);
    expect(terms).toContain(ANONYMOUS_NOTICE);
    expect(privacy).toMatch(/delete your account/);
    expect(terms).toMatch(/Read everything before you use it with a student/);
  });
});
