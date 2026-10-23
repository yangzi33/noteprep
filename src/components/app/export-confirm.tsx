import Link from "next/link";
import { ExportConfirmButton } from "@/components/app/export-confirm-button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PAGE_FORMATS, type PageFormat } from "@/lib/latex/templates";
import type { DocumentKind } from "@/lib/package/schema";
import { DOCUMENT_LABELS } from "@/lib/ui/lesson-view";
import { generationErrorMessage } from "@/lib/ui/messages";

export const EXPORT_PROMISE = "This will use 1 generation when your PDFs are ready. If export fails, no generation is used.";

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
  /** Generations left, or null when unknown. */
  remaining: number | null;
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
  const errorMessage = generationErrorMessage(p.error);
  const gate = !p.enabled ? generationErrorMessage("EXPORT_DISABLED") : p.stale ? generationErrorMessage("EXPORT_CONFLICT") : null;
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
      <h1 className="font-heading text-[28px] leading-[1.2]" data-testid="export-title">
        Export PDFs
      </h1>
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
          {p.allowanceText}
        </p>
      </Card>

      {errorMessage && (
        <Notice intent="error" className="mt-4" data-testid="export-error">
          {errorMessage}
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
                <input type="radio" name="pageFormat" value={f} defaultChecked={f === "letter"} data-testid={`export-format-${f}`} />
                {PAGE_FORMAT_LABELS[f]}
              </label>
            ))}
            <p className="text-sm text-muted-foreground">All PDFs of this export use the format you choose. Exporting the same lesson in another format uses another generation.</p>
          </fieldset>
          <p className="text-sm font-semibold" data-testid="export-promise">
            {EXPORT_PROMISE}
          </p>
          {p.remaining !== null && p.remaining <= 0 && (
            <Notice intent="info" data-testid="export-free-note">
              You have no generations left. An unchanged re-export of a version you already exported is free.{" "}
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
