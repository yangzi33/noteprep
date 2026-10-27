import Link from "next/link";
import { ContactText } from "@/components/app/contact-link";
import { ExportConfirmButton } from "@/components/app/export-confirm-button";
import { FLOW_STEPS, StepIndicator } from "@/components/app/step-indicator";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PAGE_FORMATS, type PageFormat } from "@/lib/latex/templates";
import type { DocumentKind } from "@/lib/package/schema";
import { DOCUMENT_LABELS, REVIEW_REMINDER } from "@/lib/ui/lesson-view";
import { generationErrorMessage, type AllowanceSourceKind } from "@/lib/ui/messages";

export const EXPORT_PROMISE = "This will use 1 lesson pack when your PDFs are ready. If export fails, no lesson pack is used.";

export const PAGE_FORMAT_LABELS: Record<PageFormat, string> = { letter: "US Letter (8.5 x 11 in)", a4: "A4 (210 x 297 mm)" };

export interface ExportConfirmProps {
  draftId: string;
  versionId: string;
  title: string;
  versionLabel: string;
  documents: readonly DocumentKind[];
  questionCount: number;
  changes: string;
  allowanceText: string;
  /** Lesson packs left, or null when unknown. */
  remaining: number | null;
  /** Where the allowance comes from; picks the wording of an exhausted error. */
  source?: AllowanceSourceKind | null;
  /** The beta daily-refresh reminder, when the daily allowance applies. */
  reminder?: string | null;
  /** "After this export you will have N left today.", when it applies. */
  afterText?: string | null;
  rev: number;
  contentHash: string;
  formKey: string;
  enabled: boolean;
  /** The page was opened for a revision other than the current one. */
  stale: boolean;
  error: string | null;
  /** The server action that confirms (passed in so this view stays free of server-only code). */
  action: (formData: FormData) => void | Promise<void>;
}

/** The confirmation page body. Receives only facts about the draft, never the package; the form carries ids, the revision and hash the tutor saw, and a key. */
export function ExportConfirmView(p: ExportConfirmProps) {
  const back = `/drafts/${p.draftId}?v=${p.versionId}`;
  const errorMessage = generationErrorMessage(p.error, p.source ?? null);
  const gate = !p.enabled ? generationErrorMessage("EXPORT_DISABLED") : p.stale ? generationErrorMessage("EXPORT_CONFLICT") : null;
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
      <h1 className="font-heading text-[28px] leading-[1.2]" data-testid="export-title">
        Export PDFs
      </h1>
      <div className="mt-3">
        <StepIndicator steps={FLOW_STEPS} current={3} />
      </div>
      <Card className="mt-4 p-5">
        <h2 className="font-heading text-lg">{p.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{p.versionLabel}</p>
        <ul className="mt-3 list-disc pl-5 text-sm" data-testid="export-documents">
          {p.documents.map((d) => (
            <li key={d}>{DOCUMENT_LABELS[d]}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm">
          {p.questionCount} question{p.questionCount === 1 ? "" : "s"} · {p.changes}
        </p>
        <p className="mt-3 text-sm" data-testid="export-balance">
          {p.reminder ? <span data-testid="refresh-reminder">{p.reminder}</span> : p.allowanceText}
        </p>
        {p.afterText && (
          <p className="mt-1 text-sm" data-testid="export-after">
            {p.afterText}
          </p>
        )}
      </Card>

      {errorMessage && (
        <Notice intent="error" className="mt-4" data-testid="export-error">
          <ContactText text={errorMessage} />
        </Notice>
      )}

      {gate ? (
        <Notice intent="error" className="mt-4" data-testid={p.enabled ? "export-conflict" : "export-disabled"}>
          {gate}{" "}
          {p.enabled && (
            <Link href={back} className="underline" data-testid="export-review">
              Review the draft
            </Link>
          )}
        </Notice>
      ) : (
        <form action={p.action} className="mt-4 flex flex-col gap-4">
          <input type="hidden" name="draftId" value={p.draftId} />
          <input type="hidden" name="versionId" value={p.versionId} />
          <input type="hidden" name="expectedRev" value={p.rev} />
          <input type="hidden" name="expectedContentHash" value={p.contentHash} />
          <input type="hidden" name="key" value={p.formKey} />
          <fieldset className="flex flex-col gap-2" data-testid="export-page-format">
            <legend className="text-sm font-semibold">Page format</legend>
            {PAGE_FORMATS.map((f) => (
              <label key={f} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name="pageFormat" className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring" value={f} defaultChecked={f === "letter"} data-testid={`export-format-${f}`} />
                {PAGE_FORMAT_LABELS[f]}
              </label>
            ))}
            <p className="text-sm text-muted-foreground">All PDFs use this page size. Exporting the same content in the same size again is free while the lesson still exists.</p>
          </fieldset>
          <p className="text-sm font-semibold" data-testid="export-promise">
            {EXPORT_PROMISE}
          </p>
          <p className="text-sm text-muted-foreground" data-testid="export-review-reminder">
            {REVIEW_REMINDER}
          </p>
          {p.remaining !== null && p.remaining <= 0 && (
            <Notice intent="info" data-testid="export-free-note">
              {p.source === "daily"
                ? "You have used all of today's free lesson packs. The count comes back at 00:00 UTC. An unchanged re-export of a version you already exported is free."
                : "You have used all your free lesson packs. An unchanged re-export of a version you already exported is free."}{" "}
              <ContactText text="To get more, contact us." />{" "}
              <Link href="/account" className="underline">
                See your account
              </Link>
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <ExportConfirmButton />
            <Link href={back} className="inline-flex min-h-11 items-center rounded-tag border border-border px-4 text-sm font-medium" data-testid="export-back">
              Back to editing
            </Link>
          </div>
        </form>
      )}
    </main>
  );
}
