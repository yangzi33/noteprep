import type { Metadata } from "next";
import { DraftCard, MaterialCard } from "@/components/app/material-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TextAction } from "@/components/ui/text-action";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { allowanceSentence, dailyRefreshReminder, draftCards, recentCards } from "@/lib/ui/dashboard-view";
import Link from "next/link";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const { ctx } = await requireAccount();
  const dal = webDal();
  const [allowance, items, drafts] = await Promise.all([dal.history.getAllowance(ctx), dal.history.listJobs(ctx), dal.drafts.listDrafts(ctx, 6)]);
  const cards = recentCards(items, 6);
  const draftList = draftCards(drafts, 6);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="text-[11px] font-semibold tracking-[0.16em] text-text-accent">YOUR WORKSPACE</p>
        <h1 className="font-heading text-[34px] leading-[1.2]">A little less prep. More teaching.</h1>
        <p className="text-muted-foreground">Pick a topic, and get lesson notes, a worksheet and solutions to review before you teach.</p>
      </header>

      <div className="mt-6 grid gap-4 md:grid-cols-[2fr_1fr]">
        <Card className="flex flex-col items-start gap-3 p-6">
          <h2 className="font-heading text-2xl">What are you teaching next?</h2>
          <p className="text-muted-foreground">Choose a curriculum topic and we will prepare the documents. Read them over before the lesson.</p>
          <Button asChild>
            <Link href="/prepare">Create lesson pack</Link>
          </Button>
        </Card>
        <Card className="flex flex-col gap-2 p-6">
          <h2 className="font-heading text-lg">Your allowance</h2>
          <p className="text-sm" data-testid="allowance">
            {dailyRefreshReminder(allowance) ? <span data-testid="refresh-reminder">{dailyRefreshReminder(allowance)}</span> : allowanceSentence(allowance)}
          </p>
          <p className="text-sm text-muted-foreground">A lesson pack is used only when you export your PDFs. Drafts and edits are free.</p>
        </Card>
      </div>

      {draftList.length > 0 && (
        <section aria-labelledby="drafts-heading" className="mt-10" data-testid="drafts-section">
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

      <section aria-labelledby="recent-heading" className="mt-10">
        <div className="flex items-center justify-between gap-4">
          <h2 id="recent-heading" className="font-heading text-2xl">
            Recent activity
          </h2>
          {cards.length > 0 && <TextAction href="/lessons">See all materials</TextAction>}
        </div>
        {cards.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">Your exported lesson packs will appear here.</p>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <li key={card.jobId}>
                <MaterialCard card={card} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
