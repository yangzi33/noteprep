import Link from "next/link";
import { Circle, CircleCheck, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { TextAction } from "@/components/ui/text-action";
import { cn } from "cn";
import type { DocumentKind } from "@/lib/package/schema";
import { describeExportOutcome, type ExportPhase, type ExportView } from "@/lib/ui/export-view";
import { DOCUMENT_LABELS } from "@/lib/ui/lesson-view";

export type ExportOutcomeNote = "reused" | "joined";

export interface ExportStatusViewProps {
  view: ExportView;
  phase: ExportPhase;
  /** From the confirm redirect (?outcome=): an allow-listed note, never free text. */
  outcome: ExportOutcomeNote | null;
  /** The finished documents (only used once the export has succeeded). */
  documents: ReadonlyArray<{ document: DocumentKind; pages: number }>;
  cancelAction: (formData: FormData) => void | Promise<void>;
}

const OUTCOME_NOTES: Record<ExportOutcomeNote, string> = {
  reused: "You already exported this exact draft. Downloading again is free.",
  joined: "This draft is already being exported. You are watching that export.",
};

const OVERLINES: Record<ExportPhase, string> = {
  queued: "QUEUED",
  retrying: "WAITING TO RETRY",
  "running:compiling": "BUILDING",
  "running:storing": "SAVING",
  stopping: "STOPPING",
  succeeded: "COMPLETE",
  failed: "FAILED",
  canceled: "CANCELED",
  retired: "LESSON DELETED",
  confirming: "FINISHING UP",
  stalled: "STILL WORKING",
  unknown: "CHECKING",
  session_expired: "SIGNED OUT",
  not_found: "NOT FOUND",
};

const STEPS = [
  { id: "queued", label: "Confirmed and queued" },
  { id: "compiling", label: "Building your PDFs" },
  { id: "storing", label: "Saving your PDFs" },
] as const;

/** How far along the three steps are, for the live phases only. */
function stepStates(phase: ExportPhase): ("done" | "active" | "todo")[] | null {
  switch (phase) {
    case "queued":
    case "retrying":
      return ["active", "todo", "todo"];
    case "running:compiling":
      return ["done", "active", "todo"];
    case "running:storing":
      return ["done", "done", "active"];
    default:
      return null;
  }
}

const STEP_ICON = { done: CircleCheck, active: LoaderCircle, todo: Circle } as const;
const STEP_TEXT = { done: "Done", active: "In progress", todo: "Not started" } as const;

/** Stateless presentation of an export: no hooks, so it renders on the server and in unit tests. */
/** The note is shown only when the export's real state agrees with it: a URL parameter alone never says anything about cost. */
function noteApplies(note: ExportOutcomeNote | null, phase: ExportPhase): note is ExportOutcomeNote {
  if (note === "reused") return phase === "succeeded";
  if (note === "joined") return phase === "queued" || phase === "retrying" || phase === "running:compiling" || phase === "running:storing";
  return false;
}

export function ExportStatusView({ view, phase, outcome, documents, cancelAction }: ExportStatusViewProps) {
  const description = describeExportOutcome(view, phase, noteApplies(outcome, phase) ? outcome : null);
  const steps = stepStates(phase);
  const terminalJob = view.job.state === "succeeded" || view.job.state === "failed" || view.job.state === "canceled";
  const canCancel = phase !== "not_found" && phase !== "session_expired" && !terminalJob && !view.job.cancelRequested && view.state === "pending";
  const showFiles = phase === "succeeded" && view.revisionId !== null;
  const live = [description.heading, description.detail, description.charge].filter(Boolean).join(" ");

  return (
    <section className="rounded-card border border-border bg-card p-6 sm:p-8" data-testid="export-status" data-phase={phase}>
      <p className="sr-only" aria-live="polite" data-testid="export-live">
        {live}
      </p>
      <p className="text-xs font-semibold tracking-wider text-text-accent">{`EXPORT · ${OVERLINES[phase]}`}</p>
      <h1 className="mt-2 font-heading text-3xl">{description.heading}</h1>
      <p className="mt-3 text-base">{description.detail}</p>
      {description.lastKnown && <p className="mt-1 text-sm text-muted-foreground">Last known: {description.lastKnown}</p>}
      {(phase === "retrying" || phase === "running:compiling" || phase === "running:storing") && view.job.attempt > 1 && (
        <p className="mt-1 text-sm text-muted-foreground">
          Attempt {view.job.attempt} of {view.job.maxAttempts}
        </p>
      )}

      {noteApplies(outcome, phase) && (
        <Notice intent="info" className="mt-4" data-testid="export-outcome-note">
          {OUTCOME_NOTES[outcome]}
        </Notice>
      )}

      {steps && (
        <ol aria-label="Export steps" className="mt-6 space-y-3">
          {STEPS.map((step, index) => {
            const state = steps[index] ?? "todo";
            const Icon = STEP_ICON[state];
            return (
              <li key={step.id} className="flex items-center gap-3 text-sm">
                <Icon aria-hidden="true" className={cn("size-5 shrink-0", state === "active" ? "animate-spin motion-reduce:animate-none text-text-accent" : state === "done" ? "text-text-accent" : "text-muted-foreground")} />
                <span className={state === "todo" ? "text-muted-foreground" : undefined}>{step.label}</span>
                <span className="sr-only">{STEP_TEXT[state]}</span>
              </li>
            );
          })}
        </ol>
      )}

      {phase === "session_expired" && (
        <p className="mt-4">
          <a href="/login" className="inline-flex min-h-11 items-center font-semibold underline" data-testid="export-sign-in">
            Sign in
          </a>
        </p>
      )}

      {description.charge && (
        <Notice intent={description.intent === "error" ? "error" : description.intent === "success" ? "success" : "info"} className="mt-6" data-testid="export-charge">
          {description.charge}
        </Notice>
      )}
      {phase === "failed" && (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing was used. You can try again from your draft.{" "}
          <Link href="/lessons" className="inline-flex min-h-11 items-center font-semibold underline" data-testid="export-failed-back">
            Back to My lesson packs
          </Link>
        </p>
      )}

      {showFiles && (
        <div className="mt-6" data-testid="export-files">
          <Link href={`/lessons/${view.lessonId}?rev=${view.revisionId}`} className="inline-flex min-h-11 items-center font-semibold underline" data-testid="export-open-lesson">
            Open the lesson
          </Link>
          {documents.length > 0 && (
            <ul className="mt-2 space-y-1">
              {documents.map((d) => (
                <li key={d.document}>
                  <a
                    href={`/lessons/${view.lessonId}/documents/${d.document}?rev=${view.revisionId}&download=1`}
                    className="inline-flex min-h-11 items-center text-sm underline"
                    data-testid={`export-download-${d.document}`}
                  >
                    Download {DOCUMENT_LABELS[d.document]} (PDF, {d.pages} {d.pages === 1 ? "page" : "pages"})
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {canCancel && (
        <form action={cancelAction} className="mt-6">
          <input type="hidden" name="exportId" value={view.exportId} />
          <Button type="submit" variant="link" className="h-auto min-h-11 px-0">
            Cancel export
          </Button>
        </form>
      )}

      {phase === "stopping" || phase === "confirming" || phase === "unknown" || phase === "queued" || phase === "retrying" || phase === "running:compiling" || phase === "running:storing" ? (
        <p className="mt-4 text-sm text-muted-foreground">Your progress is saved. You can leave this page and find this export in My lesson packs.</p>
      ) : (
        <p className="mt-6 flex gap-6 text-sm font-semibold">
          <TextAction href="/lessons">My lesson packs</TextAction>
          <TextAction href="/prepare">Create another</TextAction>
        </p>
      )}
    </section>
  );
}
