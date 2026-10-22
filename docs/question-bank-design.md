# Question bank design (proposal for approval; **no implementation yet**)

Owner request (2026-10-22): topics and their content fully configurable; the owner generates finished questions, answers and steps with an LLM and loads them as configuration. Decision on unverifiable items: **a reviewed-draft tier** (imported, hidden from tutors until a human marks them approved, then shown with a "not machine-verified" label). This design needs owner approval, including two deliberate exceptions to CLAUDE.md (section 6 below).

## 1. Tiers
| Tier | Meaning | Visible to tutors |
|---|---|---|
| `verified` | Passes our validator (exact solver, step checks). Only possible for problem types that have a validator (today: linear equations in one variable) | Yes, labelled as today |
| `reviewed` | No validator exists. A named human reviewer checked the answer and steps and approved it in the file (reviewer, date, scope) | Yes, with a visible "answers not machine-verified" label on the page, the preview and the PDF |
| `draft` | Imported, not approved | **No.** Never offered, never used in a pack |

The tier is derived on import, never trusted from the file: an item claiming `verified` that fails the validator is rejected; an item without a validator can be at most `reviewed`.

## 2. Item format (JSON per topic, in the repo)
`data/question-bank/<topic-key>.json`, `topic-key` from the shared topic catalog (`data/curricula-src/topics.json`). Each item:
- `id` (stable, unique), `topic`, `skill` (free label from a per-topic list), `level` (basic | mixed | challenge)
- `statement`, `answer`, `steps[]` written in **MathText** (section 3), never raw LaTeX
- `provenance`: generator model, prompt version, date; `originality` note (not copied from a textbook or worksheet)
- `review` (required for `reviewed`): `by`, `at`, `scope`
- `fingerprint` computed on import (canonical statement + answer) for duplicate detection

## 3. MathText: the safety-critical part
CLAUDE.md section 8 allows only supported math expressions and macros, so free-form LLM math cannot enter LaTeX as text. MathText is a small restricted markup (digits, variables, `+ - * / ^`, parentheses, `=`, `<`, `>`, fractions, roots, a fixed list of function names such as sin/cos/tan/log, pi, and plain words). It is **parsed to an AST** on import (reject anything unparseable) and rendered by our own renderers to LaTeX and to KaTeX HTML. Unknown symbols make the item invalid. This needs the owner to accept that some LLM-written items will be rejected until the grammar covers them; the grammar grows by deliberate change, not per item.

## 4. Storage and loading
Same pattern as curricula: files in the repo, validated by `pnpm bank:validate` in CI, loaded into a new table (`question_bank_item`) by a manual workflow with an immutable version per bank. A pack stores the exact item content it used (pack content remains the source of truth, hashes unchanged in spirit), so later bank edits never alter an existing lesson.

## 5. How packs use the bank
- For a topic with a bank, the builder draws the requested number of items for the level, seeded and without repeats, and builds exercise and solution blocks paired by `questionId`, as today. Topics with only the generator keep using the generator.
- Validation report: per-question `method` is `exact_solver` for verified items and `human_review` for reviewed items. A pack containing any reviewed item has overall status **`reviewed`** (not `verified`) and shows the label everywhere. No pack may be labelled verified if it contains an unverified item.
- Finite supply: "duplicate with new numbers" and "replace question" ([B2](beta-roadmap.md#b2)) draw other items; when the bank is exhausted the UI says so. They no longer invent numbers for bank topics.
- Allowance: a successful reviewed pack is a complete generation and consumes allowance like any other (open decision 3).

## 6. Exceptions to CLAUDE.md that need your approval
1. **Section 1:** "selectable topics must have validation coverage". For bank topics, coverage = human review. Proposed wording: a topic is selectable when it has verified generation, or at least N approved reviewed items per level it offers (proposed N = 30), with the reviewed label shown.
2. **Section 7:** "known mathematical errors block final export" stays. The new text allows the `reviewed` status for items with a recorded human review and requires the label; it does not allow `draft` or unlabelled unverified math. "Math content is never hand-edited" stays true for tutors; the owner's reviewed files are the controlled path.

## 7. Build slices (after approval)
1. MathText grammar, parser, renderers (LaTeX, HTML), tests incl. injection fuzzing. Independent security review.
2. Item schema, `bank:validate`, tier derivation, duplicate detection, CI.
3. Table, migration, load workflow.
4. Pack builder integration, validation status `reviewed`, labels in UI/PDF/lesson page, E2E.
5. Replace question and duplicate for bank topics (inside B2).
Rough size: slices 1 to 4 are weeks of work, not days. Slice 1 is the riskiest.

## 8. Decisions for the owner
1. Approve the three tiers and the file format (sections 1 to 2).
2. Approve MathText as the only way math enters bank items, and that rejected items stay rejected until the grammar grows (section 3).
3. Does a successful pack with reviewed items consume allowance like a verified one? (Recommended: yes, with the label.)
4. Approve the two CLAUDE.md exceptions and N = 30 approved items per level (section 6).
5. First bank topics: which ones do you plan to generate first?
