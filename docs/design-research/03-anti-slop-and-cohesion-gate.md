# Anti-slop and cohesion gate

## Working definition

For this project, AI slop is design without grounding: a visual, sentence,
metric, personalization claim, or proof point that cannot be traced to a real
user need, product behavior, source of truth, or distinctive editorial
judgment.

This is an operational design standard, not a claim that every rounded card,
gradient, or AI-assisted sentence is inherently bad. The question is whether
the choice earns its place and makes the product more specific, useful, or
trustworthy.

There is emerging evidence that AI-generated interfaces can be usable while
still feeling conventional or weak on originality. [Usable but Conventional:
An Empirical Study on the UX of AI-Generated Interface Prototypes](https://arxiv.org/abs/2605.15124)
The more common visual-tell lists are practitioner heuristics, not a settled
research taxonomy. [SmoothUI](https://smoothui.dev/blog/ai-design-slop),
[Impeccable slop catalog](https://impeccable.style/slop/)

## Reject these patterns by default

- Decoration posing as product meaning: gradients, glass, glow, sparkles,
  oversized icons, or animated shimmer that do not explain state, hierarchy,
  or action.
- One choreography everywhere: hero, three cards, metric row, testimonial,
  and CTA repeated on every public page regardless of the user’s job.
- Card grids as a universal answer, including for prose, records, progress,
  workflows, and settings that need different structures.
- Metrics theater: scores, trends, streaks, or percentages without a source,
  timeframe, denominator, decision, or honest empty state.
- Vague AI capability language: “unlock your potential,” “AI copilot,”
  “personalized insights,” or “seamless” without specific inputs, outputs,
  limits, and controls.
- Fake personalization: “for you” or “recommended” without a meaningful
  user-specific signal, rationale, freshness, and fallback.
- Confidence theater: “best match,” “perfect resume,” or precise confidence
  numbers that cannot be interpreted or challenged.
- Invented proof: fake testimonials, anonymous success stories, usage counts,
  employer logos, or unsupported “studies show” claims.
- Generic AI voice: adjective stacks, symmetrical slogans, vague verbs, and
  copy that could be pasted into another career product unchanged.
- Forced choreography: interruptions, un-dismissible suggestions, repeated
  prompts, or motion used to capture attention instead of communicate change.
- Template consistency mistaken for coherence: every component has identical
  weight, radius, elevation, and density even when the task changes.
- Atmosphere over access: low contrast, tiny icon-only controls, visual-only
  status, ambiguous headings, or motion that fails reduced-motion users.

## Impeccable-derived review checklist

The [Impeccable slop catalog](https://impeccable.style/slop/) is a useful
pattern inventory, not a universal design taxonomy. Apply the following
checks to the relevant CareerPigeon surface, then record the product reason
for any intentional exception.

| Surface | Check for | CareerPigeon application |
|---|---|---|
| Landing and public pages | Hero eyebrow/pill chips, oversized long headlines, repeated section kickers, identical card grids, hero-metric layouts, and centered hero + CTA choreography | Lead with one concrete job-search promise and a truthful product artifact; vary composition by the user’s reading or decision task |
| Dashboard and module shells | Nested cards, monotonous spacing, side-tab accent borders, hairline borders paired with wide shadows, extreme card radii, and icon tiles stacked above every heading | Use records, grouped sections, and task-specific work areas; let hierarchy come from CareerPigeon objects and state rather than decoration |
| Color, type, and surfaces | Purple/blue gradients, cyan-on-dark neon, radial halos, gradient text, warm cream defaults, reflexive use of current font waves such as Inter, Geist, Space Grotesk, or Instrument Serif, and a single font with no hierarchy | Choose tokens for a deliberate product palette and hierarchy; never use a color effect as a substitute for status, provenance, or emphasis. A single sans can be deliberate in a dense authenticated interface when hierarchy is strong; an approved display/body pairing may better serve landing or editorial reading. Neither choice passes merely because it avoids a cataloged font. |
| AI and marketing copy | Buzzword stacks, aphoristic contrast lines, “theater” framing, repeated em dashes, and generic personalization language | Name the actual input, output, uncertainty, and next action; use literal, product-specific language |
| Motion and imagery | Pulsing static status dots, fake cursors, auto-scrolling marquees, bounce/elastic easing, image hover scaling, and shape-assembled illustration | Animate only real change or feedback; use real product artifacts or authored imagery, and keep content visible and usable at rest |
| Accessibility and finish | Low contrast, tiny body text, skipped heading levels, cramped padding, long unreadable lines, clipped overflow, and invisible-at-rest content | Treat complete state coverage, semantic structure, readable measures, keyboard operation, and reduced motion as ship gates |

Impeccable distinguishes personalized CLI checks for design-system drift,
deterministic CLI/browser checks, and LLM-only judgments. Use deterministic
findings as repeatable defect checks, but review the context manually: a
gradient, serif headline, or rounded card may be appropriate when it has a
clear product, editorial, or interaction job.

## Counter-principles

1. Start with the user’s job, current state, and next useful action.
2. Make every prominent element orient, explain, help decide, enable action,
   show state, support recovery, or express verified product identity.
3. Use a shared grammar, not identical layouts: tokens and interaction rules
   persist while composition follows the task.
4. Make specificity structural through CareerPigeon’s real objects: facts,
   resume evidence, tailored drafts, interview answers, applications,
   follow-ups, and networking context.
5. Earn personalization. Show its input, rationale, scope, freshness, and
   controls; be honest when information is missing.
6. Make metrics decision-relevant. If data is absent or insufficient, show the
   truthful empty state.
7. Use one product voice with contextual tone: direct in controls, candid in
   uncertainty, constructive in coaching, calm in failure, plain in billing,
   and source-first in editorial.
8. Use motion to communicate a state change, progress, or feedback—not the
   mere existence of a feature.
9. Let visual distinctiveness come from the product’s information hierarchy,
   relationships, and artifacts before adding decorative novelty.
10. Keep human authorship in the loop for hierarchy, copy, visual direction,
    claims, and final review. NIST’s human-centered design framing requires
    explicit user needs and iterative evaluation, not one-shot generation.
    [NIST human-centered design](https://www.nist.gov/itl/iad/human-centered-technologies/human-factors-human-centered-design)

## Review gates

### Specificity

- Logo-off: can a reviewer identify the product’s job without the logo?
- Domain-swap: if product nouns become “item,” “score,” and “project,” does the
  design still feel equally specific? If yes, strengthen the domain model.
- Copy substitution: could the main copy be pasted into another AI career
  product? If yes, rewrite it.
- Five-second: can a new user identify purpose, state, and next action quickly?

### Visual restraint

- Remove gradients, glass, shadows, sparkles, and excessive pills. The page
  must still retain hierarchy, purpose, state, and action.
- Delete half the cards. If the task becomes clearer, the cards were carrying
  decoration rather than information.
- For every signature treatment, write its job: identity, orientation, status,
  emphasis, comprehension, or recovery. No job means no treatment.
- Vary composition when the underlying task varies. A cohesive product is not
  a repeated template.

### AI, data, and claims

- AI contract: what can it do, what data does it use, how can it be wrong, and
  what can the user do next?
- Rationale: recommendations expose a concise reason tied to actual inputs.
- Correction: users can edit, reject, refine, dismiss, undo, or continue
  manually without restarting the whole workflow.
- Personalization: every tailored/recommended claim has a real source and
  fallback state.
- Metric ledger: every number has source, timeframe, definition, and empty
  state. No fabricated chart series or placeholder percentages.
- Claim ledger: every objective claim, testimonial, logo, or study reference
  has an evidence link and owner before publication.

### Cohesion and accessibility

- Shared action labels, spacing, focus behavior, state language, tokens, and
  navigation behave consistently across product, blog, and extension.
- Layout and density are allowed to change when task, content, or consequence
  changes.
- Test semantic headings, keyboard flow, focus visibility, non-color status
  cues, contrast, target size, 200% text resize, 400% reflow, and reduced
  motion. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- Loading, empty, error, low-confidence, stale-data, unavailable, and success
  states are authored rather than left as component defaults.

## Reviewer calibration

For major design batches, two reviewers independently score the same captured
screens before reading the design rationale:

| Dimension | 0 — fail | 1 — adequate | 2 — strong |
|---|---|---|---|
| Product specificity | Interchangeable SaaS nouns and hierarchy | Correct domain content but familiar generic composition | CareerPigeon objects and relationships visibly organize the screen |
| Task hierarchy | Several equal focal points or unclear next action | Primary job is findable after inspection | Purpose, state, and next action are immediate |
| Composition fit | Card grid or page template regardless of task | Layout supports the task with some generic defaults | Editing, practice, records, and reading have distinct useful compositions |
| Provenance and truth | Unsupported metrics, proof, personalization, or AI confidence | Claims are truthful but some source/context is distant | Evidence, freshness, uncertainty, and correction appear where decisions occur |
| Restraint | Decoration competes with work | Most elements earn their place | Visual character is distinctive and functionally disciplined |
| State quality | Happy path only or generic component defaults | Core alternate states exist | Alternate states preserve context, explain cause, and enable recovery |
| Cohesion | Screens feel unrelated or mechanically identical | Tokens and labels are mostly consistent | Shared grammar is obvious while task-specific composition remains intact |

Pass rule:

- no dimension may score 0;
- total score must be at least 11 of 14;
- any S0 or S1 finding from `05-validation-and-iteration-protocol.md` is a
  veto regardless of score;
- reviewers attach the exact screenshot/state used;
- scoring disagreements of 2 points on a dimension require a recorded joint
  resolution or an explicit exception owner.

Calibration examples live in `07-annotated-visual-precedent-atlas.md`. A strong
product screenshot surrounded by a generic gradient hero can pass “proof” while
still scoring weakly on composition and restraint; a consistent card system
can pass cohesion while failing composition fit.

## Ship rule

If a design decision cannot answer “which user need, product behavior,
evidence, or brand meaning does this express?”, it is decoration or copy filler
until proven otherwise.
