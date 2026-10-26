import type { JobView } from "@/lib/ui/job-view";

export type StepState = "done" | "active" | "todo" | "failed";

export interface JobStep {
  id: "checked" | "writing" | "building" | "preview";
  label: string;
  state: StepState;
}

const STEP_DEFINITIONS: ReadonlyArray<Pick<JobStep, "id" | "label">> = [
  { id: "checked", label: "Curriculum and settings checked" },
  { id: "writing", label: "Writing and checking the lesson" },
  { id: "building", label: "Building your PDFs" },
  { id: "preview", label: "Preparing the preview" },
];

/** Index of the step that owns each processing stage; generating and validating share step 2. */
const STAGE_STEP_INDEX: Record<NonNullable<JobView["stage"]>, number> = {
  generating: 1,
  validating: 1,
  compiling: 2,
  storing: 3,
};

/**
 * Maps a job's state and stage onto the fixed four-step progress list.
 * Pure: the same input always yields the same steps.
 */
export function jobSteps(job: Pick<JobView, "state" | "stage">): JobStep[] {
  const stepStates = STEP_DEFINITIONS.map((): StepState => "todo");
  // Step 1 is done for every existing job, whatever its state.
  stepStates[0] = "done";

  if (job.state === "succeeded") {
    stepStates.fill("done");
  } else if (job.state === "running") {
    const current = job.stage === null ? 1 : STAGE_STEP_INDEX[job.stage];
    for (let i = 0; i < current; i += 1) stepStates[i] = "done";
    stepStates[current] = "active";
  } else if (job.state === "failed" && job.stage !== null) {
    // NOTE: failed/canceled jobs with a stage cannot occur with the current backend (it clears
    // the stage on every terminal transition) and the view renders no steps for those states.
    const current = STAGE_STEP_INDEX[job.stage];
    for (let i = 0; i < current; i += 1) stepStates[i] = "done";
    stepStates[current] = "failed";
  } else if (job.state === "canceled" && job.stage !== null) {
    const current = STAGE_STEP_INDEX[job.stage];
    for (let i = 0; i < current; i += 1) stepStates[i] = "done";
  }
  // queued, failed without a stage and canceled without a stage keep the defaults.

  return STEP_DEFINITIONS.map((definition, index) => ({
    ...definition,
    state: stepStates[index] ?? "todo",
  }));
}

export function jobHeading(job: Pick<JobView, "state" | "attempt">): string {
  switch (job.state) {
    case "queued":
    case "running":
      return "Preparing your lesson pack.";
    case "succeeded":
      return "Your lesson pack is ready.";
    case "failed":
      return "We could not finish this lesson pack.";
    case "canceled":
      return "Lesson pack canceled.";
  }
}

export function jobOverline(job: Pick<JobView, "state" | "attempt">): string {
  const word = (() => {
    switch (job.state) {
      case "queued":
        return job.attempt > 0 ? "WAITING TO RETRY" : "QUEUED";
      case "running":
        return "BUILDING";
      case "succeeded":
        return "COMPLETE";
      case "failed":
        return "FAILED";
      case "canceled":
        return "CANCELED";
    }
  })();
  return `LESSON PACK · ${word}`;
}

export function stepStateText(state: StepState): string {
  switch (state) {
    case "done":
      return "Done";
    case "active":
      return "In progress";
    case "todo":
      return "Not started";
    case "failed":
      return "Failed";
  }
}
