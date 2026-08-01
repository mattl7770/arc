# Validation and screen-iteration protocol

Date: 2026-07-27

## Purpose

This protocol turns the research into design decisions that can survive real
content, real states, and real users. It prevents two failure modes:

- jumping from principles to polished mockups without validating the workflow;
  and
- enforcing “cohesion” by repeating one attractive template across unrelated
  tasks.

Current CareerPigeon screens may be consulted to enumerate behavior and state.
They are not the visual baseline.

## Required traceability

Every material design choice must have a short ledger entry:

| Field | Required answer |
|---|---|
| Screen and state | Which exact screen, viewport, data condition, and user state? |
| User job | What is the person trying to accomplish now? |
| Dominant object | What record, artifact, conversation, or decision organizes the screen? |
| Decision | What hierarchy, interaction, copy, or visual treatment is proposed? |
| Rationale | Which user need, product behavior, evidence, or brand meaning supports it? |
| Source strength | Tier A, B, C, or D from `04`; or direct CareerPigeon user evidence |
| Risk | What could be misunderstood, hidden, fabricated, inaccessible, or manipulative? |
| Test | What realistic task or inspection would disprove the choice? |
| Outcome | Keep, revise, reject, or unresolved; include date and owner |

If a decision has no testable rationale, it is a preference. Preferences are
allowed, but they must be named as such instead of laundered as “best
practice.”

## Screen brief required before mockups

Create one brief per screen or tightly coupled flow:

1. **Entry context:** why the user arrived and what they already know.
2. **Primary job:** one sentence, written as an outcome.
3. **Primary action:** the next useful action, not the most valuable business
   CTA.
4. **Dominant object:** the thing the user is working on.
5. **Information priority:** must know now, useful next, available on demand.
6. **Trust boundary:** data use, AI inference, approval, money, privacy, or
   external consequence that must be explicit.
7. **State matrix:** first use, loading, partial, populated, no results,
   validation error, system failure, stale data, conflict, success, permission
   or plan gate, and destructive action where applicable.
8. **Cross-module links:** what context enters and leaves this screen.
9. **Responsive obligation:** what must remain fully operable in compact,
   medium, and expanded modes.
10. **Non-goals:** what this screen deliberately does not show or optimize.

Mockups without this brief do not enter visual review.

## Representative task set

The redesign must be tested with realistic content and end-to-end tasks, not
isolated happy-path screens.

| Journey | Representative task | Critical evidence |
|---|---|---|
| Discover and evaluate | Understand what CareerPigeon does, compare the plan, and predict what happens after sign-up | Message comprehension, pricing/renewal understanding, no unsupported claim |
| First value | Create an account, provide the minimum career context, and reach a useful artifact | Time and hesitation to first value, optional-step comprehension, preserved progress |
| Resume evidence | Import a resume, resolve an unsupported suggestion, edit a fact, approve selected changes, and export | Provenance comprehension, granular correction, no lost edits |
| Application operation | Process an imported opportunity, place it in the pipeline, filter the working set, snooze, and return | Triage clarity, state continuity, no duplicate mental model |
| Interview practice | Start in text or voice, answer, inspect evidence-backed feedback, challenge it, and recover from a failure | Recording clarity, feedback contestability, session preservation |
| Recruiter recommendation | Explain why a role appeared, dismiss or save it, and carry context into an application | Fit is not misread as probability; rationale and uncertainty are understood |
| Networking | Review relationship history, edit a suggested message, defer it, and confirm nothing was sent automatically | User authorship, privacy, cadence and send boundary |
| Subscription exit | Identify current plan and effective date, cancel, and explain the resulting access state | No obstruction, surprise, or ambiguous completion |
| Editorial bridge | Read a guide, inspect its basis and freshness, and take one relevant product action | Source trust, CTA relevance, continuity into product |
| Public recovery | Follow a stale or mistyped link, understand what failed, and recover to the intended product or editorial area | No silent redirect, blame, or dead end |
| Extension capture | Understand permissions, preview parsed fields, correct them, and save explicitly | Data-boundary comprehension, correction before persistence |

## Validation stages

### Stage 0 — language, architecture, and task model

Use rough flows, object maps, and navigation labels. Do not introduce polished
visual styling.

Test:

- whether users group features around the same career-search model;
- whether navigation labels are understood without explanation;
- whether the dashboard’s proposed primary job matches what users need on
  return;
- whether “progress” means useful career-search progress rather than product
  activity.

Exit when the major object vocabulary, navigation, and dashboard objective are
stable enough that visual exploration will not mask structural disagreement.

### Stage 1 — low-fidelity workflow and state coverage

Prototype the representative tasks above with real-length, realistic content.
Include interruption, no-results, partial-data, error, retry, and undo paths.

Exit when users can complete and recover from the core task without relying on
facilitator explanation or decorative cues.

### Stage 2 — comparative visual directions

Apply the three directions in `04` to the same content, viewport, and states.
Do not compare one polished concept with two sketches.

Evaluate:

- first-glance purpose, state, and next action;
- perceived trust without prestige theater;
- legibility and information density;
- product specificity with the logo removed;
- fit across dense work, coaching, editorial, and compact contexts;
- whether the direction depends on generic AI imagery or copy.

Veto a direction if it fails accessibility, truthful data, AI control,
consequential-action clarity, or the domain-swap test. Do not let visual appeal
outvote a veto.

### Stage 3 — high-fidelity interaction and trust

Prototype the AI evidence chain, granular review, destructive actions, billing,
permission explanations, autosave/conflict, and failure recovery. Test actual
microcopy, focus behavior, keyboard order, motion, and responsive transitions.

Exit when participants can explain:

- what information the AI used;
- what is generated versus approved;
- how to correct or reject it;
- what will happen on export, save, send, delete, or cancel; and
- whether their work is safe after failure.

### Stage 4 — cross-surface cohesion

Review representative screens together, not one at a time:

- dashboard;
- Resume Workshop or draft review;
- Interview Coach;
- Applications;
- landing or plan page;
- blog article;
- extension popup;
- compact/mobile navigation;
- error, empty, and gated states.

Check that the same concepts share names, action hierarchy, focus behavior,
state language, tokens, and trust patterns. Then check the inverse: each
surface must still have a composition suited to its task.

Exit only when reviewers can identify one product language without finding one
repeated page template.

### Stage 5 — accessibility, resilience, and performance

Required checks:

- full core-flow keyboard completion and logical focus restoration;
- semantic headings, labels, descriptions, status messages, and error links;
- contrast, non-color state cues, forced-colors/high-contrast behavior;
- 200% text resize and 400% reflow at 320 CSS pixels;
- pointer target size and spacing using the actual WCAG 2.5.8 exceptions;
- reduced motion and interruption control;
- slow network, offline/retry, stale data, partial data, and save conflict;
- realistic long content, localization expansion, and user-supplied text;
- Core Web Vitals and route-level performance budgets.

Accessibility inspection and automated checks are necessary but not sufficient;
include users of relevant assistive technologies in validation where possible.

## Anti-slop detection and craft evidence

The [Impeccable slop catalog](https://impeccable.style/slop/) was checked on
2026-07-28. It describes 64 patterns, with 59 enabled detector rules and five
broader judgments. Its labels are evidence about how to run the check, not a
license to treat every occurrence as an automatic design failure.

| Source classification | Meaning | Required evidence |
|---|---|---|
| Personalized CLI | Deterministic checks against the project’s documented design system | Check font, color, radius, and type-size values against the project `DESIGN.md` or equivalent; record any intentional exception and owner. |
| CLI — AI slop or quality | Deterministic checks that can run from files without a browser | Run `npx impeccable detect` against the implementation or review target; record command, target, timestamp, findings, and disposition. |
| Browser — AI slop or quality | Deterministic checks that require real layout or rendered interaction | Inspect the actual browser render at the target viewport/state, or use the browser/Puppeteer path; attach the capture and viewport to each finding. |
| LLM only — AI slop | No deterministic detector; requires contextual critique | A fresh reviewer records the rationale, task fit, product meaning, and any intentional exception. The author cannot close the finding alone. |

For the dashboard and public surfaces, the source-classified coverage must
include these relevant patterns:

- **Personalized CLI:** font/color/radius/type-size drift from the documented
  design system.
- **CLI:** decorative grids, thick side-tab borders, hairline-plus-wide-shadow treatment,
  repeating-gradient stripes, flat type hierarchy, icon tiles above headings,
  italic serif heroes, eyebrow and repeated kicker labels, oversized heroes,
  crushed tracking, reflexive use of current font waves such as Inter, Geist,
  Space Grotesk, or Instrument Serif, single-font use without hierarchy, radial halos, AI color palettes,
  glowing dark mode, gradient text, cream/beige defaults, tiny numbered labels,
  monotonous spacing, nested cards, pulsing status dots, marquees, bounce or
  elastic easing, image hover transforms, em-dash overuse, buzzword copy,
  aphoristic cadence, theater framing, shape-assembled illustration, repeated
  text in one container, all-caps body text, layout-property animation,
  broken/placeholder images, justified text, low contrast, skipped headings,
  tight line height, tiny body text, and wide body letter spacing.
- **Browser:** decorative/fake cursors and layout defects involving scroller
  gutters, occluded text, unbalanced first-viewport columns, crowded headings,
  long lines, overflow, clipped positioned children, uncaught load errors,
  invisible-at-rest content, cramped padding, or body text touching the
  viewport edge.
- **LLM only:** glassmorphism used as decoration, extreme radii on small cards,
  amateurish hand-coded SVG, hero-metric layouts, and identical card grids.

Run the checks in this order:

1. Complete the CLI scan and fix or explicitly disposition deterministic
   findings.
2. Rerender the exact states and viewports, then complete the Browser checks.
3. Run a fresh human/LLM critique for LLM-only findings and contextual
   exceptions; do not let the written rationale substitute for the artifact.
4. After any change to layout, type, surface, motion, copy, or imagery, rerun
   the affected checks and capture the new evidence.
5. Keep the anti-slop result separate from the user-validation result. A screen
   can be visually restrained and still fail a realistic task, state, or
   accessibility test.

## Participant coverage

Recruit for the task and risk, not a generic “SaaS user” label. Across rounds,
include:

- early-career candidates in an active search;
- users with sparse experience and users with denser histories;
- people doing repeated applications and people returning after a pause;
- mobile-constrained users if mobile is declared first-class;
- users who rely on keyboard navigation, screen magnification, screen readers,
  voice input, or reduced motion, as relevant to the flow;
- users who are skeptical of AI-generated career advice as well as frequent AI
  users.

Use small iterative rounds, but do not treat a fixed participant count as a
magic proof threshold. Continue until high-severity failures are resolved and
new sessions stop revealing materially new task-model problems for the tested
cohort.

## Severity and exit criteria

Classify every finding before deciding whether a round passes:

| Severity | Definition | Exit consequence |
|---|---|---|
| S0 — veto | Lost or overwritten work; unintended send/export/delete/payment; privacy boundary misunderstood; fabricated data or AI claim accepted as verified; critical flow inaccessible | Direction or flow fails immediately; no exception by visual review |
| S1 — blocking | Primary task cannot be completed or recovered; next action, system state, or consequential result is materially misunderstood; repeated navigation failure | Batch cannot advance until fixed and retested |
| S2 — significant | Task completes with avoidable hesitation, backtracking, or facilitator help; secondary state or hierarchy is unclear | Fix in the current batch unless explicitly deferred with owner and test |
| S3 — polish | Preference, minor friction, or visual craft issue that does not change comprehension or completion | May enter the tracked polish backlog |

Before each study, record:

- cohort and number of participants;
- primary task and allowed assistance;
- required comprehension questions;
- maximum acceptable S0, S1, and S2 findings;
- task-completion and recovery target expressed as an absolute count, not a
  percentage that hides a small sample;
- the decision that will follow each possible result.

Fixed minimums:

- zero S0 findings;
- zero unresolved S1 findings before implementation;
- every participant must correctly predict the consequence of send, export,
  delete, cancel, permission grant, and final AI approval before taking it;
- no participant may mistake an unsupported AI claim for verified career
  evidence after using the review flow;
- every scripted failure path must preserve user work and expose a usable next
  step.

These are veto conditions, not a claim of statistical generalization. Larger
summative studies should set power and confidence requirements appropriate to
the product decision.

## WCAG conformance evidence

The selected checks in Stage 5 are a risk-oriented working list, not the full
definition of WCAG conformance. Before release:

- maintain a matrix of every applicable WCAG 2.2 Level A and AA success
  criterion for each full page and complete process;
- record automated, manual, keyboard, screen-reader, zoom/reflow,
  forced-colors, and reduced-motion evidence as applicable;
- document any not-applicable criterion and the reason;
- test complete flows, including authentication, generated-content review,
  errors, recovery, and final actions—not isolated components only.

[WCAG 2.2 conformance requirements](https://www.w3.org/TR/WCAG22/#conformance-reqs)

## Review roles

Keep authorship and approval separate:

- the screen designer explains the brief and traceability ledger;
- a content reviewer checks specificity, claims, tone, and terminology;
- an accessibility reviewer checks semantics and interaction;
- an AI-trust reviewer checks provenance, uncertainty, correction, and
  consequence;
- a fresh design reviewer runs the anti-slop and cohesion gate without seeing
  the preferred rationale first;
- real users decide whether the model is understandable and useful.

No design approves itself merely because it conforms to the design system.

## Batch deliverable

Each design batch should include:

1. screen brief and object/flow map;
2. precedent translations and evidence ledger;
3. realistic content set with provenance for every number and claim;
4. primary, compact, empty, loading, error, stale, success, gated, and
   destructive states as applicable;
5. keyboard/focus notes and responsive behavior;
6. prototype for the representative task;
7. validation findings with keep/revise/reject decisions;
8. anti-slop and cohesion review;
9. unresolved product decisions clearly separated from visual preferences.

## Release rule

A screen is ready for implementation only when:

- its user job and dominant object are explicit;
- critical states and recovery are designed;
- consequential AI, privacy, billing, send, export, and delete boundaries are
  understandable;
- the visual direction passes accessibility and anti-slop vetoes;
- realistic task validation has no unresolved high-severity failure;
- its cross-surface vocabulary and behavior agree with the unified system; and
- the design still looks purposeful when generic AI decoration and unsupported
  proof are removed.
