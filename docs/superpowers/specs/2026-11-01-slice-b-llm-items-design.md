# Slice B design: the LLM question source

Status: DESIGN ONLY (owner go for the design on 2026-11-01). Nothing here is built. Building needs an approved plan, and the CLAUDE.md amendments in the appendix need the owner's separate approval before any build. Sources: [generation-flow](../../generation-flow.md) (D-94 to D-101), [decisions](../../decisions.md), [question-bank-design](../../question-bank-design.md), the S1 to S6 plan ([preview-adjust-export](../plans/2026-10-23-preview-adjust-export.md)) and the code at `origin/main` 526f9b6.

Labels: **[D]** decided by the owner, **[YOUR CALL]** left to the builder with my recommended default, **[OWNER]** only the owner can answer (section 6), **[GUESS]** an estimate or assumption to check, **[F]** a fact read from the repo (file cited), **UNVERIFIED** cannot be determined from the repo.

## 1. Intent and why

Today a tutor can produce a lesson for 4 topics only, all linear equations in one variable [F: `data/curricula-src/topics.json` maps exactly `one-step-equations`, `two-step-equations`, `unknown-both-sides`, `like-terms-before-solving` to the one registered concept in `src/lib/curriculum/capabilities.ts`]. 49 curricula are live, and every Grade 11 and 12 course is greyed out. The owner chose (D-95) to widen breadth with LLM-written questions whose correctness is shown as a label instead of enforced as a gate. Slice B adds that second question source, plus the safety (MathText), the cost control (D-98) and the feedback loop (flag, bank collection) it needs, without weakening the deterministic path (D-102) or the export/billing invariants (CLAUDE.md section 5).

How items are produced today [F]:
- `createDraft` (`src/lib/server/dal/drafts.ts`) runs in the web request, inside one transaction: it builds the package synchronously with `buildPackageWithMeta` (`src/lib/package/build.ts`), runs `validatePackage` and stores only an overall `verified` package in `draft_version.content`.
- Questions enter only through the item-source gate (`src/lib/content/item-source.ts`, D-107): a source returns a `RawItem`; `admitItem` schema-parses it against the linear-equation `QuestionSchema` (`src/lib/math/schema.ts`), re-solves it exactly (`validateLinearQuestion`) and only a `verified` result becomes a `VerifiedItem`. Replace draws candidates through the same source (`drawReplacement` in `src/lib/package/draft-ops.ts`).
- The package schema (`src/lib/package/schema.ts`, `lesson-package/1`) has math blocks only for linear equations (`problem.equation.lhs/rhs`); LaTeX math comes only from `src/lib/latex/math.ts` and the HTML preview reuses the same TeX strings through KaTeX (`src/lib/ui/math-html.ts`, `trust: false`, `strict: "error"`).
- Notes prose for drafts comes from per-topic blueprints (`src/lib/content/blueprints/linear-general.ts`); the optional LLM prose path (`src/lib/package/prose-generate.ts`) runs only in the worker.
- The LLM key is held by the worker alone [F: `.env.example` line 61; `docs/security-and-privacy.md` role table]. The provider interface is `src/lib/llm/types.ts` (Anthropic adapter, deterministic fake, `createLlmProvider` in `factory.ts`). `src/lib/server/limits.ts` already reserves `LLM_MAX_CALLS_PER_DRAFT`, `LLM_MAX_TOKENS_PER_DRAFT`, `LLM_MAX_COST_MICROS_PER_DRAFT` (read by nothing yet). The S1 plan mentioned a `ResourceBudget` on `ItemSource.draw`; it does not exist in the code.

Where the LLM source plugs in: as a second `ItemSource`-like producer whose output goes through a new gate (`admitAiItem`, section 5.2) instead of `admitItem`, run in the worker (because of the key and the call latency), writing its result into the existing draft tables.

## 2. Goals, non-goals, anti-goals

Goals
1. A tutor can select an `ai_beta` topic in Grade 8 to 12 courses and get a draft whose exercises, worked examples, solutions and notes prose come from the LLM, each item visibly labelled with its check status on screen and in every PDF.
2. Replace, Remove, Undo, Create Another Version and Export work for AI drafts with the same rules as today; export charges only on success (unchanged).
3. No raw model text reaches LaTeX or HTML; every math string is MathText parsed by our code.
4. LLM spend is capped per call, per preview, per account (hour, day, lifetime) and globally per month, enforced before each call, recorded after it.
5. A tutor can flag an item; it is quarantined at once and never served again.
6. Every shown AI item is collected into a write-only bank from day one.
7. One switch turns the LLM source off instantly; deterministic topics keep working.

Non-goals (slice B): free-text refinement (slice C); other subjects; primary school; Stripe/billing; serving from the bank (follow-up slice, section 5.7); figures and graphs (question-bank-design 7f); tutor editing of math; analytics beyond server-side counters; flagging on already exported lessons (drafts only).

Anti-goals (must not happen): an LLM item labelled "verified" or "checked by code" without a code check that re-derived it; a curriculum alignment claim in AI content or labels; a model call from the web process; a model call without a prior budget reservation; a pack charged for a failed or capped generation; SymPy, any general CAS, `eval` or `new Function`; storing tutor or account identifiers in the shared bank.

## 3. Constraints

- CLAUDE.md sections 1, 5, 7, 9, 10, 11 as amended (appendix). Until the owner approves the amendments, the current text binds and the build cannot start.
- Section 10: the web app validates, enqueues and returns an id; no long transaction across an LLM call; durable jobs with leases and fencing; polling is enough.
- Section 3: single source of truth for jobs (the `generation_job` table).
- Section 8: the compiler, templates and `assertTexIsSafe` (`src/lib/latex/render.ts`) stay the export-time boundary; MathText only adds a safe producer in front of them.
- Section 9 and D-43: send the provider only minimum lesson context; no account, billing, other users' or student data.
- D-98 (confirmed by the owner on 2026-11-01; `docs/decisions.md` row D-98 still says "open" and should be updated by the owner): all values are configuration.
- Process: CI uses the fake LLM and fictional data; real-provider evaluations run separately; the real path needs an owner-provided OpenAI key (never in the repo).

## 4. What the owner already decided [D]

- **D-95 (2026-10-22):** LLM-first items. Correctness is a label, not a gate: each item shows **checked by code**, **cross-checked** or **AI-generated, not checked**, on screen and in the PDF. Export is never blocked by an unchecked AI item. Tutors can flag an item, which quarantines it. An item that FAILS a check we can run (for example a code checker proves the stated answer wrong, or a safe-render check fails) is never shown as valid: it is regenerated within a bounded retry budget, otherwise dropped or refused. "Known mathematical errors block final export" (CLAUDE.md section 7) stays.
- **D-102 (2026-10-23):** for items from the deterministic source, verification stays a hard gate; D-95 only widens to non-deterministic sources.
- **D-96:** MathText (a restricted LaTeX-style syntax parsed by our own code) is mandatory; preview HTML and PDF render from the same parsed content; no raw LLM text reaches LaTeX or HTML; the TeX string is dry-run and safety-checked at preview time; the parser and renderers get an independent security review.
- **D-81 / D-40:** OpenAI is the preferred real provider; add one OpenAI adapter, keep the Anthropic adapter and the fake; model id, prices, timeouts, token and cost limits are configuration with no model or price defaults in the repo.
- **D-98 (confirmed 2026-11-01):** lifetime cap $25 of LLM spend per test account; daily sub-cap about $3 per account; per-preview cap about $0.15; about 10 LLM calls per account per hour; global monthly cap $100 with an alert at 70 percent and an automatic stop at 100 percent. Configuration, enforced server-side BEFORE a call (reserve an estimate, settle actuals), recorded per call (tokens, cost micros, model, request/job ids; no content). Preview and regeneration costs are separate from the pack allowance; the allowance is charged only at a successful export; failed generation never charges a pack.
- **D-99:** collect items from day one; stored items are not served until a bucket reaches a configurable threshold N; reported items are removed; free-text-derived items never enter the shared bank.
- **D-100:** legacy families and blueprints stay decoupled; the linear solver/checker may remain a "checked by code" source.
- **D-43 / D-78:** subprocessor disclosure and a beta privacy notice are required before real users; minimum context only.
- **Scope:** secondary math only; topic-first (D-74): a topic is selectable only if it is in the dataset AND has a generation capability. Slice B adds a second capability kind. Internal topic states: `verified`, `ai_beta` (shown with "AI-generated, check before you use it", never described as aligned or official), `unavailable`. `ai_beta` topics come from an explicit allowlist.
- **Out of scope:** slice C, other subjects, primary, Stripe, any general CAS, tutor math editing (only regenerate/replace/remove; minimal text-field corrections), analytics beyond content-free counters.
- **Process:** fake LLM in CI; controlled real evaluations; owner-provided key; a kill switch env flag; each slice needs its own go.

## 5. What is left to the builder (my recommended defaults)

### 5.1 Execution model [YOUR CALL]
- **Run AI item generation in the worker as a durable job.** The key lives only on the worker, calls take seconds to tens of seconds [GUESS], and section 10 forbids holding the draft transaction across a call. Reuse `generation_job` (single source of truth) with a new kind `draft_items`, a nullable `draft_id`, and `lesson_id` made nullable under a CHECK (`kind = 'draft_items'` exactly when `draft_id IS NOT NULL AND lesson_id IS NULL`, and no reservation). The enum value is irreversible like D-110, so it is an [OWNER] item. Fallback if refused: a separate `draft_item_job` table with the same lease and fencing columns (rejected by default because it creates a second job source of truth).
- **Async draft creation for ai_beta topics.** `createDraft` validates, checks budgets cheaply (read-only pre-check for a fast message), inserts the `draft` row with `active_version_id = NULL` (already nullable [F: `prisma/schema.prisma` model Draft]) and the job in one transaction, and returns the draft id. `/drafts/[id]` shows a progress state and polls a status endpoint (owner-scoped). The worker commits `draft_version` 1 and the pointer with the current fencing token, in one short transaction. Deterministic topics keep today's synchronous path unchanged.
- **Per-account concurrency 1** for `draft_items` jobs; global queue cap as for exports. Job budget: `max_calls`, `max_tokens`, `max_cost_micros` [F: columns exist on `generation_job`] set from the per-preview cap; one budget across all attempts and repairs.

### 5.2 Item contract [YOUR CALL]
Schema version `ai-items/1`, sent to the provider as JSON Schema (common subset, as `responseSchema` today) and parsed by our own zod schema; the result is untrusted until parsed (`types.ts` already says so).

One call returns a batch: `{ items: AiItem[] }`, where each `AiItem` is a strict object:
- `stem`: MathText, at most 600 characters (the package `Text` limit).
- `answer`: `{ kind, value }`, `kind` from a per-topic allowlist: `number` (exact rational or decimal), `expression`, `roots` (list of values for one variable), `pair` (x, y for a 2x2 system), `inequality`, `text` (short words only, for probability wording and similar). `value` is MathText (or a list of MathText for `roots`/`pair`).
- `steps`: 1 to 8 MathText strings, each at most 300 characters.
- `check`: optional structured claim our code can test (see 5.3); absent means no code check.
- `difficulty`: `basic | mixed | challenge` (the model's own judgement; never checked, never claimed).
- `role`: `example | exercise`.
No other fields; extra keys fail the strict parse. No `topic`, no free-form `notes`, no URLs.

Per-item gate `admitAiItem(raw, topicCapability)`, in order, each failure yielding a reason code (never the text): strict schema; length limits; MathText parse of every field (5.4); forbidden content via the existing prose rules (`checkText`/`curriculumNames` in `src/lib/package/prose-rules.ts`: no curriculum names, codes or alignment words) plus URL/email/control-character/bidi checks; answer kind allowed for the topic; check-claim binding and code check (5.3); TeX dry run of the rendered item and `assertTexIsSafe` on a document containing it; dedupe by fingerprint `sha256(canonical AST of stem + answer)` against items already in the draft and spares. The result is an `AiItem` with a status, the reasons list empty. The output type is branded like `VerifiedItem` so nothing else can construct it.

Package storage: a new package schema version `lesson-package/2` with three new blocks, keeping the worksheet/answer separation by section kind exactly as today (`DOCUMENT_SECTION_KINDS`): `ai_question` (exercises section: `questionId`, `stem` AST, `status`), `ai_solution` (solutions section: `questionId`, `answer`, `steps`, `status`), `ai_worked_example` (notes: stem, answer, steps, status). Each block stores the parsed AST (canonical serialized form), not the source string, and its `itemHash`; question and solution share `questionId` and the same `itemHash`, so a new question can never be paired with an old answer; section `contentHash`/`inputsHash` work as today. `lesson-package/1` stays readable unchanged.

### 5.3 What each status means [YOUR CALL on mechanism; labels are D-95]
- **checked by code**: a deterministic checker of ours re-derived the stated final answer exactly AND the claim it checked is bound to the displayed stem. Binding rule: `check.equation` (or expression) must parse to an AST that is structurally equal to a math span that appears in the parsed stem; otherwise the item is treated as having no check. Checkers in slice B (exact integer/rational arithmetic and the restricted AST only; no CAS):
  1. Linear equations in one variable: the existing `src/lib/math/linear.ts` solver after normalizing a parsed polynomial of degree at most 1 (handles brackets).
  2. Polynomial equations of degree at most 2 in one variable with rational coefficients: compute the exact root set (rational, or `(p ± q√d)/r` with `d` square-free, represented exactly) and compare with the stated `roots` as a set, including the double-root and no-real-root cases.
  3. Two linear equations in two unknowns: exact elimination, including no-solution and infinitely-many cases.
  4. Numeric expressions (percent, ratio, exponent laws with integer exponents, Pythagorean lengths given as integers or square roots, nCr/nPr with small integers, arithmetic/geometric nth term and finite sums, f(a) for a polynomial f): exact evaluation with bounded sizes (digit and exponent limits to prevent blow-up).
  5. Linear inequalities in one variable: exact solve including the direction flip on division by a negative.
- **cross-checked**: no code checker applies, and a second, independent model call that sees only the stem (not the answer or steps) produced an answer that equals the stated one after both are parsed and normalized by our code. It shows that two model outputs agreed; it is not proof and is never shown as "checked by code" or "verified". Recommended default: on for topics without a code checker, batched (one call per draft for all unchecked items) [GUESS: adds 30 to 60 percent to the cost of a preview]. Cross-check model and prompt version are recorded with the item.
- **AI-generated, not checked**: everything else that passed the gate.
- **Failures (never shown):** a code checker disagrees with the stated answer; a cross-check disagrees (conservative: treated as disputed and regenerated, not shown); any gate failure.
- **Not claimed, ever:** correctness of intermediate steps (except the linear step checks the existing validator already performs for deterministic items), the difficulty level, wording quality, originality, pedagogical fit, or curriculum fit. The label legend says "Answer checked by code" for clarity in the UI and PDFs.
- **Re-derivation:** `validatePackage` re-runs code checks on every AI item (cheap, deterministic) and never trusts a stored "checked by code" claim; a stored "cross-checked" status is accepted as a recorded fact (it cannot be re-run without a model call) but is downgraded to failed if a code checker now disagrees.

Package overall status becomes `verified` (every item checked by code or deterministic-verified), `labelled` (no failed or quarantined item, at least one AI item with a weaker status), or `failed`. `confirmExport` (`src/lib/server/dal/export.ts` line 121 refuses anything but `verified` [F]) accepts `verified` or `labelled`; deterministic items must still be `verified` (D-102). Labels are rendered into the TeX source, so they are part of the export identity automatically (D-109).

### 5.4 MathText [YOUR CALL on grammar; mandatory per D-96]
- **String form:** plain text with inline math in `\( ... \)`. A bare `$` is ordinary text (percent and money problems need it). No display math in slice B.
- **Text segments:** printable Unicode letters, digits, spaces and a punctuation allowlist; no backslash, no control characters, no bidi overrides, no `\(` nesting; `http`, `www.`, `@` with a domain are rejected.
- **Math grammar (minimum viable subset):** integers and decimals (bounded digits); single Latin letters as variables; `\alpha \beta \theta \pi`; `+ - = < > \le \ge \neq \pm \times \cdot \div / ,`; parentheses and brackets (balanced); `|x|`; `\frac{a}{b}`; `x^{n}` and `x^2`; `x_{1}` and `x_1`; `\sqrt{x}` and `\sqrt[n]{x}`; `\%`; `^\circ`; `\sin \cos \tan \log \ln`; `\ldots`. Later (deliberate grammar changes, not per item): vectors, sigma notation, limits, integrals, derivatives, display math. Limits: math span at most 300 characters, nesting depth at most 8, exponent nesting at most 3, at most 20 spans per string.
- **Parser:** a hand-written recursive-descent parser of ours producing a typed AST (discriminated union: `num`, `var`, `greek`, `binop`, `rel`, `frac`, `pow`, `sub`, `sqrt`, `abs`, `func`, `group`, `percent`, `degree`, `list`). Unknown command, unbalanced group, bad nesting or over-limit input is a parse error with a code. No regex-based sanitizing as the boundary.
- **Renderers:** `toTex(ast)` emits only a fixed macro set (and escapes text through the existing `t()` from `src/lib/latex/escape.ts`); `ALLOWED_BODY_COMMANDS` grows by exactly the macros emitted. The HTML preview renders the SAME `toTex` output through the existing `renderMathHtml` (KaTeX, `trust: false`); text segments go through React escaping only. A canonical serializer gives `parse(serialize(ast)) == ast`, used for hashing and dedupe.
- **Why it is security-critical:** it is the only path by which attacker-influenced bytes (model output, and later slice C free text) reach the TeX compiler and the browser. A parser bug could reach file reads or macro bombs in TeX (the sandbox is the last line, not the first) or script in the preview. **Independent Opus security review required.**
- **Tests:** golden accept/reject tables; property tests (random ASTs round-trip; every emitted TeX passes `assertTexIsSafe`; every emitted TeX renders in KaTeX strict mode); a fuzz corpus of hostile inputs (`\input`, `\csname`, `\catcode`, `^^5c`, `\def`, unbalanced braces, deep nesting, 100k-character strings, `\href{javascript:}`, HTML tags, Unicode confusables and bidi, NUL); a size/time bound test so parsing is linear.
- **First step before code** (question-bank-design 3): a one-page grammar spec plus about 20 sample items, tried on the chosen model to measure the first-pass parse rate.

### 5.5 Cost control [YOUR CALL on mechanism; caps D-98]
- **Ledger:** table `llm_call` (one row per provider call): `id`, `owner_id`, `job_id`, `draft_id`, `request_id`, `purpose` (`items | prose | crosscheck`), `provider`, `model`, `prompt_version`, `state` (`reserved | settled`), `estimate_micros`, `input_tokens`, `output_tokens`, `cost_micros`, `usage_estimated`, `created_at`, `settled_at`. No content. Table `llm_spend_month` (`month` UTC, `reserved_micros`, `settled_micros`, `alerted_70_at`, `stopped_at`), one row per month.
- **Before every call** (worker, one short transaction): lock the account's profile row (the existing per-account serialization) and the month row `FOR UPDATE`; compute `estimate = input-token estimate * input price + max_output_tokens * output price`; refuse unless lifetime, UTC-day, per-preview (the job's `max_cost_micros`) and global-month totals (settled actuals plus open reservations plus this estimate) stay within the caps, and the hourly call count is under its cap; insert the `reserved` row.
- **After the call:** settle to actual usage, or to the ceiling when the provider reported none (as `prose-generate.ts` already charges the ceiling). The worker's recovery sweep settles stale `reserved` rows at their estimate (the call may have happened), never releases them to zero.
- **Retries:** only retryable error types (`isRetryableLlmError`), exponential backoff with jitter (`src/lib/domain/retry.ts`), each retry is a new reserved call inside the same job budget; item regeneration ("refill") at most 2 extra calls per job [GUESS]; repair prompts carry rule codes only, never the earlier output.
- **When a cap is hit:** the job fails with a typed code (`llm_cap_hour | llm_cap_day | llm_cap_lifetime | llm_cap_preview | llm_global_stop`); nothing is charged to the pack allowance; the UI says which kind of limit and when it resets, without dollar amounts; deterministic topics still work.
- **Kill switch:** `LLM_ITEMS_ENABLED=0` (read by web and worker): ai_beta topics become unavailable in selection and are refused server-side; queued `draft_items` jobs fail with `llm_disabled` (budget reservations settle as above); existing AI drafts stay previewable, adjustable from their spare pool (no new calls) and exportable (export calls no model).
- **Automatic stop:** when the month's total reaches 100 percent the reservation is refused for everyone (`stopped_at` set) until the month rolls or the owner raises the cap. At 70 percent the worker emits one structured log event `llm_spend_alert` per month (hook for the alerting B4 plans; the current alerting mechanism is UNVERIFIED).
- **Grants:** `worker_runtime`: INSERT/UPDATE on `llm_call` and `llm_spend_month`. `app_runtime`: SELECT on `llm_call` (owner-filtered in the DAL) for the fast pre-check and the "limit reached" message only; no write. Migration role: DDL only. No Data API grants.

### 5.6 Prompt and injection handling [YOUR CALL]
- Prompts are versioned TypeScript constants in the repo (`ITEMS_PROMPT_VERSION`, `CROSSCHECK_PROMPT_VERSION`), next to the existing `PROSE_PROMPT_VERSION`.
- Input is built only from dataset fields and structured selections: topic title and summary (`topics.json`), an approximate grade band derived from the course level (for example "about Grade 10"; not the curriculum name, code or version), difficulty, count, role, the allowed answer kinds and the MathText grammar summary. Slice B has no free text. This adds the grade band to the D-43 field list, so `docs/security-and-privacy.md` needs a matching edit.
- Model output is data: parsed, never executed, never used to choose tools, files, URLs, templates or prompts. No tool use, no browsing.
- Logs and metrics carry request/job ids, prompt version, model, tokens, cost, counts of reason codes; never stems, answers or prompts.

### 5.7 Bank collection in slice B [YOUR CALL]
- **Build now (write-only):** table `bank_item`: `fingerprint` (unique), `topic_key`, `grade_band`, `difficulty`, `role`, canonical item content (AST form), `status`, `provider`, `model`, `prompt_version`, `created_at`, `exported_count`, `reported_at`. No owner, draft or account id. Every item shown in a draft is upserted by the worker when the draft version commits; `exported_count` increments when an export containing it succeeds. Table `bank_blocklist(fingerprint)`: reported fingerprints never re-enter.
- **Flag/quarantine:** the owner-scoped `item_flag` table (`owner_id`, `draft_id`, `question_id`, `fingerprint`, `reason` enum: `wrong_answer | unclear | inappropriate | other`, `created_at`) records the tutor's flag; in the same transaction the item is removed from the draft version (filled from the spare pool if available, as a Replace with history entry, so Undo of the flag is NOT offered for a quarantined item) and a narrow `SECURITY DEFINER` function `report_bank_item(fingerprint)` marks `reported_at` and adds the blocklist row. The tutor's identity stays only in `item_flag`, which is owner-scoped.
- **Later (follow-up slice, after the owner settles D-99 eligibility):** per-bucket counting, threshold N, the serving switch, the fresh fraction, seeded draws, per-account exclusion. Nothing reads `bank_item` for serving in slice B.

### 5.8 Draft operations for AI topics [YOUR CALL]
- **Initial draft:** one items call for examples + exercises + spares (spares = `CANDIDATES_PER_SLOT`-bounded pool, default 3 [GUESS]), one prose call (the existing section-prose path generalized to the topic; prose blocks stay words only, enforced by the prose check; fallback is a short topic-neutral template), one optional batched cross-check call. Admitted items fill the slots; if fewer than `MIN_EXERCISES` survive after the refill budget, the job fails (`too_few_valid_items`) and charges nothing; otherwise the draft may have fewer exercises than asked and says so.
- **Replace:** draws from the draft's spare pool (instant, no call). When the pool is empty, Replace enqueues a small `draft_items` refill job and the candidate panel polls; the original stays visible until Accept (D-102 behaviour).
- **Create Another Version:** a new `draft_items` job for the full set; counts against the same caps.
- **Remove, Undo, version switch:** unchanged pure operations (`draft-ops.ts`), extended to the new block types.
- **Export freezing:** unchanged mechanism (`export_snapshot` copies the full package); statuses are inside the blocks, so they are frozen and printed.
- **PDF and preview display:** every AI item carries a short status marker next to its number, and each document that contains AI items gets a legend ("Answer checked by code / Cross-checked by a second AI pass / AI-generated, not checked: check before you use it") and the existing "AI-assisted material. Review it before teaching." line. The worksheet shows the marker and legend but never an answer (its view has no solutions section, as today). Whether the student worksheet shows per-item markers is [OWNER] item 6.

### 5.9 Topics [YOUR CALL on mechanism; allowlist is OWNER item 4]
- `Capability` (`src/lib/curriculum/capabilities.ts`) gains `kind: "verified" | "ai_beta"`, the allowed answer kinds and the checker id (if any). New concepts (one per allowlisted topic) get capability entries, `concept` rows by migration, and `concept` fields in `topics.json`; `pnpm curricula:build` regenerates the datasets. The env allowlist `LLM_TOPICS_ENABLED` can only narrow the code registry, never add to it. With the kill switch off, `ai_beta` resolves to `unavailable` in `loadTree` (`src/lib/server/dal/curriculum.ts`).
- **Proposed first set (12 topics; grade placement from the course templates in `curricula.json`, individual curricula may differ [GUESS]):** Grade 8 to 9: `percent-of-quantity`, `percent-change`, `proportions`, `exponent-laws`, `pythagorean-theorem`, `simple-probability`, `equations-with-brackets`. Grade 10: `systems-linear-equations`, `quadratic-equations-factoring`, `function-notation`. Grade 11: `quadratic-formula`, `sequences-series`. Grade 12: `function-notation` and `sequences-series` also appear in Grade 12 templates; add `counting-permutations-combinations` (13th, numeric checker) if one more Grade 12 topic is wanted. All but `simple-probability` have a code checker for most items.
- **Rule for adding a topic:** in `topics.json`, secondary math, no figures needed, answer kinds expressible in MathText, and a controlled evaluation (section 7) of at least 60 items over the three difficulties with parse rate at least 95 percent, zero safe-render failures, and code-check failure rate at most 10 percent before refills [GUESS thresholds]; then the owner adds it to the registry by a reviewed change.

### 5.10 UI [YOUR CALL]
- Selection: `ai_beta` topics are clickable with a small "AI beta" badge and the text "AI-generated questions: check before you use them". Never "aligned", "official" or "verified". The "N of M topics available" count includes ai_beta topics and says how many are AI beta.
- Draft page: a progress state while the job runs (status survives refresh); status badge per item (text, not colour alone; `aria-label` with the full status); a "Flag this question" action with a short reason picker and a confirmation that it will be removed; the legend at the top of each document tab.
- Failures and caps: plain messages per typed code ("AI questions are paused for now; checked topics still work", "You have reached today's AI limit; it resets at 00:00 UTC", "We could not produce enough good questions for this topic; try again or pick another topic"). No dollar amounts.
- Accessibility: keyboard reachable flag action, focus moves to the result message, the polling region is `aria-live="polite"`; the existing axe checks extend to the new states.

## 6. Open items for the owner (most important first)

1. **Approve the CLAUDE.md amendments** in the appendix (sections 1, 5, 7, 11; optional one-liners for 4 and 10). Recommendation: approve as drafted; nothing can be built before this.
2. **Approve the irreversible enum value `job_kind ADD VALUE 'draft_items'`** and nullable `generation_job.lesson_id` (5.1). Recommendation: approve (keeps one job table); the alternative is a separate job table.
3. **What "about 10 LLM calls per account per hour" counts.** A preview is 2 to 4 raw calls (items, prose, cross-check, refills), so 10 raw calls is about 3 previews per hour. Recommendation: count LLM-backed operations (preview, new version, refill) at 10 per hour, and bound raw calls per operation by the job budget.
4. **Confirm the first ai_beta allowlist** (5.9). Recommendation: the 12 listed topics.
5. **Cross-check default** (5.3). Recommendation: on, batched, only for topics or items without a code checker.
6. **Per-item markers on the student worksheet.** Recommendation: a small neutral marker plus legend on the worksheet, full labels in Notes and Solutions.
7. **Bank eligibility (D-99, still open).** Recommendation: collect every shown item now (write-only); decide servable rules (exported, not reported, per-bucket N) before the serving slice.
8. **Privacy and subprocessor wording, and the grade band sent to the provider** (D-43, D-78). Recommendation: approve the grade band; name OpenAI as a subprocessor in the beta notice before the first real user.
9. **Model and OpenAI project limit.** Recommendation: pick the model after the controlled evaluation (section 7); set the OpenAI project's own monthly hard limit at or below $100 as a second stop.

## 7. Acceptance checks (observable behaviour, for the plan)

1. With `LLM_PROVIDER=fake` and the kill switch on, selecting an allowlisted topic creates a draft asynchronously; after refresh the same draft and status appear; the preview shows every item with a status badge and the legend.
2. Hostile fake outputs (extra keys, raw `\input`, `<script>`, unbalanced braces, 100k strings, curriculum codes, wrong answers on checkable items) never reach the preview or PDF; wrong-answer items are regenerated or dropped, and the reason codes appear in logs without content.
3. A checkable item labelled "checked by code" fails validation if its answer is altered in the stored package (re-derivation).
4. The worksheet PDF contains no answer for any AI exercise; the solutions PDF pairs each answer with its question by `questionId` and `itemHash`.
5. Export of a `labelled` draft succeeds and consumes exactly one generation; its PDFs show the markers and legend; a draft with a failed or quarantined item cannot be exported.
6. Previews, refills, versions, cross-checks, failures and caps never touch `usage_bucket` or `usage_reservation`.
7. Every provider call has a `llm_call` row reserved before and settled after; two concurrent previews for one account cannot together exceed any cap; at 100 percent of the global cap every new call is refused; the 70 percent event fires once.
8. `LLM_ITEMS_ENABLED=0` hides ai_beta topics, refuses them server-side, fails queued jobs and leaves existing AI drafts previewable and exportable; deterministic topics unaffected.
9. Flagging removes the item from the draft at once, records `item_flag`, marks the bank row reported and blocklists the fingerprint; the item is never shown again in any draft.
10. Bank rows contain no owner, draft or account identifiers.
11. Cross-user access to AI drafts, job status, flags and spend is refused.
12. Real-provider evaluation (separate, controlled): at least 100 items per allowlisted topic across difficulties [GUESS sample size]; measured parse rate, gate pass rate, code-check pass rate, cross-check agreement, cost per preview against the $0.15 cap, p50/p95 latency, and a manual review of 20 items per topic for answer and step correctness. Exit toward a stronger label: a topic can be described as "checked" (never "verified") when every item type it serves has a code checker, at least 98 percent of shown items are checked by code over 200 items, and manual review finds at most 1 wrong step in 50 items [GUESS thresholds]; "verified" still means a deterministic generator with a passing sweep (D-77).

## 8. Risks

- **MathText parser or renderer bug** reaches TeX or HTML: mitigated by the grammar, property and fuzz tests, `assertTexIsSafe`, KaTeX strict, the unchanged sandbox, and the Opus review.
- **Wrong answers labelled "not checked" mislead tutors**: accepted by D-95; mitigated by labels, legend, flagging, cross-check and checker coverage.
- **Binding gap**: a checker proves a claim the stem does not show. Mitigated by the AST-equality binding rule and tests with mismatched claims.
- **Cost overrun** from retries or concurrency: one job budget, reserve-before-call, row locks, global stop, provider-side project limit.
- **Latency** makes the preview feel slow [GUESS 10 to 40 seconds]: spares make Replace instant; progress UI; evaluate p95.
- **Low first-pass parse rate** shrinks usable output: measure with the 20-sample step before the parser; grow the grammar deliberately.
- **Prompt injection via dataset fields**: the dataset is first-party and reviewed; still treated as data.
- **Schema v2 migration** breaks old drafts or exports: v1 stays readable; golden render test for v1 unchanged; a render version bump only affects new exports.
- **Irreversible enum**: owner approval and the D-110 rollout pattern.
- **Scope creep** (serving, figures, slice C): explicitly out.

## 9. Slicing (each independently shippable with its own tests and review)

1. **B-a MathText** (grammar spec and 20 samples first; parser, AST, canonical serializer, TeX and HTML renderers, allowlist update, fuzz and property tests). No product wiring. **Independent Opus security review.**
2. **B-b OpenAI adapter** (`src/lib/llm/openai.ts`, `LLM_PROVIDER` enum, factory, injected-`fetch` contract tests, error classification, re-run of `scripts/eval-prose.ts`; check the official structured-output rules first, D-81). Can run in parallel with B-a. **Opus review of the provider boundary** (with B-e if convenient).
3. **B-c Item contract and checkers** (`ai-items/1`, `admitAiItem`, the five checkers, binding rule, status derivation, `lesson-package/2` blocks, renderers with markers and legend, `validatePackage` overall `labelled`, `confirmExport` gate change). Fake source only. **Opus review** (export gate and correctness labels).
4. **B-d Spend ledger and caps** (migrations `llm_call`, `llm_spend_month`, grants; reserve/settle; caps; kill switch; global stop; recovery settlement; real-Postgres concurrency tests). **Independent Opus review (cost accounting and concurrency).**
5. **B-e Worker job and draft integration** (enum migration, `draft_items` runner with leases and fencing, async `createDraft`, polling, spares and refill, Create Another Version, prose for ai_beta, capability kind and allowlist, `topics.json` concepts and migration, selection UI). **Opus review of the prompt/provider boundary.**
6. **B-f Flag, bank collection, E2E and docs** (`item_flag`, `bank_item`, `bank_blocklist`, `report_bank_item`; flag UI; E2E with the fake provider: select ai_beta topic, wait, statuses, flag, replace, export, PDF text contains markers and no worksheet answers; architecture, README, `.env.example`, `docs/fresh-droplet-setup.md`, privacy doc edits; the controlled evaluation script).

Order: B-a and B-b in parallel, then B-c, B-d, B-e, B-f.

## 10. Operational and owner prerequisites

- An OpenAI API key provided by the owner, stored only in the worker host and staging secrets; an OpenAI project with its own monthly hard limit.
- Model choice: no model id is written here or defaulted in the repo (D-40). Criteria: JSON-schema structured output support as the adapter needs it, input/output price per million tokens (configured as `LLM_PRICE_*_MICROS_PER_MTOK`), math accuracy and parse rate in the controlled evaluation, p95 latency, and the provider's data retention terms. A second, possibly cheaper or different model for cross-checks is optional configuration.
- Subprocessor and beta privacy wording (D-43, D-78) approved before any real user.
- Staging environment variables (names are proposals; values are owner configuration): `LLM_PROVIDER=openai`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_PRICE_INPUT_MICROS_PER_MTOK`, `LLM_PRICE_OUTPUT_MICROS_PER_MTOK`, `LLM_BASE_URL` (optional), `LLM_ITEMS_ENABLED` (web and worker), `LLM_TOPICS_ENABLED`, `LLM_CROSSCHECK_ENABLED`, `LLM_CROSSCHECK_MODEL` (optional), `LLM_SPEND_LIFETIME_MICROS_PER_ACCOUNT` (25000000), `LLM_SPEND_DAILY_MICROS_PER_ACCOUNT` (3000000), `LLM_SPEND_PER_PREVIEW_MICROS` (150000), `LLM_OPS_PER_ACCOUNT_PER_HOUR` (10), `LLM_SPEND_GLOBAL_MONTHLY_MICROS` (100000000), `LLM_SPEND_ALERT_PERCENT` (70), `LLM_ITEM_REFILL_CALLS` (2), `LLM_ITEMS_JOB_DEADLINE_SECONDS`, `LLM_ITEMS_CONCURRENCY_PER_USER` (1), `BANK_COLLECT_ENABLED` (1). The three reserved `LLM_MAX_*_PER_DRAFT` keys in `limits.ts` are replaced by these.

## Appendix: CLAUDE.md amendments (draft text, NOT applied)

Note on `docs/claude-md-amendment-draft.md`: its S1 to S6 proposals (sections 1, 4, 5, 10, 11) are already in CLAUDE.md, so that file is stale as a proposal; its line "Section 7 stays as written" is superseded by the text below once approved. The current CLAUDE.md wording is the base here.

**Section 1, second bullet: replace the first two sentences** ("The initial release supports ... expansion is only to topics with validation coverage.") with:
"The initial release supports secondary-school Math only and individual tutor accounts. Selection is topic-first (decision D-74): a topic is selectable only when it is an entry in a versioned topic dataset AND has a generation capability registered in code. There are two capability kinds (decision D-95). `verified`: a deterministic generator whose items pass the validator; such a topic is live only when its verification sweep passes at every level offered, and the first acceptance path remains linear equations in one variable. `ai_beta`: items written by the configured LLM, accepted only through MathText (section 7), each labelled with its check status; an `ai_beta` topic comes only from an explicit allowlist in code (configuration may narrow it, never widen it), is shown with an "AI-generated, check before you use it" label, is never described as aligned, official or verified, and disappears from selection when the LLM item source is switched off."
(The rest of the bullet, from "Make educational level, language, and curriculum explicit settings", is unchanged.)

**Section 5, first bullet: replace** with:
"A complete generation is a successful export: the complete requested PDF set, made from a frozen snapshot that passed structural checks, safe-render checks and every mathematical check that applies to its items (no item a check proved wrong, no flagged item), is compiled, validated, stored and available through authorized downloads. Items no check covers may be included with their visible status label (section 7). Whether the browser receives the success response does not affect settlement."

**Section 5, new bullet after "At export confirmation ...":**
"LLM spend for drafts (decision D-98) is governed by separate server-side budgets, never by the generation allowance: per call, per preview, per account per hour, per UTC day and lifetime, and a global monthly cap with an alert at 70 percent and an automatic stop at 100 percent; all values are configuration. Each model call reserves an estimate against these budgets before it is made and settles actual usage (or the ceiling when none is reported) afterwards, recorded per call without content. A model call for a draft needs no allowance reservation, never consumes a generation, and its failure or a reached cap never charges one."

**Section 5, the bullet "Downloading existing files ...": replace its last sentence** ("Quick adjustments (decision D-33): ... single settlement as generations.") with:
"Quick adjustments (decision D-33): deterministic adjustments that call no model are not new generations and are rate-limited; adjustments that call the model (replacement refills, new versions of AI drafts) are governed by the LLM spend budgets above, are never charged to the generation allowance, and a failure charges nothing."

**Section 7, replace these bullets as follows** (bullets not listed stay unchanged):
- Pipeline: "Pipeline: validate input → resolve the curriculum context snapshot → plan the outline → produce items (deterministic generator, or the LLM item source for `ai_beta` topics) and prose → validate schema → parse all math as MathText → run every applicable check (exact validator, code checkers, optional cross-check) and assign each item's status → bounded regeneration of failed items → render LaTeX deterministically (dry run and source safety check at preview time) → compile in a sandbox at export → persist and settle."
- Content bullet, last sentence: "Link questions and answers through stable IDs and a shared item hash. Math enters documents only as structured questions: from the deterministic source by reference to validated questions, or from the LLM item source as MathText parsed by our own code into a restricted AST (decision D-96); never as raw model text, raw LaTeX or HTML."
- Deterministic bullet: "Prefer deterministic parameterized questions and solvers where they exist: code selects valid parameters and computes answers. For items from the deterministic source, verification is a hard gate (decision D-102). LLM-written items (decision D-95) are allowed only for `ai_beta` topics and only under the labelling rules below."
- Record bullet: "Record each item's validation method, coverage, result, limitations, checker version and status. Item statuses are: verified (deterministic source, validator passed), checked by code (a code checker of ours re-derived the stated final answer exactly from a claim bound to the displayed question), cross-checked (an independent second model answer, parsed and compared by code, agreed), AI-generated not checked, and failed. Steps of LLM items are not claimed as checked. LLM review and numerical sampling are supplementary; neither ever yields verified or checked by code. Stored 'checked by code' statuses are re-derived by code before export, never trusted."
- Failed output bullet: "An item that fails a check we can run (schema, MathText parse, safe-render dry run, forbidden content, a code checker proving the answer wrong, or a cross-check disagreement) is never shown as valid: it is regenerated within a bounded per-job budget, otherwise dropped. A draft that cannot reach the minimum number of valid items fails, and no generation is charged. Items no check covers may be shown and exported with the visible status 'AI-generated, not checked'; that label alone never blocks export."
- Changes bullet: keep, and append: "Known mathematical errors and flagged (quarantined) items block final export; a tutor's flag removes the item from the draft at once and from any shared item store."
- Preview bullet, append: "Every document containing LLM items shows each item's status and a legend, on screen and in the PDF."

**Section 11, append to the unit-test bullet:** "MathText parser and renderers (accept/reject tables, round-trip and safety property tests, hostile-input fuzzing), each code checker and the claim binding rule, item status derivation and re-derivation, and the item gate against malformed and hostile fake LLM outputs."
**Section 11, append to the integration-test bullet:** "LLM spend: reservation before every call, settlement after, concurrent calls for one account against each cap, the global stop, stale-reservation recovery, the kill switch, and flag quarantine with shared-store removal, against real temporary Postgres."
**Section 11, new required-cases bullet:** "Required cases for the LLM item source: no raw model text reaches LaTeX or HTML; a wrong answer on a checkable item is never shown; the worksheet carries no AI answer; statuses appear on screen and in the PDF and are frozen in the export snapshot; previews, refills, versions and reached caps never reserve or consume allowance; a labelled draft exports and charges once; a flagged item never reappears; disabling the LLM source leaves deterministic topics working."
**Section 11, E2E bullet, append:** "A second E2E covers an `ai_beta` topic with the fake provider: select → wait for the draft → status badges → flag → replace → export → PDF text contains the labels and no worksheet answers."

**Optional one-liners (if item 2 is approved):** Section 4, minimum model: add "LLM spend ledger, item flags and a write-only item bank". Section 10: add "Draft item jobs (kind `draft_items`) use the same states, leases and fencing, carry no reservation, and commit a draft version only with the current fencing token."
