import "katex/dist/katex.min.css";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { LessonDraft } from "@/components/app/lesson-draft";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { domainErrorCode } from "@/lib/domain/errors";
import { htmlDocument } from "@/lib/package/html-view";
import { DOCUMENT_KINDS, type DocumentKind } from "@/lib/package/schema";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { DOCUMENT_LABELS, DOCUMENT_PURPOSE, alignmentNotice } from "@/lib/ui/lesson-view";

const utc = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const Search = z.object({ rev: z.uuid().optional(), doc: z.enum(DOCUMENT_KINDS).optional(), view: z.enum(["pdf", "draft"]).optional() });

const linkBase = "inline-flex min-h-11 items-center rounded-tag border border-border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const linkActive = "bg-foreground text-background";

export default async function LessonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx } = await requireAccount();
  const { id } = await params;
  const parsed = Search.safeParse(Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])));
  if (!z.uuid().safeParse(id).success || !parsed.success) notFound();
  const draftView = parsed.data.view === "draft";

  let lesson;
  try {
    lesson = await webDal().lessons.getLessonView(ctx, id, parsed.data.rev);
  } catch (error) {
    if (domainErrorCode(error) === "NOT_FOUND") notFound();
    throw error;
  }

  const available = lesson.documents.map((d) => d.document);
  const active: DocumentKind = parsed.data.doc && available.includes(parsed.data.doc) ? parsed.data.doc : available[0]!;
  const activeDoc = lesson.documents.find((d) => d.document === active)!;

  // The package is read only for the draft view, and only the one document's view tree reaches the (server) draft component.
  let draft: ReturnType<typeof htmlDocument> | null = null;
  if (draftView) {
    try {
      const { package: pkg } = await webDal().lessons.getLessonPackage(ctx, lesson.lessonId, lesson.revisionId);
      draft = htmlDocument(pkg, active);
    } catch (error) {
      if (domainErrorCode(error) === "NOT_FOUND") notFound();
      throw error;
    }
  }

  // Every link carries the revision, so the preview, the download and the tabs always show the same revision.
  const fileUrl = (doc: DocumentKind, download = false) => `/lessons/${lesson.lessonId}/documents/${doc}?rev=${lesson.revisionId}${download ? "&download=1" : ""}`;
  const tabUrl = (doc: DocumentKind, view: "pdf" | "draft" = draftView ? "draft" : "pdf") => `/lessons/${lesson.lessonId}?rev=${lesson.revisionId}&doc=${doc}${view === "draft" ? "&view=draft" : ""}`;
  const notice = lesson.alignment ? alignmentNotice(lesson.alignment) : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
      <p className="text-sm text-muted-foreground">
        <Link href="/lessons" className="underline">
          My materials
        </Link>
        {" / "}
        <span>{lesson.title}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-[28px] leading-[1.2]" data-testid="lesson-title">
          {lesson.title}
        </h1>
        <Badge tone={lesson.isCurrent ? "accent" : "neutral"}>{lesson.isCurrent ? `Version ${lesson.revisionNumber}` : "Earlier version"}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">Created {utc.format(lesson.createdAt)} UTC</p>
      <Notice intent="info" className="mt-3" data-testid="review-reminder">
        AI-assisted material can contain mistakes. Read everything before you use it with a student.
      </Notice>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <nav aria-label="Documents" className="flex flex-wrap gap-2" data-testid="document-tabs">
            {lesson.documents.map((d) => (
              <Link key={d.document} href={tabUrl(d.document)} aria-current={d.document === active ? "page" : undefined} className={`${linkBase} ${d.document === active ? linkActive : ""}`}>
                {DOCUMENT_LABELS[d.document]}
              </Link>
            ))}
          </nav>
          <nav aria-label="Preview type" className="mt-2 flex flex-wrap gap-2" data-testid="view-tabs">
            <Link href={tabUrl(active, "pdf")} aria-current={!draftView ? "true" : undefined} className={`${linkBase} ${!draftView ? linkActive : ""}`}>
              PDF preview
            </Link>
            <Link href={tabUrl(active, "draft")} aria-current={draftView ? "true" : undefined} className={`${linkBase} ${draftView ? linkActive : ""}`}>
              Draft preview
            </Link>
          </nav>

          <section className="mt-4" data-testid="document-panel" data-document={active} data-revision={lesson.revisionId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {DOCUMENT_PURPOSE[active]}
                {draftView ? null : ` · ${activeDoc.pages} ${activeDoc.pages === 1 ? "page" : "pages"}`}
              </p>
              <p className="flex gap-4 text-sm">
                <a href={fileUrl(active)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline" data-testid="open-pdf">
                  Open in a new tab
                </a>
                <a href={fileUrl(active, true)} className="inline-flex min-h-11 items-center underline" data-testid="download-pdf">
                  Download PDF
                </a>
              </p>
            </div>
            {draft ? (
              <div className="mt-3 space-y-4">
                <Notice intent="info" data-testid="draft-notice">
                  Draft preview. The exported PDF is the final version.
                </Notice>
                <LessonDraft doc={draft} />
              </div>
            ) : (
              <>
                <iframe src={fileUrl(active)} title={`${DOCUMENT_LABELS[active]} preview`} className="mt-3 h-[75vh] w-full rounded border" data-testid="pdf-frame" />
                <p className="mt-2 text-sm text-muted-foreground">If the preview does not appear in your browser, use “Open in a new tab” or “Download PDF”.</p>
              </>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <Card className="p-5" data-testid="export-card">
            <h2 className="font-heading text-lg">Export</h2>
            <ul className="mt-3 space-y-2">
              {lesson.documents.map((d) => (
                <li key={d.document}>
                  <a href={fileUrl(d.document, true)} className={`${linkBase} w-full`} data-testid={`export-${d.document}`}>
                    Download {DOCUMENT_LABELS[d.document]} (PDF)
                  </a>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-5" data-testid="alignment-panel">
            <h2 className="font-heading text-lg">Curriculum</h2>
            {lesson.alignment && notice ? (
              <>
                <p className="mt-2 text-sm" data-testid="alignment-notice">
                  {notice}
                </p>
                <ul className="mt-3 space-y-1 text-sm">
                  {lesson.alignment.objectives.map((o) => (
                    <li key={o.id}>
                      {o.officialCode ? `${o.officialCode} — ` : ""}
                      {o.label}
                      {o.coverage === "partial" && <span className="text-muted-foreground"> (partly covered{o.note ? `: ${o.note}` : ""})</span>}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-2 text-sm">No curriculum information is attached to this lesson.</p>
            )}
          </Card>
        </aside>
      </div>
    </main>
  );
}
