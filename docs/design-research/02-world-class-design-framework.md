# World-class design framework for a CareerPigeon overhaul

Date: 2026-07-27

## North star

CareerPigeon should feel like a calm, intelligent career-search workbench:
clear enough for a first-time user, deep enough for repeated work, honest about
uncertainty, and specific enough that it could not be mistaken for a generic AI
SaaS template.

The product’s existing north star is useful here: professional tool first,
motivational second; private rather than social; grounded in real career facts;
and designed to make the search visible and rewarding. The overhaul should
strengthen that identity through task design and product-specific detail, not
through decorative theming.

## The 10 principles

### 1. Design the next useful action

Every major surface should answer, in order:

1. Where am I?
2. What matters now?
3. What can I do next?
4. What happens if I defer, undo, or change my mind?

The dashboard is not a museum of metrics. Each metric, chart, badge, and
notification must either explain a decision, expose meaningful progress, or
route to an action.

### 2. Use one career-search model, many focused views

The modules should share a vocabulary for roles, companies, contacts, facts,
drafts, applications, sessions, follow-ups, and outcomes. The user should not
have to reconstruct relationships between modules from scratch.

That does not mean every page looks identical. A tailored-draft editor,
pipeline, interview room, and long-form article have different task grammars.
They should share foundational tokens, navigation logic, state language, and
interaction expectations while preserving their own useful composition.

### 3. Make trust visible at the moment of consequence

Before AI generation, show the input boundary. Before approval, show evidence
and changes. Before export or send, make the final consequence explicit. Before
an extension save, show exactly what will be stored. Before payment, show price,
renewal, limits, and cancellation.

Trust should be an interaction pattern, not a footer claim.

### 4. Make AI output inspectable, editable, and contestable

The default lifecycle is:

`generate -> inspect -> edit -> approve -> export/send`

“Why this changed,” “what evidence supports this,” “what is missing,” “restore
original,” “regenerate this part,” and “continue manually” should be ordinary
controls, not support articles.

### 5. Progressive disclosure without concealment

Put the frequent decision in front of the user. Keep advanced controls close
enough to find and explicit enough to understand. Do not hide material facts,
data use, limits, or irreversible consequences behind a clever interaction.

### 6. Treat state design as design

Every data-bearing surface needs a designed response for:

| State | Required answer |
|---|---|
| First use | What is this, why does it matter, and how do I start? |
| Loading | What is loading, what can I still do, and is progress known? |
| Partial data | What is available now and what is still pending? |
| No results | Why is there nothing here, and how do I broaden or reset? |
| Completed | What did I accomplish and what is the next useful option? |
| Permission/gating | Why is this unavailable and what can I do about it? |
| Validation error | Which input is wrong and how do I correct it? |
| System failure | What failed, is my work safe, and can I retry or continue manually? |
| Save conflict | What changed, which version is mine, and how do I resolve it? |
| Destructive action | What will be removed, can I undo it, and what remains linked? |
| Success | What durable change happened and where can I find it? |

### 7. Use progression to reinforce agency, not pressure

CareerPigeon can make effort visible without turning a job search into a
streak-punishment system. Emphasize reviewed matches, strong applications,
useful practice, replies, interviews, and reflection. Make pause, snooze, reset,
and private visibility normal.

### 8. Make the public and product experiences one trust story

Public pages should explain outcomes and limitations. Blog articles should
teach and substantiate. Onboarding should connect the promise to a first
artifact. The product should return users to useful guidance when context calls
for it. Pricing, privacy, and extension permissions should be legible before
commitment.

### 9. Build one foundation and adapt it by surface

Define a versioned design foundation with semantic tokens for:

- color roles and contrast;
- typography hierarchy and readable measure;
- spacing and density;
- surface, border, and elevation roles;
- focus, selection, validation, loading, and disabled states;
- motion and reduced-motion behavior;
- responsive layout modes;
- icon and illustration rules;
- content voice and action labels.

Use the same names and meanings in the SPA, blog, and extension. Do not force a
blog article, interview session, or extension popup into the same component
silhouette.

### 10. Make specificity the antidote to AI slop

Before implementation, each screen needs a human-authored answer to:

- What unique user job does this screen own?
- What information deserves the strongest visual priority, and why?
- What product-specific object or relationship makes this screen different?
- What is the one signature interaction or composition that earns its place?
- Which visual elements are deliberately absent because they would add noise?

If the answer is “a modern dashboard with cards, gradients, and AI insights,”
the design brief is not ready.

## Screen-level design contracts

### Landing page

- Lead with the job and outcome for early-career candidates, not an internal
  feature inventory.
- Tell a progressive story: problem, workflow, concrete output, evidence,
  limits, next action.
- Show real product behavior or a truthful prototype; never use invented
  activity data, testimonials, or social proof.
- Let the visual signature come from CareerPigeon’s own career-search model,
  not a generic “AI” atmosphere.

### Auth and onboarding

- Make the shortest path to a useful first artifact the default.
- Ask one decision at a time; explain why sensitive data is requested.
- Make optional steps explicit; pause/resume must preserve work.
- Teach through the task and provide contextual help later instead of a long
  mandatory product tour.
- Keep errors specific, local, recoverable, and field-preserving.

### Dashboard

- Put a next-action queue above passive reporting.
- Use progress as context for work, not as a competing destination.
- Separate “needs attention,” “recently changed,” and “long-term progress.”
- Route every meaningful block to a focused screen with context preserved.
- Treat no friends, no applications, and no activity as honest states with one
  helpful next action, not fake filled-in charts.

### Resume Workshop and tailored draft editor

- Make the authority chain visible: source material -> approved facts -> draft.
- Show what changed at claim level and why.
- Let the user accept, edit, reject, restore, or continue manually at the
  smallest useful unit.
- Flag missing evidence instead of filling the gap with confident prose.
- Preserve edits across generation failure, refresh, retry, or version change.
- Treat export and acceptance as consequential checkpoints, not casual button
  clicks.

### Interview Coach

- Orient the user to the session goal, mode, and expected feedback before the
  first question.
- Make voice optional with a clear text fallback and explicit recording state.
- Keep the conversation, transcript, rubric, and evidence connected without
  turning the active practice space into an analytics dashboard.
- Give feedback that distinguishes observed behavior, interpretation, and advice.
- Make critique challengeable; show the excerpt or rubric behind it.
- Preserve the session and offer retry/manual recovery when voice or AI fails.

### Applications

- Use a small set of human-readable stages whose names imply the next action.
- Offer list and board views over one underlying dataset if both support real
  user tasks.
- Keep search, filters, sort, counts, and bulk actions near the working set.
- Make follow-up, waiting, stale, and snoozed states visible without shaming.
- Open detail in a way that preserves the user’s context and selection.

### Networking

- Treat each contact as a relationship record, not a CRM lead.
- Put context and history before generated copy.
- Show why a draft was suggested and what source information it used.
- Require human review before any message leaves CareerPigeon.
- Support cadence controls, reminders, quiet periods, and snooze.

### Personal Recruiter

- Explain why a role appeared, what evidence supports the fit, and what remains
  uncertain.
- Make dismiss, snooze, save, and “not for me” actions reversible and useful.
- Never present fit as a hiring probability or imply knowledge the system lacks.
- Carry match reasoning into applications and interview preparation when the
  user chooses to continue.

### Profile, ranks, and progress

- Treat profile data as user-owned context, not a completion game.
- Show the quality and meaning of progress rather than only volume.
- Keep private-by-default and pause/reset controls discoverable.
- Avoid public-social patterns, shame mechanics, and ornamental leaderboards.
- Surface missing setup as a clear, optional task list with visible benefit.

### Plans, upgrade, and cancellation

- Make plan comparison scannable and complete.
- State limits, billing period, renewal, effective date, and downgrade behavior
  before commitment.
- Keep the cancellation path at least as easy as sign-up.
- Use retention offers only after the user understands the cancellation choice;
  never obstruct, guilt, or hide the exit.

### Privacy, terms, and public recovery

- Treat privacy and terms as readable decision surfaces, not legal-text dumps:
  use descriptive headings, contents navigation, dates, stable anchors, and
  plain-language summaries without replacing the governing text.
- Link policy claims back to the relevant product moment, especially data
  upload, AI use, extension permissions, deletion, and billing.
- A not-found page should name the problem, avoid blaming the user, and offer a
  small set of useful recovery routes into the product, blog, and support.
- Preserve the requested URL for diagnosis where appropriate; never redirect
  every unknown route to a plausible but unrelated page.

### Marketing, blog, and trust pages

- Organize around user questions and tasks, not internal publishing categories
  alone.
- Make author identity, sources, freshness, limitations, and corrections
  observable.
- Optimize for scanning: descriptive headings, short sections, meaningful links,
  useful figures, and clear related guides.
- Give each article one primary product bridge and a small number of relevant
  next links. Avoid converting every paragraph into a CTA.

### Chrome extension

- Treat the popup as a narrow, high-trust action surface.
- Explain what is read, where parsing happens, and exactly what will be saved.
- Preview extracted fields, allow correction, then require explicit save.
- Keep the extension’s visual language related to the platform but adapted to
  the browser context and its compact interaction budget.

## Anti-slop acceptance tests

Run these tests on every design batch before implementation approval:

1. **Logo-off test:** Without the logo, can a reviewer identify the product’s
   specific job from the hierarchy, content, and interaction model?
2. **Copy substitution test:** If the nouns are replaced with another SaaS
   product’s nouns, does the page still read the same? If yes, it is too generic.
3. **Card deletion test:** Remove half the cards. Does the task become clearer?
   If yes, the cards were carrying decoration, not information.
4. **Real-data test:** Can every visible number, chart, avatar, quote, and status
   be traced to real product data or a clearly labeled example?
5. **State test:** Show first-use, no-results, error, loading, and success states.
   Do they feel designed, specific, and useful rather than blank placeholders?
6. **AI-copy test:** Remove “AI,” “smart,” “seamless,” “personalized,” and
   “empowering.” Does the copy still say something concrete?
7. **Signature test:** Is there one justified, product-specific composition or
   interaction? Are there five decorative “signatures” competing for attention?
8. **Cohesion test:** Across pages, do action labels, spacing, focus behavior,
   state language, tokens, and navigation behave consistently?
9. **Human-edit test:** Does a human designer or writer own the hierarchy,
   content, and final visual decisions, with AI used only as a bounded aid?
10. **Accessibility test:** Keyboard flow, focus, contrast, 200% text resize,
    400% reflow, reduced motion, and screen-reader status communication pass.

## Proposed redesign sequence

### Phase 0 — task and architecture baseline

- Confirm the primary user journeys and the meaning of “progress.”
- Validate navigation labels and cross-module object vocabulary with users.
- Map the state matrix for every screen before visual styling.
- Define metrics for time-to-next-action, first useful artifact, recovery, trust,
  and meaningful progress.

### Phase 1 — shared foundation and shell

- Establish tokens, type hierarchy, spacing/density, surfaces, controls, focus,
  validation, motion, and responsive modes.
- Define shared shell behavior across authenticated SPA, public pages, blog,
  and extension without forcing identical layouts.
- Create a real content voice guide and anti-slop checklist.

### Phase 2 — first-value loop

- Onboarding -> dashboard -> Resume Workshop -> tailored draft review.
- Prove the first useful artifact, evidence/provenance interaction, and state
  recovery before broad visual polish.

### Phase 3 — operational loop

- Applications -> networking -> follow-up and notification surfaces.
- Prove one underlying work model, focused views, filtering, snooze, and
  context-preserving detail.

### Phase 4 — coaching and recommendation loop

- Interview Coach -> Recruiter -> application/interview preparation handoff.
- Prove calibrated AI trust, challengeable feedback, explicit uncertainty, and
  graceful failure.

### Phase 5 — public trust and conversion

- Landing, plan, extension, blog, trust pages, and legal reading surfaces.
- Prove the discover -> understand -> trust -> evaluate -> activate journey.

### Phase 6 — progress, account, and polish

- Profile, ranks, notifications, upgrade/cancellation, cross-surface QA.
- Polish only after task, trust, state, accessibility, and cohesion gates pass.

## Success measures

Design quality should be evaluated with both behavioral and human measures:

- time to first useful artifact;
- time to next useful action after landing on dashboard;
- task completion and recovery success for realistic workflows;
- comprehension of AI evidence, uncertainty, and approval boundaries;
- proportion of generated changes users can explain or correct;
- follow-up completion without notification overload;
- upgrade comprehension and successful cancellation without assistance;
- article-to-product activation and retained use, not just clicks;
- keyboard completion, focus, contrast, zoom/reflow, reduced-motion, and screen
  reader checks;
- qualitative judgment from real users: “this feels like it understands my
  search” versus “this looks like a generic AI tool.”

## Decisions to resolve before visual ideation

No blocking question prevented this research pass. Before choosing a final
visual direction, two decisions will materially affect the work:

1. Is the authenticated workspace desktop-primary with responsive mobile
   support, or must mobile support full first-class workflows?
2. Should the dashboard optimize primarily for next action, job-search health,
   or a deliberate split between an action queue and progress context?

The framework recommends next action as the primary job, with progress as
secondary context. That is a design recommendation, not a settled product
decision.

Do not move directly from this document to production UI. Use the precedent
translations in `04-evidence-ledger-and-precedent-map.md`, then run the
screen-brief, visual-direction, prototype, and validation sequence in
`05-validation-and-iteration-protocol.md`.
