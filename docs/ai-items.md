# Model-written items: contract, checks, labels and the export gate (slice B-c)

Spec: `docs/superpowers/specs/2026-11-01-slice-b-llm-items-design.md` (sections 5.2 to 5.6, 9 item 3). This slice adds the item contract and everything that decides whether an item may be shown or exported. It calls no model: tests use fictional fake outputs only, and no course, unit or topic becomes selectable.

## The gate: `admitAiItem` (`src/lib/content/ai-item.ts`)

A model's item enters a lesson only as an `AiItem`, which only `admitAiItem` makes. Order of checks, each ending in a reason code and never an echo of model text:

1. Strict schema `ai-items/1`: `role`, `difficulty`, `stem`, `answer {kind, value}`, `steps`, optional `check` (a claim). Extra keys refuse the item; long strings refuse it (`length`).
2. Answer kind is allowed for the topic, and its shape fits (`answer_kind`, `answer_shape`).
3. Every string is parsed as MathText (`parse:<field>:<code>`), checked for curriculum names, codes and alignment wording (`forbidden:<field>:<code>`), and passed through the static render check (`unsafe:<field>:<code>`).
4. The claim is parsed with a closed vocabulary (`claim_invalid`), bound to the displayed stem, and run through an exact checker. A checker that disagrees with the stated answer refuses the item (`check_failed`).
5. De-duplication by fingerprint (canonical stem and answer AST).

Reason codes go to the optional `onReject` sink; the caller logs them. They contain codes only.

## Exact checkers and claim binding (`src/lib/math/checkers/`, `checkers/1`)

Five checkers re-derive the stated final answer with exact `BigInt` rationals and a closed set of surds: linear and quadratic equations, linear inequalities and systems, evaluation of an expression, and the sequence, counting and polynomial helpers listed in `types.ts`. No `eval`, no CAS, no floating point. A claim counts only when it is bound to the displayed question: its operands must be recognisable in the stem. A claim that is not bound gives no check, and the item is `unchecked`, not `code_checked`. Binding is by presence of the operand tokens in the stem, not by their order. Steps are never claimed as checked.

## Statuses and the two labels (`src/lib/content/ai-status.ts`)

`verified` (deterministic source), `code_checked`, `cross_checked`, `unchecked`, `failed`. The tutor sees two labels only: "Checked by code" for `verified` and `code_checked`, and "AI-generated: please review" for everything else (including `cross_checked`: model agreement is not a guarantee). `failed` never reaches a draft.

## Package: `lesson-package/2`

The deterministic builder still produces `lesson-package/1`. A /2 package may hold `ai_worked_example`, `ai_question` and `ai_solution` blocks. A question and its answer share `questionId` and `itemHash` (hash of stem, answer, steps and claim). `withAiItems` (`src/lib/package/ai-blocks.ts`) assembles one from admitted items; the model item source (B-e) will call it.

`validatePackage` adds `overall: "labelled"` and an `ai` report. It never trusts a stored status: it re-hashes each item, runs its checker again, repeats the render and wording checks, pairs questions and answers by id and hash, and refuses a stored status stronger than what code derives (`AI_ITEM_HASH_MISMATCH`, `AI_CHECK_FAILED`, `AI_STATUS_OVERSTATED`, ...). A `/1` package with an AI block is refused (`AI_BLOCK_IN_V1`). Deterministic packs are unchanged: the golden render hashes and `PACKAGE_VALIDATOR_VERSION` stay as they were.

## Rendering

Every character of an item reaches TeX and HTML through `mathTextToTex` / `mathTextToInlineParts`. Notes and Solutions PDFs put a small neutral `*` only on items that are not code-checked, and one legend line only when the document has such an item. The Worksheet has no marker and no answer (it is built from `documentView`, which excludes answers by construction). Markers and the legend are part of the rendered source, so they are part of the export key. The HTML preview shows the two labels with text and a glyph.

## Export gate

`confirmExport` accepts `verified` and `labelled`. It refuses a failed package (`EXPORT_NOT_VERIFIED`), an item the exporting owner flagged (`EXPORT_ITEM_FLAGGED`) and an item an administrator took down (`EXPORT_ITEM_TAKEN_DOWN`), all before anything is reserved. The flag and takedown stores belong to slice B-f; until then `ExportDeps.itemGate` defaults to empty sets and tests inject them. The export worker re-validates the frozen snapshot, and a labelled revision is recorded as `unverified` in `validation_status` (the enum has no `labelled`; the stored report keeps the exact state, and the revision carries an `acknowledgement` of kind `labelled_items` because the schema requires one for any unverified final revision). Migration `20261103100000_export_snapshot_labelled` relaxes the `export_snapshot_verified` check to accept `labelled` as well as `verified`.

## Not in this slice

Draft creation, adjustment and correction (`drafts.ts`, `draft-ops.ts`, `correct.ts`) still require a `verified` package, so a labelled draft cannot yet be created or adjusted through the UI. That is part of the model item source (B-e).
