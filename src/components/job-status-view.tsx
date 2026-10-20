import Link from "next/link";
import { Circle, CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { cn } from "cn";
import { jobHeading, jobOverline, jobSteps, stepStateText, type StepState } from "@/lib/ui/job-steps";
import { isRetrying, isTerminal, type JobView } from "@/lib/ui/job-view";
import { describeOutcome, stateLabel } from "@/lib/ui/messages";

const STEP_ICONS = { done: CircleCheck, active: LoaderCircle, todo: Circle, failed: CircleAlert } as const;

const STEP_ICON_STYLES: Record<StepState, string> = {
  done: "text-text-accent",
  active: "animate-spin text-text-accent",
  todo: "text-muted-foreground",
  failed: "text-destructive",
};

/** Stateless presentation of a job: no hooks, so it renders on the server and in unit tests. */
export function JobStatusView({
  job,
  offline,
  panel,
  cancelAction,
}: {
  job: JobView;
  offline: boolean;
  panel: { href: string | null; text: string };
  cancelAction: (formData: FormData) => void | Promise<void>;
}) {
  const terminal = isTerminal(job.state);
  const outcome = describeOutcome(job.state, job.errorCode);

  return (
    <section
      aria-live="polite"
      className="rounded-card border border-border bg-card p-6 sm:p-8"
      data-testid="job-status"
      data-state={job.state}
    >
      <p className="text-xs font-semibold tracking-wider text-text-accent">{jobOverline(job)}</p>
      <h1 className="mt-2 font-heading text-3xl">{jobHeading(job)}</h1>

      <p className="mt-3 text-base" data-testid="job-state">
        {isRetrying(job) ? "Waiting to retry" : stateLabel(job.state)}
      </p>
      {job.attempt > 1 && !terminal && (
        <p className="mt-1 text-sm text-muted-foreground">
          Attempt {job.attempt} of {job.maxAttempts}
        </p>
      )}
      {job.cancelRequested && !terminal && <p className="mt-1 text-sm">Cancel requested…</p>}

      <ol aria-label="Generation steps" className="mt-6 space-y-3">
        {jobSteps(job).map((step) => {
          const Icon = STEP_ICONS[step.state];
          return (
            <li key={step.id} className="flex items-center gap-3 text-sm">
              <Icon aria-hidden="true" className={cn("size-5 shrink-0", STEP_ICON_STYLES[step.state])} />
              <span className={step.state === "todo" ? "text-muted-foreground" : undefined}>{step.label}</span>
              <span className="sr-only">{stepStateText(step.state)}</span>
            </li>
          );
        })}
      </ol>

      {job.state === "succeeded" ? (
        <Notice intent="success" className="mt-6" data-testid="job-succeeded">
          <p>{panel.text}</p>
          {panel.href && (
            <Link href={panel.href} className="mt-1 inline-block font-semibold underline">
              Open the preview
            </Link>
          )}
        </Notice>
      ) : (
        outcome && (
          <Notice intent={job.state === "failed" ? "error" : "info"} className="mt-6">
            {outcome}
          </Notice>
        )
      )}

      {offline && <p className="mt-4 text-sm text-muted-foreground">Connection problem; still trying…</p>}

      {!terminal && !job.cancelRequested && (
        <form action={cancelAction} className="mt-6">
          <input type="hidden" name="jobId" value={job.id} />
          <Button type="submit" variant="link" className="h-auto min-h-11 px-0">
            Cancel generation
          </Button>
        </form>
      )}
      {terminal && (
        <p className="mt-6 flex gap-6 text-sm font-semibold">
          <Link href="/lessons" className="text-primary underline underline-offset-4">
            My materials
          </Link>
          <Link href="/prepare" className="text-primary underline underline-offset-4">
            Create another
          </Link>
        </p>
      )}
      {!terminal && (
        <p className="mt-4 text-sm text-muted-foreground">
          Your progress is saved. You can leave this page and find your lesson in My materials.
        </p>
      )}
    </section>
  );
}
