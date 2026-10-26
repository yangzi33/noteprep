import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContactLink, ContactText } from "@/components/app/contact-link";
import { exhaustedNotice } from "@/lib/ui/messages";
import { parseSupportEmail, splitAtContact } from "@/lib/ui/support";

describe("parseSupportEmail", () => {
  it("accepts a plain address and trims it", () => {
    expect(parseSupportEmail("  help@example.com ")).toBe("help@example.com");
  });
  it("returns null for unset, empty or malformed values", () => {
    for (const v of [undefined, null, "", "  ", "help", "a@b", "a b@example.com", "mailto:a@example.com", "a@example.com, b@example.com", '"x"@example.com']) {
      expect(parseSupportEmail(v)).toBeNull();
    }
  });
});

describe("splitAtContact", () => {
  it("splits around the first phrase", () => {
    expect(splitAtContact("To get more, contact us.")).toEqual({ before: "To get more, ", phrase: "contact us", after: "." });
  });
  it("returns null without the phrase", () => {
    expect(splitAtContact("Nothing here.")).toBeNull();
  });
});

describe("ContactLink and ContactText", () => {
  it("renders words only when there is no address", () => {
    expect(renderToStaticMarkup(<ContactLink email={null} />)).toBe("contact us");
    const html = renderToStaticMarkup(<ContactText text={exhaustedNotice("trial")} email={null} />);
    expect(html).toContain("contact us");
    expect(html).not.toContain("mailto");
  });
  it("renders a mailto link with the address as text when it exists", () => {
    const html = renderToStaticMarkup(<ContactText text={exhaustedNotice("trial")} email="help@example.com" />);
    expect(html).toContain('href="mailto:help@example.com"');
    expect(html).toContain(">help@example.com</a>");
    expect(html).toContain("contact us at ");
  });
  it("leaves text without the phrase unchanged", () => {
    expect(renderToStaticMarkup(<ContactText text="Plain." email="help@example.com" />)).toBe("Plain.");
  });
});
