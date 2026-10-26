import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftCard, MaterialCard, MaterialRow } from "@/components/app/material-card";
import { allowanceSentence, dailyRefreshReminder, exportAfterSentence, draftCards, emptyExportsText, formatUtc, recentCards, statusHref, type DraftSummaryLike, type HistoryLike } from "@/lib/ui/dashboard-view";
import { exhaustedMessage, generationErrorMessage, stateLabel } from "@/lib/ui/messages";

const item = (over: Partial<HistoryLike> = {}): HistoryLike => ({
  jobId: "job-1",
  lessonId: "les-1",
  title: "Linear equations",
  state: "succeeded",
  revisionId: "rev-1",
  createdAt: new Date("2026-03-05T14:30:00Z"),
  ...over,
});

describe("allowanceSentence", () => {
  it("keeps the exact existing format", () => {
    expect(allowanceSentence({ source: "trial", remaining: 2, limit: 3, pending: 0 })).toBe("2 of 3 free lesson packs left.");
    expect(allowanceSentence({ source: "trial", remaining: 1, limit: 3, pending: 1 })).toBe("1 of 3 free lesson packs left (1 in progress).");
    expect(allowanceSentence(null)).toBe("Your account is being set up.");
  });
});

describe("formatUtc", () => {
  it("formats in UTC regardless of host zone", () => {
    expect(formatUtc(new Date("2026-03-05T23:30:00Z"))).toBe("Mar 5, 2026, 11:30 PM UTC");
  });
});

describe("recentCards", () => {
  it("opens a finished lesson on its revision", () => {
    const [c] = recentCards([item()], 6);
    expect(c).toMatchObject({
      href: "/lessons/les-1?rev=rev-1",
      action: "Open",
      label: stateLabel("succeeded"),
      title: "Linear equations",
    });
  });
  it("links everything else to the job status", () => {
    for (const state of ["queued", "running", "failed", "canceled"] as const) {
      expect(recentCards([item({ state, revisionId: null })], 6)[0]).toMatchObject({ href: "/jobs/job-1", action: "View status" });
    }
    expect(recentCards([item({ revisionId: null })], 6)[0]!.href).toBe("/jobs/job-1");
  });
  it("links failed and canceled jobs to the status page even with a revision", () => {
    for (const state of ["failed", "canceled"] as const) {
      expect(recentCards([item({ state, revisionId: "rev-1" })], 6)[0]).toMatchObject({ href: "/jobs/job-1", action: "View status" });
    }
  });
  it("caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ jobId: `j${i}` }));
    expect(recentCards(many, 6)).toHaveLength(6);
  });
});

describe("MaterialCard", () => {
  const card = recentCards([item()], 6)[0]!;
  const html = renderToStaticMarkup(createElement(MaterialCard, { card }));
  it("has exactly one link with the card href", () => {
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<a[^>]*href="\/lessons\/les-1\?rev=rev-1"[^>]*>[^<]*Open/);
  });
  it("shows state text, title and date", () => {
    expect(html).toContain(card.label);
    expect(html).toContain("Linear equations");
    expect(html).toContain("Mar 5, 2026, 2:30 PM UTC");
  });
});

describe("MaterialCard link name", () => {
  const render = (title: string, jobId: string) =>
    renderToStaticMarkup(createElement(MaterialCard, { card: recentCards([item({ title, jobId })], 6)[0]! }));
  it("is unique per title and keeps the visible text", () => {
    const a = render("Linear equations", "j1");
    const b = render("Quadratics", "j2");
    expect(a).toMatch(/<a[^>]*aria-label="Open: Linear equations"[^>]*>Open<\/a>/);
    expect(b).toMatch(/<a[^>]*aria-label="Open: Quadratics"[^>]*>Open<\/a>/);
  });
});

describe("MaterialRow", () => {
  const html = renderToStaticMarkup(
    createElement(MaterialRow, { jobId: "job-9", title: "T", state: "failed", label: "Could not finish", date: "d UTC", outcome: "Reason." }),
  );
  it("is an li with data-state and the title link to the job as its only link", () => {
    expect(html).toMatch(/^<li[^>]*data-state="failed"/);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<a[^>]*href="\/jobs\/job-9"[^>]*>T<\/a>/);
    expect(html).toContain("Reason.");
    expect(html).toContain("Could not finish");
  });
});

describe("export items", () => {
  const exp = (over: Partial<HistoryLike> = {}) => item({ kind: "export", exportId: "exp-1", ...over });
  it("link non-succeeded exports to their own status page", () => {
    for (const state of ["queued", "running", "failed", "canceled"] as const) {
      expect(recentCards([exp({ state, revisionId: null })], 6)[0]).toMatchObject({ href: "/exports/exp-1", action: "View status" });
      expect(statusHref(exp({ state }))).toBe("/exports/exp-1");
    }
  });
  it("keep a succeeded export linking to its lesson", () => {
    expect(recentCards([exp()], 6)[0]).toMatchObject({ href: "/lessons/les-1?rev=rev-1", action: "Open" });
    expect(statusHref(exp({ state: "succeeded" }))).toBe("/jobs/job-1");
  });
  it("leave legacy jobs and an export without a row on the job page", () => {
    expect(statusHref(item({ kind: "generate", exportId: null, state: "failed" }))).toBe("/jobs/job-1");
    expect(statusHref(exp({ exportId: null, state: "failed" }))).toBe("/jobs/job-1");
    expect(statusHref(item({ state: "queued" }))).toBe("/jobs/job-1");
  });
  it("MaterialRow links to the href it is given, else the job page", () => {
    const row = (href?: string) => renderToStaticMarkup(createElement(MaterialRow, { jobId: "job-1", ...(href ? { href } : {}), title: "T", state: "failed", label: "Failed", date: "d", outcome: null }));
    expect(row("/exports/exp-1")).toContain('href="/exports/exp-1"');
    expect(row()).toContain('href="/jobs/job-1"');
  });
});

describe("draftCards", () => {
  const draft = (over: Partial<DraftSummaryLike> = {}): DraftSummaryLike => ({
    draftId: "11111111-1111-4111-8111-111111111111",
    title: "Linear equations",
    updatedAt: new Date("2026-03-05T14:30:00Z"),
    expiresAt: new Date("2026-03-19T23:30:00Z"),
    ...over,
  });

  it("links to /drafts/[id] and states the UTC expiry", () => {
    const [card] = draftCards([draft()], 6);
    expect(card).toEqual({
      draftId: "11111111-1111-4111-8111-111111111111",
      title: "Linear equations",
      href: "/drafts/11111111-1111-4111-8111-111111111111",
      updated: "Mar 5, 2026, 2:30 PM UTC",
      expires: "expires Mar 19, 2026, 11:30 PM UTC",
    });
  });

  it("keeps the given order and caps the count", () => {
    const list = [1, 2, 3, 4].map((n) => draft({ draftId: `d${n}`, title: `T${n}` }));
    expect(draftCards(list, 2).map((c) => c.title)).toEqual(["T1", "T2"]);
    expect(draftCards([], 3)).toEqual([]);
  });

  it("renders one link and the expiry, and escapes the title", () => {
    const html = renderToStaticMarkup(createElement(DraftCard, { card: draftCards([draft({ title: "<b>x</b>" })], 1)[0]! }));
    expect(html).toContain('href="/drafts/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain("expires Mar 19, 2026, 11:30 PM UTC");
    expect(html).not.toContain("<b>x</b>");
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});

describe("emptyExportsText", () => {
  it("says nothing is here only when there are no drafts either", () => {
    expect(emptyExportsText(0)).toBe("Nothing here yet");
  });
  it("does not claim emptiness below a Drafts section", () => {
    expect(emptyExportsText(2)).toBe("No exported lessons yet");
  });
});

describe("draftCards title fallback", () => {
  const draft = (title: unknown) => ({ draftId: "d-1", title: title as string, updatedAt: new Date("2026-03-05T14:30:00Z"), expiresAt: new Date("2026-03-12T14:30:00Z") });
  it("labels a draft without a topic title instead of showing null", () => {
    for (const bad of [null, undefined, "", "   "]) expect(draftCards([draft(bad)], 6)[0]!.title).toBe("Untitled draft");
    expect(draftCards([draft("Linear equations")], 6)[0]!.title).toBe("Linear equations");
  });
});

const daily = (over: Partial<{ remaining: number; limit: number; pending: number }> = {}) => ({
  source: "daily" as const,
  remaining: 3,
  limit: 5,
  pending: 0,
  ...over,
});

describe("dailyRefreshReminder", () => {
  it("states the perk, the count and the reset with the owner-approved wording", () => {
    expect(dailyRefreshReminder(daily())).toBe("Beta perk: 5 free lesson packs every day. 3 of 5 left today. Refreshes at 00:00 UTC.");
  });
  it("mentions jobs in progress", () => {
    expect(dailyRefreshReminder(daily({ remaining: 2, pending: 1 }))).toBe("Beta perk: 5 free lesson packs every day. 2 of 5 left today (1 in progress). Refreshes at 00:00 UTC.");
  });
  it("when none are left it says the count comes back at 00:00 UTC and never mentions subscribing", () => {
    const text = dailyRefreshReminder(daily({ remaining: 0 }))!;
    expect(text).toContain("0 of 5 left today");
    expect(text).toContain("comes back at 00:00 UTC");
    expect(text.toLowerCase()).not.toContain("subscri");
  });
  it("is null with the perk off (trial, paid) or no allowance, and the old sentence is unchanged", () => {
    expect(dailyRefreshReminder({ source: "trial", remaining: 2, limit: 3, pending: 0 })).toBeNull();
    expect(dailyRefreshReminder({ source: "paid", remaining: 2, limit: 30, pending: 0 })).toBeNull();
    expect(dailyRefreshReminder(null)).toBeNull();
    expect(allowanceSentence({ source: "trial", remaining: 2, limit: 3, pending: 0 })).toBe("2 of 3 free lesson packs left.");
    expect(allowanceSentence(null)).toBe("Your account is being set up.");
  });
});

describe("exportAfterSentence", () => {
  it("tells how many are left after this export", () => {
    expect(exportAfterSentence(daily())).toBe("After this export you will have 2 left today.");
    expect(exportAfterSentence(daily({ remaining: 1 }))).toBe("After this export you will have 0 left today. They come back at 00:00 UTC.");
  });
  it("is null when nothing is left, not daily, or unknown", () => {
    expect(exportAfterSentence(daily({ remaining: 0 }))).toBeNull();
    expect(exportAfterSentence({ source: "trial", remaining: 2, limit: 3, pending: 0 })).toBeNull();
    expect(exportAfterSentence(null)).toBeNull();
  });
});

describe("exhaustedMessage", () => {
  it("daily says the count comes back at 00:00 UTC and to contact us, with no subscribe wording", () => {
    const text = exhaustedMessage("daily");
    expect(text).toContain("00:00 UTC");
    expect(text).toContain("contact us");
    expect(text.toLowerCase()).not.toContain("subscri");
  });
  it("trial says contact us with no subscribe wording; paid and unknown keep the generic text", () => {
    expect(exhaustedMessage("trial")).toContain("contact us");
    expect(exhaustedMessage("trial").toLowerCase()).not.toContain("subscri");
    expect(exhaustedMessage(null)).toBe("You have used all your free lesson packs. If a job is still in progress, its lesson pack comes back if that job fails.");
    expect(exhaustedMessage("paid")).toBe(exhaustedMessage(null));
  });
  it("generationErrorMessage picks the wording from the source, and only for ALLOWANCE_EXHAUSTED", () => {
    expect(generationErrorMessage("ALLOWANCE_EXHAUSTED", "daily")).toBe(exhaustedMessage("daily"));
    expect(generationErrorMessage("ALLOWANCE_EXHAUSTED")).toBe(exhaustedMessage(null));
    expect(generationErrorMessage("RATE_LIMITED", "daily")).toBe(generationErrorMessage("RATE_LIMITED"));
  });
});
