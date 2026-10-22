import Link from "next/link";
import { createAnotherVersion, switchToVersion } from "@/app/drafts/[id]/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DocumentKind } from "@/lib/package/schema";
import type { DraftViewDto } from "@/lib/server/dal/dto";
import { changesBadge, CREATE_VERSION_HELP, versionLabel, versionLimitNote } from "@/lib/ui/draft-versions";

// Server-rendered version switcher. Switching and creating are real forms that name the draft revision the page showed;
// nothing here needs client state. Creating needs no confirmation: the current version is kept.

const itemBase = "inline-flex min-h-11 items-center gap-2 rounded-tag border border-border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function VersionSwitcher({ view, doc }: { view: DraftViewDto; doc: DocumentKind }) {
  const limitNote = versionLimitNote(view.versions.length, view.versionLimit);
  const hidden = (
    <>
      <input type="hidden" name="draftId" value={view.draftId} />
      <input type="hidden" name="expectedDraftRev" value={view.draftRev} />
      <input type="hidden" name="doc" value={doc} />
      <input type="hidden" name="v" value={view.versionId} />
    </>
  );
  return (
    <section id="versions" className="scroll-mt-4 space-y-3" aria-labelledby="versions-heading">
      <h2 id="versions-heading" className="text-sm font-medium">
        Versions
      </h2>
      <nav aria-label="Versions" data-testid="version-switcher">
        <ul className="flex flex-wrap gap-2">
          {view.versions.map((v) => {
            const badge = changesBadge(v.changesSummary);
            const current = v.versionId === view.versionId;
            const inner = (
              <>
                {versionLabel(v.ordinal)}
                {badge ? (
                  <Badge tone="neutral" data-testid="version-changes">
                    {badge}
                  </Badge>
                ) : null}
              </>
            );
            return (
              <li key={v.versionId}>
                {current ? (
                  <Link href={`/drafts/${view.draftId}?${new URLSearchParams({ doc, v: v.versionId })}`} aria-current="page" className={`${itemBase} bg-foreground text-background`} data-testid="version-link" data-ordinal={v.ordinal}>
                    {inner}
                  </Link>
                ) : (
                  <form action={switchToVersion}>
                    {hidden}
                    <input type="hidden" name="versionId" value={v.versionId} />
                    <button type="submit" className={itemBase} data-testid="version-link" data-ordinal={v.ordinal}>
                      {inner}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <form action={createAnotherVersion} className="space-y-1">
        {hidden}
        <Button type="submit" variant="outline" disabled={limitNote !== null} aria-describedby={limitNote ? "version-limit-note" : "create-version-help"} data-testid="create-version-btn">
          Create another version
        </Button>
        <p id="create-version-help" className="text-[13px] text-muted-foreground">
          {CREATE_VERSION_HELP}
        </p>
        {limitNote ? (
          <p id="version-limit-note" className="text-[13px] text-foreground" data-testid="version-limit-note">
            {limitNote}
          </p>
        ) : null}
      </form>
    </section>
  );
}
