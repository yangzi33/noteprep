"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelJobAction } from "@/app/jobs/[id]/actions";
import { JobStatusView } from "@/components/job-status-view";
import { isTerminal, type JobView } from "@/lib/ui/job-view";
import { succeededPanel } from "@/lib/ui/lesson-view";

const POLL_MS = 2000;

/**
 * The page is server-rendered with the job's current state, so a refresh or a return visit always shows
 * the truth. While the job is unfinished this component polls the status endpoint.
 */
export function JobStatus({ initial, hasPreview = false }: { initial: JobView; hasPreview?: boolean }) {
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

  const panel = succeededPanel(job, { serverConfirmed: initial.state === "succeeded", hasPreview });

  return <JobStatusView job={job} offline={offline} panel={panel} cancelAction={cancelJobAction} />;
}
