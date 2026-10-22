import "katex/dist/katex.min.css";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ChangesIndicator, QuestionControls, ReplacedBadge, UndoControl, type AdjustContext } from "@/components/app/draft-adjust";
import { VersionSwitcher } from "@/components/app/draft-versions";
import { LessonDraft } from "@/components/app/lesson-draft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { domainErrorCode } from "@/lib/domain/errors";
import { htmlDocument } from "@/lib/package/html-view";
import { DOCUMENT_KINDS, type DocumentKind } from "@/lib/package/schema";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { serverEnv } from "@/lib/server/env";
import { generationErrorMessage } from "@/lib/ui/messages";
import { DOCUMENT_LABELS, DOCUMENT_PURPOSE } from "@/lib/ui/lesson-view";
import { versionLabel } from "@/lib/ui/draft-versions";
import { prepareHref } from "@/lib/ui/prepare-url";

const utc = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const Search = z.object({ v: z.uuid().optional(), doc: z.enum(DOCUMENT_KINDS).optional(), error: z.string().regex(/^[A-Z_]{1,40}$/).optional() });

const linkBase = "inline-flex min-h-11 items-center rounded-tag border border-border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const linkActive = "bg-foreground text-background";

export default async function DraftPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx } = await requireAccount();
  const { id } = await params;
  const parsed = Search.safeParse(Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])));
  if (!z.uuid().safeParse(id).success || !parsed.success) notFound();
  const dal = webDal();

  let view;
  try {
    view = await dal.drafts.getDraftView(ctx, id, parsed.data.v);
  } catch (error) {
    const code = domainErrorCode(error);
    if (code === "NOT_FOUND") notFound();
    if (code === "DRAFT_EXPIRED") {
      // Recovery: the same selection on the Prepare page (a plain link to Prepare once the draft has been purged).
      const selection = await dal.drafts.getDraftSelection(ctx, id);
      return (
        <main className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
          <h1 className="font-heading text-[28px] leading-[1.2]">This draft has expired</h1>
          <Notice intent="error" className="mt-4" data-testid="draft-expired">
            {generationErrorMessage("DRAFT_EXPIRED")}
          </Notice>
          <Link href={selection ? prepareHref(selection) : "/prepare"} className={`${linkBase} mt-4`} data-testid="draft-start-again">
            Start again
          </Link>
        </main>
      );
    }
    throw error;
  }

  const available = view.documents;
  const active: DocumentKind = parsed.data.doc && available.includes(parsed.data.doc) ? parsed.data.doc : available[0]!;
  // Only the one document's view tree reaches the (server) draft component; the package itself stays here.
  const doc = htmlDocument(view.package, active);
  // The version is named in the URL only when it is not the one the draft opens on, so refresh keeps the selected version.
  const versionParam = view.versionId === view.activeVersionId ? "" : `v=${view.versionId}`;
  const tabUrl = (d: DocumentKind) => `/drafts/${view.draftId}?doc=${d}${versionParam ? `&${versionParam}` : ""}`;
  const reloadQuery = [active === available[0] ? "" : `doc=${active}`, parsed.data.v ? `v=${parsed.data.v}` : ""].filter(Boolean).join("&");
  const reloadUrl = `/drafts/${view.draftId}${reloadQuery ? `?${reloadQuery}` : ""}`;
  const adjustCtx: AdjustContext = { draftId: view.draftId, versionId: view.versionId, rev: view.rev, doc: active, adjust: view.adjust, questionCount: view.adjust.slots.length };
  const slots =
    active === "worksheet"
      ? { afterQuestion: (q: { questionId: string; number: number }) => <QuestionControls ctx={adjustCtx} questionId={q.questionId} number={q.number} /> }
      : active === "solutions"
        ? { afterSolution: (q: { questionId: string }) => <ReplacedBadge ctx={adjustCtx} questionId={q.questionId} /> }
        : undefined;
  const errorMessage = generationErrorMessage(parsed.data.error);
  const exportPending = serverEnv().FLOW_MODE === "draft";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
      <p className="text-sm text-muted-foreground">
        <Link href="/prepare" className="underline">
          Prepare
        </Link>
        {" / "}
        <span>{view.title}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-[28px] leading-[1.2]" data-testid="draft-title">
          {view.title}
        </h1>
        <Badge tone="accent">Draft</Badge>
      </div>
      <p id="editing-version" className="mt-3 scroll-mt-4 font-heading text-xl" data-testid="editing-version" data-ordinal={view.ordinal}>
        You are editing {versionLabel(view.ordinal)}
      </p>
      <p className="mt-1 text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="saved-status">
        Saved. Last change {utc.format(view.updatedAt)} UTC
      </p>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="draft-expiry">
        Draft expires {utc.format(view.expiresAt)} UTC
      </p>
      <Notice intent="info" role="status" className="mt-3" data-testid="draft-notice">
        Draft preview. Nothing has been used from your allowance.
      </Notice>
      <Notice intent="info" className="mt-3" data-testid="review-reminder">
        Read everything before you use it with a student.
      </Notice>

      {parsed.data.error === "DRAFT_CONFLICT" ? (
        <Notice id="draft-error" intent="error" className="mt-3 scroll-mt-4" data-testid="draft-conflict">
          {errorMessage}{" "}
          <a href={reloadUrl} className="underline" data-testid="draft-reload">
            Reload
          </a>
        </Notice>
      ) : errorMessage ? (
        <Notice id="draft-error" intent="error" className="mt-3 scroll-mt-4" data-testid="draft-error">
          {errorMessage}
        </Notice>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <VersionSwitcher view={view} doc={active} />
          <nav aria-label="Documents" className="mt-4 flex flex-wrap gap-2" data-testid="document-tabs">
            {available.map((d) => (
              <Link key={d} href={tabUrl(d)} aria-current={d === active ? "page" : undefined} className={`${linkBase} ${d === active ? linkActive : ""}`}>
                {DOCUMENT_LABELS[d]}
              </Link>
            ))}
          </nav>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <ChangesIndicator adjust={view.adjust} />
            <UndoControl ctx={adjustCtx} />
          </div>
          <section className="mt-4" data-testid="draft-preview" data-document={active} data-version={view.versionId}>
            <p className="text-sm text-muted-foreground">{DOCUMENT_PURPOSE[active]}</p>
            <div className="mt-3">
              <LessonDraft doc={doc} slots={slots} />
            </div>
          </section>
        </div>

        {exportPending && (
          <aside className="space-y-4">
            <Card className="p-5">
              <h2 className="font-heading text-lg">Export</h2>
              <Button type="button" disabled aria-disabled="true" className="mt-3 w-full" data-testid="draft-export-disabled">
                Export is coming next
              </Button>
              <p className="mt-2 text-[13px] text-muted-foreground">PDF export for drafts is not available yet.</p>
            </Card>
          </aside>
        )}
      </div>
    </main>
  );
}
