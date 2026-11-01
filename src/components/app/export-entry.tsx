import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { exportConfirmHref } from "@/lib/ui/export-confirm";

/** The draft page's Export card. Only in the draft flow; a live link only when export is enabled, otherwise a disabled button with an honest pause message (EXPORT_ENABLED=0 is the pause switch). */
export function ExportEntry({ flowMode, exportEnabled, draftId, versionId, rev }: { flowMode: "legacy" | "draft"; exportEnabled: boolean; draftId: string; versionId: string; rev: number }) {
  if (flowMode !== "draft") return null;
  return (
    <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
      <Card className="p-5">
        <h2 className="select-none font-heading text-lg">Export</h2>
        {exportEnabled ? (
          <>
            <Link
              href={exportConfirmHref(draftId, versionId, { rev })}
              className="mt-3 inline-flex min-h-12 w-full select-none items-center justify-center rounded-control transition-colors duration-150 active:translate-y-px bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
              data-testid="draft-export"
            >
              Export PDFs
            </Link>
            <p className="mt-2 text-[13px] text-muted-foreground">Uses 1 lesson pack when your PDFs are ready.</p>
          </>
        ) : (
          <>
            <Button type="button" disabled aria-disabled="true" className="mt-3 w-full" data-testid="draft-export-disabled">
              Export PDFs
            </Button>
            <p className="mt-2 text-[13px] text-muted-foreground">PDF export is paused right now. Your draft is saved.</p>
          </>
        )}
      </Card>
    </aside>
  );
}

/** Below lg the aside sits after the whole document, so the toolbar row carries a second way in. Same target, different test id. */
export function ExportEntryMobile({ flowMode, exportEnabled, draftId, versionId, rev }: { flowMode: "legacy" | "draft"; exportEnabled: boolean; draftId: string; versionId: string; rev: number }) {
  if (flowMode !== "draft" || !exportEnabled) return null;
  return (
    <Link
      href={exportConfirmHref(draftId, versionId, { rev })}
      className="inline-flex min-h-11 select-none items-center justify-center rounded-control transition-colors duration-150 active:translate-y-px bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring lg:hidden"
      data-testid="draft-export-mobile"
    >
      Export PDFs
    </Link>
  );
}
