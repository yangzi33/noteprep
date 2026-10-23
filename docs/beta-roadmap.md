# Beta roadmap (B0 to B6)

> **Direction change (2026-10-22):** B1 (topic-faithful question engine) is superseded by the preview-first, LLM-first flow in [generation-flow](generation-flow.md) (D-94 to D-101); the other milestones stand unless that document says otherwise.

Source: the strategy review approved on 2026-10-21; decisions are recorded as D-70 to D-84 in [decisions.md](decisions.md). Status is updated by hand. **Nothing here is a commitment to a date.** Estimates are unmeasured.

Order is the build order. "Concierge" means the founder generates packs for about 5 tutors and interviews them weekly; "self-serve" is the invite-only free Beta for 10 to 30 tutors.

| Milestone | One-line summary | Before concierge | Before self-serve |
|---|---|---|---|
| [B0](#b0) | Verify, merge, start the concierge phase | partly | yes |
| [B1](#b1) | Topic-faithful question engine | yes (4 topics) | yes (8 to 10 topics) |
| [B2](#b2) | Adjustment loop with replace/remove question | no | yes |
| [B3](#b3) | Topic dataset and curriculum dropdown | no | yes |
| [B4](#b4) | Beta ops, privacy, analytics | minimal | yes |
| [L1](#l1) | OpenAI provider slice | no | only if LLM prose is offered |
| [B5](#b5) | Second concept (trigger-based) | no | after signal |
| [B6](#b6) | After the Beta signal | no | after signal |

<a id="b0"></a>
## B0: Verify, merge, start the concierge phase
Status: **merges done** (UI rollout, M6 core with the D-72 changes, decision records); the rest is open.
- Done: integration and E2E tests green in CI on the UI branch; merged to `main`; M6 S1 pure core merged; Letter label, topic title in the PDF header, Quick form removed from the sidebar.
- Open: worker-host checks on the new droplet ([runbook §12](worker-host-runbook.md)); first-party analytics table and `track()` ([design](analytics-design.md)); concierge phase with about 5 tutors ([drafts](concierge/)); the ChatGPT answer-key error experiment (100+ items through our validator).
- Not in B0: new features, Stripe, a curriculum dataset.

<a id="b1"></a>
## B1: Topic-faithful question engine
Topics become declarative profiles (data) over the existing generator; a CI verification sweep generates the coverage ledger; a topic is live only when the ledger passes at every level offered (D-77). Concierge menu: one-step, two-step, both sides, like terms (brackets only if interviews require). Grows to about 8 to 10 verified topics before self-serve. Needs the topic list from the owner before it can be sized.

<a id="b2"></a>
## B2: Adjustment loop
M6 S2 (drafts, migration) and S3 (worker), the adjustment screen: easier/harder, add exercises or examples, replace question, remove question (D-71), accept/discard, duplicate with new numbers. `change_duration` stays hidden (D-72). Text corrections and LLM adjustments are deferred.

<a id="b3"></a>
## B3: Topic dataset and curriculum dropdown
A first-party "NotePrep topics" dataset (D-74). A curriculum dropdown with unofficial "suggested topics": live topics clickable, the rest greyed with a request button and a count (D-75). No alignment claims.

<a id="b4"></a>
## B4: Beta ops, privacy, analytics
Beta privacy notice and terms, decided data region, manual deletion (D-78); invite allowance of about 30 generations (D-79); IP rate limit; alerts for failures, stalled queue and cost; in-app "report a problem"; consent banner with GA4, URL scrubbing and CSP (D-84); three-tier preview pricing UI (D-83); closed Beta on the current droplet with written limits (D-82).

<a id="l1"></a>
## L1: OpenAI provider (small, parallel)
New adapter, provider setting, tests, rerun of the prose evaluation, docs; keep the Anthropic adapter (D-81). Only matters for the few testers who opt in to LLM prose.

<a id="b5"></a>
## B5: Second concept (trigger-based)
Chosen from demand by course tag (D-80); default linear inequalities. Not scheduled.

<a id="b6"></a>
## B6: After the Beta signal
Stripe and the real plans, full deletion flows, text corrections, student profiles (anonymous presets, D-76), localization with a French option (D-70), IB and AP overlay labels after a legal wording check, an LLM template-authoring pilot, more provinces.
