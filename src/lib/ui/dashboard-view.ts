import { stateLabel } from "./messages";

export interface HistoryLike {
  jobId: string;
  /** Export jobs that have not succeeded are followed on /exports/{exportId}; absent for older rows and legacy jobs. */
  kind?: "generate" | "export";
  exportId?: string | null;
  lessonId: string;
  title: string;
  state: "queued" | "running" | "succeeded" | "failed" | "canceled";
  revisionId: string | null;
  createdAt: Date;
}

export interface MaterialCardModel {
  jobId: string;
  state: HistoryLike["state"];
  title: string;
  label: string;
  date: string;
  href: string;
  action: "Open" | "View status";
}

const utc = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** "Mar 5, 2026, 2:30 PM UTC" with plain spaces (newer ICU uses a narrow no-break space before AM/PM). */
export function formatUtc(date: Date): string {
  return `${utc.format(date).replace(/\s/g, " ")} UTC`;
}

/** Where a history item's status lives: an unfinished or failed export has its own page, everything else the job page. */
export function statusHref(item: Pick<HistoryLike, "jobId" | "kind" | "exportId" | "state">): string {
  return item.kind === "export" && item.exportId && item.state !== "succeeded" ? `/exports/${item.exportId}` : `/jobs/${item.jobId}`;
}

export function allowanceSentence(allowance: { remaining: number; limit: number; pending: number } | null): string {
  return allowance
    ? `${allowance.remaining} of ${allowance.limit} generations left${allowance.pending > 0 ? ` (${allowance.pending} in progress)` : ""}.`
    : "Your account is being set up.";
}

export function recentCards(items: readonly HistoryLike[], max: number): MaterialCardModel[] {
  return items.slice(0, max).map((item) => {
    const open = item.state === "succeeded" && item.revisionId !== null;
    return {
      jobId: item.jobId,
      state: item.state,
      title: item.title,
      label: stateLabel(item.state),
      date: formatUtc(item.createdAt),
      href: open ? `/lessons/${item.lessonId}?rev=${item.revisionId}` : statusHref(item),
      action: open ? "Open" : "View status",
    };
  });
}

/** The part of a draft summary the cards need (a structural subset of the DAL's DraftSummaryDto). */
export interface DraftSummaryLike {
  draftId: string;
  title: string;
  updatedAt: Date;
  expiresAt: Date;
}

export interface DraftCardModel {
  draftId: string;
  title: string;
  href: string;
  updated: string;
  expires: string;
}

/** Cards for the caller's own active drafts (the DAL already filters by owner and expiry). Keeps the given order. */
export function draftCards(items: readonly DraftSummaryLike[], max: number): DraftCardModel[] {
  return items.slice(0, max).map((d) => ({
    draftId: d.draftId,
    title: d.title,
    href: `/drafts/${d.draftId}`,
    updated: formatUtc(d.updatedAt),
    expires: `expires ${formatUtc(d.expiresAt)}`,
  }));
}

/** Heading of the empty exports/activity area; accurate when the page also lists drafts above it. */
export function emptyExportsText(draftCount: number): string {
  return draftCount > 0 ? "No exported lessons yet" : "Nothing here yet";
}
