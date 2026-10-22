# Content architecture: from verified math to useful teaching material (approved design, no code yet)

> **Legacy (2026-10-22):** superseded as the active direction by [generation-flow](generation-flow.md) (D-94 to D-101). The code from M0 stays in the repo, decoupled; this document is kept as an archive.

Status: design approved by the owner on 2026-10-22; decisions D-85 to D-93 in [decisions.md](decisions.md). **No implementation has started.** Each milestone below needs its own explicit go. Labels: **[F]** verified repo fact (read from `origin/main`), **[I]** inference to confirm at the start of the milestone, **[R]** recommendation (now approved where listed in section G), **[A]** assumption to validate with tutors. Related: [question-bank-design](question-bank-design.md) (deferred, see section E), [beta-roadmap](beta-roadmap.md), [curriculum-architecture](curriculum-architecture.md).

## Context
The generation infrastructure is strong; the educational design is thin. Verified symptoms: all four equation topics use one generator and one fixed prose template; difficulty is numeric style; a 45-minute lesson yields 4 exercises; common mistakes are five generic sentences. The owner proposed: a teaching-material positioning, three modes (Targeted Practice, Teach a Concept, Diagnose), a Content Blueprint layer, a hybrid of parameterized question families and a curated bank, a multidimensional difficulty model, and priorities P0-P2. This document critiques that proposal against the code and recommends a smaller, incremental design.

## A. Current-state assessment
**Strong [F]:** exact-rational generator and 7-check validator (unknown form/type returns `unverified`, not a crash, so new families do not touch the trust model); seeded determinism with per-section `inputsHash`/`contentHash` and 27 golden hash pairs; adjustment invariants (positional numbering, exercise/solution `questionId` pairing, byte-identical untouched sections); alignment text only from the dataset.

**Weak [F]:**
1. Topic is ignored: `build.ts:157` hard-codes `LINEAR_CONCEPT_ID`; "one-step equations" yields `4x - 11 = -39` (two-step). Mapping rows already admit this ("do not yet differ by topic").
2. Every non-basic lesson gets an off-topic two-sided no-solution example.
3. Prose (explanation, derivation, teaching sequence, five common mistakes) is identical for every topic (`build.ts:199-269`).
4. Pacing: `planOutline(45)` = 7/11/5/22 min, so 4 exercises; 60 min gives 6. Notes minutes are budgeted even when notes are not selected.
5. Variety is numeric, not structural: ~3,840 basic, ~195k mixed, ~341k challenge distinct equations, but only two shapes and 2-3 steps. Challenge differs from mixed only by fractional answers.
6. Code/comment mismatch: header says no coefficient 1 on x; two-sided can produce it.

**Missing [F]:** one-step forms, a combine-like-terms op, unknown-on-right equations (`final_form` expects x on the left [I from agent; verify when building]), brackets (no grouped-term in the schema), any notion of skill, any structure inside a worksheet.

**Unnecessary or dead [F/I]:** `context.concepts[].capability` copies the registry into every snapshot but only `difficulties`/`outcomes` are read; `Capability.forms` never used for selection; `objectiveIds` plumbed but never sent; `templateId`/`locale` single-valued; `DOCUMENT_SECTION_KINDS`, `documents[].sectionIds`, `views.ts` and `checkStructure` all state one mapping; `change_duration` hidden with no UI; stale docs (`refactor-plan.md` says M6 not started; A4 vs Letter; preview text vs D-60).

## B. Positioning and modes
**Positioning [R]:** NotePrep makes *session-ready practice material for one tutoring session*: a worksheet that progresses on purpose, an answer key whose every step is code-checked, and optionally a one-page tutor brief. Not a lesson-plan writer, not a generic AI worksheet generator. The hypothesis in the brief is accepted; the pitch is the guarantee ("every answer and step is checked by code").

**Modes [R]:**
- **Do not add a mode to the request.** Mode A and B are already expressed by document selection. Show two UI preset cards, "Practice set" (worksheet + solutions) and "Lesson + practice" (all three), that only pre-tick documents. No request field, no hash or version change.
- The real content difference is the exercise budget: when notes are not selected, notes minutes go to exercises (derived from `documents` inside the allocation function).
- If a purpose is ever needed beyond documents, add an optional `purpose` with no Zod default (old stored requests and hashes keep parsing).
- **Drop Mode C.** CLAUDE.md excludes automated learner diagnostics and "diagnostic" is a validity claim without evidence. A later, legitimate variant: a "Quick check" part with one item per skill and the key listing each item's target skill (a fact about construction). NotePrep never states what a student's result means, and the UI never says "diagnostic".

## C. Content architecture
**Is a Blueprint layer needed?** Yes as a concept, no as a framework [R]: one validated data object per topic in the repo, read by a pure `composeLesson(blueprint, request, seed)` that replaces the hard-coded parts of `buildPackage`. No class hierarchy, no table, no "Teaching Objective" entity (curriculum objectives already exist).

```
 dataset (mappings.json, optional blueprintId)      repo code + data (versioned, reviewed)
 ┌───────────────────────────────────┐              ┌──────────────────────────────────────┐
 │ Topic ──mapping──> conceptId      │              │ CAPABILITIES (concept registry)      │
 │        (+ optional blueprintId)   │              │ SKILLS (closed list per concept)     │
 │ Objectives (verbatim, alignment)  │              │ FAMILIES (pure draw(rng) -> params)  │
 └────────────────┬──────────────────┘              │ BLUEPRINTS (zod data per topic)      │
                  │ snapshot (contextHash)          └─────────────────┬────────────────────┘
                  v                                                   │
  LessonRequestV2 ──> resolveBlueprint(context) ──> Blueprint@version ┘
                              │
                              v
            composeLesson(bp, request, seed)   (pure, deterministic)
            ├ allocate(parts, exerciseCount, documents) -> slots (family per position)
            ├ pick examples (bp.examples per preset)
            └ per slot: family.draw(Rng(familyId|seed|qid|retry)) -> params
                              v
            existing step builders -> Question (existing schema)
                              v
            validateQuestion (7 checks, unchanged) --failed--> redraw / build error
                              v verified
            buildPackage: 10 sections, existing EDGES; prose = bp.prose (deterministic)
                              | opt-in LLM ProseDraft (unchanged path)
                              v
            checkStructure + checkProse + hashes -> LaTeX sandbox -> 3 PDFs
```

**Entities and boundaries [R]:**
| Entity | Status | Lives in | Responsible for | Not responsible for |
|---|---|---|---|---|
| Concept | exists (`CAPABILITIES`) | code | what the engine can generate and verify | pedagogy |
| Topic | exists (dataset / `topics.json`) | data | what the tutor picks | content selection |
| Learning objective | exists (dataset) | data | verbatim alignment text | never authored by NotePrep |
| Skill | new, closed list per concept | code constant | a named competency ("undo multiplication") | mastery, student state |
| Mistake | new, inside the blueprint | data | topic-specific "what it looks like / what to say", tied to a skill | showing a wrong step as math |
| Question family | new (named `choose*` functions today) | code | param constraints, draw function, form, skills, features, rung, pace | steps, validation |
| Question item | exists (`Question`) | package | one concrete question + solution | a family's output or a bank item (provenance `family:<id>` / `bank:<id>`) |
| Blueprint | new | data in repo, zod-validated | skills, family pools per part per preset, examples, part shares, topic prose and mistakes | equations, LLM output |
Not entities: Mode, Teaching Objective, cognitive-demand objects, misconception taxonomy, question bank (deferred).

**Difficulty [R]:** do not build a multidimensional scoring model now. Keep the `basic|mixed|challenge` enum. Each family carries descriptive `features` and a `rung` (1-3); a preset is just which families go in which part. Family-aware `make_easier/harder` use `easier/harder` neighbours (replaces `LADDER`/`isChallengeLevel` for blueprint packages only).

**Representative interfaces (fit this repo: zod strict, pure, seeded):**
```ts
export const LINEAR_SKILLS = ["undo-add-subtract","undo-multiply-divide","inverse-order","negative-coefficient",
  "divide-form","unknown-on-right","collect-unknowns","combine-like-terms","fraction-answer","special-outcomes","distribute"] as const;
export type SkillId = (typeof LINEAR_SKILLS)[number];

export type FamilyId = `${string}@${number}`;             // "lin.two-step.neg@1"
export interface FamilyFeatures { steps: 1|2|3|4; negatives: boolean; fractions: "none"|"answer"|"coefficient";
  xBothSides: boolean; likeTerms: boolean; outcome: Outcome }
export interface QuestionFamily {
  id: FamilyId; conceptId: "linear-equations-one-variable";
  form: Form;                                  // must be in SUPPORTED_FORMS; the validator decides
  skills: readonly [SkillId, ...SkillId[]];    // [0] primary
  features: FamilyFeatures; rung: 1|2|3; paceMinutes: number;
  easier?: FamilyId; harder?: FamilyId;
  draw(rng: Rng): Record<string,string>;       // params only; equation + steps come from form builders
}
const Part = z.strictObject({ key: z.enum(["start","core","mixed","check"]), label: z.string().max(60), share: z.number().min(0).max(1) });
const Preset = z.strictObject({ parts: z.record(z.enum(["start","core","mixed","check"]), z.array(z.string()).min(1)),
  examples: z.array(z.strictObject({ family: z.string() })).min(1).max(3) });
export const BlueprintSchema = z.strictObject({
  id: z.string(), version: z.number().int().positive(), conceptId: z.string(), topicKeys: z.array(z.string()).min(1),
  skills: z.array(z.enum(LINEAR_SKILLS)).min(1), parts: z.array(Part).min(1).max(4),
  presets: z.strictObject({ basic: Preset, mixed: Preset, challenge: Preset }),
  prose: ProseDraftSchema,                      // same shape as ProseDraft, deterministic provenance
  mistakes: z.array(z.strictObject({ skill: z.enum(LINEAR_SKILLS), looksLike: z.string(), response: z.string() })).min(2).max(5) });
export function composeLesson(bp: ContentBlueprint, req: LessonRequestV2, seed: string):
  { examples: GeneratedQuestion[]; exercises: GeneratedQuestion[]; slots: { position: number; part: string; familyId: FamilyId; questionId: string }[] };
```

**Back-compat [R]:** optional `blueprintId` on the dataset mapping row, carried into `context.concepts[]` (frozen in the snapshot). Missing = `linear.general@1` = today's behaviour exactly (legacy chooser functions, `difficultyRamp`, `degenerateExample`, current template text). `sectionInputsParams` adds `{blueprint:"id@v"}` only when not general, so old packages, `stored-package-v1.json` and the 27 goldens keep their bytes. New families seed with `Rng(familyId|seed|qid|retry)`, so `GENERATOR_VERSION` never moves. `PACKAGE_SCHEMA_VERSION`, `requestVersion` and `TEMPLATE_VERSION` do not change through M5 (only optional additions; no existing block renders differently). Repo-authored template prose is already `method:"deterministic"` [I], so no new "template pack" provenance is required; the blueprint id in `inputsHash` params makes it traceable. Adjustment invariants hold: families emit ordinary `Question`s, so pairing and positional numbering are unchanged.

## D. Linear Equations walkthrough
Request: topic "Two-step equations" (Alberta suggested dataset, so no alignment claim and the objective reads "Practise: Two-step equations"), Practice set (worksheet + solutions), 45 min, mixed.
- **Blueprint `linear.two-step@1`.** Skills: undo-add-subtract, undo-multiply-divide, inverse-order, negative-coefficient, divide-form, unknown-on-right, fraction-answer. Families: `two-step.pos` (ax+b=c, a 2..9, x0 1..10, rung 1); `.neg` (a negative, rung 2); `.div` (x/a + b = c, x0 multiple of a, rung 2); `.right` (c = ax+b, needs `swap_sides`, rung 2); `.frac-ans` (fractional answer, rung 3).
- **Allocation.** Notes not selected, so budget = 45 − review 10% − 3 min warm-up ≈ 37 min at mean pace ≈ 2.7 min = **12 exercises** (today: 4). Parts: Get started 25% (3 items, `pos`), Core practice 50% (6, round-robin `neg`/`div`/`right`), Stretch 25% (3, `frac-ans` + `neg`). Sample: `3x + 4 = 19`, `-4x + 3 = 23`, `x/3 + 5 = 9`, `14 = 2x - 6`, `4x + 1 = 7` (x = 3/2).
- **Worked examples** (composed so the package keeps its 10 sections; printed only if notes are selected): one `pos` (inverse order), one `neg` (sign handling); **no** no-solution example for this topic.
- **Mistakes** (words only, prose rules apply): dividing before removing the constant; dropping the sign when dividing by a negative; treating "x over a number" as subtraction, each with a one-line teaching response.
- **Solutions.** Same order and numbering; existing 2-3 verified steps per item (3 for `right`); per-item annotations come later.
- **Validation/publication.** Each item through the 7 checks (a `failed` result means redraw), then checkStructure, checkProse, hashes, sandbox compile, as today.
- **Why better:** 12 on-topic items in three rising parts instead of 4 items that ramp into an off-topic two-sided equation; three real mistakes instead of five generic ones.

**New capabilities per topic [F/I]:**
| Topic | New generator work | New validator work | Unchanged |
|---|---|---|---|
| One-step | forms `x+b=c`, `ax=c`, `x/a=c` (SUPPORTED_FORMS, requiredParams, expectedEquation, FORM_WORDS, CAPABILITIES; extend `a.isZero()` check) | none (verify coefficient-1 rendering) | all 7 checks |
| Two-step | families above; `c=ax+b` form | `swap_sides` op (recommended over relaxing `final_form`) | the rest |
| Both sides | collect-onto-larger-coefficient, negative, coefficient-1 result, identity/no-solution as a "check" part | none | all |
| Like terms | form `ax+bx+c=d` (data `x:["2","3"]` already expressible) | `combine_like_terms` op (one side summed, other byte-equal) | substitution, exact solve, key match |
| Brackets (later) | optional grouped-term on `SideSchema`, `a(x+b)=c` | `distribute` op + `sideToLinear` expansion | the rest |

## E. Incremental milestones (each leaves the product shippable)
- **M0 Pure extraction, zero byte change.** Add `families.ts` (wrap today's `choose*` as `legacy.*`), `composeLesson`, `linear.general@1`. Modify `build.ts` (`drawQuestions` and template prose move behind `composeLesson`). Accept: 27 goldens, stored-package fixture and adjust property tests unchanged. Risk: RNG call order drift. Out: any new content.
- **M1 Blueprint resolution + topic prose.** Optional `blueprintId` in mapping rows and snapshot; blueprints for two-step and both-sides using existing forms only; topic prose and mistakes; no-solution example only for both-sides. Modify `dataset-schema.ts`, `context.ts`, `build.ts`, `sectionInputsParams`, `validate-dataset.ts` (unknown `blueprintId` fails). Accept: default-path goldens pass; new goldens per topic; every blueprint passes the schema, names existing families, passes prose rules. Out: new forms, UI.
- **M2 One-step forms.** Three forms, families, `linear.one-step@1`. Accept: validator fixtures verified; bad fixtures fail; coefficient-1 rendering snapshot. Mapping note updated honestly; coverage stays `partial` until reviewed.
- **M3 Two-step variants.** `swap_sides` + `c=ax+b`; `div`, `frac-ans`. Validator tests incl. "sides swapped and changed" negative case.
- **M4 Like terms.** `combine_like_terms`; form and blueprint. Test that `2x + 3x` is not auto-combined in rendering.
- **M5 Practice pacing + presets.** Budget from `documents` and `paceMinutes` for blueprint versions only; practice cap 16 (within the 20/60-block caps); UI preset cards that only tick documents.
- **M6 Worksheet parts.** Part label as a `paragraph` block before each part (exercises/solutions schemas already allow paragraphs; no schema change). Verify `adjust.ts` numbering/insertion with paragraphs between questions [unverified assumption] and fix if needed. A real `heading` block (schema, blockTex, html-view, lesson-draft, EDITABLE_BLOCKS, TEMPLATE_VERSION bump) waits for tutor demand.
- **M7 Family-aware adjustments.** `easier/harder` neighbours replace `LADDER`/`isChallengeLevel` for blueprint packages; `add_exercises` targets a part; legacy path unchanged. Depends on [B2](https://github.com/yangzi33/noteprep/blob/main/docs/beta-roadmap.md#b2) adjustment screen.
- **M8 later.** Brackets; Quick-check part; optional solution annotations (additive `note` on `SolutionBlock`).
- **Reconcile with `docs/question-bank-design.md` [R]:** keep the closed vocabulary (becomes `SKILLS`) and verified/reviewed/draft tiers; **defer** MathText, the LLM-authored offline bank, word problems and find-the-error items (justified only for content families cannot generate, none needed for the MVP); merge "bank item" and "family output" into one `Question` with provenance `family:<id>` / `bank:<id>`; drop per-item misconception tags until a family can construct the actual error. Note: this partly reverses the owner's earlier stated preference for the bank-first approach; see decision 1.

## F. MVP release bar (inviting 5 tutors)
- **Correctness (automated):** 100% `verified` over 1,000 seeds × 4 topics × 3 presets × {45,60,90} min; no duplicate equations within a package; no `unverified` item in any PDF; goldens pass; LaTeX compiles across the sweep.
- **Pedagogy (human, required):** a practising math tutor who is not the developer reviews 3 sample packages per topic × preset (start with two-step and both-sides) against a checklist: items match the topic; parts rise from easier to harder; no item wrong for the level; examples representative; each mistake is real and the response usable; notes fit about 1-2 pages without filler. Sign-off recorded per blueprint version; a new version needs a new review.
- **Alignment (separate):** suggested datasets render "no alignment claim"; mapping notes describe real content; `coverage: full` only with a reviewed dataset.
- **May ship unfinished:** brackets, styled headings, family-aware adjustment UI, LLM prose, Quick check, annotations, other concepts.

## G. Decisions requiring approval (recommendation first)
1. **Content path:** families + blueprints first, question bank and MathText deferred (reverses the stated bank-first preference). Recommend yes; the bank stays designed and revisited after tutor feedback.
2. **No mode in the request;** two UI presets that pre-tick documents. Recommend yes.
3. **Drop Mode C;** possibly a later "Quick check" with item-to-skill labels and no interpretation. Recommend yes.
4. **Blueprints as repo data selected by an optional `blueprintId` on the dataset mapping** (not implicit by topic slug). Recommend yes.
5. **Practice budget ignores notes minutes** for new blueprint versions (more exercises for worksheet-only requests). Recommend yes.
6. **`swap_sides` op** rather than relaxing `final_form`. Recommend the op.
7. **Worksheet parts as paragraph blocks first;** `heading` block and TEMPLATE_VERSION bump deferred. Recommend yes.
8. **Keep the three-value difficulty enum;** families carry features and rungs; revisit a multidimensional model after tutor feedback. Recommend yes.
9. Who is the independent math-tutor reviewer for blueprint sign-off (owner to name).

## Assumptions to validate with tutors [A]
Tutors mostly want practice sets (worksheet + key is the core); 10-14 items in three parts suits a 45-60 minute session; words-only mistake notes are useful; part labels help ("Stretch" vs "Challenge" wording); x/a notation is preferred over (1/a)x; tutors accept no free-text prompt when topic choice is accurate.

## Top risks
1. M0 RNG order drift silently changes goldens, so the refactor stops being a regression guard (mitigate: M0 must be byte-identical before anything else lands).
2. Paragraphs between questions may break adjust numbering/insertion (unverified; property tests in M6).
3. Blueprint text must pass prose rules (no digits, no curriculum words), which makes good mistake notes awkward; write against `checkText` from the start.
4. Pedagogical review is the bottleneck (12 blueprint/preset combinations); start with two topics.
5. Scope creep into a bank or ontology before five tutors have used the product.

## Remove or simplify in the current content path
Stop writing unused capability fields into new snapshots (keep old ones readable); retire `isChallengeLevel`/`LADDER` for blueprint packages; keep `change_duration` out of the UI (or remove); make the no-solution example conditional per topic; drop the "does not yet differ by topic" mapping note once false; refresh stale docs (`refactor-plan.md`, A4/Letter, preview text).

## Verification status
Facts come from read-only reviews of `origin/main` on 2026-10-22 (docs and decisions; generator, validator, builder, adjustment and prose code including sampled equations; curriculum wiring, request, package schema, assembly, worker, UI and tests). Items marked [I] or "unverified" (for example `final_form` x-on-left behaviour, adjust handling of mid-section paragraphs, the exact paragraph-block allowance) must be confirmed at the start of the relevant milestone.
