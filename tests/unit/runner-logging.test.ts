import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "@/lib/server/dal/jobs";
import { PipelineError, type PipelineDeps } from "../../worker/pipeline";

const pipeline = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../worker/pipeline", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../worker/pipeline")>()), runPipeline: pipeline.run }));
vi.mock("../../worker/export", () => ({ runExport: pipeline.run }));

const { processJob } = await import("../../worker/runner");
const { runOnce } = await import("../../worker/loop");

let out: { mock: { calls: unknown[][] } };
beforeEach(() => {
  out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  pipeline.run.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const logged = () => out.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
const raw = () => out.mock.calls.map((c) => String(c[0])).join("");
const job = { id: "j1", kind: "export", fencingToken: 1n, attempt: 2, ownerId: "o", lessonId: "l", maxAttempts: 3, deadlineAt: new Date() } as unknown as ClaimedJob;

function deps(over: Record<string, unknown> = {}) {
  const jobs = { heartbeat: vi.fn(async () => "ok"), retryOrFail: vi.fn(async () => "requeued"), claimNext: vi.fn(async () => job), ...over };
  const settlement = { finishJob: vi.fn(async () => undefined) };
  return { jobs, settlement, leaseMs: 30_000 } as unknown as PipelineDeps;
}

describe("job log lines", () => {
  it("a terminal PipelineError logs its class, code, redacted detail, kind, last stage and duration", async () => {
    pipeline.run.mockImplementation(async (_job: ClaimedJob, d: PipelineDeps) => {
      await d.jobs.heartbeat("j1", 1n, 1000, "compiling");
      throw new PipelineError("compile_failed", false, undefined, "LaTeX error in document 2");
    });
    expect(await processJob(job, deps())).toBe("failed");
    const line = logged().find((l) => l.event === "job_failed")!;
    expect(line).toMatchObject({ kind: "export", attempt: 2, stage: "compiling", code: "compile_failed", errorClass: "PipelineError", detail: "LaTeX error in document 2" });
    expect(typeof line.durationMs).toBe("number");
  });

  it("truncates the detail to 200 characters on one line", async () => {
    pipeline.run.mockRejectedValue(new PipelineError("compile_failed", false, undefined, `a\nb ${"x".repeat(500)}`));
    await processJob(job, deps());
    const detail = logged().find((l) => l.event === "job_failed")!.detail as string;
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail).not.toContain("\n");
  });

  it("reduces the detail to a safe alphabet: no path, URL, '=', backslash or quoted lesson text survives", async () => {
    const hostile = String.raw`! Undefined control sequence \foo at /work/job-1/notes.tex:12 see https://x.example/a?b=c token="secret" "Solve 3x+5=11" {a}[b]<c>;|$#%&~^*@`;
    pipeline.run.mockRejectedValue(new PipelineError("compile_failed", false, undefined, hostile));
    await processJob(job, deps());
    const detail = logged().find((l) => l.event === "job_failed")!.detail as string;
    expect(detail).toMatch(/^[A-Za-z0-9 .,'()_:?-]*$/);
    for (const bad of ["\\", "/", "=", '"', "{", "[", "<", ";", "|", "$", "@", "+"]) expect(detail, bad).not.toContain(bad);
    expect(detail).toContain("Undefined control sequence");
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  it("an unexpected error logs its class only: never its message", async () => {
    const boom = new Error("connection to postgres://user:pw@host/db failed for tutor@example.com");
    boom.name = "PrismaClientInitializationError";
    pipeline.run.mockRejectedValue(boom);
    expect(await processJob(job, deps())).toBe("requeued");
    const line = logged().find((l) => l.event === "job_requeued")!;
    expect(line).toMatchObject({ code: "internal_error", errorClass: "PrismaClientInitializationError" });
    expect(line).not.toHaveProperty("detail");
    expect(raw()).not.toMatch(/postgres:|tutor@example|pw@/);
  });

  it("a failed heartbeat is logged with the error class only", async () => {
    let release!: () => void;
    pipeline.run.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const heartbeat = vi.fn(async () => {
      throw Object.assign(new Error("secret message"), { name: "TimeoutError" });
    });
    const done = processJob(job, { ...deps({ heartbeat }), leaseMs: 3 });
    await vi.waitFor(() => expect(logged().some((l) => l.event === "job_heartbeat_failed")).toBe(true));
    release();
    await done;
    expect(logged().find((l) => l.event === "job_heartbeat_failed")).toMatchObject({ jobId: "j1", kind: "export", errorClass: "TimeoutError" });
    expect(raw()).not.toContain("secret message");
  });

  it("job_claimed names the kind of the job", async () => {
    pipeline.run.mockResolvedValue(undefined);
    await runOnce(deps(), "w1");
    expect(logged().find((l) => l.event === "job_claimed")).toMatchObject({ jobId: "j1", kind: "export", attempt: 2, worker: "w1" });
  });
});
