# Generation flow: preview first, export charges (design; decisions D-94 to D-101; **no implementation yet**)

Status: direction chosen by the owner on 2026-10-22, replacing the verified-first content direction ([content-architecture](content-architecture.md), now legacy). Nothing here is built. Each slice needs its own go. Labels: **[D]** decided by the owner, **[P]** proposed, awaiting owner confirmation, **[I]** inference to confirm when building, **[F]** repo fact.

## 1. Why the direction changed
NotePrep is a simple tool for independent tutors, not for schools or exam bodies. Strict machine verification of every item limits topic breadth to what we can write validators for. The owner chose an LLM-first flow where correctness is a label, not a gate. The trade-off is accepted knowingly: wrong answers will appear sometimes, and the product's edge over a general chatbot becomes selection, a clean preview and print-ready PDFs.

## 2. The flow [D]
1. The tutor selects topic, difficulty, length and documents on Prepare (selection first).
2. **Preview:** a web preview only. No LaTeX is compiled and no allowance is charged. Items come from the LLM, or from the bank cache once enabled (section 6).
3. **Unsatisfied?** The tutor types a free-text request and the preview regenerates. Still no charge.
4. **Export:** a confirmation dialog, then the LaTeX compile. **One generation is consumed only when the compile succeeds** and the PDFs are available to download (whether they are downloaded does not matter). A failed compile charges nothing.

## 3. Draft, preview and export mechanics
- **Drafts [I]:** each preview is stored as an owner-scoped draft revision with a content hash and a time-to-live (the adjustment drafts planned in M6 slices S2 and S3 are the same concept, see [beta-roadmap](beta-roadmap.md#b2)). Previews, answers and downloads must use the same `revisionId` (CLAUDE.md section 4).
- **Charge point [D]:** at export the system **reserves** one generation (a held slot, not a charge) and converts it to a charge in the same transaction that publishes the compiled revision. Failure, timeout or cancel releases it. Double clicks return the same job through the existing idempotency key [F: reservation, fencing and per-user idempotency already exist; job kinds generate and compile exist in the schema].
- **Confirmation [D]:** clicking Export opens a dialog ("This uses 1 of your N generations. Check your preview first.") with a "Don't show again today" checkbox. It is a per-browser convenience that expires at midnight; the server never relies on it.
- **Re-export of the same draft [P]:** free (consistent with today's rule that existing files stay free to download); any content change creates a new draft whose export costs another generation. Awaiting owner confirmation.
- **Flawless LaTeX [D, mechanism P]:** at preview time the pipeline parses all math into the restricted MathText tree (section 5), renders the TeX string as a dry run and runs the existing source safety check (`assertTexIsSafe`), so unsupported constructs are rejected before the tutor sees the preview. Rare layout failures can still happen at compile time; they release the reservation and show a clear message.

## 4. Correctness is a label, not a gate [D]
- The LLM writes the items. Cheap checks run where they exist: the existing exact linear-equation solver and checker, and a cross-check pass (a second independent solve compared with the key) [P].
- Every item carries a visible status: **checked by code**, **cross-checked**, or **AI-generated, not checked**, on screen and in the PDF.
- Export is never blocked by an unchecked item. A tutor can flag an item as wrong and get a replacement; flagged items are quarantined (section 6).
- This relaxes CLAUDE.md sections 1, 5, 7 and 11 (see section 8). Those edits need the owner's separate approval.

## 5. Safe rendering stays mandatory [D]
LLM output must never reach LaTeX or the web preview as raw text: LaTeX injection can read files or run commands inside the compiler, and HTML injection can run script in the preview. So **MathText** (a restricted LaTeX-style syntax parsed by our own code, see [question-bank-design](question-bank-design.md) section 3) is required again. Preview HTML and PDF render from the same parsed content; no raw HTML; KaTeX with trust off; the sandbox and fixed templates are unchanged.

## 6. Bank cache [D for the mechanism, P for eligibility]
- **Collect from day one, serve later [D]:** generated items are saved from the start, but **no stored item is served until the bank reaches a threshold N** (owner example: 10,000 rows). Until then every preview generates fresh content. After the threshold, previews randomly draw suitable stored items. The purpose is scaling, not saving money at first. N and the on/off switch are configuration, so the owner can toggle it when comfortable.
- **Open parameters [P]:** count rows **per bucket** (topic by level) rather than globally, so thin buckets do not serve repeats (a global 10,000 spread over many topics leaves each bucket small); keep an optional fresh fraction after the switch (for example 20 percent still generated fresh) so stored mistakes are diluted.
- **Eligibility [P, awaiting confirmation]:** only items from a preview made from selection alone (no free text) can be stored; an item becomes servable only after its pack was exported and it has not been reported; reported items are removed at once; items from free-text refinements stay private to their draft and never enter the shared bank (they could contain student details or an injected instruction).
- **Serving [I]:** deduplicate by item fingerprint; exclude items the same account has already used; draw with a seed so a draft is reproducible.

## 7. LLM spend limits and privacy
- **Budgets [D: $25 lifetime per test account; P: the rest]:** lifetime cap **$25** of LLM spend per test account (owner). Proposed, pending owner confirmation and a measurement of real cost per preview with the existing evaluation script: a daily sub-cap of about $3 per account; a per-preview cap of about $0.15; about 10 LLM calls per account per hour; and a **global monthly cap** (suggested $100) with an alert at 70 percent and an automatic stop at 100 percent. Spend is tracked in micro-dollars with the existing per-call cost accounting [F: `costMicros` and per-job cost limits exist].
- **Refinement box:** restricted to producing lesson items (structured output only), so it cannot become a general chatbot. Bounded length, anonymity warning ("do not enter student names or identifying details"), and recommended: do not store the raw text beyond the draft's time-to-live. Prompt text is data, never instructions (CLAUDE.md section 7).
- **Sub-processor:** the LLM provider becomes a disclosed sub-processor for every user, not only opt-in testers (decision D-78 notice must name it).
- **Provider:** OpenAI adapter is required ([L1](beta-roadmap.md#l1)).

## 8. CLAUDE.md amendments needed (not made; need owner approval)
- Section 1: selectable topics need validation coverage; selection-first with no free text (refinement box exception); the "complete generation" definition.
- Section 5: a generation is consumed at successful export, not at job start; LLM preview spend is governed by separate budgets, and a model call may precede any reservation.
- Section 7: math validated and known errors block export becomes labelled status with no export block; unsupported AI output may be shown labelled; adjustment and refinement rules.
- Section 11: definition of done and required tests for the new flow.

## 9. Build order [P]
- **Slice A, preview/export split (no LLM needed):** draft storage, HTML preview, charge-at-export with the confirmation dialog, using today's linear generator as the item source. Fixes the flow for current tutors.
- **Slice B, LLM item source:** OpenAI adapter, MathText parser and renderers (independent security review), item statuses, flagging, collect-from-day-one bank with the threshold switch, spend caps.
- **Slice C, free-text refinement:** budget, injection handling, privacy wording.

## 10. Legacy
The families, blueprints and the M0 extraction ([content-architecture](content-architecture.md)) remain in the repo, decoupled from this flow and archived as legacy. The linear solver and checker may serve as the optional "checked by code" label source because they cost nothing to keep.

## 11. Open owner items
1. Confirm the bank eligibility rule (section 6) and per-bucket counting.
2. Confirm the proposed spend caps (section 7) after measuring cost per preview.
3. Confirm that re-exporting the same draft is free (section 3).
4. Approve the CLAUDE.md amendments (section 8) before any build.
