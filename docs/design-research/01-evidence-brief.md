# Evidence brief: exceptional design for CareerPigeon

Date: 2026-07-27

## How to read this

The findings below are forward-looking. They do not grade CareerPigeon’s
current layout, palette, typography, or component choices. They answer what a
world-class product should make easy, trustworthy, and memorable across the
surface inventory in `00-scope-and-screen-inventory.md`.

“Evidence” means the cited source directly supports the practice. “Synthesis”
means a design implication inferred from multiple sources and CareerPigeon’s
product contract.

Sources are not interchangeable. Standards, regulators, peer-reviewed work,
first-party pattern documentation, commercial research, practitioner opinion,
and preprints carry different weight. The operational evidence tiers and
freshness rules are defined in `04-evidence-ledger-and-precedent-map.md`.

## 1. Authenticated workspaces should behave like task systems

The strongest dashboard/workspace pattern is not “show every metric.” It is:
show where the user is, what matters now, what can be done next, and how to
recover when something changes.

- Organize navigation around user jobs and familiar language. Validate labels
  against users’ mental models instead of internal teams or feature ownership.
  [NN/g card sorting](https://www.nngroup.com/articles/card-sorting-definition/),
  [NN/g menu design](https://www.nngroup.com/articles/menu-design/)
- Keep primary navigation and current location visible. Add local orientation
  when a workflow becomes deep.
  [NN/g menu-design checklist](https://www.nngroup.com/articles/menu-design/)
- Give the dashboard an operational job: prioritize work, alerts, recent
  changes, and useful actions. Metrics earn space when they explain a decision
  or lead to an action.
  [IBM Carbon dashboards](https://carbondesignsystem.com/data-visualization/dashboards/),
  [Infor dashboard layout](https://design.infor.com/patterns/page-layouts/dashboard/)
- Match the view to the task: tables for finding/comparing/editing, boards for
  movement through stages, timelines for duration/dependencies, calendars for
  date planning. Prefer multiple views over the same underlying work.
  [NN/g data tables](https://www.nngroup.com/articles/data-tables/),
  [Notion database views](https://www.notion.com/help/views-filters-and-sorts),
  [Asana project views](https://asana.com/features/project-management/project-views)
- Keep search, filters, sort, scope, counts, batch actions, and no-results
  recovery in one coherent system. Make active filters and reset behavior
  visible.
  [NN/g search](https://www.nngroup.com/articles/search-visible-and-simple/),
  [Carbon filtering](https://carbondesignsystem.com/patterns/filtering/)
- Use progressive disclosure for advanced controls, but never hide information
  needed to make a consequential decision.
  [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
- Design empty states as navigation, not decoration. Distinguish first use,
  no results, completed work, no permission, missing configuration, and service
  failure.
  [Carbon empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/),
  [Michelin empty state guidance](https://designsystem.michelin.com/components/empty-state)
- Preserve the working context when opening detail: list position, filters,
  selection, and user edits should survive the transition.
  [Carbon data table](https://carbondesignsystem.com/components/data-table/usage/)

### Synthesis for CareerPigeon

The authenticated home should be designed as a next-action surface over a
career-search work queue. The tracker, networking ledger, tailored drafts,
interview sessions, and recommended roles should feel like different focused
views of one career-search system, not isolated feature destinations.

## 2. AI should earn calibrated trust

AI UX is not a decorative “sparkle” layer. The user should understand what the
system used, what it inferred, what it does not know, and how to correct it.

- Set capability boundaries before generation so users form an accurate mental
  model.
  [Microsoft HAX: performance expectations](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-how-well-the-system-can-do-what-it-can-do/),
  [Google PAIR: mental models](https://pair.withgoogle.com/guidebook-v2/chapter/mental-models/)
- Treat generated text as a draft and define the human review role.
  [IBM AI best practices](https://www.ibm.com/think/insights/ai-best-practices),
  [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)
- Attach provenance to claims and show why an output appeared now. Local,
  input-to-output explanations are more useful than generic “AI reasoning.”
  [Google PAIR explainability and trust](https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/),
  [Microsoft HAX: explanations](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-why-the-system-did-what-it-did/)
- Make uncertainty actionable. “Needs your confirmation” is stronger than a
  precise-looking confidence number with no decision meaning.
  [OpenAI on hallucinations](https://openai.com/index/why-language-models-hallucinate/),
  [Microsoft HAX: performance expectations](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-how-well-the-system-can-do-what-it-can-do/)
- Scale approval friction to consequence. Exporting a resume, accepting a
  claim, or sending an external message requires more explicit review than
  brainstorming.
  [Google PAIR explainability and trust](https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/),
  [NIST human-AI interaction](https://airc.nist.gov/airmf-resources/airmf/appendices/app-c-ai-risk-management-and-human-ai-interaction/)
- Make correction and undo first-class: granular accept/reject, in-place edit,
  selective regeneration, restore-original, and versioning.
  [Microsoft HAX: efficient correction](https://www.microsoft.com/en-us/haxtoolkit/guideline/support-efficient-correction/)
- State the scope and effect of feedback. “Fix this draft” is not the same as
  “change my future experience” or “share product feedback.”
  [Google PAIR feedback and controls](https://pair.withgoogle.com/guidebook-v2/chapter/feedback-controls/)
- Treat failure as recoverable: preserve the last good draft, offer retry or
  manual continuation, and do not silently replace user work.
  [Google PAIR errors and graceful failure](https://pair.withgoogle.com/chapter/errors-failing/),
  [NN/g error-message guidelines](https://www.nngroup.com/articles/error-message-guidelines/)
- Interview feedback should be contestable and grounded in observable evidence,
  not flattering identity judgments. Show the rubric or transcript excerpt and
  allow the user to challenge the assessment.
  [OpenAI Model Spec](https://model-spec.openai.com/),
  [Anthropic disempowerment patterns](https://www.anthropic.com/research/disempowerment-patterns?slug=helpful-honest-harmless-ai)

### Synthesis for CareerPigeon

The product’s AI trust contract should be explicit: the system selects,
reframes, and coaches from approved evidence; it does not turn missing
evidence into invented experience. Every high-consequence AI surface should
support `generate -> inspect -> edit -> approve -> export/send`.

## 3. Job-search workflows need momentum without manipulation

The job search is emotionally uneven and structurally uncertain. Exceptional
design reduces cognitive load and externalizes memory without turning rejection,
rest, or delay into moral failure.

- Get users to a useful first artifact quickly. Ask only for necessary inputs,
  explain why each is needed, and allow one decision per step.
  [GOV.UK form structure](https://www.gov.uk/service-manual/design/form-structure),
  [GOV.UK question pages](https://design-system.service.gov.uk/patterns/question-pages/)
- Make setup progressive, resumable, reversible, and optional where possible.
  Teach through the task instead of making users memorize a tour.
  [Apple onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
- Separate incoming opportunities from active work. A triage queue with accept,
  decline, duplicate, and snooze is clearer than silently mixing unprocessed
  imports into active work.
  [Linear triage](https://linear.app/docs/triage)
- Use a small set of comprehensible application stages. Status should answer
  “what happens next?” rather than reproduce every internal ATS transition.
  [LinkedIn Job Tracker](https://www.linkedin.com/help/linkedin/answer/a8684146)
- Make deferral first-class. Snooze should preserve context and return work at
  a chosen time or meaningful event.
  [Linear triage](https://linear.app/docs/triage)
- Support networking with context and user review. The product may suggest a
  reason or draft, but it should never silently send a message.
  [LinkedIn networking guidance](https://www.linkedin.com/business/talent/blog/talent-acquisition/how-to-grow-linkedin-network)
- Explain recommendations with relevant inputs, limitations, and controls;
  do not present “fit” as a hiring probability.
  [LinkedIn recommendations](https://www.linkedin.com/help/linkedin/answer/a512279),
  [NIST AI explainability](https://airc.nist.gov/airmf-resources/airmf/3-sec-characteristics/)
- Research has associated perceived job-search progress with subsequent search
  intensity. It does not establish a specific product metric set.
  [Journal of Vocational Behavior study](https://www.sciencedirect.com/science/article/pii/S0001879118300757)
- **CareerPigeon synthesis:** meaningful progress may include reviewed matches,
  strong applications, replies, interviews, and useful conversations. Validate
  those meanings with users instead of treating product activity as progress.
- Retention mechanics such as streaks can change return behavior. That evidence
  does not prove they support user wellbeing or job-search outcomes.
  [Oxford review of behavior-change apps](https://academic.oup.com/iwc/article/38/3/447/7760010),
  [Duolingo streak experiment](https://blog.duolingo.com/improving-the-streak/)
- **CareerPigeon synthesis:** keep progression flexible and test whether pause,
  snooze, private visibility, or resets better support agency than streak loss
  or leaderboard pressure.
- Make upgrade and cancellation equally legible and easy. Explain effective
  dates, limits, downgrade behavior, and cancellation outcomes before asking
  for commitment.
  [Stripe customer portal](https://docs.stripe.com/customer-management),
  [FTC dark-pattern report](https://www.ftc.gov/news-events/news/press-releases/2022/09/ftc-report-shows-rise-sophisticated-dark-patterns-designed-trick-trap-consumers)

Legal-currentness note: the FTC’s 2024 amended Negative Option Rule, commonly
called “Click-to-Cancel,” was vacated by the Eighth Circuit on July 8, 2025.
It must not be cited as current federal law. The underlying equal-ease
cancellation principle remains a deliberate CareerPigeon trust standard, while
actual legal requirements must be checked for the applicable jurisdiction at
implementation time.
[Eighth Circuit opinion](https://ecf.ca8.uscourts.gov/opndir/25/07/243137P.pdf),
[FTC federal-court report](https://www.ftc.gov/system/files/ftc_gov/pdf/2025-12-Final-Public.pdf)

## 4. Public product, blog, and extension should be one trust story

- Lead with the user’s job and outcome. The first screen should answer what the
  product is, who it is for, what the user gets, and what happens next.
  [GOV.UK user needs](https://www.gov.uk/service-manual/user-research/start-by-learning-user-needs)
- Use a progressive story: problem -> how it works -> concrete product output
  -> relevant use case -> evidence and limitations -> action.
  [Baymard: show SaaS UI](https://baymard.com/blog/highlight-saas-ui)
- Treat pricing as a decision tool. Show plan definitions, limits, billing
  frequency, renewal terms, and cancellation before commitment.
  [Baymard SaaS UX](https://baymard.com/blog/saas-website-ux-best-practices),
  [FTC dark patterns](https://www.ftc.gov/news-events/news/press-releases/2022/09/ftc-report-shows-rise-sophisticated-dark-patterns-designed-trick-trap-consumers)
- Explain privacy at the point where data is requested or used, not only in a
  long policy.
  [GOV.UK personal information](https://www.gov.uk/service-manual/design/collecting-personal-information-from-users)
- Treat the extension listing and in-product popup as a permission/trust
  surface: narrow purpose, exact permissions, and accurate data boundaries.
  [Chrome Web Store best practices](https://developer.chrome.com/docs/webstore/best-practices),
  [Chrome privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- **CareerPigeon synthesis:** preview extracted fields, allow correction, then
  require explicit save.
- Organize the blog around user questions and journeys, with topic hubs,
  breadcrumbs, contextual links, and prioritized related content.
  [GOV.UK related navigation](https://design-guide.publishing.service.gov.uk/components/related-navigation/),
  [GOV.UK service navigation](https://design-system.service.gov.uk/patterns/navigate-a-service/)
- Make articles scannable and verifiable: descriptive headings, meaningful
  links, author identity, published/updated/reviewed dates, primary sources,
  correction paths, and visible limits.
  [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/),
  [Google Article structured data](https://developers.google.com/search/docs/appearance/structured-data/article),
  [GOV.UK content maintenance](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/plan-manage-content/manage-existing-govuk-content/)

### Synthesis for CareerPigeon

The public experience should move users through:

`discover -> understand -> trust -> evaluate -> activate -> continue`

An article, extension page, landing page, pricing page, or product onboarding
step should make the next transition specific and unsurprising.

## 5. Foundations are product quality, not polish

- Set WCAG 2.2 AA as the release baseline across SPA, blog, and extension.
  [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- Make keyboard behavior complete and predictable; use semantic HTML first and
  WAI-ARIA patterns only where needed.
  [WAI-ARIA keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
- Treat focus as a first-class state; never obscure it with sticky navigation or
  overlays.
  [WCAG focus](https://www.w3.org/TR/WCAG22/#focus-visible),
  [GOV.UK focus states](https://design-system.service.gov.uk/get-started/focus-states/)
- Design responsive modes around content constraints, including 320 CSS px and
  400% zoom reflow.
  [WCAG reflow](https://www.w3.org/TR/WCAG22/#reflow),
  [Material canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview)
- Use readable type, meaningful hierarchy, relative units, and a constrained
  reading measure. GOV.UK’s guidance uses roughly 75 characters per line as a
  useful long-form reference.
  [GOV.UK layout](https://design-system.service.gov.uk/styles/layout/),
  [WCAG text spacing](https://www.w3.org/TR/WCAG22/#text-spacing)
- Meet minimum contrast and never use color alone for status, selection, errors,
  or progress.
  [WCAG contrast](https://www.w3.org/TR/WCAG22/#contrast-minimum),
  [WCAG use of color](https://www.w3.org/TR/WCAG22/#use-of-color)
- Respect reduced motion and keep motion purposeful, short, and interruptible.
  [web.dev accessibility](https://web.dev/learn/design/accessibility),
  [WCAG animation from interactions](https://www.w3.org/TR/WCAG22/#animation-from-interactions)
- Use semantic design tokens for roles, not scattered raw values. Share the
  foundation across SPA, blog, and extension while allowing each surface to
  retain an appropriate shell.
  [IBM Carbon themes and tokens](https://carbondesignsystem.com/elements/themes/overview/),
  [Apple design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)
- Make state matrices and performance budgets part of the system. A useful web
  target is LCP <= 2.5s, INP <= 200ms, CLS <= 0.1 at the 75th percentile.
  [Core Web Vitals thresholds](https://web.dev/articles/defining-core-web-vitals-thresholds)

## 6. Anti-slop research: what we can responsibly claim

“AI slop” is a useful industry term, but it is not yet a single established
design-science taxonomy. The strongest available support is a combination of
human-centered design standards, emerging empirical work, and practitioner
pattern catalogs. We should use the term as an acceptance-bar shorthand, not
pretend every visual tell is a proven causal usability failure.

- NIST defines human-centered design as focusing interactive systems on users,
  their needs, and their requirements.
  [NIST human-centered design](https://www.nist.gov/itl/iad/human-centered-technologies/human-factors-human-centered-design)
- A 2026 empirical study found AI-generated prototypes could be usable and
  efficient while rating neutral or negative on originality and innovation,
  suggesting functional competence does not equal distinctive design.
  [Usable but Conventional](https://arxiv.org/abs/2605.15124)
- Industry critiques consistently identify the same failure cluster: purple or
  blue gradients, glassmorphism, repeated rounded cards, generic dashboards,
  centered hero formulas, decorative icons, and copy that could belong to any
  product. These are useful visual heuristics, not universal bans.
  [SmoothUI anti-slop analysis](https://smoothui.dev/blog/ai-design-slop),
  [Built In on the AI slop era](https://builtin.com/articles/ai-design-slop-era),
  [Impeccable slop catalog](https://impeccable.style/slop/)
- Emerging research on generative design systems describes the underlying risk
  as reinforcement of dominant layout and style conventions; product-specific
  intent must interrupt the average.
  [Systematic review of generative no-code design](https://www.mdpi.com/2073-431X/15/4/238),
  [AI-inspired UI design](https://arxiv.org/abs/2406.13631)

### Anti-slop operating definition

For this project, a screen is anti-slop when its hierarchy, language, visual
signature, and interaction details are justified by the user’s actual job and
CareerPigeon’s specific product model. It should remain recognizable without
the logo because the content, states, and interaction grammar belong to this
product.

### Anti-slop signals to reject

- generic “modern / seamless / empower / unlock / level up” copy with no
  product-specific claim;
- invented metrics, social proof, testimonials, avatars, or trend lines;
- identical hero + three-card + CTA choreography repeated across public pages;
- card grids used as the default answer for every information type;
- decorative gradients, glass, glow, oversized icons, sparkles, or rounded pills
  that do not explain hierarchy or state;
- every page using the same visual density regardless of task complexity;
- AI copy that uses symmetrical phrases, adjective stacks, fake confidence, or
  generic “personalized” claims;
- empty, loading, error, and success states treated as afterthoughts;
- visual novelty added after the fact instead of a deliberate product-specific
  composition chosen before implementation.

These are acceptance heuristics. Each must be tested against purpose: a visual
device is allowed when it carries product meaning, helps orientation, or makes
an interaction clearer.
