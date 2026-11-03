import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/auth/require-user", () => ({ getRequestUser: async () => null }));

import { TestBanner } from "@/components/app/test-banner";
import { NO_CONTACT_FALLBACK, PrivacyContent, TermsContent } from "@/components/app/legal-content";
import { LegalPage } from "@/components/app/legal-page";
import { ANONYMOUS_NOTICE, buildDisclosure } from "@/lib/ui/legal";

const privacyHtml = (env: Record<string, string | undefined>) => renderToStaticMarkup(createElement(PrivacyContent, { disclosure: buildDisclosure(env) }));

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

  it("keeps every link at least 44px tall for touch", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "help@example.test");
    const links = [...renderToStaticMarkup(createElement(TestBanner)).matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(3);
    for (const l of links) expect(l).toMatch(/min-h-11/);
  });

  it("adds a feedback mailto link when a support address is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "help@example.test");
    expect(renderToStaticMarkup(createElement(TestBanner))).toMatch(/href="mailto:help@example\.test\?subject=NotePrep%20feedback"[^>]*>Send feedback/);
  });
});

describe("privacy notice subprocessors follow configuration", () => {
  it("says AI is off and names no AI provider when LLM_PROVIDER is fake or unset", () => {
    for (const env of [{}, { LLM_PROVIDER: "fake" }, { LLM_PROVIDER: "fake", LESSON_PROSE: "llm" }]) {
      const html = privacyHtml(env);
      expect(html).toMatch(/AI writing is switched off in this test: no lesson data is sent to any AI provider/);
      expect(html).not.toMatch(/Anthropic|OpenAI/);
    }
  });

  it("names Anthropic as an AI subprocessor when it is the configured provider, and never OpenAI", () => {
    const html = privacyHtml({ LLM_PROVIDER: "anthropic" });
    expect(html).toContain("<strong>Anthropic.</strong>");
    expect(html).toMatch(/AI writing is switched on: lesson context is sent to Anthropic/);
    expect(html).not.toMatch(/switched off|OpenAI/);
  });

  it("discloses an unrecognised provider generically instead of claiming AI is off", () => {
    const html = privacyHtml({ LLM_PROVIDER: "someday" });
    expect(html).toMatch(/AI writing is switched on: lesson context is sent to An AI provider/);
    expect(html).not.toMatch(/switched off/);
  });

  it("never names Resend or any sender the owner has not confirmed", () => {
    const unset = privacyHtml({});
    expect(unset).not.toMatch(/Resend/);
    expect(unset).toContain("<strong>Sign-in email sender (not yet confirmed).</strong>");
    expect(privacyHtml({ NOTEPREP_MAIL_SENDER: "<mail sender>" })).toContain("not yet confirmed");
    expect(privacyHtml({ NOTEPREP_MAIL_SENDER: "Example Mailer" })).toContain("<strong>Example Mailer.</strong> Sends the sign-in and password emails.");
  });

  it("always lists Vercel, Supabase and DigitalOcean", () => {
    expect(buildDisclosure({}).subprocessors.map((x) => x.name).slice(0, 3)).toEqual(["Vercel", "Supabase", "DigitalOcean"]);
  });
});

describe("contact route on the notices", () => {
  const text = (html: string) => html.replace(/&#x27;/g, "'");

  it("links the configured address wherever the notices say contact us", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "help@example.test");
    for (const html of [privacyHtml({}), renderToStaticMarkup(createElement(TermsContent))]) {
      expect(html).toContain('href="mailto:help@example.test"');
      expect(text(html)).not.toContain(NO_CONTACT_FALLBACK);
    }
    expect(privacyHtml({}).match(/mailto:help@example\.test/g)).toHaveLength(2);
  });

  it("renders an explicit fallback channel, not bare words, when no address is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "");
    for (const html of [privacyHtml({}), renderToStaticMarkup(createElement(TermsContent))]) {
      expect(text(html)).toContain(`contact us ${NO_CONTACT_FALLBACK}`);
      expect(html).not.toMatch(/mailto:/);
    }
  });
});

describe("privacy and terms notices", () => {
  it("asks for anonymous examples and offers deletion on both pages", () => {
    const text = (html: string) => html.replace(/&#x27;/g, "'");
    const privacy = text(privacyHtml({}));
    const terms = text(renderToStaticMarkup(createElement(TermsContent)));
    expect(privacy).toContain(ANONYMOUS_NOTICE);
    expect(terms).toContain(ANONYMOUS_NOTICE);
    expect(privacy).toMatch(/delete your account/);
    expect(privacy).toMatch(/do not promise zero retention/);
    expect(terms).toMatch(/Read everything before you use it with a student/);
  });

  it("LegalPage renders the title as the h1 with the public header for a signed-out visitor", async () => {
    const html = renderToStaticMarkup(await LegalPage({ title: "Privacy notice (test version)", children: createElement("p", null, "body") }));
    expect(html).toMatch(/<h1[^>]*>Privacy notice \(test version\)<\/h1>/);
    expect(html).toMatch(/<main id="main"/);
    expect(html).toMatch(/Sign in/);
  });
});
