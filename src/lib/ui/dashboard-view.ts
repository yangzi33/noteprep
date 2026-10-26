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

/** The structural part of the DAL's AllowanceView the display helpers need. */
export interface AllowanceLike {
  source: "trial" | "paid" | "daily";
  remaining: number;
  limit: number;
  pending: number;
}

export function allowanceSentence(allowance: AllowanceLike | null): string {
  return allowance
    ? `${allowance.remaining} of ${allowance.limit} generations left${allowance.pending > 0 ? ` (${allowance.pending} in progress)` : ""}.`
    : "Your account is being set up.";
}

/** The beta perk reminder (D-112); null unless the allowance is the daily one. The daily count refreshes at 00:00 UTC. */
export function dailyRefreshReminder(allowance: AllowanceLike | null): string | null {
  if (allowance?.source !== "daily") return null;
  const pending = allowance.pending > 0 ? ` (${allowance.pending} in progress)` : "";
  const tail = allowance.remaining > 0 ? "Refreshes at 00:00 UTC." : "The count comes back at 00:00 UTC.";
  return `Beta perk: ${allowance.limit} free exports every day. ${allowance.remaining} of ${allowance.limit} left today${pending}. ${tail}`;
}

/** What is left after the export being confirmed; null unless the view is daily and at least one is left. */
export function exportAfterSentence(allowance: AllowanceLike | null): string | null {
  if (allowance?.source !== "daily" || allowance.remaining < 1) return null;
  const after = allowance.remaining - 1;
  return `After this export you will have ${after} left today.${after === 0 ? " They come back at 00:00 UTC." : ""}`;
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

export const UNTITLED_DRAFT = "Untitled draft";

/** Cards for the caller's own active drafts (the DAL already filters by owner and expiry). Keeps the given order. */
export function draftCards(items: readonly DraftSummaryLike[], max: number): DraftCardModel[] {
  return items.slice(0, max).map((d) => ({
    draftId: d.draftId,
    title: d.title?.trim() ? d.title : UNTITLED_DRAFT, // the DAL reads it from JSON and it can be NULL
    href: `/drafts/${d.draftId}`,
    updated: formatUtc(d.updatedAt),
    expires: `expires ${formatUtc(d.expiresAt)}`,
  }));
}

/** Heading of the empty exports/activity area; accurate when the page also lists drafts above it. */
export function emptyExportsText(draftCount: number): string {
  return draftCount > 0 ? "No exported lessons yet" : "Nothing here yet";
}
