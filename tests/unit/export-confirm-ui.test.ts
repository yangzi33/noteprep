import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EXPORT_PROMISE, ExportConfirmView, type ExportConfirmProps } from "@/components/app/export-confirm";
import { ExportEntry } from "@/components/app/export-entry";
import { CONFIRM_REDIRECT_CODES, confirmErrorTarget, confirmSuccessHref, exportConfirmHref } from "@/lib/ui/export-confirm";
import { generationErrorMessage } from "@/lib/ui/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const D = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const base: ExportConfirmProps = {
  draftId: D,
  versionId: V,
  title: "Linear equations",
  versionLabel: "Version 2",
  documents: ["notes", "worksheet", "solutions"],
  questionCount: 6,
  changes: "1 question removed",
  allowanceText: "2 of 3 generations left.",
  remaining: 2,
  rev: 4,
  contentHash: "abc123",
  formKey: "key-0123456789",
  enabled: true,
  stale: false,
  error: null,
  action: () => {},
};
const render = (over: Partial<ExportConfirmProps> = {}) => renderToStaticMarkup(createElement(ExportConfirmView, { ...base, ...over }));

describe("export confirmation view", () => {
  it("shows the exact promise, the facts and the balance", () => {
    const html = render();
    expect(html).toContain("This will use 1 generation when your PDFs are ready. If export fails, no generation is used.");
    for (const text of ["Linear equations", "Version 2", "Tutor Lesson Notes", "Student Practice Worksheet", "Solutions / Answer Key", "6 questions", "1 question removed", "2 of 3 generations left."]) {
      expect(html).toContain(text);
    }
  });

  it("has the five hidden inputs, an Export PDFs submit and a Back to editing link; no opt-out and no checkbox", () => {
    const html = render();
    const hidden = [...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => m[0]);
    const pick = (name: string) => hidden.find((i) => i.includes(`name="${name}"`)) ?? "";
    expect(hidden).toHaveLength(5);
    expect(pick("draftId")).toContain(`value="${D}"`);
    expect(pick("versionId")).toContain(`value="${V}"`);
    expect(pick("expectedRev")).toContain('value="4"');
    expect(pick("expectedContentHash")).toContain('value="abc123"');
    expect(pick("key")).toContain('value="key-0123456789"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>[^<]*Export PDFs/);
    expect(html).toContain(`href="/drafts/${D}?v=${V}"`);
    expect(html).toContain("Back to editing");
    expect(html).not.toMatch(/type="checkbox"/);
    expect(html).not.toMatch(/don.?t show/i);
  });

  it("offers a page format radio group inside the form, letter checked by default, and names both formats", () => {
    const html = render();
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => r.includes('name="pageFormat"'))).toBe(true);
    const letter = radios.find((r) => r.includes('value="letter"'))!;
    const a4 = radios.find((r) => r.includes('value="a4"'))!;
    expect(letter).toContain("checked");
    expect(a4).not.toContain("checked");
    expect(html).toContain("US Letter");
    expect(html).toContain("A4");
    expect(html.indexOf("<form")).toBeLessThan(html.indexOf('value="a4"'));
  });

  it("says that exporting the same content in the same page format again is free, next to the truthful promise", () => {
    const html = render();
    expect(html).toContain("Exporting the same content in the same page format again is free");
    expect(html).toContain(EXPORT_PROMISE);
  });

  it("flag off: the disabled message and no form", () => {
    const html = render({ enabled: false });
    expect(html).toContain(generationErrorMessage("EXPORT_DISABLED")!);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });

  it("a revision that is not the one the tutor saw shows the conflict and no form", () => {
    const html = render({ stale: true });
    expect(html).toContain(generationErrorMessage("EXPORT_CONFLICT")!);
    expect(html).toContain("Review the draft");
    expect(html).toContain(`href="/drafts/${D}?v=${V}"`);
    expect(html).not.toContain("<form");
  });

  it("zero allowance keeps the form and says an unchanged re-export is free, with a link to the account", () => {
    const html = render({ remaining: 0, allowanceText: "0 of 3 generations left." });
    expect(html).toContain("<form");
    expect(html).toContain("0 of 3 generations left.");
    expect(html).toMatch(/unchanged[^<]*free/i);
    expect(html).toContain('href="/account"');
  });

  it("daily view shows the reminder and the after-export sentence; exhausted daily has no subscribe wording", () => {
    const html = render({ allowanceText: "3 of 5 generations left.", remaining: 3, reminder: "Beta perk: 5 free exports every day. 3 of 5 left today. Refreshes at 00:00 UTC.", afterText: "After this export you will have 2 left today." });
    expect(html).toContain('data-testid="refresh-reminder"');
    expect(html).toContain("Beta perk: 5 free exports every day. 3 of 5 left today. Refreshes at 00:00 UTC.");
    expect(html).toContain("After this export you will have 2 left today.");
    const out = render({ remaining: 0, source: "daily", error: "ALLOWANCE_EXHAUSTED" });
    expect(out).toContain("00:00 UTC");
    expect(out).toContain("contact us");
    expect(out.toLowerCase()).not.toMatch(/subscri|checkout/);
    expect(render()).not.toContain("refresh-reminder");
  });

  it("daily view replaces the generic count with the reminder (shown once, inside the balance element)", () => {
    const reminder = "Beta perk: 5 free exports every day. 3 of 5 left today. Refreshes at 00:00 UTC.";
    const html = render({ allowanceText: "3 of 5 generations left.", remaining: 3, source: "daily", reminder });
    expect(html).not.toContain("3 of 5 generations left.");
    expect(html).toMatch(/data-testid="export-balance"[^>]*>\s*<span[^>]*data-testid="refresh-reminder"/);
    expect(html.split(reminder)).toHaveLength(2);
    // other sources keep the generic sentence
    expect(render()).toContain("2 of 3 generations left.");
  });

  it("daily exhausted free note says the count returns at 00:00 UTC, without subscribe or checkout words", () => {
    const html = render({ remaining: 0, source: "daily", reminder: "Beta perk: 5 free exports every day. 0 of 5 left today. The count comes back at 00:00 UTC." });
    const note = html.slice(html.indexOf('data-testid="export-free-note"'));
    expect(note).toContain("used all of today");
    expect(note).toContain("00:00 UTC");
    expect(note.slice(0, note.indexOf("</div>")).toLowerCase()).not.toMatch(/subscri|checkout|contact/);
    expect(render({ remaining: 0, source: "trial" })).toContain("You have no generations left.");
  });

  it("does not show the free note while generations remain; an error code shows its message", () => {
    expect(render()).not.toContain('href="/account"');
    expect(render({ error: "RATE_LIMITED" })).toContain(generationErrorMessage("RATE_LIMITED")!);
  });
});

describe("export entry on the draft page", () => {
  const entry = (flowMode: "legacy" | "draft", exportEnabled: boolean) => renderToStaticMarkup(createElement(ExportEntry, { flowMode, exportEnabled, draftId: D, versionId: V, rev: 4 }));
  it("is a link carrying v and rev only with FLOW_MODE=draft and EXPORT_ENABLED=1", () => {
    const html = entry("draft", true);
    expect(html).toContain(`href="/drafts/${D}/export?v=${V}&amp;rev=4"`);
    expect(html).toContain('data-testid="draft-export"');
    expect(html).toContain("Uses 1 generation when your PDFs are ready.");
    expect(html).not.toContain("draft-export-disabled");
  });
  it("keeps the disabled button exactly otherwise", () => {
    for (const html of [entry("draft", false)]) {
      expect(html).toContain('data-testid="draft-export-disabled"');
      expect(html).toContain("PDF export is paused right now. Your draft is saved.");
      expect(html).not.toContain("coming next");
      expect(html).not.toContain("/export?");
    }
    expect(entry("legacy", true)).toBe("");
    expect(entry("legacy", false)).toBe("");
  });
});

describe("confirm action mapping", () => {
  it("builds hrefs", () => {
    expect(exportConfirmHref(D, V, { error: "RATE_LIMITED" })).toBe(`/drafts/${D}/export?v=${V}&error=RATE_LIMITED`);
    expect(exportConfirmHref(D, undefined, { error: "INVALID_REQUEST" })).toBe(`/drafts/${D}/export?error=INVALID_REQUEST`);
    expect(confirmSuccessHref({ outcome: "created", exportId: "e1" })).toBe("/exports/e1");
    expect(confirmSuccessHref({ outcome: "joined", exportId: "e1" })).toBe("/exports/e1?outcome=joined");
    expect(confirmSuccessHref({ outcome: "reused", exportId: "e1" })).toBe("/exports/e1?outcome=reused");
    expect(confirmSuccessHref({ outcome: "replayed", exportId: "e1" })).toBe("/exports/e1");
  });
  it("maps conflict and expiry to the draft page, not found to 404, the rest back to the confirm page", () => {
    expect(confirmErrorTarget("EXPORT_CONFLICT", D, V)).toEqual({ kind: "redirect", href: `/drafts/${D}?v=${V}&error=EXPORT_CONFLICT` });
    expect(confirmErrorTarget("DRAFT_EXPIRED", D, V)).toEqual({ kind: "redirect", href: `/drafts/${D}?v=${V}&error=DRAFT_EXPIRED` });
    expect(confirmErrorTarget("NOT_FOUND", D, V)).toEqual({ kind: "notFound" });
    expect(confirmErrorTarget("RATE_LIMITED", D, V)).toEqual({ kind: "redirect", href: `/drafts/${D}/export?v=${V}&error=RATE_LIMITED` });
    expect(confirmErrorTarget("INVARIANT_VIOLATION", D, V)).toEqual({ kind: "rethrow" });
    expect(confirmErrorTarget("SOMETHING_ELSE", D, V)).toEqual({ kind: "rethrow" });
  });
  it("every code the action can redirect with has its own tutor-facing message", () => {
    for (const code of CONFIRM_REDIRECT_CODES) {
      const m = generationErrorMessage(code);
      expect(m, code).toBeTruthy();
      expect(m, code).not.toBe("Something went wrong. Please try again.");
      expect(m, code).not.toMatch(/idempoten|exception|stack|null/i);
    }
    for (const code of ["ALLOWANCE_EXHAUSTED", "RATE_LIMITED", "TOO_MANY_ACTIVE_JOBS", "QUEUE_BUSY", "EXPORT_BUSY", "EXPORT_UNAVAILABLE", "EXPORT_DISABLED", "EXPORT_NOT_VERIFIED", "EXPORT_RENDER_FAILED", "IDEMPOTENCY_KEY_REUSED", "ACCOUNT_NOT_ACTIVE", "INVALID_REQUEST", "EXPORT_CONFLICT", "DRAFT_EXPIRED"]) {
      expect(CONFIRM_REDIRECT_CODES as readonly string[]).toContain(code);
    }
  });
});
