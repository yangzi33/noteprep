import { MaterialRow } from "@/components/app/material-card";
import { Card } from "@/components/ui/card";
import { TextAction } from "@/components/ui/text-action";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { allowanceSentence, formatUtc } from "@/lib/ui/dashboard-view";
import { describeOutcome, stateLabel } from "@/lib/ui/messages";

export default async function HistoryPage() {
  const { ctx } = await requireAccount();
  const dal = webDal();
  const [allowance, items] = await Promise.all([dal.history.getAllowance(ctx), dal.history.listJobs(ctx)]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="text-[11px] font-semibold tracking-[0.16em] text-text-accent">YOUR WORKSPACE</p>
        <h1 className="font-heading text-[34px] leading-[1.2]">My materials</h1>
        <p className="text-sm" data-testid="allowance">
          {allowanceSentence(allowance)}
        </p>
        <p className="text-sm text-muted-foreground">Times are shown in UTC. Deleting a lesson never gives a generation back.</p>
      </header>

      {items.length === 0 ? (
        <Card className="mt-6 p-6">
          <p className="text-sm">Nothing here yet.</p>
          <TextAction href="/prepare">Create your first lesson</TextAction>
        </Card>
      ) : (
        <Card className="mt-6">
          <ul className="divide-y divide-border" data-testid="history-list">
            {items.map((item) => (
              <MaterialRow
                key={item.jobId}
                jobId={item.jobId}
                title={item.title}
                state={item.state}
                label={stateLabel(item.state)}
                date={formatUtc(item.createdAt)}
                outcome={describeOutcome(item.state, item.errorCode)}
              />
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
