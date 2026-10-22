"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { domainErrorCode, InvalidRequest } from "@/lib/domain/errors";
import { DOCUMENT_KINDS } from "@/lib/package/schema";
import { requireAccount } from "@/lib/server/auth/require-user";
import { webDal } from "@/lib/server/dal/instance";

// Question-level adjustment of a draft version. Every action names the version and the revision the page showed
// (`expectedRev`), so a second tab holding an older page gets a conflict instead of overwriting a newer state. The
// browser sends ids and integers only; nothing about the questions themselves comes from it.

const Base = z.object({
  draftId: z.uuid(),
  versionId: z.uuid(),
  expectedRev: z.coerce.number().int().min(1).max(1_000_000_000),
  doc: z.enum(DOCUMENT_KINDS).optional(),
});
const QuestionId = z.string().regex(/^ex-[1-9]\d{0,5}$/);
const CandidateId = z.uuid();

const field = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" && v !== "" ? v : undefined;
};

/** Where the page returns to after the full-page redirect: the acted question, or the changes indicator (for undo). */
const fragmentOf = (formData: FormData) => {
  const at = field(formData, "at");
  if (at === "changes") return "#changes-indicator";
  return at && /^[1-9]\d?$/.test(at) ? `#question-${at}` : "";
};

const draftHref = (draftId: string, doc: string | undefined, error?: string, fragment = "", version?: string) => {
  const q = new URLSearchParams();
  if (doc) q.set("doc", doc);
  if (version) q.set("v", version); // the version the tab is looking at survives the redirect (and a conflict reload)
  if (error) q.set("error", error);
  // A redirect to the page's own URL plus a fragment would be a hash-only navigation, which the router does not refetch.
  // A changing token makes it a real navigation, so the page is rendered again with the new state.
  if (fragment) q.set("n", Date.now().toString(36));
  const s = q.toString();
  return `/drafts/${draftId}${s ? `?${s}` : ""}${fragment}`;
};

type Dal = ReturnType<typeof webDal>["drafts"];
type Ctx = Awaited<ReturnType<typeof requireAccount>>["ctx"];
type Parsed = z.infer<typeof Base>;

async function run(formData: FormData, extra: (formData: FormData) => z.ZodType | null, op: (dal: Dal, ctx: Ctx, base: Parsed, x: Record<string, string>) => Promise<unknown>) {
  const { ctx } = await requireAccount();
  const base = Base.safeParse({ draftId: field(formData, "draftId"), versionId: field(formData, "versionId"), expectedRev: field(formData, "expectedRev"), doc: field(formData, "doc") });
  if (!base.success) redirect(z.uuid().safeParse(field(formData, "draftId")).success ? `/drafts/${field(formData, "draftId")}` : "/prepare");
  const { draftId, doc } = base.data;
  const schema = extra(formData);
  const x = schema ? schema.safeParse(Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string"))) : null;
  if (x && !x.success) redirect(draftHref(draftId, doc, "QUESTION_NOT_FOUND", fragmentOf(formData), base.data.versionId));
  let target = draftHref(draftId, doc, undefined, fragmentOf(formData), base.data.versionId);
  try {
    await op(webDal().drafts, ctx, base.data, (x?.data ?? {}) as Record<string, string>);
  } catch (error) {
    const code = domainErrorCode(error);
    if (!code) throw error;
    target = draftHref(draftId, doc, code, fragmentOf(formData), base.data.versionId);
  }
  redirect(target); // outside the try: redirect() works by throwing
}

const forQuestion = () => z.object({ questionId: QuestionId });
const forCandidate = () => z.object({ candidateId: CandidateId });

/** Asks for an alternative to one exercise (the original stays until it is accepted). Asking again draws the next one. */
export async function requestCandidate(formData: FormData) {
  await run(formData, forQuestion, (dal, ctx, b, x) => dal.requestCandidate(ctx, b.draftId, b.versionId, b.expectedRev, x.questionId!));
}

export async function tryAnother(formData: FormData) {
  await run(formData, forCandidate, (dal, ctx, b, x) => dal.tryAnother(ctx, b.draftId, b.versionId, b.expectedRev, x.candidateId!));
}

export async function keepOriginal(formData: FormData) {
  await run(formData, forCandidate, (dal, ctx, b, x) => dal.keepOriginal(ctx, b.draftId, b.versionId, b.expectedRev, x.candidateId!));
}

export async function acceptCandidate(formData: FormData) {
  await run(formData, forCandidate, (dal, ctx, b, x) => dal.acceptCandidate(ctx, b.draftId, b.versionId, b.expectedRev, x.candidateId!));
}

export async function removeQuestion(formData: FormData) {
  await run(formData, forQuestion, (dal, ctx, b, x) => dal.removeQuestion(ctx, b.draftId, b.versionId, b.expectedRev, x.questionId!));
}

export async function undoChange(formData: FormData) {
  await run(formData, () => null, (dal, ctx, b) => dal.undo(ctx, b.draftId, b.versionId, b.expectedRev));
}

// --- versions (S3). These name the DRAFT revision the page showed (`expectedDraftRev`); a stale tab gets the conflict notice. ---

const VersionBase = z.object({
  draftId: z.uuid(),
  expectedDraftRev: z.coerce.number().int().min(1).max(1_000_000_000),
  doc: z.enum(DOCUMENT_KINDS).optional(),
  v: z.uuid().optional(), // the version this tab is showing, kept on errors
  versionId: z.uuid().optional(),
});

async function runVersion(formData: FormData, op: (dal: Dal, ctx: Ctx, b: z.infer<typeof VersionBase>) => Promise<{ versionId: string }>) {
  const { ctx } = await requireAccount();
  const base = VersionBase.safeParse({ draftId: field(formData, "draftId"), expectedDraftRev: field(formData, "expectedDraftRev"), doc: field(formData, "doc"), v: field(formData, "v"), versionId: field(formData, "versionId") });
  if (!base.success) redirect(z.uuid().safeParse(field(formData, "draftId")).success ? `/drafts/${field(formData, "draftId")}` : "/prepare");
  const { draftId, doc, v } = base.data;
  let target: string;
  try {
    const done = await op(webDal().drafts, ctx, base.data);
    target = draftHref(draftId, doc, undefined, "#editing-version", done.versionId);
  } catch (error) {
    const code = domainErrorCode(error);
    if (!code) throw error;
    target = draftHref(draftId, doc, code, "#versions", v);
  }
  redirect(target);
}

/** Creates another version (new seed, same lesson configuration); the current version is kept. No confirmation: nothing is lost. */
export async function createAnotherVersion(formData: FormData) {
  await runVersion(formData, (dal, ctx, b) => dal.createVersion(ctx, b.draftId, b.expectedDraftRev));
}

/** Makes another existing version the one the draft opens on. Writes only the draft's pointer. */
export async function switchToVersion(formData: FormData) {
  await runVersion(formData, async (dal, ctx, b) => {
    if (!b.versionId) throw new InvalidRequest();
    return dal.switchVersion(ctx, b.draftId, b.versionId, b.expectedDraftRev);
  });
}
