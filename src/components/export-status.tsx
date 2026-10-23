"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelExportAction } from "@/app/exports/[id]/actions";
import { ExportStatusView, type ExportOutcomeNote } from "@/components/export-status-view";
import type { DocumentKind } from "@/lib/package/schema";
import { startExportPoller } from "@/lib/ui/export-poller";
import { exportPhase, isSettledExport, type ExportNet, type ExportView } from "@/lib/ui/export-view";

const POLL_MS = 2000;

/**
 * The page is server-rendered with the export's current state, so a refresh or a return visit shows the truth. While the
 * export is unfinished this polls the status endpoint. A failed poll keeps the last known state and says so; it never
 * decides the outcome.
 */
export function ExportStatus({
  initial,
  documents,
  outcome,
}: {
  initial: ExportView;
  documents: ReadonlyArray<{ document: DocumentKind; pages: number }>;
  outcome: ExportOutcomeNote | null;
}) {
  const [view, setView] = useState<ExportView>(initial);
  const [net, setNet] = useState<ExportNet>({ unreachable: false, gone: false, expired: false });
  const router = useRouter();

  // On the transition to a settled state, ask the server again: it knows the documents of a finished export.
  useEffect(() => {
    if (isSettledExport(view) && !isSettledExport(initial)) router.refresh();
  }, [view, initial, router]);

  useEffect(() => {
    if (isSettledExport(initial)) return;
    return startExportPoller({ exportId: initial.exportId, intervalMs: POLL_MS, onView: setView, onNet: setNet });
  }, [initial]);

  return <ExportStatusView view={view} phase={exportPhase(view, net)} outcome={outcome} documents={documents} cancelAction={cancelExportAction} />;
}
