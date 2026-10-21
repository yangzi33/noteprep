import { stateLabel } from "./messages";

export interface HistoryLike {
  jobId: string;
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
      href: open ? `/lessons/${item.lessonId}?rev=${item.revisionId}` : `/jobs/${item.jobId}`,
      action: open ? "Open" : "View status",
    };
  });
}
