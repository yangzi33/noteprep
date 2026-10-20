import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { domainErrorCode } from "@/lib/domain/errors";
import { DOCUMENT_IDS } from "@/lib/domain/lesson-request";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import type { SelectionPath } from "@/lib/server/dal/curriculum";
import { prepareHref, readPrepareParams, upTo, type PrepareParams } from "@/lib/ui/prepare-url";
import { generationErrorMessage } from "@/lib/ui/messages";
import { prepareLesson } from "./actions";

const STEP_TITLE = { level: "Choose a level", course: "Choose a course", unit: "Choose a unit", topic: "Choose a topic" } as const;
const DOCUMENT_LABEL = { notes: "Tutor Lesson Notes", worksheet: "Student Practice Worksheet", solutions: "Solutions / Answer Key" } as const;
const inputClass = "w-full rounded border px-3 py-2";

function Crumbs({ path, params }: { path: SelectionPath; params: PrepareParams }) {
  const items: { label: string; href: string }[] = [
    { label: `${path.curriculum.name} — ${path.curriculum.versionLabel}`, href: prepareHref({ v: params.v }) },
  ];
  if (path.level) items.push({ label: path.level.label, href: prepareHref(upTo(params, "level")) });
  if (path.course) items.push({ label: path.course.label, href: prepareHref(upTo(params, "course")) });
  if (path.unit) items.push({ label: path.unit.label, href: prepareHref(upTo(params, "unit")) });
  if (path.topic) items.push({ label: path.topic.label, href: prepareHref(upTo(params, "topic")) });
  return (
    <nav aria-label="Your selection" className="mt-4 text-sm">
      <ol className="flex flex-wrap gap-x-2">
        <li>
          <Link href="/prepare" className="underline">
            All curricula
          </Link>
        </li>
        {items.map((item) => (
          <li key={item.href} className="flex gap-2">
            <span aria-hidden>›</span>
            <Link href={item.href} className="underline">
              {item.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SampleBanner() {
  return (
    <Notice intent="info" className="mt-4" data-testid="sample-banner">
      Sample data, not a real curriculum. No curriculum alignment is claimed for lessons made from it.
    </Notice>
  );
}

export default async function PreparePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx } = await requireAccount();
  const params = readPrepareParams(await searchParams);
  const dal = webDal();
  const allowance = await dal.history.getAllowance(ctx);
  const exhausted = allowance !== null && allowance.remaining <= 0;

  const header = (
    <>
      <h1 className="text-2xl font-semibold">Prepare a lesson</h1>
      <p className="mt-2 text-sm" data-testid="allowance">
        {allowance
          ? `${allowance.remaining} of ${allowance.limit} generations left${allowance.pending > 0 ? ` (${allowance.pending} in progress)` : ""}.`
          : "Your account is being set up."}
      </p>
      {params.error && (
        <Notice intent="error" className="mt-4">
          {generationErrorMessage(params.error)}
        </Notice>
      )}
    </>
  );

  // ---- step 0: which curriculum -----------------------------------------------------------------------
  if (!params.v) {
    const curricula = await dal.curriculum.listCurricula();
    return (
      <main className="mx-auto max-w-3xl p-8">
        {header}
        <h2 className="mt-6 text-lg font-medium">Choose a curriculum</h2>
        {curricula.length === 0 ? (
          <p className="mt-3 text-sm" data-testid="no-curricula">
            No curriculum is available yet. You can still use the{" "}
            <Link href="/lessons/new" className="underline">
              quick form
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-3 divide-y rounded border" data-testid="options">
            {curricula.map((c) => (
              <li key={c.id} className="p-3 text-sm">
                <Link href={prepareHref({ v: c.latestVersionId })} className="font-medium underline">
                  {c.name}
                </Link>
                <p className="text-muted-foreground">
                  {c.educationSystem.name}
                  {c.versions[0]?.kind !== "real" ? " · sample data" : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </main>
    );
  }

  // ---- later steps -----------------------------------------------------------------------------------------
  let path: SelectionPath;
  try {
    path = await dal.curriculum.getSelectionPath({ versionId: params.v, levelId: params.level, courseId: params.course, unitId: params.unit, topicId: params.topic });
  } catch (error) {
    const code = domainErrorCode(error);
    if (code !== "CURRICULUM_NOT_FOUND" && code !== "INVALID_SELECTION") throw error;
    return (
      <main className="mx-auto max-w-3xl p-8">
        {header}
        <Notice intent="error" className="mt-4" data-testid="bad-selection">
          {generationErrorMessage(code)}{" "}
          <Link href="/prepare" className="underline">
            Start again
          </Link>
        </Notice>
      </main>
    );
  }
  const sample = path.curriculum.kind !== "real";

  // a topic is chosen: show the summary and the last few options
  if (path.topic) {
    if (!path.topic.supported) {
      return (
        <main className="mx-auto max-w-3xl p-8">
          {header}
          <Crumbs path={path} params={params} />
          <Notice intent="error" className="mt-4" data-testid="unsupported-topic">
            {generationErrorMessage("TOPIC_UNSUPPORTED")}{" "}
            <Link href={prepareHref(upTo(params, "unit"))} className="underline">
              Back to the topics
            </Link>
          </Notice>
        </main>
      );
    }
    const context = await dal.curriculum.resolveCurriculumContext({ versionId: params.v, topicId: path.topic.id });
    const key = randomUUID(); // one key per rendered form: a double click or retried submit returns the same job
    return (
      <main className="mx-auto max-w-3xl p-8">
        {header}
        <Crumbs path={path} params={params} />
        {sample && <SampleBanner />}
        {exhausted && (
          <Notice intent="info" role="status" className="mt-4">
            You have used all of your free generations. Subscriptions are not available yet (they arrive in a later phase).
          </Notice>
        )}

        <section className="mt-6" data-testid="topic-summary">
          <h2 className="text-lg font-medium">{context.topic.title}</h2>
          <h3 className="mt-3 text-sm font-medium">Learning objectives</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {context.objectives.map((o) => (
              <li key={o.id}>
                {o.label}
                {o.coverage === "partial" && o.note ? <span className="text-muted-foreground"> — partly covered: {o.note}</span> : null}
              </li>
            ))}
          </ul>
          {context.prerequisites.length > 0 && (
            <>
              <h3 className="mt-3 text-sm font-medium">Builds on</h3>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {context.prerequisites.map((p) => (
                  <li key={p.topicId}>{p.title}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <form action={prepareLesson} className="mt-6 flex flex-col gap-4">
          <input type="hidden" name="key" value={key} />
          {(["v", "level", "course", "unit", "topic"] as const).map((name) => (params[name] ? <input key={name} type="hidden" name={name} value={params[name]} /> : null))}
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Lesson length
              <select name="durationMinutes" defaultValue="60" className={inputClass}>
                {[30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Difficulty
              <select name="difficulty" defaultValue="mixed" className={inputClass}>
                <option value="basic">Basic</option>
                <option value="mixed">Mixed (easy to hard)</option>
                <option value="challenge">Challenge</option>
              </select>
            </label>
          </div>
          <fieldset className="text-sm">
            <legend className="mb-1">Documents</legend>
            {DOCUMENT_IDS.map((id) => (
              <label key={id} className="mr-4 inline-flex items-center gap-2">
                <input type="checkbox" name="documents" value={id} defaultChecked />
                {DOCUMENT_LABEL[id]}
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            Choosing fewer documents still uses one generation.
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={exhausted}>
              Generate lesson
            </Button>
            <Link href={prepareHref(upTo(params, "unit"))} className="text-sm underline">
              Choose another topic
            </Link>
          </div>
        </form>
      </main>
    );
  }

  // a step in the middle: list the options
  const next = await dal.curriculum.getSelectionOptions({ versionId: params.v, levelId: params.level, courseId: params.course, unitId: params.unit });
  const paramKey = { level: "level", course: "course", unit: "unit", topic: "topic" } as const;
  return (
    <main className="mx-auto max-w-3xl p-8">
      {header}
      <Crumbs path={path} params={params} />
      {sample && <SampleBanner />}
      <h2 className="mt-6 text-lg font-medium">{STEP_TITLE[next.step]}</h2>
      <ul className="mt-3 divide-y rounded border" data-testid="options" data-step={next.step}>
        {next.options.map((o) =>
          o.supported ? (
            <li key={o.id} className="p-3 text-sm">
              <Link href={prepareHref({ ...params, [paramKey[next.step]]: o.id })} className="font-medium underline">
                {o.label}
              </Link>
              {o.coverage === "partial" && <span className="ml-2 text-muted-foreground">(partly covered)</span>}
            </li>
          ) : (
            <li key={o.id} className="p-3 text-sm text-muted-foreground" data-unsupported="true">
              {o.label}
              <span className="ml-2">
                — {next.step === "topic" ? "not available yet: we cannot verify practice for this topic" : "nothing here is available yet"}
              </span>
            </li>
          ),
        )}
      </ul>
    </main>
  );
}
