# Slice B design: the LLM question source

Status: DESIGN, answered by the owner on 2026-11-01 (approvals and 12 amendments, section 6). Nothing here is built. Building needs an approved plan; the CLAUDE.md text in the appendix is approved only after it incorporates the owner's constraints (amendment 12), and the D-33 revision needs explicit owner review first. Sources: [generation-flow](../../generation-flow.md) (D-94 to D-101), [decisions](../../decisions.md), [question-bank-design](../../question-bank-design.md), the S1 to S6 plan ([preview-adjust-export](../plans/2026-10-23-preview-adjust-export.md)) and the code at `origin/main` 526f9b6.

Labels: **[D]** decided by the owner, **[CC]** controller call (2026-11-01), owner may overrule, **[YOUR CALL]** left to the builder with my recommended default, **[GUESS]** an estimate to check, **[F]** a fact read from the repo (file cited), **UNVERIFIED** cannot be determined from the repo.

## 1. Intent and why

Today a tutor can produce a lesson for 4 topics only, all linear equations in one variable [F: `data/curricula-src/topics.json` maps exactly `one-step-equations`, `two-step-equations`, `unknown-both-sides`, `like-terms-before-solving` to the one concept in `src/lib/curriculum/capabilities.ts`]. 49 curricula are live and every Grade 11 and 12 course is greyed out. The owner chose an LLM-first direction (D-95, reaffirmed by amendment 1): the LLM writes the questions; exact code checks raise confidence where they exist but are not required for a topic to be offered. Slice B adds that source with its safety (MathText), cost control (D-98) and feedback loop (flags, takedown, bank collection), without weakening the deterministic path (D-102) or the pack-allowance contract (CLAUDE.md section 5). The owner's priority: a working, safe end-to-end slice B before expanding the topic catalog.

How items are produced today [F]:
- `createDraft` (`src/lib/server/dal/drafts.ts`) runs in the web request, in one transaction: `buildPackageWithMeta` (`src/lib/package/build.ts`) builds the package synchronously, `validatePackage` runs, and only an overall `verified` package is stored in `draft_version.content`.
- Questions enter only through `src/lib/content/item-source.ts` (D-107): `admitItem` schema-parses a `RawItem` against the linear `QuestionSchema` (`src/lib/math/schema.ts`), re-solves it exactly and returns a `VerifiedItem` only when verified. Replace draws through the same source (`drawReplacement`, `src/lib/package/draft-ops.ts`).
- `lesson-package/1` (`src/lib/package/schema.ts`) has math blocks only for linear equations; TeX math comes only from `src/lib/latex/math.ts`; the HTML preview renders the same TeX through KaTeX (`src/lib/ui/math-html.ts`, `trust: false`, `strict: "error"`).
- Notes prose for drafts comes from blueprints (`src/lib/content/blueprints/linear-general.ts`); the optional LLM prose path (`src/lib/package/prose-generate.ts`) runs only in the worker.
- Only the worker holds the LLM key [F: `.env.example` line 61; `docs/security-and-privacy.md`]. Provider interface: `src/lib/llm/types.ts` (Anthropic adapter, fake, `factory.ts`). `src/lib/server/limits.ts` reserves three unused `LLM_MAX_*_PER_DRAFT` keys; `CANDIDATES_PER_SLOT` is 5. The D-33 adjustment budget exists only as an error class (`AdjustmentBudgetExhausted` in `src/lib/domain/errors.ts`); nothing enforces it and no setting exists.

Where the LLM source plugs in: a worker job (`draft_items`) produces raw items, a new gate `admitAiItem` (5.2) admits them, and the result is written into the existing draft tables.

## 2. Goals, non-goals, anti-goals

Goals
1. A tutor can select an allowlisted AI topic in Grade 8 to 12 courses and get a draft whose items and notes wording come from the LLM, with each item's tutor-visible label on screen and the legend in the PDFs.
2. Replace, Remove, Undo, Create Another Version and Export work for AI drafts as today; export charges only on success.
3. No raw model text reaches LaTeX or HTML; all math is MathText parsed by our code into one shared AST.
4. LLM use is limited per user (10 AI operations per hour) and, separately, by raw-call, token, retry and cost caps, enforced atomically before each call and reconciled after.
5. A tutor can flag an item (own-draft effect); the operator can take an item down globally.
6. Every shown AI item is collected into a write-only bank.
7. One switch turns the LLM source off; deterministic topics keep working.

Non-goals: free-text refinement (slice C); subjects other than math (only a tiny `Subject` boundary, 5.11); primary school; Stripe; serving from the bank; figures; tutor math editing; analytics beyond content-free telemetry; flagging exported lessons; expanding past the 12 topics before the end-to-end sub-slice passes.

Anti-goals: an AI item shown as "Checked by code" without a code checker re-deriving it; LLM agreement presented as a guarantee; any alignment claim in AI content; a model call from the web process or without a prior reservation; a pack allowance charged or held for a failed generation or failed export; a general CAS, `eval` or `new Function`; tutor or account identifiers in the shared bank; a curriculum schema change or a new curriculum version made only to enable AI generation.

## 3. Constraints

- CLAUDE.md sections 1, 5, 7, 9, 10, 11 as amended (appendix); until then the current text binds.
- Section 10: the web app validates, enqueues and returns an id; no transaction across an LLM call; durable jobs with leases and fencing; polling.
- Section 3: one job table (`generation_job`).
- Section 8: compiler, templates and `assertTexIsSafe` (`src/lib/latex/render.ts`) stay the export-time boundary.
- Section 9 and D-43: minimum context to the provider; an approximate grade band is approved; no student personal data.
- D-98 is CONFIRMED (owner, 2026-11-01; recorded in PR #60). All values are configuration.
- D-94: no LaTeX compile at preview. Amendment 11: no curriculum JSON schema change and no new curriculum versions for AI generation.
- Process: CI uses the fake LLM and fictional data; real-provider runs are separate and controlled; the owner provides the OpenAI key.

## 4. Earlier owner decisions this design builds on [D]

- **D-95:** LLM-first; correctness is a label, not a gate; status on screen and in the PDF; export never blocked by an unchecked AI item; flagging quarantines. An item that FAILS a check we can run is never shown as valid: bounded regeneration, otherwise dropped. "Known mathematical errors block final export" stays.
- **D-102:** for deterministic-source items verification stays a hard gate.
- **D-96:** MathText mandatory; preview and PDF from the same parsed content; no raw LLM text in LaTeX or HTML; preview-time safety check; independent security review.
- **D-81 / D-40:** OpenAI preferred; keep Anthropic and the fake; no model id or price defaults in the repo.
- **D-98:** $25 lifetime per test account; about $3 per day; about $0.15 per preview; 10 per hour (now defined as AI operations, amendment 4); $100 global monthly cap, alert at 70 percent, stop at 100 percent; reserve before, settle after, recorded per call without content; separate from the pack allowance.
- **D-99:** collect from day one; serve only after a per-bucket threshold N; reported items removed; free-text items never enter the bank. Eligibility rules are decided before the serving slice.
- **D-100:** legacy families stay decoupled; the linear solver may be a "checked by code" source.
- **D-43 / D-78:** subprocessor disclosure and beta privacy notice before real users.
- **Scope (D-74):** a topic is selectable only if it is in the dataset AND has a generation capability; topic states `verified`, `ai_beta`, `unavailable`; `ai_beta` only from an explicit allowlist.

### 4.1 Decisions this design revises (owner approval needed; none is applied)
- **D-107** ("only `VerifiedItem`s can enter a package"): for authorized AI topics, an `AiItem` admitted by `admitAiItem` may also enter a package (owner approved AI items in packages for authorized AI topics, 2026-11-01). `VerifiedItem` stays the only path for deterministic topics; D-102 stays.
- **D-33:** see the appendix section "D-33: current text and proposed revision" (explicit owner review required, amendment 12).
- **D-43:** adds the approximate grade band (approved by the owner, 2026-11-01; `docs/security-and-privacy.md` needs the matching edit when built).
- **CLAUDE.md sections 1, 5, 7, 11** (optionally 4 and 10): the appendix.

## 5. Design

### 5.1 Execution model [D: worker + existing job table + `draft_items`]
- AI generation runs in the worker as a durable job in `generation_job` with the new kind `draft_items` (irreversible enum value, approved), a nullable `draft_id`, and `lesson_id` made nullable under a CHECK (`kind = 'draft_items'` exactly when `draft_id IS NOT NULL AND lesson_id IS NULL`; such jobs never have a reservation).
- **Idempotent and asynchronous [YOUR CALL]:** `createDraft` for an AI topic validates, applies the existing idempotency key (operation `draft`, same key + same request returns the same draft and job; same key + different request conflicts), counts one AI operation (5.5), inserts the `draft` row with `active_version_id = NULL` (already nullable [F]) and the job in one transaction, and returns the draft id. `/drafts/[id]` polls an owner-scoped status endpoint; status survives refresh. The worker commits `draft_version` 1 and the pointer in one short transaction guarded by the current fencing token. Deterministic topics keep today's synchronous path.
- **Explicit failure states:** the job ends `succeeded`, `failed` (typed codes: `llm_cap_*`, `llm_global_stop`, `llm_disabled`, `too_few_valid_items`, `llm_<provider error>`, `deadline`), or `canceled`; the UI maps each code to a message (5.10).
- Per-account concurrency 1 for `draft_items`; a global queue cap; per-job `max_calls`, `max_tokens`, `max_cost_micros` [F: columns exist] as one budget across all attempts and repairs.
- The `draft_items` job never uses the compile sandbox (5.2).

### 5.2 Item contract and gate [YOUR CALL]
Schema `ai-items/1`, sent as JSON Schema (common subset, like `responseSchema` today), parsed strictly by our zod schema. A call returns `{ items: AiItem[] }`; each item is a strict object:
- `stem`: MathText, at most 600 characters.
- `answer`: `{ kind, value }`, `kind` from the topic's allowed kinds: `number`, `expression`, `roots`, `pair`, `inequality`, `text` (short words). `value` is MathText (a list for `roots`/`pair`).
- `steps`: 1 to 8 MathText strings, each at most 300 characters.
- `check`: optional structured claim a code checker can test (5.3).
- `difficulty`: `basic | mixed | challenge` (model judgement; never claimed).
- `role`: `example | exercise`.
No other fields.

`admitAiItem(raw, topicEntry)`, in order, each failure a reason code (never text): strict schema; lengths; MathText parse of every field (5.4); forbidden content (existing `checkText`/`curriculumNames` in `src/lib/package/prose-rules.ts`, plus URL/email/control/bidi checks); answer kind allowed; claim binding and code check (5.3); static safety check (below); dedupe by fingerprint `sha256(canonical AST of stem + answer)` against the draft, its spares and the global blocklist (5.7). Output: a branded `AiItem` carrying its internal status, `itemHash` and `genConfig` (5.8).

**Static preview check only [D, approved 2026-11-01].** The preview-time "dry run" is: MathText parse, `toTex` and a check against the fixed macro allowlist as `assertTexIsSafe` does, and optionally a KaTeX render of the same TeX. No LaTeX compile at preview (D-94); D-96 says the export compile is "expected to succeed", not guaranteed; a compile failure at export is handled by the export flow (reservation released, nothing charged).

**Package storage:** `lesson-package/2` adds blocks `ai_question` (exercises: `questionId`, stem AST, `status`), `ai_solution` (solutions: `questionId`, answer, steps, `status`), `ai_worked_example` (notes) and `key_formulas` (notes, optional, 5.9), keeping the worksheet/answer split by section kind (`DOCUMENT_SECTION_KINDS`). Blocks store the canonical AST, `itemHash` and `genConfig`; question and solution share `questionId` and `itemHash`. `lesson-package/1` stays readable.

### 5.3 Validation status vs tutor-visible label [D: amendments 1 and 3; mapping CC]
**Internal status** (stored in the block, hashed into the frozen snapshot, used in telemetry and the bank): `code_checked | cross_checked | unchecked | failed`.
- `code_checked`: one of our exact checkers re-derived the stated final answer AND the checked claim is bound to the displayed stem (the claim's AST must equal a math span in the parsed stem; otherwise the item counts as having no check). Checkers (exact integer/rational arithmetic, restricted AST, no CAS): (1) linear equations in one variable, via `src/lib/math/linear.ts` after normalizing degree at most 1; (2) polynomial equations of degree at most 2 with rational coefficients, exact roots in Q or `(p ± q√d)/r`, compared as a set incl. double and no-real roots; (3) 2x2 linear systems incl. none/infinite; (4) bounded exact numeric evaluation (percent, ratio, integer exponents, Pythagorean lengths, nCr/nPr, arithmetic/geometric terms and sums, f(a) for polynomial f); (5) linear inequalities incl. direction flip. Checkers are high-confidence validation where they apply, NOT a requirement for a topic or an item (amendment 1).
- `cross_checked`: no checker applies and an independent second model call that saw only the stem gave an answer equal to the stated one after both are parsed and normalized by code. Internal only (amendment 3): two model outputs agreeing is not a mathematical guarantee. Default [CC]: on, batched (one call per draft for unchecked items), configurable.
- `unchecked`: passed the gate, no check applied.
- `failed`: a checker or cross-check disagrees, or any gate failure. Never shown; regenerated within the budget or dropped.

**Tutor-visible label** (only two states, plus the flag action):
- **"Checked by code"** when `code_checked`.
- **"AI-generated: please review"** for `cross_checked` and `unchecked`.
`cross_checked` is never shown to tutors as a separate or stronger state.

**PDF [CC]:** no per-question badge on every item. Notes and Solutions carry a small neutral marker only next to items that are NOT code-checked, plus one legend line ("Marked items are AI-generated and were not checked by code: please review them before teaching") and the existing "AI-assisted material. Review it before teaching." line. The worksheet carries no per-item markers and no answers; it keeps the existing worksheet header (D-95 is satisfied by the two on-screen states and the legend in Notes and Solutions). Reason: the owner asked not to mark every exported question prominently, and student-facing pages should not carry review notes meant for the tutor.

**Not claimed, ever:** correctness of steps (except existing linear step checks for deterministic items), difficulty, wording, originality, curriculum fit.

**Re-derivation:** `validatePackage` re-runs checkers on every AI item and never trusts a stored `code_checked`; a stored `cross_checked` is a recorded fact, downgraded to `failed` if a checker now disagrees. Package overall: `verified` (every item code-checked or deterministic-verified), `labelled` (no failed, flagged or taken-down item; at least one weaker item), `failed`. `confirmExport` (today refuses anything but `verified`, `src/lib/server/dal/export.ts` line 121 [F]) accepts `verified` or `labelled`; deterministic items must still be verified. The marker and legend are rendered into TeX, so they are part of the export identity (D-109).

### 5.4 MathText: one shared AST [D: approved; grammar YOUR CALL]
- String form: plain text with inline math in `\( ... \)`; a bare `$` is text. No display math in slice B.
- Text segments: printable letters, digits, spaces, a punctuation allowlist; no backslash, control or bidi characters; URLs and emails rejected.
- Math subset: bounded integers and decimals; single Latin letters; `\alpha \beta \theta \pi`; `+ - = < > \le \ge \neq \pm \times \cdot \div / ,`; balanced `()` `[]`; `|x|`; `\frac{}{}`; `^`; `_`; `\sqrt{}` and `\sqrt[n]{}`; `\%`; `^\circ`; `\sin \cos \tan \log \ln`; `\ldots`. Limits: span at most 300 characters, depth 8, exponent nesting 3, 20 spans per string. The grammar grows only by deliberate change.
- Parser: hand-written recursive descent into a typed AST, versioned (`MATHTEXT_PARSER_VERSION`); errors are codes; no regex sanitizing as the boundary.
- Renderers: `toTex(ast)` emits a fixed macro set (text through `t()` in `src/lib/latex/escape.ts`; `ALLOWED_BODY_COMMANDS` grows by exactly those macros); HTML renders the SAME TeX via `renderMathHtml`; text through React escaping. Canonical serializer with `parse(serialize(ast)) == ast` for hashing.
- Security-critical (only path from model bytes to TeX and the browser). Tests: golden accept/reject tables; property tests (round trip; every emitted TeX passes the allowlist check and KaTeX strict); hostile fuzz corpus (`\input`, `\csname`, `\catcode`, `^^5c`, `\def`, unbalanced braces, deep nesting, 100k strings, `\href{javascript:}`, HTML, confusables, bidi, NUL); linear-time bound.
- First step: a one-page grammar spec and about 20 sample items tried on candidate models.

### 5.5 Rate limits, spend ledger and reservations [D: amendments 4, 5, 7, 9; mechanism YOUR CALL]
**User-level AI operations (amendment 4):** 10 per user per hour (`rate_limit_window`, key `aiop:u:`). An operation is one of: preview (AI draft creation), new version, replace/try-another that needs AI content, refill. Counted in the web transaction that enqueues the job (or consumes a spare); a replay of a recorded idempotency key is not counted.

**Separate caps in the ledger:** raw provider calls per job and per user per hour; tokens per job; retries per job; cost per call, per preview (job), per user per UTC day, per user lifetime ($25), and global per month ($100, alert 70 percent, stop 100 percent). All configuration.

**Tables (migration sketch):**
- `llm_call`: `id`, `owner_id`, `job_id`, `job_attempt`, `fencing_token`, `call_seq`, `purpose` (`items | prose | crosscheck`), `provider`, `model`, `config_id`, `prompt_version`, `state`, `estimate_micros`, `input_tokens`, `output_tokens`, `cost_micros`, `usage_estimated`, `created_at`, `settled_at`. UNIQUE (`job_id`, `job_attempt`, `call_seq`). No content.
- `llm_spend_user` (one row per owner: `lifetime_reserved`, `lifetime_settled`) and `llm_spend_user_day` (`owner_id`, `day` UTC, reserved, settled, calls), `llm_spend_month` (`month` UTC, reserved, settled, `alerted_70_at`, `stopped_at`). Counters are kept equal to the ledger by the same transactions; a reconciliation query compares them with `SUM` over `llm_call` (drift is an alert, never silently fixed).

**State machine per call:** `reserved → settled` (actual usage, or the ceiling when the provider reported none) or `reserved → released` (only when the call provably was not sent: the reservation transaction committed but the worker's pre-send check failed, e.g. fencing lost or cancel seen, recorded before any network I/O). One-way; settle and release are `UPDATE ... WHERE state = 'reserved'` and affect at most one row.

**Reserve (one atomic transaction, amendment 5):** lock `llm_spend_month` (the month row) then the user row then the user-day row `FOR UPDATE`, in that fixed order (no deadlocks across workers); verify the job is `running` with this worker's `fencing_token` and attempt; check every cap with reserved + settled + this estimate (`estimate = input-token estimate * input price + max_output_tokens * output price`); insert the `llm_call` row (the unique key makes a repeated reserve for the same attempt and `call_seq` a no-op that returns the existing row); add the estimate to the counters. Refused if any cap would be exceeded or `stopped_at` is set.

**After the call:** settle with actual usage (counters: minus estimate from reserved, plus actual to settled); the job's `calls_used`, `tokens_used`, `cost_micros` are updated in the same transaction. A late settle from a worker that lost its lease still settles the ledger (the money was spent) but cannot commit content (fencing, 5.1).

**No double charge after retries:** a retry of the job is a new attempt with new `call_seq` rows; the previous attempt's rows stay settled or are settled by recovery, never re-reserved or re-charged; `call_seq` is persisted before sending, so a worker restart within the same attempt reuses the existing row instead of reserving again.

**Crash and lease-expiry recovery:** the worker's recovery sweep settles every `reserved` row older than the call timeout plus a grace period at its estimate (an unreported call may have happened: never zero), and the job follows the normal lease-expiry path. Unused reservations are released only under the provable not-sent rule above.

**Allowance contract (amendment 7):** `draft_items` jobs never create usage reservations; failed generation (job failure, validation exhaustion, cap hit) and failed export never consume or hold the pack allowance.

**Kill switch:** `LLM_ITEMS_ENABLED=0` (web and worker): AI topics become unavailable and refused server-side; queued `draft_items` jobs fail with `llm_disabled`; existing AI drafts stay previewable, adjustable from spares and exportable. **Automatic stop** at 100 percent of the monthly cap; one `llm_spend_alert` log event at 70 percent (alerting hook; the current alerting mechanism is UNVERIFIED). **Provider-side limit (amendment 9):** the OpenAI project's own hard limit at most USD 100 for the initial test; application caps stay authoritative.

**Grants:** `worker_runtime`: INSERT/UPDATE on the ledger tables. `app_runtime`: SELECT on its own rows through the DAL for messages; the AI-operation counter uses the existing `rate_limit_window` grants. Migration role: DDL only.

**Telemetry (cost and quality, no content):** per call: tokens, cost, latency, model, config id, prompt version, error type; per job: reason-code counts, internal status counts, refills, retries, duration, outcome. Aggregates: cost per successfully validated lesson pack, code-check rate, cross-check agreement, failure rate per topic.

### 5.6 Prompt and injection handling [YOUR CALL]
- Versioned prompt constants (`ITEMS_PROMPT_VERSION`, `CROSSCHECK_PROMPT_VERSION`, beside `PROSE_PROMPT_VERSION`), one generic topic template (5.9).
- Input only from dataset fields and selections: topic title and summary, the approximate grade band (approved), difficulty, count, role, allowed answer kinds, the grammar summary. No free text, no curriculum names or codes, no student data.
- Output is data, never executed or used to pick tools, files, URLs or templates. Repair prompts carry rule codes only. Logs never contain stems, answers or prompts.

### 5.7 Flags, administrator takedown and bank collection
**Tutor flag (tutor-scoped) [D; details CC from the earlier round, kept]:** owner-scoped `item_flag` (`owner_id`, `draft_id`, `question_id`, `fingerprint`, `reason` enum, `created_at`). Effects: the item is replaced in the flagger's draft at once from spares or by refill; until replaced or removed it blocks that draft's export; removal honours `MIN_EXERCISES` (a replacement first if needed). The fingerprint goes to `bank_blocklist` through a narrow `SECURITY DEFINER` function, which affects only FUTURE generation and bank collection/serving. Other accounts' existing drafts and exports are not touched. `confirmExport` re-checks the frozen snapshot against the owner's own flags, so Undo or versions cannot resurrect it. Rate limit `flag:u:` (placeholder 30 per hour).

**Administrator safety takedown [D: required; mechanism CC].** A separate operator-only lever, not user-facing: an owner-run script (`pnpm takedown -- --fingerprint <hash> | --topic <key> --prompt-version <v> --reason <text>`) run with worker/owner credentials, never a web route and never available to `app_runtime`. It inserts rows into `item_takedown` (`fingerprint` or `topic_key` + `prompt_version`, `reason`, `created_at`, `created_by` operator label) and the blocklist, in one audited transaction. Effects:
- never generated, collected or served again; removed from the bank (`bank_item` row deleted, fingerprint kept in the blocklist);
- drafts that already contain it: on the next open of the draft the item is replaced from spares or by refill (marked in the change summary); if the tutor exports before that, `confirmExport` refuses with a clear message ("One question was withdrawn for safety. It has been replaced; please review the draft."). This is the only global export gate; it is operator-initiated and audited, and tutor flags never trigger it;
- completed exports are NOT altered; the script lists affected export ids (from `export_snapshot` content) for the owner to decide on.
Grants: write access to `item_takedown` for the worker/owner role only; `app_runtime` gets SELECT for the export check. Reason: the owner approved tutor-scoped flags with a separate administrator-level takedown; keeping the global lever offline and audited prevents one tutor blocking another.

**Bank collection (write-only) [YOUR CALL]:** `bank_item`: `fingerprint` (unique), `subject`, `topic_key`, `grade_band`, `difficulty`, `role`, canonical content, internal `status`, `gen_config`, `created_at`, `exported_count`, `reported_at`. No owner, draft or account id. Upserted when a draft version commits; `exported_count` increments on a successful export. Serving (per-bucket N, switch, fresh fraction, eligibility) is a later slice, decided before it starts.

### 5.8 Draft operations and spares [D: amendment 6; spares column CC kept]
- **Initial draft:** one items call (examples, exercises, spares), one prose call (words only), one optional batched cross-check call; bounded refills (`LLM_ITEM_REFILL_CALLS`, default 2 [GUESS]); fewer than `MIN_EXERCISES` valid items fails the job (`too_few_valid_items`), charging nothing.
- **Spare pool:** a separate column `draft_version.spares` with its own `spares_rev`, outside the hashed package, never exported. Target size `LLM_SPARE_POOL_TARGET`, default `CANDIDATES_PER_SLOT` (5 in code [F]). A refill job writes ONLY into the pool, guarded by its fencing token and a `spares_rev` compare-and-swap that does not touch `rev`, so it never conflicts with the tutor. Replace and Try Another consume spares (bumping `rev` as today).
- **Each spare keeps its own** `itemHash`, internal status and `genConfig` (`prompt_version`, `schema_version` `ai-items/1`, `provider`, `model`, `config_id`, `checker_versions`, `parser_version`).
- **Compatibility revalidation on insertion** into a (possibly revised) package: same topic key and subject; difficulty allowed for the slot; answer kind allowed by the CURRENT registry entry; re-parse with the CURRENT MathText parser version; checker re-run when any checker version differs (status may change, `failed` drops it); dedupe against the current package and the blocklist/takedown list. Incompatible spares are dropped (counted in telemetry), never inserted.
- **Create Another Version:** a new `draft_items` job (one AI operation).
- **Remove, Undo, version switch:** unchanged pure operations, extended to the new blocks.
- **Export freezing:** unchanged; internal statuses and `genConfig` are inside the frozen snapshot.

### 5.9 Topics: generic path, no curriculum change [D: amendments 2 and 11; mechanism CC kept]
- **Registry by topic key:** `AI_TOPICS` (beside `capabilities.ts`), keyed by canonical topic key. No `concept` fields in `topics.json`, no `topic_concept` rows, no curriculum JSON schema change, no new curriculum versions (amendment 11). The stored topic id is `${unitId}/${topicKey}` for suggested datasets [F: `src/lib/curriculum/suggested-build.ts` line 206], so the key is the last segment; for other datasets the format is UNVERIFIED and the lookup fails closed. `loadTree` (`src/lib/server/dal/curriculum.ts`) reports support from `topic_concept` rows (`kind: "verified"`) plus the registry (`kind: "ai_beta"`); all readers of `supportedConcepts` and `resolveCurriculumContext` (`TopicUnsupported`) use the same rule. `LLM_TOPICS_ENABLED` can only narrow the registry; the kill switch empties it. The context snapshot carries the registry entry and its version.
- **Generic, minimal entry for a new topic:** `subject` ("math"), topic key, allowed answer kinds, optional checker ids, optional authored key formulas (MathText). Title and summary come from the dataset; objectives and prerequisites come from the dataset where present (topic objectives and prerequisite links), otherwise a words-only LLM paragraph stands in [YOUR CALL]. No hand-authored formulas required.
- **Notes template (generic) [CC kept, made optional]:** objectives, prerequisites, timing from duration, an LLM explanation in words only, key formulas ONLY when the entry has authored ones (a quality boost for the initial 12, never a gate), worked examples = AI items with full steps, common mistakes in words only, a code-generated teaching sequence. The model never writes formulas outside items.
- **Initial allowlist (approved for the first internal implementation):** `percent-of-quantity`, `percent-change`, `proportions`, `exponent-laws`, `pythagorean-theorem`, `simple-probability`, `equations-with-brackets`, `systems-linear-equations`, `quadratic-equations-factoring`, `function-notation`, `quadratic-formula`, `sequences-series` (grade placement from the course templates in `curricula.json`; individual curricula may differ [GUESS]).
- **Adding a topic later:** in `topics.json`, secondary math, no figures, answer kinds expressible in MathText; a controlled run of at least 60 items with parse rate at least 95 percent, zero static-check failures and checker-failure rate at most 10 percent before refills [GUESS]; a reviewed registry change. Cost per topic: the run plus a minimal entry [GUESS: about 15 minutes, plus about 30 more if formulas are authored]. Authoring for the initial 12: about 6 hours including formulas [GUESS].

### 5.10 UI [YOUR CALL]
- Selection: AI topics show an "AI beta" badge and "AI-generated questions: please review before use". Never "aligned", "official" or "verified".
- Draft page: progress state while the job runs; per item one of the two labels (text plus icon, not colour alone, `aria-label`); "Flag this question" with a reason picker; the legend.
- Failures and caps: one plain message per typed code, no dollar amounts ("You have used your AI requests for this hour; try again at HH:MM", "AI questions are paused for now; checked topics still work", "We could not produce enough good questions; try again or pick another topic", the takedown message in 5.7).
- Accessibility: keyboard-reachable flag action, focus to result messages, `aria-live="polite"` polling region, axe checks on the new states.

### 5.11 Subject boundary [D: amendment 10; shape CC]
A `Subject` type with one value `"math"`; registry entries, `bank_item` and the item contract carry `subject`. No other subject, placeholder module or UI exists. Reason: the owner wants reusable interfaces without premature Chemistry/Physics/Biology work; a one-value type is enough to keep the seams honest.

## 6. Owner decisions (2026-11-01)

**Approved:** background worker using the existing job table with the new `draft_items` job type (incl. the irreversible enum value and nullable `lesson_id`); one shared validated math AST for preview and PDF; static preview checks without compiling in the draft path; tutor-scoped flag effects with a separate administrator-level safety takedown; the LLM spend ledger, the global kill switch and independent security reviews; AI-generated items in packages for authorized AI topics (D-107 revision); the approximate grade band sent to the model without unnecessary student personal data (D-43 revision).

**Amendments, and where they are applied:** (1) LLM-first; checkers are confidence mechanisms, not mandatory (5.3). (2) The 12-topic allowlist for the first internal build; a generic topic path; formulas optional (5.9). (3) `cross_checked` internal only; two visible labels; no prominent per-question badge (5.3, 5.10, appendix). (4) 10 AI operations per user per hour; separate raw-call, token, retry and cost caps (5.5). (5) Atomic reservations across concurrent workers, reconciliation, safe release, no double charge (5.5). (6) Spares keep hash, status and generation config; compatibility revalidation (5.8). (7) Pack allowance contract preserved (5.5, check 7). (8) Model chosen by a controlled benchmark (10). (9) OpenAI project hard limit at most USD 100; app caps authoritative (5.5, 10). (10) Math only; tiny `Subject` boundary (5.11). (11) No curriculum schema change or new versions (5.9). (12) CLAUDE.md text approved only with these constraints; D-33 needs explicit review (appendix).

**Delivery requirements (owner):** idempotent asynchronous jobs; strict output schema and safe rendering; independent math validation where available; bounded retries and explicit failure states; cost and quality telemetry; end-to-end preview/edit/export tests; independent security reviews for authorization, spend enforcement, worker lifecycle and rendering boundaries; a working, safe end-to-end slice B before expanding the catalog. Mapped to checks (section 7) and sub-slices (section 9).

**Remaining open (owner):**
1. Approve the final CLAUDE.md appendix text (now incorporating the 12 amendments).
2. Review the D-33 revision (appendix) and choose: retire the per-package budget setting (recommended) or keep it as an additional cap.
3. Model choice after the benchmark, and the OpenAI project limit set before the first real call.
4. Privacy notice and subprocessor wording before the first real user (D-43, D-78).
5. Bank eligibility rules: before the serving slice (not needed for slice B).

## 7. Acceptance checks (observable behaviour)

1. With the fake provider, selecting an allowlisted topic creates a draft asynchronously; refresh shows the same draft and job status; repeating the request with the same idempotency key returns the same draft and job; a different request with that key conflicts.
2. Hostile fake outputs (extra keys, `\input`, `<script>`, unbalanced braces, 100k strings, curriculum codes, wrong answers on checkable items) never reach preview or PDF; reason codes are logged without content.
3. The tutor sees only "Checked by code" or "AI-generated: please review"; a `cross_checked` item shows the second label; altering a stored code-checked answer makes validation fail.
4. Notes and Solutions PDFs show the neutral marker only on items not code-checked, plus the legend; the worksheet has no per-item markers and no AI answer; answers pair with questions by `questionId` and `itemHash`.
5. Export of a `labelled` draft succeeds and consumes exactly one generation; a draft with a failed item, an unreplaced own-flagged item or a taken-down item cannot be exported; preview never compiles and `draft_items` never uses the sandbox.
6. Bounded retries: a provider that keeps failing ends the job `failed` with a typed code after the configured attempts and calls; no unbounded loop.
7. Allowance contract: failed generation (job failure, validation exhaustion, cap hit) and failed export never consume or hold the pack allowance; `draft_items` jobs never create a usage reservation.
8. The 11th AI operation in an hour is refused with its message; raw-call, token, retry and cost caps refuse independently.
9. Spend: every call has a ledger row reserved before and settled after; concurrent workers for one account cannot jointly exceed any cap (real Postgres); a retried or restarted attempt never charges a call twice; a stale reservation is settled at its estimate, never zero; counters equal the ledger sums; the global stop refuses all calls; the 70 percent event fires once.
10. Kill switch off: AI topics hidden and refused; queued jobs fail; existing AI drafts stay previewable and exportable; deterministic topics unaffected.
11. Flags: own-draft replacement, own export blocked until replaced, `MIN_EXERCISES` honoured, no resurrection by Undo or versions, blocklist affects only future content, another account's draft with the same item still exports, rate limit applies.
12. Takedown: only the operator script can create one; the item is never generated, collected or served again; a draft containing it is repaired on open or refused at export with the message; completed exports are unchanged and listed.
13. Spares: a refill never causes `DRAFT_CONFLICT`; spares never change `content_hash` or appear in exports; a spare with an outdated parser or checker version is revalidated, and an incompatible one is dropped.
14. Topics: an allowlisted topic is selectable with no dataset rebuild, migration or curriculum version; narrowing `LLM_TOPICS_ENABLED` refuses it in UI and server; a topic without authored formulas produces Notes without a formulas block.
15. Telemetry records cost and quality metrics per call and job without content; bank rows have no owner, draft or account identifiers.
16. Cross-user access to AI drafts, job status, flags, spend and takedown data is refused.
17. End-to-end with the fake provider: select AI topic → wait → labels → flag → replace → new version → confirm export → PDFs with legend and no worksheet answers → free re-download.
18. Controlled real-provider benchmark (separate): per candidate model, at least 100 items per topic [GUESS]; parse rate, gate pass rate, code-check rate, cross-check agreement, sampled human review (20 items per topic) for answers and steps, p50/p95 latency, and cost per successfully validated lesson pack.

## 8. Risks

- MathText parser or renderer bug: grammar, property and fuzz tests, allowlist check, KaTeX strict, sandbox, independent review.
- Unchecked wrong answers mislead tutors: accepted by D-95; the label, legend, flags, takedown and checkers mitigate.
- Binding gap (checker proves a claim not shown): AST-equality binding and mismatch tests.
- Cost overrun or double charge: atomic reservations, unique call keys, fencing, recovery at estimate, provider-side limit.
- Ledger/counter drift: reconciliation query and alert.
- Compile failure at export despite static checks: handled by the export flow; measured in the benchmark.
- Flag abuse: rate limit; flags never affect other tutors' work. Takedown misuse: operator-only, audited.
- Latency [GUESS 10 to 40 s]: spares, progress UI, p95 in the benchmark.
- Low parse rate: 20-sample trial first; deliberate grammar growth.
- Schema v2: v1 stays readable; v1 golden render unchanged.
- Topic id format in non-suggested datasets: UNVERIFIED; fails closed.
- Scope creep (serving, figures, slice C, other subjects, more topics): out until the end-to-end sub-slice passes.

## 9. Slicing (each with its own tests and review)

1. **B-a MathText** (spec and 20 samples first; parser, AST, serializer, TeX/HTML renderers, allowlist, fuzz/property tests). **Independent Opus review: rendering boundary.**
2. **B-b OpenAI adapter** (`src/lib/llm/openai.ts`, provider enum, factory, injected-`fetch` contract tests, error classification; check the official structured-output rules first). Parallel with B-a. Reviewed with B-e.
3. **B-c Item contract, checkers, statuses** (`ai-items/1`, `admitAiItem`, five checkers, binding, internal status and two visible labels, `lesson-package/2`, marker and legend rendering, `validatePackage` `labelled`, static check, `confirmExport` gate). Fake only. **Independent Opus review: rendering boundary (renderer side) and export gate.**
4. **B-d Spend ledger, caps, rate limits** (ledger and counter tables, reservation state machine, unique keys, fencing check, recovery, reconciliation, AI-operation limit, kill switch, global stop, telemetry, grants, real-Postgres concurrency tests). **Independent Opus review: spend enforcement.**
5. **B-e Worker job and draft integration** (enum migration, `draft_items` runner with leases and fencing, idempotent async `createDraft`, polling, explicit failure states, spares with `genConfig` and revalidation, refill, versions, generic notes template, `AI_TOPICS` registry with `Subject`, initial 12 entries, combined support rule, selection UI). **Independent Opus reviews: worker lifecycle, and authorization (owner scoping of drafts, jobs, status endpoint).**
6. **B-f Flags, takedown, bank** (`item_flag`, blocklist function, `item_takedown` and the operator script, takedown repair and export refusal, `bank_item`, flag UI and rate limit, docs incl. `docs/fresh-droplet-setup.md`, `.env.example`, privacy doc edits). **Independent Opus review: authorization (flag and takedown boundaries).**
7. **B-g End-to-end proof** (E2E check 17 with its own worker, all UI states, axe, the controlled benchmark script and one benchmark run report, a final cross-slice Opus security review). Topic expansion beyond the 12 starts only after B-g passes.

Order: B-a and B-b in parallel, then B-c, B-d, B-e, B-f, B-g.

## 10. Operational prerequisites

- OpenAI key from the owner, only on the worker host and in staging secrets; the OpenAI project hard limit at most USD 100 before the first real call.
- Model selection by the controlled benchmark (check 18): correctness (checkers and sampled human review), p50/p95 latency, cost per successfully validated lesson pack; structured-output support is a prerequisite. No model id in the repo (D-40). An optional separate cross-check model is configuration.
- Privacy notice and subprocessor wording before the first real user.
- Staging variables (names proposed; values are configuration): `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_CONFIG_ID`, `LLM_PRICE_INPUT_MICROS_PER_MTOK`, `LLM_PRICE_OUTPUT_MICROS_PER_MTOK`, `LLM_BASE_URL` (optional), `LLM_ITEMS_ENABLED`, `LLM_TOPICS_ENABLED`, `LLM_CROSSCHECK_ENABLED`, `LLM_CROSSCHECK_MODEL` (optional), `AI_OPS_PER_USER_PER_HOUR` (10), `LLM_CALLS_PER_USER_PER_HOUR`, `LLM_MAX_CALLS_PER_JOB`, `LLM_MAX_TOKENS_PER_JOB`, `LLM_MAX_RETRIES_PER_JOB`, `LLM_SPEND_PER_PREVIEW_MICROS` (150000), `LLM_SPEND_DAILY_MICROS_PER_USER` (3000000), `LLM_SPEND_LIFETIME_MICROS_PER_USER` (25000000), `LLM_SPEND_GLOBAL_MONTHLY_MICROS` (100000000), `LLM_SPEND_ALERT_PERCENT` (70), `LLM_ITEM_REFILL_CALLS` (2), `LLM_SPARE_POOL_TARGET`, `LLM_ITEMS_JOB_DEADLINE_SECONDS`, `LLM_ITEMS_CONCURRENCY_PER_USER` (1), `BANK_COLLECT_ENABLED` (1). They replace the three unused `LLM_MAX_*_PER_DRAFT` keys in `limits.ts`.

## Appendix A: CLAUDE.md amendments (draft text, NOT applied)

`docs/claude-md-amendment-draft.md` is stale (its S1 to S6 text is already in CLAUDE.md). The base is the current CLAUDE.md.

**Section 1, second bullet: replace the first two sentences** ("The initial release supports ... expansion is only to topics with validation coverage.") with:
"The initial release supports secondary-school Math only and individual tutor accounts; Math is the only active generation subject, and subject-neutral interfaces must not implement other subjects early. Selection is topic-first (decision D-74): a topic is selectable only when it is an entry in a versioned topic dataset AND has a generation capability registered in code. Capabilities are of two kinds (decision D-95). `verified`: a deterministic generator whose items pass the validator; such a topic is live only when its verification sweep passes at every level offered, and the first acceptance path remains linear equations in one variable. `ai_beta`: items written by the configured LLM, accepted only through MathText (section 7); such a topic comes only from an explicit allowlist registered in code by topic key (configuration may narrow it, never widen it), is shown with an AI-generated label, is never described as aligned, official or verified, and disappears from selection when the LLM item source is switched off. Enabling AI generation never changes the curriculum JSON schema or publishes a new curriculum version."

**Section 5, first bullet: replace** with:
"A complete generation is a successful export: the complete requested PDF set, made from a frozen snapshot that passed structural checks, static safe-render checks and every mathematical check that applies to its items (no item a check proved wrong, no item the exporting owner flagged, no item taken down by an administrator), is compiled, validated, stored and available through authorized downloads. Items that no exact check covers may be included with their tutor-visible label (section 7). Whether the browser receives the success response does not affect settlement. A failed generation or a failed export never consumes or holds a lesson-pack allowance."

**Section 5, new bullet after "At export confirmation ...":**
"LLM use for drafts (decision D-98) is governed by separate server-side limits, never by the generation allowance: at most a configured number of AI operations per user per hour (preview, new version, replacement, refill; 10 at the start), and separately raw provider calls, tokens, retries and cost per call, per job, per user per UTC day and lifetime, and a global monthly cap with an alert at 70 percent and an automatic stop at 100 percent. Before each model call one atomic, row-locked transaction checks every cap and records a reservation for that call; afterwards it is settled to actual usage (or to the estimate when none is reported, never zero) or released only when the call provably was not sent. Reservations are idempotent per job attempt and call, and a worker without the current lease cannot commit content. Draft jobs never create allowance reservations and never consume a generation. The provider-side project limit is a backstop; the application caps are authoritative."

**Section 5, last sentence of the bullet "Downloading existing files ...":** see Appendix B (D-33), for explicit owner review.

**Section 7, replace these bullets** (others unchanged):
- Pipeline: "Pipeline: validate input → resolve the curriculum context snapshot → plan the outline → produce items (deterministic generator, or the LLM item source for `ai_beta` topics) and prose → validate the strict output schema → parse all math as MathText into one shared AST → run every applicable check (exact validator, code checkers, optional cross-check) and record each item's internal status → bounded regeneration of failed items → render LaTeX deterministically from the AST (at preview time only static checks, no compile) → compile in a sandbox at export → persist and settle."
- Content bullet, last sentence: "Link questions and answers through stable IDs and a shared item hash. Math enters documents only as structured questions: from the deterministic source by reference to validated questions, or from the LLM item source as MathText parsed by our own code into a restricted AST (decision D-96); never as raw model text, raw LaTeX or HTML. Preview and PDF render from the same AST."
- Deterministic bullet: "The architecture is LLM-first for `ai_beta` topics. Deterministic parameterized questions and solvers remain the source for `verified` topics, where verification is a hard gate (decision D-102). Exact code checkers are high-confidence validation where they apply; they are not required for a topic or an item to be offered."
- Record bullet: "Record each item's validation method, coverage, result, limitations, checker and parser versions, generation configuration and internal status: verified (deterministic source), code_checked (an exact checker of ours re-derived the stated final answer from a claim bound to the displayed question), cross_checked (an independent second model answer, parsed and compared by code, agreed), unchecked, or failed. Tutors see only two labels: 'Checked by code' for verified and code_checked items, and 'AI-generated: please review' for everything else. Model agreement is never presented as a mathematical guarantee. Steps of LLM items are not claimed as checked. Stored code_checked statuses are re-derived by code before export."
- Failed output bullet: "An item that fails a check we can run (strict schema, MathText parse, static safe-render check, forbidden content, an exact checker or a cross-check disagreeing) is never shown as valid: it is regenerated within a bounded per-job budget of calls, tokens, retries and cost, otherwise dropped; every job ends in an explicit success or typed failure state. A draft that cannot reach the minimum number of valid items fails and nothing is charged. Items no exact check covers may be shown and exported with the label 'AI-generated: please review'; that label alone never blocks export."
- Changes bullet, append: "Known mathematical errors block final export. A tutor's flag replaces the item in that tutor's own draft, blocks that tutor's export until it is replaced, and keeps its fingerprint out of future generation and any shared item store; it never alters or blocks other accounts' drafts or exports. Only an audited, operator-initiated safety takedown blocks an item globally, including at export. Spare items keep their own hash, status and generation configuration and are revalidated for compatibility before insertion."
- Preview bullet, append: "Documents with LLM items show the tutor-visible labels on screen; Notes and Solutions PDFs carry a small neutral marker only on items not checked by code, with a one-line legend; the student worksheet carries neither markers nor answers."

**Section 11, unit-test bullet, append:** "MathText parser and renderers (accept/reject tables, round-trip and safety property tests, hostile-input fuzzing), each exact checker and the claim binding rule, internal status derivation and the two-label mapping, spare compatibility revalidation, and the item gate against malformed and hostile fake LLM outputs."
**Section 11, integration-test bullet, append:** "LLM limits against real temporary Postgres: the AI-operation limit, atomic reservations by concurrent workers against every cap, idempotent reservation per attempt and call, settlement, release only when not sent, recovery at the estimate, counter/ledger reconciliation, the global stop and the kill switch; flags, takedowns and their export effects."
**Section 11, new required-cases bullet:** "Required cases for the LLM item source: idempotent asynchronous draft jobs; no raw model text reaches LaTeX or HTML; a wrong answer on a checkable item is never shown; the worksheet carries no AI answer; labels and statuses are frozen in the export snapshot; failed generation, cap hits and failed exports never consume or hold allowance; a labelled draft exports and charges once; a tutor flag never affects another account; an administrator takedown blocks the item everywhere at export; bounded retries end in a typed failure; disabling the LLM source leaves deterministic topics working."
**Section 11, E2E bullet, append:** "A second E2E covers an `ai_beta` topic with the fake provider: select → wait for the draft → labels → flag → replace → new version → confirm export → PDFs with the legend and no worksheet answers → free re-download. Independent security reviews cover authorization, spend enforcement, worker lifecycle and the rendering boundary."

**Optional one-liners:** Section 4, minimum model: add "LLM call ledger and spend counters, item flags, item takedowns and a write-only item bank". Section 10: add "Draft item jobs (kind `draft_items`) use the same states, leases and fencing, carry no allowance reservation, and commit draft content only with the current fencing token."

## Appendix B: D-33, current text and proposed revision (FOR EXPLICIT OWNER REVIEW BEFORE ANYTHING IS EDITED)

**Current D-33 row (`docs/decisions.md` line 90, verbatim):**
"| D-33 | 调整计费方案 B:**不调用模型的确定性调整**不是新生成(受速率与计算配额限制);**含模型的调整**消耗每课包的调整额度(配置值,与生成次数分开),成功才消耗、失败返还、一次结算。**每课包调整额度的默认值待定** | **已批准**(默认值待定) |"

**Current CLAUDE.md section 5 sentence implementing it (verbatim):**
"Quick adjustments (decision D-33): deterministic adjustments that call no model are not new generations and are rate-limited; adjustments that call the model consume a per-package adjustment budget (configurable, separate from the generation allowance) with the same success-only consumption, failure release, and single settlement as generations."

**State of the code [F]:** the per-package budget is not implemented; only the error class `AdjustmentBudgetExhausted` exists (`src/lib/domain/errors.ts` line 124), used in one unit test; no setting, table or enforcement exists. Today no adjustment calls a model.

**What slice B changes:** the only model-calling adjustments become AI replacement/refill and new versions of AI drafts. They are governed by the D-98 caps and the 10-AI-operations-per-hour limit (5.5). The first half of D-33 (deterministic adjustments are not new generations and are rate-limited) is unchanged.

**Options:** (a) retire the per-package adjustment budget; (b) keep it as an additional per-draft cap on model-calling adjustments.
**Recommendation: (a), retire it.** Reasons: it was never implemented and has no default (D-33 left it "待定"); the D-98 per-preview, daily, lifetime and global caps plus the hourly operation limit already bound cost per draft and per account; a third budget with success-only consumption would duplicate the ledger's reservation logic and add another settlement path to test. If the owner wants a per-draft bound, the existing `MAX_VERSIONS_PER_DRAFT` and `CANDIDATES_PER_SLOT` limits already cap the number of AI operations one draft can trigger.

**Proposed replacement D-33 text (new row or a note on D-33):** "Adjustments: deterministic adjustments that call no model are not new generations (rate- and compute-limited). Adjustments that call the model (AI replacements, refills, new versions of AI drafts) are not new generations either; they are governed by the D-98 LLM limits (AI operations per user per hour, raw calls, tokens, retries and cost caps) with reserve-before-call and settle-after accounting. The per-package adjustment budget is retired (it was never implemented)."

**Proposed replacement CLAUDE.md sentence:** "Quick adjustments (decision D-33 as revised): deterministic adjustments that call no model are not new generations and are rate-limited; adjustments that call the model are not new generations, never touch the generation allowance, and are governed by the LLM limits above; a failure charges nothing."
