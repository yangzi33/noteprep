import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startExportPoller } from "@/lib/ui/export-poller";
import type { ExportNet, ExportView } from "@/lib/ui/export-view";

const view = (state: ExportView["state"] = "pending", over: Partial<ExportView> = {}): ExportView => ({
  exportId: "e1", state, job: { state: "queued", stage: null, attempt: 0, maxAttempts: 3, cancelRequested: false, errorCode: null }, charge: "held", lessonId: "l", revisionId: null, deadlineAt: "x", ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(fetchImpl: ReturnType<typeof vi.fn>) {
  const views: ExportView[] = [];
  const nets: ExportNet[] = [];
  const stop = startExportPoller({ exportId: "e1", intervalMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch, onView: (v) => views.push(v), onNet: (n) => nets.push(n) });
  return { views, nets, stop };
}
const tick = (ms = 1000) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startExportPoller", () => {
  it("polls the status endpoint with no-store and reports the view", async () => {
    const f = vi.fn().mockResolvedValue(json(view()));
    const { views, nets, stop } = setup(f);
    await tick();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe("/api/exports/e1");
    expect(f.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
    expect(views).toHaveLength(1);
    expect(nets.at(-1)).toEqual({ unreachable: false, gone: false, expired: false });
    stop();
  });

  it("never overlaps requests: a slow answer skips the ticks that pass meanwhile", async () => {
    let resolve!: (r: Response) => void;
    const f = vi.fn().mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
    const { views, stop } = setup(f);
    await tick(5000);
    expect(f).toHaveBeenCalledTimes(1);
    resolve(json(view()));
    await tick(0);
    expect(views).toHaveLength(1);
    await tick();
    expect(f).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores an answer that arrives after stop (unmount), and aborts the request", async () => {
    let resolve!: (r: Response) => void;
    let signal!: AbortSignal;
    const f = vi.fn().mockImplementation((_u: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((r) => (resolve = r));
    });
    const { views, nets, stop } = setup(f);
    await tick();
    stop();
    expect(signal.aborted).toBe(true);
    resolve(json(view("succeeded")));
    await tick(0);
    expect(views).toEqual([]);
    expect(nets).toEqual([]);
  });

  it("an aborted request is not reported as a network problem", async () => {
    const f = vi.fn().mockImplementation((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const { nets, stop } = setup(f);
    await tick();
    stop();
    await tick(0);
    expect(nets).toEqual([]);
  });

  it("clears the timer on stop: no request after unmount", async () => {
    const f = vi.fn().mockResolvedValue(json(view()));
    const { stop } = setup(f);
    await tick();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await tick(10_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("stops by itself once the export has settled", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(view())).mockResolvedValueOnce(json(view("succeeded", { revisionId: "r" }))).mockResolvedValue(json(view()));
    const { views } = setup(f);
    await tick(2000);
    expect(views.map((v) => v.state)).toEqual(["pending", "succeeded"]);
    expect(vi.getTimerCount()).toBe(0);
    await tick(10_000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("404 reports gone and stops polling", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "not_found" }, 404));
    const { nets, views } = setup(f);
    await tick();
    expect(nets.at(-1)).toMatchObject({ gone: true, unreachable: false });
    expect(views).toEqual([]);
    await tick(10_000);
    expect(f).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("401 reports an expired session and stops polling", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "unauthenticated" }, 401));
    const { nets } = setup(f);
    await tick();
    expect(nets.at(-1)).toMatchObject({ expired: true, gone: false, unreachable: false });
    await tick(10_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 500 or a network error keeps the last view, reports unreachable and keeps polling; recovery clears it", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(view())).mockResolvedValueOnce(json({}, 500)).mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(json(view()));
    const { views, nets, stop } = setup(f);
    await tick();
    await tick();
    expect(nets.at(-1)).toMatchObject({ unreachable: true });
    await tick();
    expect(nets.at(-1)).toMatchObject({ unreachable: true });
    expect(views).toHaveLength(1); // nothing overwrote the last known view
    await tick();
    expect(nets.at(-1)).toMatchObject({ unreachable: false });
    expect(f).toHaveBeenCalledTimes(4);
    stop();
  });

  it("gives up after too many polls in the finishing-up state, with a stalled net and no more requests", async () => {
    const confirming = view("pending", { job: { state: "succeeded", stage: null, attempt: 1, maxAttempts: 3, cancelRequested: false, errorCode: null } });
    const f = vi.fn().mockImplementation(async () => json(confirming));
    const views: ExportView[] = [];
    const nets: ExportNet[] = [];
    startExportPoller({ exportId: "e1", intervalMs: 1000, maxConfirmingPolls: 3, fetchImpl: f as unknown as typeof fetch, onView: (v) => views.push(v), onNet: (n) => nets.push(n) });
    await tick(10_000);
    expect(f).toHaveBeenCalledTimes(3);
    expect(nets.at(-1)).toMatchObject({ stalled: true });
  });

  it("an ordinary pending state resets the finishing-up count", async () => {
    const confirming = view("pending", { job: { state: "failed", stage: null, attempt: 1, maxAttempts: 3, cancelRequested: false, errorCode: null } });
    const queue = [confirming, confirming, view(), confirming];
    const f = vi.fn().mockImplementation(async () => json(queue.shift() ?? confirming));
    const nets: ExportNet[] = [];
    const stop = startExportPoller({ exportId: "e1", intervalMs: 1000, maxConfirmingPolls: 3, fetchImpl: f as unknown as typeof fetch, onView: () => {}, onNet: (n) => nets.push(n) });
    await tick(5000);
    expect(nets.some((n) => n.stalled)).toBe(false);
    stop();
  });
});
