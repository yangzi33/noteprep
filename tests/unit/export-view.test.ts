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
    expect(d.detail).toContain("starts a new export and uses another lesson pack");
    expect(d.charge).toBe("This used 1 lesson pack.");
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
  it("says 'No lesson pack was used.' only when the server confirmed a release", () => {
    for (const v of all()) {
      const t = text(v);
      expect(t.includes("No lesson pack was used."), `${phase(v)} ${v.charge}`).toBe(v.charge === "not_used");
    }
  });
  it("says 'This used 1 lesson pack.' only when consumed", () => {
    for (const v of all()) expect(text(v).includes("This used 1 lesson pack."), phase(v)).toBe(v.charge === "used");
  });
  it("never claims 'not used' for a failed job whose reservation is still held, and shows the neutral state", () => {
    const v = view({}, { state: "failed", errorCode: "compile_failed" }, "reserved");
    expect(text(v)).toContain("Finishing up");
    expect(text(v)).not.toMatch(/not used|No lesson pack was used/i);
  });
  it("unreachable keeps the last known state, says so, and never claims not used", () => {
    const running = view({}, { state: "running", stage: "storing" });
    const d = describeExportOutcome(running, phase(running, { unreachable: true, gone: false }));
    expect(d.detail + d.heading).toContain("We cannot check the status right now. Still trying…");
    expect(d.detail + d.heading + (d.charge ?? "")).not.toMatch(/No lesson pack was used|used 1/);
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
        const expected = (p === "succeeded" || p === "retired") && c === "used" ? "This used 1 lesson pack." : (p === "failed" || p === "canceled") && c === "not_used" ? "No lesson pack was used." : null;
        expect(d.charge).toBe(expected);
        const prose = [d.heading, d.detail, d.lastKnown ?? ""].join(" ");
        expect(prose).not.toMatch(/No lesson pack was used|used 1 generation|held/i);
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

// --- S6-8: exhaustive tables. `satisfies Record<ExportPhase, ...>` makes adding a phase a compile error until it has wording. ---

describe("every export phase has its own wording (exhaustive table)", () => {
  // heading and intent per phase; the typecheck fails when a phase is added to ExportPhase and not here
  const EXPECTED = {
    queued: { heading: "Your PDFs are in the queue.", intent: "progress" },
    retrying: { heading: "Trying again.", intent: "progress" },
    "running:compiling": { heading: "Building your PDFs.", intent: "progress" },
    "running:storing": { heading: "Saving your PDFs.", intent: "progress" },
    stopping: { heading: "Stopping this export.", intent: "info" },
    confirming: { heading: "Finishing up…", intent: "progress" },
    stalled: { heading: "We could not confirm the result yet.", intent: "info" },
    succeeded: { heading: "Your PDFs are ready.", intent: "success" },
    retired: { heading: "This lesson was deleted.", intent: "info" },
    canceled: { heading: "Export canceled.", intent: "info" },
    failed: { heading: "We could not build your PDFs.", intent: "error" },
    unknown: { heading: "Checking the status…", intent: "info" },
    session_expired: { heading: "Your session has expired.", intent: "info" },
    not_found: { heading: "Export not found.", intent: "error" },
  } satisfies Record<ExportPhase, { heading: string; intent: "progress" | "success" | "error" | "info" }>;

  for (const [p, want] of Object.entries(EXPECTED) as [ExportPhase, (typeof EXPECTED)[ExportPhase]][]) {
    it(`${p}: heading, intent, non-empty detail, and no internal wording`, () => {
      const d = describeExportOutcome(view(), p);
      expect(d.heading).toBe(want.heading);
      expect(d.intent).toBe(want.intent);
      expect(d.detail.length).toBeGreaterThan(10);
      expect([d.heading, d.detail, d.lastKnown ?? ""].join(" ")).not.toMatch(/reservation|job id|snapshot|stack|undefined|null|\.tex/i);
    });
  }
});

describe("the 'generation used / not used' wording comes from the reservation state, never from the phase alone", () => {
  // reservation state of a settled export -> the sentence (null when the server has not said so)
  const CASES = [
    { name: "succeeded, consumed", state: "succeeded", job: "succeeded", reservation: "consumed", phase: "succeeded", sentence: "This used 1 lesson pack." },
    { name: "succeeded, reservation row missing", state: "succeeded", job: "succeeded", reservation: null, phase: "succeeded", sentence: null },
    { name: "failed, released", state: "failed", job: "failed", reservation: "released", phase: "failed", sentence: "No lesson pack was used." },
    { name: "failed, still reserved", state: "failed", job: "failed", reservation: "reserved", phase: "failed", sentence: null },
    { name: "canceled, released", state: "failed", job: "canceled", reservation: "released", phase: "canceled", sentence: "No lesson pack was used." },
    { name: "canceled, row missing", state: "failed", job: "canceled", reservation: null, phase: "canceled", sentence: null },
    { name: "retired, consumed", state: "retired", job: "succeeded", reservation: "consumed", phase: "retired", sentence: "This used 1 lesson pack." },
    { name: "pending, held", state: "pending", job: "running", reservation: "reserved", phase: "running:compiling", sentence: null },
  ] as const;
  for (const c of CASES) {
    it(c.name, () => {
      const v = view({ state: c.state, revisionId: c.state === "pending" ? null : "r-1" }, { state: c.job, stage: c.job === "running" ? "compiling" : null, attempt: c.job === "running" ? 1 : 0, errorCode: c.state === "failed" && c.job === "failed" ? "compile_failed" : null }, c.reservation);
      expect(phase(v)).toBe(c.phase);
      expect(describeExportOutcome(v, phase(v)).charge).toBe(c.sentence);
    });
  }
});

describe("confirm outcomes (created, joined, reused, replayed) on the result page", () => {
  const done = () => view({ state: "succeeded", revisionId: "r-1" }, { state: "succeeded" }, "consumed");
  const live = () => view({}, { state: "running", stage: "compiling", attempt: 1 });
  // what describeExportOutcome adds for each outcome; created and replayed are the plain page (they never carry ?outcome=)
  const OUTCOMES = {
    created: { settled: "This used 1 lesson pack.", live: null },
    replayed: { settled: "This used 1 lesson pack.", live: null },
    joined: { settled: "This used 1 lesson pack.", live: null },
    reused: { settled: "An export with the same content and page format already used 1 lesson pack. This one used none.", live: null },
  } satisfies Record<"created" | "joined" | "reused" | "replayed", { settled: string; live: string | null }>;
  for (const [outcome, want] of Object.entries(OUTCOMES)) {
    it(`${outcome}: settled sentence is exactly what the table says; a live export never prints a charge`, () => {
      const pass = outcome === "reused" || outcome === "joined" ? outcome : null; // only these two ever reach the page as ?outcome=
      expect(describeExportOutcome(done(), "succeeded", pass).charge).toBe(want.settled);
      expect(describeExportOutcome(live(), "running:compiling", pass).charge).toBe(want.live);
    });
  }
  it("reused never rewrites a failed or canceled export's wording", () => {
    const failed = view({ state: "failed" }, { state: "failed", errorCode: "compile_failed" }, "released");
    expect(describeExportOutcome(failed, "failed", "reused").charge).toBe("No lesson pack was used.");
  });
});
