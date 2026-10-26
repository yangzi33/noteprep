import type { Metadata } from "next";
import { learningObjectiveItems } from "@/lib/curriculum/context";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { GenerateButton } from "@/components/app/generate-button";
import { PackageOption } from "@/components/app/package-option";
import { PreparePendingProvider } from "@/components/app/prepare-pending";
import { SelectionFields } from "@/components/app/selection-fields";
import { StepIndicator } from "@/components/app/step-indicator";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { SelectField } from "@/components/ui/select-field";
import { domainErrorCode } from "@/lib/domain/errors";
import { DOCUMENT_IDS } from "@/lib/domain/lesson-request";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";
import { serverEnv } from "@/lib/server/env";
import type { SelectionOption, SelectionPath, SelectionStep } from "@/lib/server/dal/curriculum";
import { allowanceSentence, dailyRefreshReminder } from "@/lib/ui/dashboard-view";
import { ContactText } from "@/components/app/contact-link";
import { exhaustedNotice, generationErrorMessage, type AllowanceSourceKind } from "@/lib/ui/messages";
import { DOCUMENT_LABELS, DOCUMENT_PURPOSE } from "@/lib/ui/lesson-view";
import { buildSelectFields, datasetBanner, resolveCountry } from "@/lib/ui/prepare-view";
import { prepareHref, readPrepareParams, upTo } from "@/lib/ui/prepare-url";
import { prepareLesson } from "./actions";

const STEPS = ["Select", "Generate", "Preview", "Export"] as const;
const DURATIONS = [30, 45, 60, 90, 120].map((m) => ({ value: String(m), label: `${m} minutes` }));
const DIFFICULTIES = [
  { value: "basic", label: "Basic" },
  { value: "mixed", label: "Mixed (easy to hard)" },
  { value: "challenge", label: "Challenge" },
];

function PageFrame({ allowanceText, reminder, source, error, children }: { allowanceText: string; reminder: string | null; source: AllowanceSourceKind | null; error?: string; children: React.ReactNode }) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold tracking-[0.16em] text-text-accent uppercase">Create lesson pack</p>
        <h1 className="font-heading text-[34px] leading-[1.2]">Prepare a lesson pack</h1>
        <p className="text-muted-foreground">A few familiar choices. Three documents shaped around your lesson.</p>
        <StepIndicator steps={STEPS} current={0} />
        <p className="text-sm" data-testid="allowance">
          {reminder ? <span data-testid="refresh-reminder">{reminder}</span> : allowanceText}
        </p>
        {error && <Notice intent="error"><ContactText text={generationErrorMessage(error, source) ?? ""} /></Notice>}
      </header>
      <div className="mt-6">{children}</div>
    </main>
  );
}

export const metadata: Metadata = { title: "Create lesson pack" };

export default async function PreparePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx } = await requireAccount();
  const rawParams = readPrepareParams(await searchParams);
  let params = rawParams;
  const dal = webDal();
  const allowance = await dal.history.getAllowance(ctx);
  // In draft mode a preview is free, so an empty allowance does not block it (D-106).
  const draftFlow = serverEnv().FLOW_MODE === "draft";
  const exhausted = !draftFlow && allowance !== null && allowance.remaining <= 0;
  const allowanceText = allowanceSentence(allowance);
  const frame = (children: React.ReactNode) => (
    <PageFrame allowanceText={allowanceText} reminder={dailyRefreshReminder(allowance)} source={allowance ? allowance.source : null} error={params.error}>
      {children}
    </PageFrame>
  );

  const curricula = await dal.curriculum.listCurricula();
  if (curricula.length === 0) {
    return frame(
      <Card className="p-6">
        <p className="text-sm" data-testid="no-curricula">
          No curriculum is available yet.
          {!draftFlow && (
            <>
              {" "}
              You can still use the{" "}
              <Link href="/lessons/new" className="underline">
                quick form
              </Link>
              .
            </>
          )}
        </p>
      </Card>,
    );
  }

  // The country is only a UI filter: with one country it is chosen for the user (no step, no URL param); with several
  // it comes from the URL or from `v`. An unknown country or one that does not match `v` is a polite notice.
  // Access is never decided here: the version and topic ids are still checked by the data layer and the action.
  const countryState = resolveCountry({ curricula, params: rawParams });
  if (!countryState.ok) {
    return frame(
      <Notice intent="error" data-testid="bad-selection">
        {generationErrorMessage("INVALID_SELECTION")}{" "}
        <Link href="/prepare" className="underline">
          Start again
        </Link>
      </Notice>,
    );
  }
  params = { ...rawParams, country: countryState.showStep ? countryState.country : undefined };

  // Resolve the selection path and the options of every step whose earlier values are present.
  // A bad or inconsistent selection (hand-edited URL) becomes a Notice, never an error page.
  let path: SelectionPath | null = null;
  let steps: SelectionStep[] = [];
  const stepOptions: Partial<Record<SelectionStep, SelectionOption[]>> = {};
  if (params.v) {
    try {
      const versionId = params.v;
      path = await dal.curriculum.getSelectionPath({ versionId, levelId: params.level, courseId: params.course, unitId: params.unit, topicId: params.topic });
      steps = await dal.curriculum.getSelectionSteps(versionId);
      const hasLevel = steps.includes("level");
      const load = async (step: SelectionStep, input: Parameters<typeof dal.curriculum.getSelectionOptions>[0]) => {
        stepOptions[step] = (await dal.curriculum.getSelectionOptions(input)).options;
      };
      if (hasLevel) await load("level", { versionId });
      if (!hasLevel || params.level) await load("course", { versionId, levelId: params.level });
      if (params.course && (!hasLevel || params.level)) await load("unit", { versionId, levelId: params.level, courseId: params.course });
      if (params.unit && params.course && (!hasLevel || params.level)) {
        await load("topic", { versionId, levelId: params.level, courseId: params.course, unitId: params.unit });
      }
    } catch (error) {
      const code = domainErrorCode(error);
      if (code !== "CURRICULUM_NOT_FOUND" && code !== "INVALID_SELECTION") throw error;
      return frame(
        <Notice intent="error" data-testid="bad-selection">
          {generationErrorMessage(code)}{" "}
          <Link href="/prepare" className="underline">
            Start again
          </Link>
        </Notice>,
      );
    }
  }

  const fields = buildSelectFields({ curricula, params, steps, stepOptions, country: { showStep: countryState.showStep, country: countryState.country } });
  const banner = path !== null ? datasetBanner(path.curriculum.kind) : null;
  const sample = banner === "sample";
  const suggested = banner === "suggested";
  const topic = path?.topic ?? null;
  const topicSupported = topic !== null && topic.supported;
  const topicOptions = stepOptions.topic ?? [];

  let context: Awaited<ReturnType<typeof dal.curriculum.resolveCurriculumContext>> | null = null;
  if (topicSupported && params.v) {
    context = await dal.curriculum.resolveCurriculumContext({ versionId: params.v, topicId: topic.id });
  }
  const key = randomUUID(); // one key per rendered form: a double click or retried submit returns the same job

  return frame(
    // minmax(0,1fr): a long option label must not widen the column past a phone viewport
    <div className={context ? "grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px]" : "grid grid-cols-[minmax(0,1fr)] gap-6"}>
      <Card className="flex flex-col gap-6 p-6">
        <PreparePendingProvider>
        <h2 className="font-heading text-xl">Start with your teaching context</h2>
        {sample && (
          <Notice intent="info" data-testid="sample-banner">
            Sample data, not a real curriculum. No curriculum alignment is claimed for lessons made from it.
          </Notice>
        )}
        {suggested && (
          <Notice intent="info" data-testid="suggested-banner">
            Suggested topics, unofficial. NotePrep wrote this list; it is not an official curriculum, and no curriculum alignment is claimed for lessons made from it.
          </Notice>
        )}
        <SelectionFields fields={fields} params={params} />
        {topicOptions.some((o) => !o.supported) && (
          <p className="text-[13px] text-muted-foreground" data-testid="topic-hint">
            Some topics cannot be chosen yet. We only offer topics whose practice questions we can check.
          </p>
        )}
        {topic && !topic.supported && (
          // The server also refuses this topic; no generation form is rendered for it.
          <Notice intent="error" data-testid="unsupported-topic">
            {generationErrorMessage("TOPIC_UNSUPPORTED")}{" "}
            <Link href={prepareHref(upTo(params, "unit"))} className="underline">
              Back to the topics
            </Link>
          </Notice>
        )}
        {!topic && <p className="text-sm text-muted-foreground">Choose a topic to continue.</p>}
        {exhausted && context && (
          <Notice intent="info" role="status">
            <ContactText text={exhaustedNotice(allowance.source)} />
          </Notice>
        )}
        {context && (
          <form action={prepareLesson} className="flex flex-col gap-6">
            <input type="hidden" name="key" value={key} />
            {(["v", "level", "course", "unit", "topic"] as const).map((name) => (params[name] ? <input key={name} type="hidden" name={name} value={params[name]} /> : null))}
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-semibold">Output package</legend>
              {DOCUMENT_IDS.map((id) => (
                <PackageOption key={id} id={`doc-${id}`} name="documents" value={id} label={DOCUMENT_LABELS[id]} description={DOCUMENT_PURPOSE[id]} defaultChecked />
              ))}
            </fieldset>
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">Settings</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField label="Lesson length" name="durationMinutes" options={DURATIONS} defaultValue="60" />
                <SelectField label="Difficulty" name="difficulty" options={DIFFICULTIES} defaultValue="mixed" />
              </div>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="cost-note">
              {draftFlow ? "Creating a draft is free. A lesson pack is used only when you export PDFs." : "Choosing fewer documents still uses one lesson pack."}
            </p>
            <GenerateButton exhausted={exhausted} label={draftFlow ? "Create draft preview" : undefined} />
          </form>
        )}
        </PreparePendingProvider>
      </Card>
      {context && (
        <aside className="flex flex-col gap-4">
          <Card className="flex flex-col gap-3 p-5" data-testid="topic-summary">
            <Badge className="self-start uppercase">Your lesson pack</Badge>
            <h2 className="font-heading text-lg">{context.topic.title}</h2>
            <h3 className="text-sm font-medium">Learning objectives</h3>
            <ul className="list-disc pl-5 text-sm">
              {context.objectives.length === 0 && learningObjectiveItems(context).map((item) => <li key={item}>{item}</li>)}
              {context.objectives.map((o) => (
                <li key={o.id}>
                  {o.label}
                  {o.coverage === "partial" && o.note ? <span className="text-muted-foreground"> — partly covered: {o.note}</span> : null}
                </li>
              ))}
            </ul>
            {context.prerequisites.length > 0 && (
              <>
                <h3 className="text-sm font-medium">Builds on</h3>
                <ul className="list-disc pl-5 text-sm">
                  {context.prerequisites.map((p) => (
                    <li key={p.topicId}>{p.title}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="text-sm">
              <span className="font-medium">Format</span> Letter · Print-ready PDF
            </p>
          </Card>
          <p className="text-[13px] text-muted-foreground">Next, review the preview, then export your PDFs.</p>
        </aside>
      )}
    </div>,
  );
}
