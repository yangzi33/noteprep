import type { ExportStatusDto } from "@/lib/server/dal/dto";
import { FAILURE_REASONS } from "./messages";

/** What the browser may know about an export: no snapshot, export key, job id, reservation row, storage path or tex. */
export interface ExportView {
  exportId: string;
  state: "pending" | "succeeded" | "failed" | "retired";
  job: {
    state: "queued" | "running" | "succeeded" | "failed" | "canceled";
    stage: "generating" | "validating" | "compiling" | "storing" | null;
    attempt: number;
    maxAttempts: number;
    cancelRequested: boolean;
    errorCode: string | null;
  };
  /** held: reserved; used: consumed; not_used: released (the only server confirmation of "not used"); unknown: no reservation row. */
  charge: "held" | "used" | "not_used" | "unknown";
  lessonId: string;
  revisionId: string | null;
  deadlineAt: string;
}

const CHARGE = { reserved: "held", consumed: "used", released: "not_used" } as const;

/** Copies named fields only, so a field added to the DTO later never reaches a client by accident. */
export function toExportView(dto: ExportStatusDto): ExportView {
  return {
    exportId: dto.exportId,
    state: dto.state,
    job: {
      state: dto.job.state,
      stage: dto.job.stage,
      attempt: dto.job.attempt,
      maxAttempts: dto.job.maxAttempts,
      cancelRequested: dto.job.cancelRequested,
      errorCode: dto.job.errorCode,
    },
    charge: dto.reservation.state ? CHARGE[dto.reservation.state] : "unknown",
    lessonId: dto.lessonId,
    revisionId: dto.revisionId,
    deadlineAt: dto.deadlineAt.toISOString(),
  };
}

export type ExportPhase =
  | "queued"
  | "retrying"
  | "running:compiling"
  | "running:storing"
  | "stopping"
  | "succeeded"
  | "failed"
  | "canceled"
  | "retired"
  | "confirming"
  | "stalled"
  | "unknown"
  | "session_expired"
  | "not_found";

export interface ExportNet {
  /** The last poll failed (network error or a non-200, non-404 answer). */
  unreachable: boolean;
  /** The server answered 404. */
  gone: boolean;
  /** The status endpoint answered 401: the session is no longer valid (not a network problem). */
  expired?: boolean;
  /** The poller gave up: the export stayed in the "finishing up" state for too many polls. */
  stalled?: boolean;
}

export const isFinalPhase = (phase: ExportPhase): boolean => phase === "succeeded" || phase === "failed" || phase === "canceled" || phase === "retired" || phase === "not_found";

/** True when polling can stop: the export row itself is settled (the job and reservation settle in the same transaction). */
export const isSettledExport = (view: Pick<ExportView, "state">): boolean => view.state !== "pending";

/** The phase of the last known state, ignoring the network. */
function basePhase(view: ExportView): ExportPhase {
  const { job } = view;
  if (view.state === "succeeded") return "succeeded";
  if (view.state === "retired") return "retired";
  if (view.state === "failed") return job.state === "canceled" ? "canceled" : "failed";
  // The export is still pending. A terminal job here is a state between two commits or a drift: never say more than "finishing".
  if (job.state === "succeeded" || job.state === "failed" || job.state === "canceled") return "confirming";
  if (job.cancelRequested) return "stopping";
  if (job.state === "queued") return job.attempt > 0 ? "retrying" : "queued";
  return job.stage === "storing" ? "running:storing" : "running:compiling";
}

/** Pending export whose job is already terminal: a moment between two commits, or a drift. */
export const isConfirmingView = (view: ExportView): boolean => basePhase(view) === "confirming";

export function exportPhase(view: ExportView, net: ExportNet): ExportPhase {
  if (net.gone) return "not_found";
  const base = basePhase(view);
  if (net.stalled && base === "confirming") return "stalled";
  if (net.expired && !isFinalPhase(base)) return "session_expired";
  if (net.unreachable && !isFinalPhase(base)) return "unknown";
  return base;
}

export interface ExportDescription {
  heading: string;
  detail: string;
  /** What happened to the generation, only when the server has said so. */
  charge: string | null;
  /** For the unknown phase: what we last knew. */
  lastKnown: string | null;
  intent: "progress" | "success" | "error" | "info";
}

const NOT_USED = "No generation was used.";
const USED = "This used 1 generation.";
export const REUSED_CHARGE = "An export with the same content and page format already used 1 generation. This one used none.";

/**
 * The charge sentence, for SETTLED phases only and only when the server's reservation state agrees. A live, stopping,
 * confirming or unknown phase never prints one, whatever the charge says.
 */
function chargeSentence(view: ExportView, phase: ExportPhase): string | null {
  if ((phase === "succeeded" || phase === "retired") && view.charge === "used") return USED;
  if ((phase === "failed" || phase === "canceled") && view.charge === "not_used") return NOT_USED;
  return null;
}

/** The last known progress in words, without any charge claim. */
function progressWords(phase: ExportPhase): string {
  switch (phase) {
    case "queued":
      return "Waiting to start.";
    case "retrying":
      return "Waiting to try again.";
    case "running:compiling":
      return "Building your PDFs.";
    case "running:storing":
      return "Saving your PDFs.";
    case "stopping":
      return "Stopping.";
    default:
      return "Working on it.";
  }
}

/**
 * Tutor-facing wording for one phase. "No generation was used." appears only for a server-confirmed release and
 * "This used 1 generation." only for a consumed one; anything not yet settled stays neutral.
 */
export function describeExportOutcome(view: ExportView, phase: ExportPhase, outcome: "reused" | "joined" | null = null): ExportDescription {
  const described = describeBase(view, phase);
  // After a free re-export the usual "This used 1 generation." would read like a charge for the click just made.
  if (outcome === "reused" && phase === "succeeded" && view.charge === "used") return { ...described, charge: REUSED_CHARGE };
  return described;
}

function describeBase(view: ExportView, phase: ExportPhase): ExportDescription {
  switch (phase) {
    case "queued":
      return { heading: "Your PDFs are in the queue.", detail: "We will start building them shortly. You can leave this page; your progress is saved.", charge: chargeSentence(view, phase), lastKnown: null, intent: "progress" };
    case "retrying":
      return { heading: "Trying again.", detail: `The last attempt did not finish, so we are trying again (attempt ${Math.min(view.job.attempt + 1, view.job.maxAttempts)} of ${view.job.maxAttempts}).`, charge: chargeSentence(view, phase), lastKnown: null, intent: "progress" };
    case "running:compiling":
      return { heading: "Building your PDFs.", detail: "This usually takes a minute or less.", charge: chargeSentence(view, phase), lastKnown: null, intent: "progress" };
    case "running:storing":
      return { heading: "Saving your PDFs.", detail: "Almost done.", charge: chargeSentence(view, phase), lastKnown: null, intent: "progress" };
    case "stopping":
      return { heading: "Stopping this export.", detail: "We will confirm here when it has stopped and whether a generation was used.", charge: null, lastKnown: null, intent: "info" };
    case "confirming":
      return { heading: "Finishing up...", detail: "We are confirming the final result. This page updates by itself.", charge: null, lastKnown: null, intent: "progress" };
    case "stalled":
      return { heading: "We cannot confirm the final state.", detail: "Refresh this page later to see the result.", charge: null, lastKnown: null, intent: "info" };
    case "succeeded":
      return { heading: "Your PDFs are ready.", detail: "Open the lesson, or download each document.", charge: chargeSentence(view, phase), lastKnown: null, intent: "success" };
    case "retired":
      return { heading: "This lesson was deleted.", detail: "The PDFs of this export are no longer available. Exporting the same draft again starts a new export and uses another generation.", charge: chargeSentence(view, phase), lastKnown: null, intent: "info" };
    case "canceled":
      return { heading: "Export canceled.", detail: "You stopped this export.", charge: chargeSentence(view, phase), lastKnown: null, intent: "info" };
    case "failed": {
      const reason = (view.job.errorCode && FAILURE_REASONS[view.job.errorCode]) || "The export could not be completed.";
      return { heading: "We could not build your PDFs.", detail: reason, charge: chargeSentence(view, phase), lastKnown: null, intent: "error" };
    }
    case "unknown":
      return {
        heading: "Checking the status...",
        detail: "We cannot check the status right now. Still trying...",
        charge: null,
        lastKnown: progressWords(basePhase(view)),
        intent: "info",
      };
    case "session_expired":
      return {
        heading: "Your session has expired.",
        detail: "Your session has expired. Sign in again to see this export.",
        charge: null,
        lastKnown: progressWords(basePhase(view)),
        intent: "info",
      };
    case "not_found":
      return { heading: "Export not found.", detail: "This export does not exist, or it belongs to another account.", charge: null, lastKnown: null, intent: "error" };
  }
}
