import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExportStatusView, type ExportStatusViewProps } from "@/components/export-status-view";
import { exportPhase, type ExportPhase, type ExportView } from "@/lib/ui/export-view";

const L = "33333333-3333-4333-8333-333333333333";
const R = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";
const docs = [
  { document: "notes", pages: 2 },
  { document: "worksheet", pages: 2 },
  { document: "solutions", pages: 1 },
] as const;

const view = (over: Partial<ExportView> = {}, job: Partial<ExportView["job"]> = {}, charge: ExportView["charge"] = "held"): ExportView => ({
  exportId: E,
  state: "pending",
  job: { state: "queued", stage: null, attempt: 0, maxAttempts: 3, cancelRequested: false, errorCode: null, ...job },
  charge,
  lessonId: L,
  revisionId: null,
  deadlineAt: "2026-10-24T10:00:00.000Z",
  ...over,
});

function html(v: ExportView, extra: Partial<ExportStatusViewProps> & { net?: { unreachable: boolean; gone: boolean } } = {}) {
  const { net, ...rest } = extra;
  const phase = exportPhase(v, net ?? { unreachable: false, gone: false });
  return renderToStaticMarkup(createElement(ExportStatusView, { view: v, phase, outcome: null, documents: [], cancelAction: () => {}, ...rest }));
}
const cancelForm = /<form[^>]*>[\s\S]*Cancel export[\s\S]*<\/form>/;
const phaseOf = (m: string) => /data-phase="([^"]*)"/.exec(m)?.[1];

const live = view({}, { state: "running", stage: "compiling", attempt: 1 });
const done = view({ state: "succeeded", revisionId: R }, { state: "succeeded" }, "used");
const failed = view({ state: "failed" }, { state: "failed", errorCode: "compile_failed" }, "not_used");
const canceled = view({ state: "failed" }, { state: "canceled", errorCode: "canceled" }, "not_used");

describe("ExportStatusView states", () => {
  const cases: [string, string, ExportView, ExportPhase][] = [
    ["queued", "in the queue", view(), "queued"],
    ["compiling", "Building your PDFs.", live, "running:compiling"],
    ["storing", "Saving your PDFs.", view({}, { state: "running", stage: "storing", attempt: 1 }), "running:storing"],
    ["retrying", "Trying again.", view({}, { attempt: 1 }), "retrying"],
    ["stopping", "Stopping this export.", view({}, { state: "running", cancelRequested: true, attempt: 1 }), "stopping"],
    ["succeeded", "Your PDFs are ready.", done, "succeeded"],
    ["failed", "We could not build your PDFs.", failed, "failed"],
    ["canceled", "Export canceled.", canceled, "canceled"],
    ["confirming", "Finishing up...", view({}, { state: "failed", errorCode: "compile_failed" }, "held"), "confirming"],
  ];
  it.each(cases)("%s renders its heading and phase", (_n, heading, v, phase) => {
    const m = html(v, { documents: [...docs] });
    expect(m).toContain(heading);
    expect(phaseOf(m)).toBe(phase);
  });
  it("shows an aria-live status region", () => {
    expect(html(live)).toMatch(/aria-live="polite"/);
  });
  it("unknown keeps the last known state and never claims a charge result", () => {
    const m = html(live, { net: { unreachable: true, gone: false } });
    expect(phaseOf(m)).toBe("unknown");
    expect(m).toContain("We cannot check the status right now. Still trying...");
    expect(m).toMatch(/Building your PDFs/);
    expect(m).not.toMatch(/No generation was used|This used 1 generation/);
  });
  it("not found has no links and no cancel", () => {
    const m = html(live, { net: { unreachable: false, gone: true } });
    expect(m).toContain("Export not found.");
    expect(m).not.toMatch(cancelForm);
    expect(m).not.toContain("/lessons/");
  });
});

describe("charge wording in the markup", () => {
  it("'No generation was used.' only when released; 'used 1' only when consumed", () => {
    expect(html(failed)).toContain("No generation was used.");
    expect(html(canceled)).toContain("No generation was used.");
    expect(html(done)).toContain("This used 1 generation.");
    expect(html(done)).not.toContain("No generation was used.");
    for (const v of [view(), live, view({}, { state: "failed", errorCode: "x" }, "held"), view({}, { state: "running", cancelRequested: true })]) {
      expect(html(v)).not.toMatch(/No generation was used|This used 1 generation/);
    }
  });
  it("shows the failure reason from the table", () => {
    expect(html(view({ state: "failed" }, { state: "failed", errorCode: "compile_timeout" }, "not_used"))).toContain("Building the documents took too long.");
  });
});

describe("outcome notes", () => {
  it("reused", () => {
    expect(html(done, { outcome: "reused" })).toContain("You already exported this exact draft. Downloading again is free.");
    expect(html(done, { outcome: "joined" })).not.toContain("Downloading again is free");
    expect(html(done)).not.toContain("Downloading again is free");
  });
  it("joined", () => {
    const m = html(live, { outcome: "joined" });
    expect(m).toContain("This draft is already being exported. You are watching that export.");
    expect(m).not.toContain("Downloading again is free");
  });
});

describe("cancel form", () => {
  it("is shown for queued, retrying, running and unknown", () => {
    for (const v of [view(), view({}, { attempt: 1 }), live]) expect(html(v)).toMatch(cancelForm);
    expect(html(live, { net: { unreachable: true, gone: false } })).toMatch(cancelForm);
  });
  it("carries only the export id", () => {
    const m = html(live);
    expect(m).toContain(`name="exportId" value="${E}"`);
    expect(m.match(/<input[^>]*type="hidden"/g)).toHaveLength(1);
  });
  it("is hidden once cancel was requested or the export is over", () => {
    for (const v of [view({}, { state: "running", cancelRequested: true }), done, failed, canceled, view({}, { state: "failed" }, "held")]) expect(html(v)).not.toMatch(cancelForm);
  });
});

describe("links", () => {
  it("success links the lesson and each download through the authorized route, with the revision", () => {
    const m = html(done, { documents: [...docs] });
    expect(m).toContain(`href="/lessons/${L}?rev=${R}"`);
    expect(m).toContain("Open the lesson");
    for (const d of ["notes", "worksheet", "solutions"]) expect(m).toContain(`href="/lessons/${L}/documents/${d}?rev=${R}&amp;download=1"`);
    expect(m).toContain("Download Tutor Lesson Notes");
  });
  it("no links before success, and none to storage, tex or ids of the job", () => {
    for (const v of [view(), live, failed, canceled]) expect(html(v, { documents: [...docs] })).not.toMatch(/\/lessons\/|download=1/);
    const m = html(done, { documents: [...docs] });
    expect(m).not.toMatch(/\.tex|storage|supabase|\/artifacts?\//i);
  });
  it("offers to try again / go back from a failed export", () => {
    expect(html(failed)).toContain('href="/lessons"');
  });
});
