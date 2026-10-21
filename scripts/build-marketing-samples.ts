import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CAPABILITIES } from "../src/lib/curriculum/capabilities";
import { withContextHash, type CurriculumContext } from "../src/lib/curriculum/context";
import { readDatasetDir } from "../src/lib/curriculum/files";
import type { LessonRequestV2 } from "../src/lib/domain/lesson-request";
import { DockerLatexCompiler, inspectPdf } from "../src/lib/latex/docker-compiler";
import { renderPackage } from "../src/lib/latex/render";
import { DEFAULT_SANDBOX } from "../src/lib/latex/sandbox";
import { buildPackage, LINEAR_CONCEPT_ID } from "../src/lib/package/build";
import { documentView } from "../src/lib/package/views";

// Builds the marketing sample PDFs and page images with the REAL pipeline: sample curriculum -> buildPackage ->
// renderPackage -> sandboxed docker compile -> pdftoppm in the same image (no host mounts, no network).
// The dataset is labelled "sample", so the documents say so and make no curriculum alignment claim.
// Only PDFs and PNGs are written; no .tex file ever leaves the pipeline (decision D-31).
const OUT = path.join("public", "samples");
const DATASET = "data/curricula/sample-math/sample-1";
const TOPIC_TITLE = "Sample topic: Unknown on both sides";
const SEED = "marketing-samples-v1";
const IMAGE = process.env.LATEX_IMAGE ?? DEFAULT_SANDBOX.image;

function sampleContext(): CurriculumContext {
  const ds = readDatasetDir(DATASET);
  const { meta, structure, objectives, mappings } = ds;
  const topic = structure.topics.find((t) => t.title === TOPIC_TITLE);
  if (!topic) throw new Error("sample topic not found");
  const unit = structure.units.find((u) => u.id === topic.unitId)!;
  const course = structure.courses.find((c) => c.id === unit.courseId)!;
  const level = structure.levels.find((l) => l.id === course.levelId) ?? null;
  const concept = mappings.topicConcepts.find((m) => m.topicId === topic.id && m.conceptId === LINEAR_CONCEPT_ID);
  if (!concept) throw new Error("sample topic has no supported concept");
  return withContextHash({
    curriculum: {
      id: meta.curriculum.id,
      name: meta.curriculum.name,
      educationSystem: meta.educationSystem,
      version: {
        id: meta.version.id,
        label: meta.version.label,
        kind: meta.version.kind,
        source: { title: meta.version.source.title, url: meta.version.source.url ?? null, publisher: meta.version.source.publisher ?? null, retrievedAt: meta.version.source.retrievedAt ?? null },
      },
    },
    level: level ? { id: level.id, label: level.label } : null,
    course: { id: course.id, code: course.code, title: course.title },
    unit: { id: unit.id, code: unit.code ?? null, title: unit.title },
    topic: { id: topic.id, title: topic.title },
    objectives: mappings.topicObjectives
      .filter((m) => m.topicId === topic.id)
      .map((m) => {
        const o = objectives.objectives.find((x) => x.id === m.objectiveId)!;
        return { id: o.id, officialCode: o.officialCode, label: o.label, coverage: m.coverage, note: m.note ?? null, source: { ref: o.sourceRef, page: o.sourcePage ?? null } };
      }),
    prerequisites: mappings.prerequisites
      .filter((p) => p.topicId === topic.id)
      .map((p) => ({ topicId: p.prerequisiteTopicId, title: structure.topics.find((t) => t.id === p.prerequisiteTopicId)?.title ?? p.prerequisiteTopicId })),
    concepts: [{ id: LINEAR_CONCEPT_ID, name: "Linear equations in one variable", coverage: concept.coverage, note: concept.note ?? null, capability: CAPABILITIES[LINEAR_CONCEPT_ID]! }],
    alignmentClaimsAllowed: meta.version.kind === "real",
  });
}

function rasterize(pdf: Uint8Array, page: number): Buffer {
  const script = `cat > /tmp/x.pdf && pdftoppm -png -f ${page} -l ${page} -singlefile -scale-to-x 900 -scale-to-y -1 /tmp/x.pdf /tmp/out && cat /tmp/out.png`;
  const r = spawnSync(
    "docker",
    [
      "run", "--rm", "-i", "--pull", "never", "--network", "none", "--read-only", "--user", "65534:65534", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65534,gid=65534",
      "--entrypoint", "sh", IMAGE, "-c", script,
    ],
    { input: Buffer.from(pdf), maxBuffer: 20_000_000 },
  );
  if (r.status !== 0) throw new Error(`pdftoppm failed: ${r.stderr.toString().slice(0, 300)}`);
  return r.stdout;
}

async function main() {
  const context = sampleContext();
  const request: LessonRequestV2 = {
    requestVersion: 2,
    curriculum: { versionId: context.curriculum.version.id, topicId: context.topic.id },
    durationMinutes: 60,
    difficulty: "mixed",
    documents: ["notes", "worksheet", "solutions"],
    templateId: "classic",
    locale: "en",
  };
  const pkg = buildPackage({ request, context, seed: SEED });
  // By construction (WorksheetView has no solution sections); checked again here so a regression fails the build.
  if (documentView(pkg, "worksheet").sections.some((s) => (s.kind as string) === "solutions")) throw new Error("worksheet view contains solutions");
  const rendered = renderPackage(pkg);
  const keep = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"];
  const clientEnv = Object.fromEntries(keep.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
  const compiler = new DockerLatexCompiler({ ...DEFAULT_SANDBOX, image: IMAGE, clientEnv });
  const compiled = await compiler.compile({ documents: rendered.map((d) => ({ id: d.id, tex: d.tex })) });
  mkdirSync(OUT, { recursive: true });
  for (const doc of compiled) {
    if (!inspectPdf(doc.pdf).safe) throw new Error(`${doc.id}: unsafe pdf`);
    writeFileSync(path.join(OUT, `${doc.id}.pdf`), doc.pdf);
    writeFileSync(path.join(OUT, `${doc.id}-1.png`), rasterize(doc.pdf, 1)); // page 1 is what the landing page shows
    console.log(`${doc.id}: ${doc.pages} pages, ${doc.pdf.byteLength} bytes`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
