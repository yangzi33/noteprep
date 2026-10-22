import type { ReactNode } from "react";
import { acceptCandidate, keepOriginal, removeQuestion, requestCandidate, tryAnother, undoChange } from "@/app/drafts/[id]/actions";
import { MathView } from "@/components/app/math";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { equationTex } from "@/lib/latex/math";
import type { DocumentKind } from "@/lib/package/schema";
import type { DraftViewDto } from "@/lib/server/dal/dto";

// Server-rendered adjustment controls for the draft page. Every control is a real <form> with hidden ids and the revision
// the page was rendered at; the package itself never reaches the browser, only these forms and the rendered math.

export interface AdjustContext {
  draftId: string;
  versionId: string;
  rev: number;
  doc: DocumentKind;
  adjust: DraftViewDto["adjust"];
  questionCount: number;
}

function Hidden({ ctx, extra }: { ctx: AdjustContext; extra?: Record<string, string> }) {
  return (
    <>
      <input type="hidden" name="draftId" value={ctx.draftId} />
      <input type="hidden" name="versionId" value={ctx.versionId} />
      <input type="hidden" name="expectedRev" value={ctx.rev} />
      <input type="hidden" name="doc" value={ctx.doc} />
      {Object.entries(extra ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

export const isReplaced = (ctx: AdjustContext, questionId: string) => ctx.adjust.changes.replacedIds.includes(questionId);

/** "Replaced" marker shown on a modified question (worksheet and answer key). */
export function ReplacedBadge({ ctx, questionId }: { ctx: AdjustContext; questionId: string }): ReactNode {
  if (!isReplaced(ctx, questionId)) return null;
  return (
    <p className="print:hidden">
      <Badge tone="neutral" data-testid="replaced-badge">
        Replaced
      </Badge>
    </p>
  );
}

function CandidatePanel({ ctx, number }: { ctx: AdjustContext; number: number }) {
  const candidate = ctx.adjust.candidate!;
  const extra = { candidateId: candidate.id };
  return (
    <div role="group" aria-label={`Suggested replacement for question ${number}`} data-testid="candidate-panel" data-candidate={candidate.id} className="space-y-3 rounded-notice border border-border bg-accent/40 p-4">
      <p className="text-sm font-medium">Suggested replacement for question {number}. The original stays until you accept this one.</p>
      <p>
        Solve for <MathView tex="x" mode="inline" />:
      </p>
      <div className="overflow-x-auto" data-testid="candidate-equation">
        <MathView tex={equationTex(candidate.item.problem.equation)} mode="display" />
      </div>
      <div className="flex flex-wrap gap-2">
        <form action={acceptCandidate}>
          <Hidden ctx={ctx} extra={extra} />
          <Button type="submit" size="sm" data-testid="accept-candidate">
            Accept
          </Button>
        </form>
        <form action={tryAnother}>
          <Hidden ctx={ctx} extra={extra} />
          <Button type="submit" size="sm" variant="outline" data-testid="try-another">
            Try another
          </Button>
        </form>
        <form action={keepOriginal}>
          <Hidden ctx={ctx} extra={extra} />
          <Button type="submit" size="sm" variant="outline" data-testid="keep-original">
            Keep original
          </Button>
        </form>
      </div>
    </div>
  );
}

/** Controls under one worksheet question: Replace and Remove always visible, the candidate panel when one is pending for it. */
export function QuestionControls({ ctx, questionId, number }: { ctx: AdjustContext; questionId: string; number: number }) {
  const min = ctx.adjust.minExercises;
  const canRemove = ctx.questionCount > min;
  const showCandidate = ctx.adjust.candidate?.targetQuestionId === questionId;
  return (
    <div className="space-y-3 print:hidden" data-testid="question-controls" data-question-id={questionId}>
      <div className="flex flex-wrap items-center gap-2">
        <form action={requestCandidate}>
          <Hidden ctx={ctx} extra={{ questionId }} />
          <Button type="submit" size="sm" variant="outline" aria-label={`Replace question ${number}`} data-testid="replace-btn">
            Replace
          </Button>
        </form>
        <form action={removeQuestion}>
          <Hidden ctx={ctx} extra={{ questionId }} />
          <Button type="submit" size="sm" variant="outline" disabled={!canRemove} aria-label={`Remove question ${number}`} title={canRemove ? undefined : `A worksheet keeps at least ${min} questions`} data-testid="remove-btn">
            Remove
          </Button>
        </form>
        <ReplacedBadge ctx={ctx} questionId={questionId} />
      </div>
      {showCandidate ? <CandidatePanel ctx={ctx} number={number} /> : null}
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 questions replaced · 1 removed", announced politely when it changes. */
export function ChangesIndicator({ adjust }: { adjust: DraftViewDto["adjust"] }) {
  const replaced = adjust.changes.replacedIds.length;
  const removed = adjust.changes.removedIds.length;
  const text = replaced === 0 && removed === 0 ? "No questions changed yet" : `${plural(replaced, "question")} replaced · ${removed} removed`;
  return (
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground" data-testid="changes-indicator">
      {text}
    </p>
  );
}

export function UndoControl({ ctx }: { ctx: AdjustContext }) {
  const label = ctx.adjust.undoLabel;
  return (
    <form action={undoChange}>
      <Hidden ctx={ctx} />
      <Button type="submit" size="sm" variant="outline" disabled={!label} data-testid="undo-btn">
        {label ? `Undo: ${label}` : "Nothing to undo"}
      </Button>
    </form>
  );
}
