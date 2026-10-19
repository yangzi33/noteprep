import Link from "next/link";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { describeOutcome, stateLabel } from "@/lib/ui/messages";

const utc = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export default async function HistoryPage() {
  const { ctx } = await requireAccount();
  const dal = webDal();
  const [allowance, items] = await Promise.all([dal.history.getAllowance(ctx), dal.history.listJobs(ctx)]);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">History</h1>
      <p className="mt-2 text-sm" data-testid="allowance">
        {allowance
          ? `${allowance.remaining} of ${allowance.limit} generations left${allowance.pending > 0 ? ` (${allowance.pending} in progress)` : ""}.`
          : "Your account is being set up."}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">Times are shown in UTC. Deleting a lesson never gives a generation back.</p>

      {items.length === 0 ? (
        <p className="mt-6 text-sm">
          Nothing here yet.{" "}
          <Link href="/lessons/new" className="underline">
            Create your first lesson
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-6 divide-y rounded border" data-testid="history-list">
          {items.map((item) => (
            <li key={item.jobId} className="flex items-center justify-between gap-4 p-3 text-sm" data-state={item.state}>
              <div>
                <Link href={`/jobs/${item.jobId}`} className="font-medium underline">
                  {item.title}
                </Link>
                <p className="text-muted-foreground">{utc.format(item.createdAt)} UTC</p>
                {describeOutcome(item.state, item.errorCode) && (
                  <p className="text-muted-foreground">{describeOutcome(item.state, item.errorCode)}</p>
                )}
              </div>
              <span className="whitespace-nowrap rounded border px-2 py-1">{stateLabel(item.state)}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
