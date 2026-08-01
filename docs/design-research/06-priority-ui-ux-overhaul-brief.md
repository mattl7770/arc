# Priority UI/UX overhaul brief

Date: 2026-07-27

## Revised emphasis

The overhaul should concentrate design effort in this order:

1. dashboard and shared workspace shell;
2. module-specific work surfaces;
3. landing page and product storytelling;
4. blog index, topic pages, articles, and editorial system;
5. onboarding, profile/progress, and compact/extension surfaces;
6. account, billing, legal, and recovery surfaces as baseline-quality
   obligations.

This prioritization does not excuse weak account or accessibility design. It
prevents supporting constraints from consuming the research agenda while the
core product remains visually unresolved.

## Product-level design thesis

CareerPigeon should not look like a dashboard that links to several AI tools.
It should look like one career-search workspace with four recognizable modes:

- **orient:** understand current state and choose the next useful action;
- **work:** edit, triage, compare, and move career-search artifacts;
- **practice:** focus, respond, receive evidence-backed coaching, and try again;
- **read:** learn from calm, credible, editorially authored guidance.

The shared visual language should come from typography, spacing, navigation,
state treatment, action hierarchy, evidence/provenance, and content voice. The
four modes should not share one page template.

## Dashboard: recommended composition

### Primary job

The dashboard should answer: **What deserves my attention now, and where can I
make useful progress?**

It should not be the home of every metric, module promotion, badge, quest,
friend, chart, and announcement.

### Expanded layout

Use a stable workspace shell with a responsive content grid. The dashboard
itself should have four zones in this order:

1. **Orientation strip**
   - short contextual heading;
   - current search focus or target-role context;
   - one compact indication when data is stale, incomplete, or still loading;
   - no oversized greeting or decorative hero.

2. **Next-action queue**
   - the dominant region;
   - a short ordered list of actionable items from across modules;
   - each item names the object, why it matters now, and the next action;
   - group only when grouping helps action: needs review, due/follow-up,
     waiting, recently changed;
   - support snooze, dismiss, and direct action without forcing a module tour.

3. **Active search context**
   - a quieter secondary region showing applications in motion, upcoming
     interviews, drafts in review, recruiter opportunities, and relationships
     awaiting follow-up;
   - use compact records, timelines, or stage summaries rather than equal-size
     promotional cards;
   - every number must route to the underlying work.

4. **Progress and reflection**
   - secondary to action;
   - show meaningful outcomes and recent effort over an understandable period;
   - explain what progress means;
   - keep XP, ranks, quests, and social comparison from overpowering the job
     search itself.

### Compact layout

On compact screens:

- preserve orientation and the first few next actions;
- convert secondary context into clearly labeled sections, not a horizontal
  carousel of cards;
- keep one primary action visible at a time;
- move dense comparison and bulk workflows into layouts designed for compact
  use rather than shrinking the desktop grid;
- if a workflow is not truly supported on mobile, say so in the product scope
  instead of producing a nominally responsive but unusable screen.

### Visual hierarchy

- Let the action queue carry the strongest contrast and largest working area.
- Use record rows and grouped sections for repeated work; reserve cards for
  genuinely bounded summaries or cross-module objects.
- Use color to express state and selection, not to paint each module a
  different brand.
- Show module identity through nouns, artifacts, and task-specific layout
  rather than oversized icons.
- Prefer one strong dashboard composition over a collage of independent
  widgets.

## Shared shell: what cohesion should mean

The shell should establish:

- persistent location and product scope;
- a predictable primary navigation order based on user jobs;
- one notification/inbox model rather than module-specific badges everywhere;
- clear current account and plan context without constant upgrade pressure;
- compact and expanded navigation modes with equivalent destinations;
- a global recovery state when bootstrap or shared data fails;
- consistent command, search, focus, and keyboard behavior where implemented.

The shell should not make every module look like a subpage of the dashboard.

## Module design archetypes

### 1. Evidence workbench

Use for Resume Workshop and tailored-draft review.

Recommended structure:

- source/evidence context;
- working artifact;
- focused change or issue;
- rationale/provenance;
- accept, edit, reject, restore, or continue manually;
- review progress and final approval.

Design implications:

- the artifact, not the AI prompt, is visually dominant;
- use change-level comparison and anchored explanation;
- preserve spatial context as the user moves between suggestions;
- separate “saved,” “reviewed,” and “approved for export” states;
- never bury unsupported evidence behind a generic confidence badge.

### 2. Focused practice room

Use for Interview Coach.

Recommended structure:

- session goal and mode before practice;
- one active prompt and response surface;
- explicit voice/recording state with text fallback;
- minimal in-session chrome;
- post-response feedback tied to transcript evidence;
- post-session synthesis only after the practice loop ends.

Design implications:

- avoid turning live practice into a dashboard;
- visually separate observed evidence, interpretation, and advice;
- let users challenge feedback and retry;
- keep session history and analytics outside the active response space.

### 3. Operational record system

Use for Applications, Networking, and Recruiter opportunities.

Shared grammar:

- records, saved views, search, sort, filters, counts, selection, detail, and
  recoverable state changes;
- list for scanning/comparison, board for stage movement, timeline/calendar
  only where date or duration is the task;
- context-preserving detail panel or route behavior;
- explicit waiting, snoozed, stale, and follow-up states.

Required differences:

- Applications centers role/company/stage and next follow-up.
- Networking centers a person, relationship history, and human-authored
  outreach.
- Recruiter centers incoming opportunities, match rationale, uncertainty, and
  triage before active work.

Do not recolor one generic table and call these three module designs.

### 4. Personal context and progress

Use for Profile, skills/ranks, setup readiness, and account context.

Recommended structure:

- editable user-owned facts and preferences;
- clear effect of each field on downstream modules;
- setup gaps shown as optional tasks with visible benefit;
- progress shown as interpretation, not a wall of achievements;
- privacy and visibility controls beside the data they affect.

## Landing page: design and layout brief

### Primary job

The landing page must make a visitor understand the product, see how the
workspace actually behaves, and decide whether to start. It should not mimic an
AI startup pitch deck.

### Recommended sequence

1. **Hero: one concrete promise and one real artifact**
   - say what CareerPigeon helps the user do;
   - show the workspace or a truthful composed product sequence near the first
     fold;
   - use one primary CTA and one lower-commitment evaluation path;
   - avoid decorative AI imagery, fake activity, and generalized empowerment.

2. **The connected workflow**
   - explain how career facts move into tailored work, applications,
     interviews, follow-up, and learning;
   - use one product-specific visual model rather than an icon grid of modules;
   - show continuity, not “six tools in one.”

3. **Representative product moments**
   - show a change review, interview feedback, application follow-up, or
     recruiter rationale with realistic content;
   - each image should prove a distinct interaction claim;
   - captions explain the user decision, not the feature name.

4. **Who it is for and when it helps**
   - use recognizable job-search situations;
   - be clear about non-goals and limits;
   - avoid invented personas, testimonials, or outcomes.

5. **Trust through product behavior**
   - demonstrate user review, evidence boundaries, privacy-relevant controls,
     and recoverability in context;
   - keep lengthy policy material out of the main narrative.

6. **Plan choice and final action**
   - make the free starting point and paid value understandable;
   - keep the final CTA specific to what happens next.

### Visual direction

- Use typography and product artifacts to create authority before illustration.
- If illustration is used, commission a coherent editorial system with a
  defined subject, line/shape language, palette, and cropping rules.
- Break section rhythm deliberately: full-width artifact, narrow explanation,
  editorial split, dense workflow, quiet proof.
- Avoid repeating centered heading + three equal cards + screenshot + CTA.
- Do not use blue-purple gradient atmosphere, glass, sparkles, floating
  interface tiles, AI orbs, rockets, targets, or growth arrows as a brand
  substitute.

## Blog: editorial design brief

### Blog index

The index should feel like a publication connected to a product, not a marketing
resource center.

Recommended composition:

- a concise editorial masthead with a real point of view;
- a featured story or useful current guide chosen editorially;
- visible topic navigation based on user questions;
- a mix of feature, standard, and compact story treatments;
- author, freshness, and content type visible before click;
- search or filtered browsing only if the corpus warrants it;
- a restrained product bridge outside the main reading hierarchy.

Use variation to indicate editorial priority. Do not put every article into the
same thumbnail card.

### Topic pages

- explain the user problem the topic covers;
- provide a deliberate reading path, not a date-sorted archive only;
- distinguish foundational guidance, current updates, and deeper analysis;
- allow sparse topics to use a simpler composition instead of an empty grid.

### Article page

- title, dek, author, dates, reading context, and source/limitation signals
  should be visible without crowding the opening;
- use a readable measure and strong heading rhythm;
- give figures, examples, quotes, and data tables their own authored visual
  treatments;
- use one lead visual with a clear editorial job;
- keep in-article product CTAs rare and contextually earned;
- end with a small set of genuinely related next reads and one product bridge.

### Editorial visual system

Define:

- masthead and article typography;
- illustration or photography art direction;
- figure, chart, pull-quote, code/example, and source-note treatments;
- category and metadata behavior;
- image ratios and crop rules;
- article-to-product transition rules.

The blog may have more editorial expression than the authenticated workspace,
but type, color roles, action language, focus behavior, and brand character
should make them recognizably related.

## Craft bar across all priority surfaces

- **Typography:** test real long content and review current font-wave
  convergence rather than choosing Inter, Geist, Space Grotesk, Instrument
  Serif, or any successor by reflex. One well-resolved sans family may suit a
  dense authenticated workspace; an approved display/body pairing may better
  serve landing or editorial reading. In either case, hierarchy must remain
  clear and the choice must fit the documented design system.
- **Density and layout:** define comfortable and compact modes by task; use
  tighter spacing within related groups and larger separation between zones.
  Balance the first viewport, avoid unexplained dead columns, and do not make
  every screen uniformly airy or uniformly compressed.
- **Surfaces:** use containment only when an object or interaction boundary is
  real. Reject thick side-tab borders on rounded elements,
  hairline-border-plus-wide-shadow treatments, nested or identical card grids,
  extreme card radii, and a reflex cream/beige palette.
- **Icons:** use one coherent family and label ambiguous actions.
- **Imagery:** every image must prove, teach, orient, or express an intentional
  editorial viewpoint; placeholder shape assemblies are not a substitute.
- **Motion:** show causality, preservation, state change, or completion; reject
  decorative pulses, bounce/elastic easing, layout-property animation, and
  hover image transforms unless a documented interaction job requires them.
- **States:** loading, empty, failure, stale, conflict, and success receive the
  same authorship as the happy path.
- **Copy:** literal controls, specific explanations, restrained coaching, and
  no redundant labels, generic buzzwords, manufactured aphorisms, “theater”
  framing, or repeated em-dash cadence.

This brief routes rather than duplicates the full catalog. Apply the
cross-surface taxonomy and contextual exceptions in
`03-anti-slop-and-cohesion-gate.md`, then collect the source-classified
Personalized CLI, CLI, Browser, LLM-only, accessibility, and user-task evidence
required by `05-validation-and-iteration-protocol.md`.

## Recommended redesign order

1. Shared shell and dashboard information architecture.
2. Resume Workshop plus tailored-draft evidence workbench.
3. Applications plus Recruiter triage and shared record grammar.
4. Interview Coach focused-practice mode.
5. Networking relationship-history mode.
6. Landing page using the now-proven product interaction language.
7. Blog index, topic, article, and editorial visual system.
8. Profile/progress, onboarding, extension, and supporting account surfaces.

This sequence lets the public identity emerge from a credible product language
instead of choosing a marketing aesthetic first and forcing the application to
match it.
