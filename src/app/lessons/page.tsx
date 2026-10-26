import type { Metadata } from "next";
import { DraftCard, MaterialRow } from "@/components/app/material-card";
import { Card } from "@/components/ui/card";
import { TextAction } from "@/components/ui/text-action";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { allowanceSentence, dailyRefreshReminder, draftCards, emptyExportsText, formatUtc, statusHref } from "@/lib/ui/dashboard-view";
import { describeOutcome, stateLabel } from "@/lib/ui/messages";

export const metadata: Metadata = { title: "History" };

export default async function HistoryPage() {
  const { ctx } = await requireAccount();
  const dal = webDal();
  const [allowance, items, drafts] = await Promise.all([dal.history.getAllowance(ctx), dal.history.listJobs(ctx), dal.drafts.listDrafts(ctx)]);
  const draftList = draftCards(drafts, 50, new Date());

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold tracking-[0.16em] text-text-accent uppercase">Your workspace</p>
        <h1 className="font-heading text-[34px] leading-[1.2]">My lesson packs</h1>
        <p className="text-sm" data-testid="allowance">
          {dailyRefreshReminder(allowance) ? <span data-testid="refresh-reminder">{dailyRefreshReminder(allowance)}</span> : allowanceSentence(allowance)}
        </p>
        <p className="text-sm text-muted-foreground">Times are shown in UTC.</p>
      </header>

      {draftList.length > 0 && (
        <section aria-labelledby="drafts-heading" className="mt-6" data-testid="drafts-section">
          <h2 id="drafts-heading" className="font-heading text-2xl">
            Drafts
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Free to read and adjust. A draft uses no lesson pack until you export it.</p>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {draftList.map((card) => (
              <li key={card.draftId}>
                <DraftCard card={card} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {items.length === 0 ? (
        <Card className="mt-6 p-6">
          <p className="text-sm">{emptyExportsText(draftList.length)}</p>
          <TextAction href="/prepare">Create your first lesson pack</TextAction>
        </Card>
      ) : (
        <Card className="mt-6">
          <ul className="divide-y divide-border" data-testid="history-list">
            {items.map((item) => (
              <MaterialRow
                key={item.jobId}
                jobId={item.jobId}
                href={statusHref(item)}
                title={item.title}
                state={item.state}
                label={stateLabel(item.state)}
                date={formatUtc(item.createdAt)}
                // An export's page states exactly what happened to the lesson pack; this list never guesses it.
                outcome={item.kind === "export" ? null : describeOutcome(item.state, item.errorCode)}
              />
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
