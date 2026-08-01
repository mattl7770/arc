# CareerPigeon design research

Status: research package updated and main-thread reviewed; the six-state
canonical dashboard visual package passed after two targeted rerenders; no
CareerPigeon source code was changed.

## Intent

This folder is the research base for a unified overhaul of CareerPigeon’s
screens. The goal is a coherent product language across the authenticated SPA,
public marketing pages, static blog, and Chrome extension without collapsing
every screen into the same template.

The standard is: product-specific, useful, calm, source-backed, accessible,
human-edited, and visually intentional. “Polished” is not enough. A screen
that is technically competent but interchangeable, overdecorated, vague, or
AI-generated-looking does not pass.

## Start here

The primary design brief is `06-priority-ui-ux-overhaul-brief.md`. It focuses
on the dashboard, modules, landing page, and blog. Payments, legal currentness,
and policy remain supporting guardrails; they are not the center of the
overhaul.

For the dashboard canonical lane, read `dashboard-adversarial-gate.md` first,
then `dashboard-canonical-iteration-spec.md`. The current status is recorded in
`dashboard-canonical-gate-verdict.md`; approved artifacts, scores, and rejected
first passes are in `dashboard-canonical-visuals/`. `03` contains the cross-surface
anti-slop gate, `04` records evidence tiers and dated source entries, and `05`
defines the deterministic, browser, human-review, and user-validation evidence
required before dispatch.

## Files

- `00-scope-and-screen-inventory.md` — current user-facing surface inventory;
  current implementation used only to identify jobs and states, never as a
  visual benchmark.
- `01-evidence-brief.md` — external research from six bounded research lanes,
  with direct source links and evidence/inference separation.
- `02-world-class-design-framework.md` — synthesized principles, screen-level
  implications, anti-slop acceptance tests, and a proposed redesign sequence.
- `03-anti-slop-and-cohesion-gate.md` — the explicit visual/content quality
  gate for avoiding generic AI-generated-looking work while preserving a
  unified product language.
- `04-evidence-ledger-and-precedent-map.md` — evidence-strength rules,
  freshness requirements, screen-by-screen precedent translations, and visual
  language guardrails.
- `05-validation-and-iteration-protocol.md` — the operating protocol for
  turning research into screen briefs, visual directions, prototypes, user
  validation, and cross-platform release gates.
- `06-priority-ui-ux-overhaul-brief.md` — the recommended layout, visual
  hierarchy, interaction archetypes, and redesign order for the dashboard,
  modules, landing page, and blog.
- `07-annotated-visual-precedent-atlas.md` — captured external visual
  precedents with explicit transfer and rejection notes.
- `08-critical-claim-ledger.md` — compact claim-by-claim evidence record that
  separates direct support from CareerPigeon synthesis.
- `09-screen-traceability-matrix.md` — one-row-per-surface coverage map from
  inventory through design contract, precedent, task, state, and validation.

## Research method

The repo and local public routes were inspected to understand product scope.
Six independent research lanes then searched external guidance and product
examples. Each lane was explicitly instructed not to spawn sub-agents. A
separate adversarial review followed the synthesis. The research uses primary
or authoritative sources where possible; `04` makes the evidence hierarchy and
freshness rules explicit. Product examples are treated as patterns to
interrogate, not templates to copy.

## Important limitation

This is design-practice research, not user research. Before finalizing a visual
direction, validate the highest-risk assumptions with real CareerPigeon users
and realistic tasks. Use `05-validation-and-iteration-protocol.md` as the
minimum process. The framework is a strong starting point, not a substitute for
observing where people hesitate, misunderstand, or abandon.
