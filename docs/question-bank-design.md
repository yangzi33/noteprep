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
- `id` (stable, unique), `topic`, `level` (basic | mixed | challenge)
- `skills[]` and `misconceptions[]`: ids from a **closed per-topic vocabulary** defined in the topic catalog (`data/curricula-src/topics.json`, new optional fields `skills` and `misconceptions`). Tags are validated on import against that vocabulary; an unknown tag rejects the item. The same tags are attached to generator profiles, so generated and banked questions can be targeted the same way. Tags are a human or LLM judgement, not machine-verified, and are labelled as such wherever they drive selection.
- `statement`, `answer`, `steps[]` written in **MathText** (section 3), never raw LaTeX
- `provenance`: generator model, prompt version, date; `originality` note (not copied from a textbook or worksheet)
- `review` (required for `reviewed`): `by`, `at`, `scope`
- `fingerprint` computed on import (canonical statement + answer) for duplicate detection

## 3. MathText: the safety-critical part
CLAUDE.md section 8 allows only supported math expressions and macros, so free-form LLM math cannot enter LaTeX as text. MathText is a small restricted markup (digits, variables, `+ - * / ^`, parentheses, `=`, `<`, `>`, fractions, roots, a fixed list of function names such as sin/cos/tan/log, pi, and plain words). It is **parsed to an AST** on import (reject anything unparseable) and rendered by our own renderers to LaTeX and to KaTeX HTML. Unknown symbols make the item invalid. This needs the owner to accept that some LLM-written items will be rejected until the grammar covers them; the grammar grows by deliberate change, not per item.

**Decided (owner, 2026-10-22): MathText is a restricted LaTeX-style syntax inside ordinary JSON strings.** It is a strict subset of familiar LaTeX notation (for example `\frac{3}{4}`, `x^2`, `\sqrt{2}`, `\sin x`), chosen because LLMs write it fluently, unlike ASCII math (ambiguous: `1/2x`) or a math AST in JSON (verbose and error-prone). Properties:
- The allowed commands, symbols and nesting are a fixed list; the import step parses every string to an AST and rejects anything else with a precise reason (for example an unknown command or unbalanced braces). Raw LaTeX never reaches the compiler; only our renderers emit LaTeX and KaTeX HTML from the AST.
- Rejections can be fed back to the LLM offline for a retry, so batch authoring converges quickly.
- The item container (fields, tags, level) is plain JSON and can be produced under an LLM JSON-schema constraint.
- MathText guarantees safe, parseable notation only. Correctness is the validator's job (verified tier) or the human reviewer's (reviewed tier).
- **First step before any parser:** write the grammar as a short spec (allowed commands, examples, forbidden constructs) plus about 20 sample items, and let the owner try them on their LLM to measure the first-pass acceptance rate. The grammar grows by deliberate change when a pattern is worth supporting.

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
0. MathText grammar spec and about 20 sample items, tried by the owner on an LLM (acceptance rate) before any code.
1. MathText parser and renderers (LaTeX, HTML), tests incl. injection fuzzing. Independent security review.
2. Item schema, `bank:validate`, tier derivation, duplicate detection, CI.
3. Table, migration, load workflow.
4. Pack builder integration, validation status `reviewed`, labels in UI/PDF/lesson page, E2E.
5. Replace question and duplicate for bank topics (inside B2).
Rough size: slices 1 to 4 are weeks of work, not days. Slice 1 is the riskiest.

## 7b. Future: AI weakness prompt (interpreter), not built
A later feature: the tutor describes a student's weakness in one sentence (AI-labelled). Design constraints decided in discussion on 2026-10-22:
- **The LLM is an interpreter, not an author.** It maps the sentence to a few chips from the closed per-topic vocabulary (skills and misconceptions), shown as "AI-suggested". The tutor confirms or edits the chips, which keeps the selection-first flow. Only the chosen tags reach the question engine, which draws verified or reviewed items by tag. The sentence itself never reaches question generation, and the LLM never writes math.
- **Student data.** The sentence is the closest thing to student information the product would take (CLAUDE.md sections 1 and 9 exclude learner diagnostics and student details). It needs: an anonymity warning ("do not enter names or identifying details"), a decision on whether to store the raw sentence at all (recommended: do not store it, keep only the confirmed tags), the LLM provider named as a sub-processor, and a deliberate scope decision recorded before build.
- **Untrusted input.** The sentence is data, never instructions (CLAUDE.md section 7): bounded length, structured output restricted to the vocabulary, anything else dropped.
- It cannot be cached or shared between tutors; each use is a live call with its own cost and rate limits.

## 7c. Open option (UNDECIDED): live top-up at press time
Idea: when a tutor presses Generate, serve from the bank if the topic and level have at least N approved items; below N, ask the LLM for new items and add them to the bank.
- **Only for problem types our validator can check** (today: linear equations). Accepted items enter the bank as `verified`. For topics without a validator the live path cannot serve unreviewed items (that was the option declined in section 1): the LLM drafts into the hidden `draft` tier, the tutor sees "not available yet, requested", and the owner reviews drafts in batches. Requests double as a demand signal.
- **Costs:** needs the OpenAI adapter and a per-job cost cap; latency on the first presses of a thin topic; the LLM becomes a sub-processor for every user, not only opt-in testers (privacy notice).
- **Risks:** LLM-assigned level and skill tags are not verifiable; items may resemble textbook problems (originality check, duplicate detection, a "report a problem" button tied to the item that quarantines it at once, sampled human review).
- Not part of the build slices above. Decide after the offline bank exists.

## 7d. Later option: a separate AI draft box (recorded, not scheduled)
Idea (owner, 2026-10-22): keep Prepare exactly as planned and add a **separate** feature, a blank text box that generates problems from a free-text prompt with an LLM.
- **Separate promise, separate label.** Prepare means verified or human-reviewed math. The AI draft box means "AI-generated draft, not machine-verified, check every answer", shown on screen and in the PDF. It never shares a page, a pack or a "verified" label with Prepare. Where the validator covers the problem type (today: linear equations), passing items may be marked verified individually; everything else stays an unverified draft.
- **Separate budget.** Its own allowance or budget, rate limits and cost cap; a failed or rejected generation releases it, as for other jobs.
- **Needs written exceptions to CLAUDE.md** for this feature only: section 1 (selection-first, no free text, validation coverage) and section 7 (math validated, unsupported AI output not billed as a complete success). Not approved.
- **Depends on:** the MathText parser and renderers (section 3), so LLM math enters LaTeX only through a safe grammar; the OpenAI adapter and a per-job cost cap; the student-data rules of section 7b (anonymity warning, no raw-text storage, LLM as sub-processor, prompt-injection handling); a "report a problem" button that quarantines an item at once.
- **Decision point:** after the offline bank exists and the Beta shows what tutors ask for. Until then it is only a recorded option.

## 7e. Guiding the tutor, and what a prompt can mean
A prompt is not limited to weaknesses. In the interpreter path (7b) the LLM turns any prompt (for example "grade 10 student studying trigonometry") into a structured selection from vocabularies the system already knows (country, curriculum, grade or course, unit, topic, level, duration, documents, skill and misconception tags), shown as editable chips labelled "AI-suggested". Parts that map to nothing appear in a visible "couldn't use this" list and never reach generation; topics with no content yet show greyed as "not available yet" and are logged as demand. Guidance: example chips under the box, a placeholder that models the format, a length limit with a counter, the no-student-names warning, the chips sharing state with the form's dropdowns, and a log of prompts that mapped to nothing (match results only, not the text) to find vocabulary gaps.

## 7f. Later slice: figures (graphs), recorded not scheduled
Graph-based topics (piecewise functions, sine and cosine graphs, single variable on the xy plane) need a **figure** type beside MathText. Owner asked on 2026-10-22; recorded as bank slice 5, to be built only if the Beta shows demand for graph topics.
- **Three uses:** a graph shown in a question; blank axes and grid for the student to sketch (the solutions page then shows the correct graph); a graph as the answer.
- **A figure is a declarative spec in JSON, never drawing code.** Axes (range, step, labels); one or more curves, each a function written in MathText (for example `3\sin(2x)`); for piecewise functions a list of pieces, each with a MathText formula and a domain condition (`x < 0`, `0 \le x < 2`); markers (open or closed circles at breakpoints, labelled points, dashed asymptotes). Angle unit (radians or degrees) and boundary inclusion are explicit fields, never implied.
- **Rendering by our code only.** A small safe evaluator (the limited expression AST CLAUDE.md section 7 allows, not a general CAS) samples each curve into points; the PDF draws them as TikZ coordinates and the HTML preview as SVG from the same points, so the two cannot disagree. No pgfplots (it would evaluate expressions inside TeX, widening the compile-time attack surface); TikZ availability in the pinned LaTeX image must be checked, nothing is installed at runtime.
- **Verification:** the picture always matches its own formula because it is drawn from it. Stated answers (amplitude, period, domain) are verified when we generate the problem from parameters (for example `y = a\sin(bx)`); for LLM-written items they stay in the reviewed tier.
- **Costs and risks:** figure type in the package schema (new schema version), evaluator, two renderers, discontinuity handling, visual regression tests, plus the item-format field. The item format reserves an optional `figure` field now so existing items do not need a migration later.

## 8. Decisions for the owner
1. Approve the three tiers and the file format (sections 1 to 2).
2. Approve MathText as the only way math enters bank items, and that rejected items stay rejected until the grammar grows (section 3).
3. Does a successful pack with reviewed items consume allowance like a verified one? (Recommended: yes, with the label.)
4. Approve the two CLAUDE.md exceptions and N = 30 approved items per level (section 6).
5. First bank topics: which ones do you plan to generate first?
6. Tags (section 2): approved in discussion on 2026-10-22; vocabulary per topic to be written with the first bank topics.
7. Live top-up at press time (section 7c): open; decide after the offline bank exists.
8. Separate AI draft box (section 7d): recorded as a later option; decide after the offline bank exists and the Beta shows demand.
9. MathText as the only way math enters bank items, as a restricted LaTeX-style syntax (section 3): approved in discussion on 2026-10-22.
10. Figures (section 7f): recorded as a later slice; decide after the Beta shows demand for graph topics.
