"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cancelExportAction } from "@/app/exports/[id]/actions";
import { ExportStatusView, type ExportOutcomeNote } from "@/components/export-status-view";
import type { DocumentKind } from "@/lib/package/schema";
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
  const [net, setNet] = useState<ExportNet>({ unreachable: false, gone: false });
  const router = useRouter();

  // On the transition to a settled state, ask the server again: it knows the documents of a finished export.
  useEffect(() => {
    if (isSettledExport(view) && !isSettledExport(initial)) router.refresh();
  }, [view, initial, router]);

  useEffect(() => {
    if (isSettledExport(view) || net.gone) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/exports/${view.exportId}`, { cache: "no-store" });
        if (res.status === 404) {
          setNet({ unreachable: false, gone: true });
          return;
        }
        if (!res.ok) {
          setNet((n) => ({ ...n, unreachable: true }));
          return;
        }
        setView((await res.json()) as ExportView);
        setNet({ unreachable: false, gone: false });
      } catch {
        setNet((n) => ({ ...n, unreachable: true }));
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [view, net.gone]);

  return <ExportStatusView view={view} phase={exportPhase(view, net)} outcome={outcome} documents={documents} cancelAction={cancelExportAction} />;
}
