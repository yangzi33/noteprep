"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelJobAction } from "@/app/jobs/[id]/actions";
import { Button } from "@/components/ui/button";
import { isRetrying, isTerminal, type JobView } from "@/lib/ui/job-view";
import { describeOutcome, stageLabel, stateLabel } from "@/lib/ui/messages";

const POLL_MS = 2000;

/**
 * The page is server-rendered with the job's current state, so a refresh or a return visit always shows
 * the truth. While the job is unfinished this component polls the status endpoint.
 */
export function JobStatus({ initial }: { initial: JobView }) {
  const [job, setJob] = useState<JobView>(initial);
  const [offline, setOffline] = useState(false);
  const router = useRouter();

  // When the job finishes, ask the server again: a finished curriculum lesson redirects to its preview.
  useEffect(() => {
    if (job.state === "succeeded" && initial.state !== "succeeded") router.refresh();
  }, [job.state, initial.state, router]);

  useEffect(() => {
    if (isTerminal(job.state)) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
        if (!res.ok) {
          setOffline(true);
          return;
        }
        setJob((await res.json()) as JobView);
        setOffline(false);
      } catch {
        setOffline(true);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job.id, job.state]);

  const outcome = describeOutcome(job.state, job.errorCode);
  const stage = stageLabel(job.stage);

  return (
    <section aria-live="polite" className="mt-6 rounded border p-4" data-testid="job-status" data-state={job.state}>
      <p className="text-lg font-medium" data-testid="job-state">
        {isRetrying(job) ? "Waiting to retry" : stateLabel(job.state)}
      </p>
      {stage && job.state === "running" && <p className="mt-1 text-sm">{stage}…</p>}
      {job.attempt > 1 && !isTerminal(job.state) && (
        <p className="mt-1 text-sm text-muted-foreground">
          Attempt {job.attempt} of {job.maxAttempts}
        </p>
      )}
      {job.cancelRequested && !isTerminal(job.state) && <p className="mt-1 text-sm">Cancel requested…</p>}
      {outcome && <p className="mt-2 text-sm">{outcome}</p>}
      {job.state === "succeeded" && (
        <p className="mt-2 text-sm">
          The lesson pack was saved. This build only produces placeholder files; downloads arrive with real compilation.
        </p>
      )}
      {offline && <p className="mt-2 text-sm text-muted-foreground">Connection problem; still trying…</p>}

      {!isTerminal(job.state) && !job.cancelRequested && (
        <form action={cancelJobAction} className="mt-4">
          <input type="hidden" name="jobId" value={job.id} />
          <Button type="submit" variant="outline" size="sm">
            Cancel
          </Button>
        </form>
      )}
      {isTerminal(job.state) && (
        <p className="mt-4 flex gap-4 text-sm">
          <Link href="/lessons" className="underline">
            History
          </Link>
          <Link href="/prepare" className="underline">
            New lesson
          </Link>
        </p>
      )}
    </section>
  );
}
