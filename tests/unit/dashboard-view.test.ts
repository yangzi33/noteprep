import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MaterialCard, MaterialRow } from "@/components/app/material-card";
import { allowanceSentence, formatUtc, recentCards, statusHref, type HistoryLike } from "@/lib/ui/dashboard-view";
import { stateLabel } from "@/lib/ui/messages";

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
    expect(allowanceSentence({ remaining: 2, limit: 3, pending: 0 })).toBe("2 of 3 generations left.");
    expect(allowanceSentence({ remaining: 1, limit: 3, pending: 1 })).toBe("1 of 3 generations left (1 in progress).");
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
