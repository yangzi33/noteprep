import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobStatusView } from "@/components/job-status-view";
import type { JobView } from "@/lib/ui/job-view";

const base: JobView = {
  id: "job-1",
  state: "queued",
  stage: null,
  attempt: 0,
  maxAttempts: 3,
  cancelRequested: false,
  errorCode: null,
  lessonId: "lesson-1",
  revisionId: null,
};

function html(
  job: Partial<JobView> = {},
  extra: { offline?: boolean; panel?: { href: string | null; text: string } } = {},
) {
  return renderToStaticMarkup(
    createElement(JobStatusView, {
      job: { ...base, ...job },
      offline: extra.offline ?? false,
      panel: extra.panel ?? { href: null, text: "" },
      cancelAction: () => {},
    }),
  );
}

const items = (markup: string) => [...markup.matchAll(/<li[ >][\s\S]*?<\/li>/g)].map((m) => m[0]);
const srText = (li: string) => /<span class="sr-only">([^<]*)<\/span>/.exec(li)?.[1];
const stateText = (markup: string) => /<p[^>]*data-testid="job-state"[^>]*>([^<]*)<\/p>/.exec(markup)?.[1];
const live = (markup: string) =>
  /<p(?=[^>]*data-testid="job-live")(?=[^>]*aria-live="polite")(?![^>]*role=)[^>]*class="sr-only"[^>]*>([^<]*)<\/p>|<p(?=[^>]*data-testid="job-live")(?=[^>]*aria-live="polite")(?![^>]*role=)[^>]*>([^<]*)<\/p>/.exec(markup)?.slice(1).find((v) => v !== undefined);
const cancelButton = /<button[^>]*>[^<]*Cancel lesson pack[^<]*<\/button>/;

describe("JobStatusView", () => {
  it("renders a queued job with a four-step list and a cancel button", () => {
    const m = html();
    expect(m).toMatch(/<section(?=[^>]*data-testid="job-status")(?=[^>]*data-state="queued")/);
    expect(m).not.toMatch(/<section[^>]*aria-live/);
    expect(live(m)).toBe("Waiting to start.");
    expect(stateText(m)).toBe("Waiting to start");
    expect(m).toMatch(cancelButton);
    expect(m).toMatch(/<ol[^>]*aria-label="Lesson pack steps"/);
    const lis = items(m);
    expect(lis).toHaveLength(4);
    expect(lis.map(srText)).toEqual(["Done", "Not started", "Not started", "Not started"]);
    expect(m).toMatch(/<form[^>]*>[\s\S]*<input type="hidden" name="jobId" value="job-1"\/>/);
    expect(m).toContain("Your progress is saved.");
  });

  it("shows retry wording for a queued job that was tried before", () => {
    expect(stateText(html({ attempt: 1 }))).toBe("Waiting to retry");
  });

  it("marks the compiling step in progress and shows the attempt counter", () => {
    const m = html({ state: "running", stage: "compiling", attempt: 2 });
    expect(srText(items(m)[2]!)).toBe("In progress");
    expect(m).toContain("Attempt 2 of 3");
    expect(live(m)).toBe("Step 3 of 4: Building your PDFs");
    expect(m).toMatch(/<svg[^>]*class="[^"]*animate-spin[^"]*motion-reduce:animate-none[^"]*"/);
  });

  it("hides the cancel button once cancel is requested", () => {
    const m = html({ state: "running", stage: "generating", attempt: 1, cancelRequested: true });
    expect(m).toContain("Cancel requested…");
    expect(m).not.toMatch(/<button/);
  });

  it("shows a canceled job with outcome and links, without a cancel button", () => {
    const m = html({ state: "canceled" });
    expect(stateText(m)).toBe("Canceled");
    expect(m).toContain("did not use one of your lesson packs");
    expect(m).not.toMatch(/<ol/);
    expect(live(m)).toContain("did not use one of your lesson packs");
    expect(m).not.toMatch(/<button/);
    expect(m).toMatch(/<a(?=[^>]*href="\/lessons")(?=[^>]*min-h-11)(?=[^>]*text-text-accent)[^>]*>My lesson packs<\/a>/);
    expect(m).toMatch(/<a(?=[^>]*href="\/prepare")(?=[^>]*min-h-11)(?=[^>]*text-text-accent)[^>]*>Create another<\/a>/);
    expect(m).not.toContain("Your progress is saved.");
  });

  it("shows a failed job as the backend reports it (no stage) with an alert and no step list", () => {
    const m = html({ state: "failed", stage: null, errorCode: "compile_failed" });
    expect(m).not.toMatch(/<ol/);
    expect(m).toContain("The documents could not be built.");
    expect(m).toContain("did not use one of your lesson packs");
    expect(m).toMatch(/role="alert"/);
    expect(live(m)).toContain("The documents could not be built.");
    expect(m).not.toMatch(/<button/);
  });

  it("hides the step list for a succeeded job without a preview", () => {
    const m = html({ state: "succeeded" }, { panel: { href: null, text: "Ready." } });
    expect(m).not.toMatch(/<ol/);
    expect(live(m)).toBe("Your lesson pack is ready.");
  });

  it("shows a succeeded job with the preview link when there is one", () => {
    const panel = { href: "/lessons/x?rev=y", text: "The lesson pack is ready." };
    const m = html({ state: "succeeded" }, { panel });
    expect(m).toMatch(/<ol/);
    expect(items(m)).toHaveLength(4);
    expect(m).toMatch(/data-testid="job-succeeded"/);
    expect(m).toMatch(/<a[^>]*href="\/lessons\/x\?rev=y"[^>]*>Open the preview<\/a>/);
    expect(m).toContain("The lesson pack is ready.");
    expect(html({ state: "succeeded" }, { panel: { href: null, text: "Ready." } })).not.toContain("Open the preview");
  });

  it("shows the connection problem line when offline", () => {
    expect(html({}, { offline: true })).toContain("Connection problem; still trying…");
    expect(html()).not.toContain("Connection problem");
  });

  it("has exactly one h1 and at most one status role in every state", () => {
    const states: Partial<JobView>[] = [
      {},
      { state: "running", stage: "storing" },
      { state: "running", cancelRequested: true },
      { state: "failed", stage: "generating", errorCode: "deadline_exceeded" },
      { state: "canceled" },
      { state: "succeeded" },
    ];
    for (const job of states) {
      const m = html(job, { offline: true, panel: { href: "/x", text: "Ready." } });
      expect(m.match(/<h1[ >]/g)).toHaveLength(1);
      expect((m.match(/role="status"/g) ?? []).length).toBeLessThanOrEqual(1);
      expect(m.match(/data-testid="job-status"/g)).toHaveLength(1);
      expect(m.match(/aria-live=/g)).toHaveLength(1);
    }
  });
});
