import { describe, expect, it } from "vitest";
import { jobHeading, jobOverline, jobSteps, stepStateText } from "@/lib/ui/job-steps";
import type { JobView } from "@/lib/ui/job-view";

type Stage = JobView["stage"];

function statesOf(state: JobView["state"], stage: Stage) {
  return jobSteps({ state, stage }).map((step) => step.state);
}

describe("jobSteps state mapping", () => {
  it("marks only the first step done while queued", () => {
    expect(statesOf("queued", null)).toEqual(["done", "todo", "todo", "todo"]);
  });

  it("maps generating and validating to step 2", () => {
    expect(statesOf("running", "generating")).toEqual(["done", "active", "todo", "todo"]);
    expect(statesOf("running", "validating")).toEqual(["done", "active", "todo", "todo"]);
  });

  it("maps compiling to step 3 and storing to step 4", () => {
    expect(statesOf("running", "compiling")).toEqual(["done", "done", "active", "todo"]);
    expect(statesOf("running", "storing")).toEqual(["done", "done", "done", "active"]);
  });

  it("treats running without a stage as step 2 active", () => {
    expect(statesOf("running", null)).toEqual(["done", "active", "todo", "todo"]);
  });

  it("marks every step done when succeeded", () => {
    expect(statesOf("succeeded", null)).toEqual(["done", "done", "done", "done"]);
    expect(statesOf("succeeded", "storing")).toEqual(["done", "done", "done", "done"]);
  });

  it("marks the stage step failed when failed with a stage", () => {
    expect(statesOf("failed", "compiling")).toEqual(["done", "done", "failed", "todo"]);
    expect(statesOf("failed", "generating")).toEqual(["done", "failed", "todo", "todo"]);
  });

  it("marks only the first step done when failed without a stage", () => {
    expect(statesOf("failed", null)).toEqual(["done", "todo", "todo", "todo"]);
  });

  it("keeps steps before the canceled stage done and the stage onward not started", () => {
    expect(statesOf("canceled", "storing")).toEqual(["done", "done", "done", "todo"]);
    expect(statesOf("canceled", "generating")).toEqual(["done", "todo", "todo", "todo"]);
  });

  it("marks only the first step done when canceled without a stage", () => {
    expect(statesOf("canceled", null)).toEqual(["done", "todo", "todo", "todo"]);
  });

  it("always returns the four fixed step labels in order", () => {
    const labels = jobSteps({ state: "running", stage: "compiling" }).map((step) => step.label);
    expect(labels).toEqual([
      "Curriculum and settings checked",
      "Writing and checking the lesson",
      "Building your PDFs",
      "Preparing the preview",
    ]);
    expect(jobSteps({ state: "running", stage: "compiling" }).map((step) => step.id)).toEqual([
      "checked",
      "writing",
      "building",
      "preview",
    ]);
  });
});

describe("jobHeading", () => {
  it("returns the heading for each state", () => {
    expect(jobHeading({ state: "queued", attempt: 0 })).toBe("Preparing your lesson pack.");
    expect(jobHeading({ state: "queued", attempt: 1 })).toBe("Preparing your lesson pack.");
    expect(jobHeading({ state: "running", attempt: 0 })).toBe("Preparing your lesson pack.");
    expect(jobHeading({ state: "succeeded", attempt: 0 })).toBe("Your lesson pack is ready.");
    expect(jobHeading({ state: "failed", attempt: 0 })).toBe("We could not finish this lesson pack.");
    expect(jobHeading({ state: "canceled", attempt: 0 })).toBe("Lesson pack canceled.");
  });
});

describe("jobOverline", () => {
  it("returns the overline for each state", () => {
    expect(jobOverline({ state: "queued", attempt: 0 })).toBe("LESSON PACK · QUEUED");
    expect(jobOverline({ state: "queued", attempt: 1 })).toBe("LESSON PACK · WAITING TO RETRY");
    expect(jobOverline({ state: "running", attempt: 0 })).toBe("LESSON PACK · BUILDING");
    expect(jobOverline({ state: "succeeded", attempt: 0 })).toBe("LESSON PACK · COMPLETE");
    expect(jobOverline({ state: "failed", attempt: 0 })).toBe("LESSON PACK · FAILED");
    expect(jobOverline({ state: "canceled", attempt: 0 })).toBe("LESSON PACK · CANCELED");
  });
});

describe("stepStateText", () => {
  it("returns the screen reader text for each step state", () => {
    expect(stepStateText("done")).toBe("Done");
    expect(stepStateText("active")).toBe("In progress");
    expect(stepStateText("todo")).toBe("Not started");
    expect(stepStateText("failed")).toBe("Failed");
  });
});
