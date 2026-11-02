"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelExportAction } from "@/app/exports/[id]/actions";
import { ExportStatusView, type ExportOutcomeNote } from "@/components/export-status-view";
import type { DocumentKind } from "@/lib/package/schema";
import { startExportPoller } from "@/lib/ui/export-poller";
import { exportPhase, isFinalPhase, isQueueSlow, isSettledExport, type ExportNet, type ExportView } from "@/lib/ui/export-view";

const POLL_MS = 2000;
const CLOCK_MS = 5000;

/**
 * The page is server-rendered with the export's current state, so a refresh or a return visit shows the truth. While the
 * export is unfinished this polls the status endpoint. A failed poll keeps the last known state and says so; it never
 * decides the outcome.
 */
export function ExportStatus({
  initial,
  documents,
  outcome,
  lessonGone = false,
}: {
  initial: ExportView;
  documents: ReadonlyArray<{ document: DocumentKind; pages: number }>;
  outcome: ExportOutcomeNote | null;
  lessonGone?: boolean;
}) {
  const [view, setView] = useState<ExportView>(initial);
  const [net, setNet] = useState<ExportNet>({ unreachable: false, gone: false, expired: false });
  // null until mounted: the server render and the first client render agree, and the notice appears from the first tick.
  const [now, setNow] = useState<number | null>(null);
  const router = useRouter();
  const phase = exportPhase(view, net);
  const final = isFinalPhase(phase);

  useEffect(() => {
    if (final) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [final]);

  // On the transition to a settled state, ask the server again: it knows the documents of a finished export.
  useEffect(() => {
    if (isSettledExport(view) && !isSettledExport(initial)) router.refresh();
  }, [view, initial, router]);

  useEffect(() => {
    if (isSettledExport(initial)) return;
    return startExportPoller({ exportId: initial.exportId, intervalMs: POLL_MS, onView: setView, onNet: setNet });
  }, [initial]);

  return <ExportStatusView view={view} phase={phase} outcome={outcome} documents={documents} cancelAction={cancelExportAction} slow={now !== null && isQueueSlow(view, phase, now)} lessonGone={lessonGone} />;
}
