import { describe, expect, it } from "vitest";
import { describeExportOutcome, exportPhase, isFinalPhase, isSettledExport, toExportView, type ExportPhase, type ExportView } from "@/lib/ui/export-view";

const dto = (over: Record<string, unknown> = {}, job: Record<string, unknown> = {}, reservation: string | null = "reserved") =>
  ({
    exportId: "e-1",
    state: "pending",
    job: { state: "queued", stage: null, attempt: 0, maxAttempts: 3, cancelRequested: false, errorCode: null, ...job },
    reservation: { state: reservation },
    lessonId: "l-1",
    revisionId: null,
    deadlineAt: new Date("2026-10-24T10:00:00Z"),
    ...over,
  }) as Parameters<typeof toExportView>[0];

const view = (over: Record<string, unknown> = {}, job: Record<string, unknown> = {}, reservation: string | null = "reserved"): ExportView => toExportView(dto(over, job, reservation));
const ok = { unreachable: false, gone: false };
const phase = (v: ExportView, net = ok): ExportPhase => exportPhase(v, net);
const text = (v: ExportView, net = ok) => {
  const d = describeExportOutcome(v, phase(v, net));
  return [d.heading, d.detail, d.charge ?? ""].join(" | ");
};

describe("toExportView", () => {
  it("maps reservation to charge and serializes the deadline", () => {
    expect(view().charge).toBe("held");
    expect(view({}, {}, "consumed").charge).toBe("used");
    expect(view({}, {}, "released").charge).toBe("not_used");
    expect(view({}, {}, null).charge).toBe("unknown");
    expect(view().deadlineAt).toBe("2026-10-24T10:00:00.000Z");
  });
  it("exposes no snapshot, key, job id, reservation or path", () => {
    const polluted = { ...dto(), snapshotId: "s", exportKey: "k", jobId: "j", path: "/x", texPath: "t.tex" } as never;
    const keys = JSON.stringify(Object.keys(toExportView(polluted)).concat(Object.keys(toExportView(polluted).job)));
    expect(keys).not.toMatch(/snapshot|exportKey|jobId|path|tex|reservation/i);
    expect(JSON.stringify(toExportView(polluted))).not.toMatch(/"s"|"k"|"j"|\/x|\.tex/);
  });
});

describe("retired export (the lesson was deleted)", () => {
  const retired = () => view({ state: "retired", revisionId: "r-1" }, { state: "succeeded" }, "consumed");
  it("is a final phase that says the lesson was deleted, whatever the network says, and keeps the truthful charge", () => {
    expect(phase(retired())).toBe("retired");
    expect(phase(retired(), { unreachable: true, gone: false })).toBe("retired");
    const d = describeExportOutcome(retired(), "retired");
    expect(d.heading).toBe("This lesson was deleted.");
    expect(d.detail).toContain("starts a new export and uses another generation");
    expect(d.charge).toBe("This used 1 generation.");
    expect(isFinalPhase("retired")).toBe(true);
    expect(isSettledExport(retired())).toBe(true);
  });
});

describe("exportPhase", () => {
  it("covers every live and terminal state", () => {
    expect(phase(view())).toBe("queued");
    expect(phase(view({}, { attempt: 1 }))).toBe("retrying");
    expect(phase(view({}, { state: "running", stage: "compiling", attempt: 1 }))).toBe("running:compiling");
    expect(phase(view({}, { state: "running", stage: "storing", attempt: 1 }))).toBe("running:storing");
    expect(phase(view({}, { state: "running", stage: null, attempt: 1 }))).toBe("running:compiling");
    expect(phase(view({}, { state: "running", stage: "compiling", cancelRequested: true }))).toBe("stopping");
    expect(phase(view({ state: "succeeded", revisionId: "r-1" }, { state: "succeeded" }, "consumed"))).toBe("succeeded");
    expect(phase(view({ state: "failed" }, { state: "failed", errorCode: "compile_failed" }, "released"))).toBe("failed");
    expect(phase(view({ state: "failed" }, { state: "canceled", errorCode: "canceled" }, "released"))).toBe("canceled");
  });
  it("is confirming while a terminal job's reservation is not yet released or consumed", () => {
    expect(phase(view({}, { state: "failed", errorCode: "compile_failed" }, "reserved"))).toBe("confirming");
    expect(phase(view({}, { state: "canceled" }, "reserved"))).toBe("confirming");
    expect(phase(view({}, { state: "succeeded" }, "consumed"))).toBe("confirming"); // export row not yet succeeded
  });
  it("network: gone is not_found; unreachable is unknown unless the state is already final", () => {
    expect(phase(view(), { unreachable: false, gone: true })).toBe("not_found");
    expect(phase(view(), { unreachable: true, gone: false })).toBe("unknown");
    expect(phase(view({ state: "succeeded", revisionId: "r" }, { state: "succeeded" }, "consumed"), { unreachable: true, gone: false })).toBe("succeeded");
  });
});

describe("describeExportOutcome: what happened to the generation", () => {
  const all = (): ExportView[] => [
    view(),
    view({}, { attempt: 1 }),
    view({}, { state: "running", stage: "compiling" }),
    view({}, { state: "running", stage: "storing" }),
    view({}, { state: "running", cancelRequested: true }),
    view({}, { state: "failed", errorCode: "compile_failed" }, "reserved"),
    view({}, { state: "canceled" }, "reserved"),
    view({ state: "failed" }, { state: "failed", errorCode: "compile_failed" }, "released"),
    view({ state: "failed" }, { state: "canceled", errorCode: "canceled" }, "released"),
    view({ state: "succeeded", revisionId: "r" }, { state: "succeeded" }, "consumed"),
    view({}, {}, null),
  ];
  it("says 'No generation was used.' only when the server confirmed a release", () => {
    for (const v of all()) {
      const t = text(v);
      expect(t.includes("No generation was used."), `${phase(v)} ${v.charge}`).toBe(v.charge === "not_used");
    }
  });
  it("says 'This used 1 generation.' only when consumed", () => {
    for (const v of all()) expect(text(v).includes("This used 1 generation."), phase(v)).toBe(v.charge === "used");
  });
  it("never claims 'not used' for a failed job whose reservation is still held, and shows the neutral state", () => {
    const v = view({}, { state: "failed", errorCode: "compile_failed" }, "reserved");
    expect(text(v)).toContain("Finishing up");
    expect(text(v)).not.toMatch(/not used|No generation was used/i);
  });
  it("unreachable keeps the last known state, says so, and never claims not used", () => {
    const running = view({}, { state: "running", stage: "storing" });
    const d = describeExportOutcome(running, phase(running, { unreachable: true, gone: false }));
    expect(d.detail + d.heading).toContain("We cannot check the status right now. Still trying...");
    expect(d.detail + d.heading + (d.charge ?? "")).not.toMatch(/No generation was used|used 1/);
    expect(d.lastKnown).toMatch(/saving/i);
  });
  it("failure reasons come from the failure table", () => {
    const v = view({ state: "failed" }, { state: "failed", errorCode: "compile_timeout" }, "released");
    expect(text(v)).toContain("Building the documents took too long.");
    const unknown = view({ state: "failed" }, { state: "failed", errorCode: "zzz" }, "released");
    expect(text(unknown)).toContain("could not be completed");
  });
  it("not found has no charge sentence", () => {
    const d = describeExportOutcome(view(), "not_found");
    expect(d.charge).toBeNull();
    expect(d.heading).toMatch(/not found/i);
  });
});

describe("charge sentence: settled phases only, every phase x charge", () => {
  const phases: ExportPhase[] = ["queued", "retrying", "running:compiling", "running:storing", "stopping", "succeeded", "failed", "canceled", "retired", "confirming", "unknown", "session_expired", "not_found"];
  const charges: ExportView["charge"][] = ["held", "used", "not_used", "unknown"];
  for (const p of phases) {
    for (const c of charges) {
      it(`${p} x ${c}`, () => {
        const d = describeExportOutcome({ ...view(), charge: c }, p);
        const expected = (p === "succeeded" || p === "retired") && c === "used" ? "This used 1 generation." : (p === "failed" || p === "canceled") && c === "not_used" ? "No generation was used." : null;
        expect(d.charge).toBe(expected);
        const prose = [d.heading, d.detail, d.lastKnown ?? ""].join(" ");
        expect(prose).not.toMatch(/No generation was used|used 1 generation|held/i);
      });
    }
  }
});

describe("session expired", () => {
  it("401 on a live export is session_expired with the sign-in sentence and no charge", () => {
    const v = view({}, { state: "running", stage: "compiling", attempt: 1 });
    expect(exportPhase(v, { unreachable: false, gone: false, expired: true })).toBe("session_expired");
    const d = describeExportOutcome(v, "session_expired");
    expect(d.detail).toBe("Your session has expired. Sign in again to see this export.");
    expect(d.charge).toBeNull();
    expect(d.lastKnown).toMatch(/Building/);
  });
  it("a settled export keeps its final phase; gone wins", () => {
    const done = view({ state: "succeeded", revisionId: "r" }, { state: "succeeded" }, "consumed");
    expect(exportPhase(done, { unreachable: false, gone: false, expired: true })).toBe("succeeded");
    expect(exportPhase(view(), { unreachable: false, gone: true, expired: true })).toBe("not_found");
  });
});
