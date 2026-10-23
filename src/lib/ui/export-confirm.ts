/** Pure routing for the export confirmation page and its action (kept apart so it can be unit tested). */

/** Domain codes the confirm action turns into a redirect; every one needs a tutor-facing message. */
export const CONFIRM_REDIRECT_CODES = [
  "EXPORT_CONFLICT",
  "DRAFT_EXPIRED",
  "ALLOWANCE_EXHAUSTED",
  "RATE_LIMITED",
  "TOO_MANY_ACTIVE_JOBS",
  "QUEUE_BUSY",
  "EXPORT_BUSY",
  "EXPORT_UNAVAILABLE",
  "EXPORT_DISABLED",
  "EXPORT_NOT_VERIFIED",
  "EXPORT_RENDER_FAILED",
  "IDEMPOTENCY_KEY_REUSED",
  "ACCOUNT_NOT_ACTIVE",
  "INVALID_REQUEST",
] as const;

const REDIRECT_CODES: ReadonlySet<string> = new Set(CONFIRM_REDIRECT_CODES);

export function exportConfirmHref(draftId: string, versionId: string | undefined, extra: { rev?: number; error?: string } = {}): string {
  const q = new URLSearchParams();
  if (versionId) q.set("v", versionId);
  if (extra.rev !== undefined) q.set("rev", String(extra.rev));
  if (extra.error) q.set("error", extra.error);
  const s = q.toString();
  return `/drafts/${draftId}/export${s ? `?${s}` : ""}`;
}

export function confirmSuccessHref(result: { outcome: "created" | "joined" | "reused" | "replayed"; exportId: string }): string {
  const base = `/exports/${result.exportId}`;
  return result.outcome === "joined" || result.outcome === "reused" ? `${base}?outcome=${result.outcome}` : base;
}

export type ConfirmErrorTarget = { kind: "notFound" } | { kind: "redirect"; href: string } | { kind: "rethrow" };

export function confirmErrorTarget(code: string | null, draftId: string, versionId: string): ConfirmErrorTarget {
  if (code === "NOT_FOUND") return { kind: "notFound" };
  if (code === "EXPORT_CONFLICT" || code === "DRAFT_EXPIRED") return { kind: "redirect", href: `/drafts/${draftId}?v=${versionId}&error=${code}` };
  if (code && REDIRECT_CODES.has(code)) return { kind: "redirect", href: exportConfirmHref(draftId, versionId, { error: code }) };
  return { kind: "rethrow" };
}

/** Export is offered only in the draft flow and only when EXPORT_ENABLED=1 (the page and the action both check this). */
export const exportAvailable = (env: { EXPORT_ENABLED: string; FLOW_MODE: string }): boolean => env.EXPORT_ENABLED === "1" && env.FLOW_MODE === "draft";
