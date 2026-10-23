# CLAUDE.md amendment draft: free draft, charge at export (PROPOSAL, CLAUDE.md is NOT edited)

Status: proposal for the owner's approval. Covers only what the Preview -> Adjust -> Export slices (S1 to S6, decisions D-102 to D-110) change. It does **not** relax mathematical verification (section 7 stays as it is); the LLM-first "correctness as a label" idea from [generation-flow](generation-flow.md) is a later slice and needs its own amendment.

Why it is needed: the code (S4a) reserves an allowance when the tutor confirms an export, but CLAUDE.md sections 1, 4, 5 and 11 still describe reserving at generation start. A reviewer following CLAUDE.md would rightly flag the new flow.

Each block shows the current text (shortened with "...") and the proposed replacement.

## Section 1, user flow
Current: "User flow: sign in → select curriculum, level, course, topic, and options → generate (trackable) → preview → apply quick adjustments or minimal text corrections → export PDFs → view history and remaining allowance → subscribe or manage billing."

Proposed: "User flow: sign in → select curriculum, level, course, topic, and options → create a free draft → preview → adjust (replace or remove questions, create another version) → confirm export → PDFs are compiled (trackable) → download → view history and remaining allowance → subscribe or manage billing. Drafts and adjustments never consume allowance; one generation is consumed only when the complete requested PDF set is ready."

## Section 1, free generations
Current: "Offer a lifetime total of 3 free complete generations without a credit card ... Free results must be fully previewable, adjustable under the same rules as paid results, and exportable ..."

Proposed: append: "A generation is consumed by a successful export (section 5). Previewing, adjusting and creating versions of drafts are free, subject to rate and resource limits."

## Section 4, minimum model
Current: "The minimum model covers User/Profile, Lesson, LessonRevision, GenerationJob, UsageBucket, UsageReservation, Subscription, and WebhookEvent."

Proposed: add "Draft and DraftVersion (free, owner-scoped, expiring previews) and ExportSnapshot and Export (an immutable snapshot and the export entitlement for one export identity)".

## Section 5, what a complete generation is
Current: "A complete generation is a new AI lesson pack that passes structural and mathematical checks, with both student and teacher editions saved as .tex/PDF and available through authorized downloads."

Proposed: "A complete generation is a successful export: the complete requested PDF set, made from a frozen snapshot that passed structural and mathematical checks, is compiled, validated, stored and available through authorized downloads. Whether the browser receives the success response does not affect settlement."

## Section 5, reservation
Current: "Check/reserve allowance, create the job, and record the idempotent request in one database transaction ... Never check the balance, call the model, and decrement afterward."

Proposed: "At export confirmation, check/reserve allowance, freeze the export snapshot, create the export job and record the idempotent request in one database transaction. Creating or adjusting a draft reserves nothing. Never check the balance, run the compile, and decrement afterward."

## Section 5, idempotency and identity (new bullet)
Proposed: "Export identity (D-105, D-109) is a hash of the rendered source of each requested document plus the sorted document set, locale, page format, template version and render version. The same identity never charges twice (double click, retry, refresh, concurrent equivalent requests share one entitlement); re-downloading is free and re-exporting an unchanged snapshot with the same identity reuses the existing export."

## Section 5, what is not a new generation
Current: "... AI regeneration of an entire pack is a new generation."

Proposed: "Creating another draft version is free. Only a confirmed export consumes a generation."

## Section 10, job kinds
Current: job states and stages are defined for generate and compile jobs.

Proposed: add "Export jobs (kind `export`) use the same states and stages (compiling and storing) and settle the export entitlement and the reservation in the same transaction; every terminal path settles all three together."

## Section 11, tests
Current E2E sentence: "sign in → select ... → complete generation → preview Notes, Worksheet, and Solutions → apply a quick adjustment → export PDFs → view history → exhaust trial → subscribe in test mode."

Proposed: "sign in → select ... → create a free draft → preview Notes, Worksheet, and Solutions → replace or remove a question → create another version → confirm export → export succeeds → free re-download → view history → exhaust trial → subscribe in test mode. Required cases add: previews never reserve or consume allowance; a double-clicked or retried export charges once; equivalent concurrent exports share one entitlement; a failed export releases its reservation; the PDF contains exactly the frozen snapshot."

## Not part of this amendment
- Section 7 (verification, labels, repairs) stays as written.
- Section 1's rule on selectable topics stays as written until the LLM slices.
- Text corrections remain deferred (D-72).
