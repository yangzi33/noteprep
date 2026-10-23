import type { ReactNode } from "react";
import { acceptCandidate, keepOriginal, removeQuestion, requestCandidate, tryAnother, undoChange } from "@/app/drafts/[id]/actions";
import { PanelFocus } from "@/components/app/panel-focus";
import { MathView } from "@/components/app/math";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { equationTex } from "@/lib/latex/math";
import { changesText } from "@/lib/ui/draft-changes";
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
  /** The page URL carries an error notice from an earlier action; a successful action then returns to the clean URL. */
  hasError?: boolean;
}

function Hidden({ ctx, extra }: { ctx: AdjustContext; extra?: Record<string, string> }) {
  return (
    <>
      <input type="hidden" name="draftId" value={ctx.draftId} />
      <input type="hidden" name="versionId" value={ctx.versionId} />
      <input type="hidden" name="expectedRev" value={ctx.rev} />
      <input type="hidden" name="doc" value={ctx.doc} />
      {ctx.hasError ? <input type="hidden" name="clearError" value="1" /> : null}
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
  const extra = { candidateId: candidate.id, at: String(number) };
  return (
    <div id={`candidate-panel-${number}`} tabIndex={-1} role="group" aria-label={`Suggested replacement for question ${number}`} data-testid="candidate-panel" data-candidate={candidate.id} className="space-y-3 rounded-notice border border-border bg-accent/40 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <PanelFocus number={number} />
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
    <div id={`question-${number}`} className="scroll-mt-4 space-y-3 print:hidden" data-testid="question-controls" data-question-id={questionId}>
      <div className="flex flex-wrap items-center gap-2">
        <form action={requestCandidate}>
          <Hidden ctx={ctx} extra={{ questionId, at: String(number) }} />
          <Button type="submit" size="sm" variant="outline" id={`replace-${number}`} aria-label={`Replace question ${number}`} data-testid="replace-btn">
            Replace
          </Button>
        </form>
        <form action={removeQuestion}>
          <Hidden ctx={ctx} extra={{ questionId, at: String(number) }} />
          <Button type="submit" size="sm" variant="outline" disabled={!canRemove} aria-label={`Remove question ${number}`} aria-describedby={canRemove ? undefined : `remove-reason-${questionId}`} data-testid="remove-btn">
            Remove
          </Button>
          {canRemove ? null : (
            <span id={`remove-reason-${questionId}`} className="ml-2 text-xs text-muted-foreground" data-testid="remove-reason">
              At least {min} questions are needed
            </span>
          )}
        </form>
        <ReplacedBadge ctx={ctx} questionId={questionId} />
      </div>
      {showCandidate ? <CandidatePanel ctx={ctx} number={number} /> : null}
    </div>
  );
}

/** "3 questions replaced · 1 removed", announced politely when it changes. */
export function ChangesIndicator({ adjust }: { adjust: DraftViewDto["adjust"] }) {
  return (
    <p id="changes-indicator" tabIndex={-1} role="status" aria-live="polite" className="scroll-mt-4 text-sm text-muted-foreground" data-testid="changes-indicator">
      {changesText(adjust.changes.replacedIds.length, adjust.changes.removedIds.length)}
    </p>
  );
}

export function UndoControl({ ctx }: { ctx: AdjustContext }) {
  const label = ctx.adjust.undoLabel;
  return (
    <form action={undoChange} className="flex flex-wrap items-center gap-2">
      <Hidden ctx={ctx} extra={{ at: "changes" }} />
      <Button type="submit" size="sm" variant="outline" disabled={!label} aria-describedby={label ? undefined : "undo-reason"} data-testid="undo-btn">
        {label ? `Undo: ${label}` : "Undo"}
      </Button>
      {label ? null : (
        <span id="undo-reason" className="text-xs text-muted-foreground" data-testid="undo-reason">
          Nothing to undo yet
        </span>
      )}
    </form>
  );
}
