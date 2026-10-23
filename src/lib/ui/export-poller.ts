import type { ExportNet, ExportView } from "./export-view";

export interface ExportPollerOptions {
  exportId: string;
  intervalMs: number;
  onView: (view: ExportView) => void;
  onNet: (net: ExportNet) => void;
  fetchImpl?: typeof fetch;
}

const OK: ExportNet = { unreachable: false, gone: false, expired: false };

/**
 * Polls the export status endpoint until the export settles, answers 404 or 401, or the caller stops it. Framework free so
 * it can be tested with fake timers. At most one request is in flight (a slow answer skips ticks instead of piling up), an
 * answer is applied only if it belongs to the newest request of a poller that is still running, and stop() aborts the
 * pending request and clears the timer.
 */
export function startExportPoller(options: ExportPollerOptions): () => void {
  const doFetch = options.fetchImpl ?? fetch;
  let stopped = false;
  let inFlight = false;
  let latest = 0;
  let controller: AbortController | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    controller?.abort();
  };

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    const mine = ++latest;
    controller = new AbortController();
    try {
      const res = await doFetch(`/api/exports/${options.exportId}`, { cache: "no-store", signal: controller.signal });
      const body: unknown = res.ok ? await res.json() : null;
      if (stopped || mine !== latest) return; // a stale answer never overwrites a newer state
      if (res.status === 404) {
        options.onNet({ ...OK, gone: true });
        stop();
      } else if (res.status === 401) {
        options.onNet({ ...OK, expired: true });
        stop();
      } else if (!res.ok) {
        options.onNet({ ...OK, unreachable: true });
      } else {
        const view = body as ExportView;
        options.onView(view);
        options.onNet(OK);
        if (view.state !== "pending") stop();
      }
    } catch {
      if (!stopped && mine === latest) options.onNet({ ...OK, unreachable: true });
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => void tick(), options.intervalMs);
  return stop;
}
