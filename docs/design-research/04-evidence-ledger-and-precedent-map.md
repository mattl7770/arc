# Evidence ledger and precedent map

Date: 2026-07-28

## Why this exists

The first research pass established sound principles, but principles alone can
still produce generic work. This document adds two controls:

1. claims are weighted by evidence strength and freshness; and
2. external precedents are translated into CareerPigeon-specific design
   lessons instead of copied or averaged into a familiar SaaS template.

Current CareerPigeon screens remain excluded as visual precedents. They may be
used to confirm product responsibilities and states only.

## Evidence hierarchy

| Tier | Source type | Appropriate use | Not sufficient for |
|---|---|---|---|
| A | Standards, regulators, court decisions, official platform requirements, NIST/W3C guidance | Conformance baselines, legal/current-status notes, platform constraints, high-trust interaction requirements | Choosing a visual style by itself |
| B | Peer-reviewed research, established human-AI guidance, first-party product/design-system documentation | Behavioral principles, interaction patterns, accessibility implementation, product-pattern precedents | Claiming a pattern is universally optimal |
| C | Commercial UX research, product examples, vendor help documentation | Design hypotheses, comparative precedents, task-specific pattern translation | Mandatory requirements or causal claims without corroboration |
| D | Preprints, practitioner critiques, pattern catalogs, essays | Vocabulary, emerging risks, anti-slop heuristics, questions to test | Standards, legal claims, or proof that a visual treatment is harmful |

Operating rules:

- A Tier D “AI slop” tell is a review prompt, not a ban.
- A Tier C product pattern is a precedent, not proof of user fit.
- A Tier A accessibility criterion is a baseline, not evidence that the whole
  experience is usable.
- CareerPigeon-specific recommendations should normally combine at least one
  direct user/job rationale with a Tier A or B source and a realistic task
  test.
- When sources conflict, record the conflict. Do not silently choose the source
  that supports the preferred visual direction.

## Dated Tier D source entry: Impeccable slop catalog

| Field | Ledger entry |
|---|---|
| Checked | 2026-07-28 |
| Exact source | [https://impeccable.style/slop/](https://impeccable.style/slop/) |
| Evidence tier | **D — practitioner pattern catalog** |
| Direct page claims | The page catalogs 64 patterns. It says its detector covers 59 enabled rules across source and rendered pages, while five broader judgments remain in `/impeccable critique`. |
| Detection taxonomy | **Personalized CLI** checks documented design-system drift. **CLI** rules are deterministic from source files. **Browser** rules are deterministic but require rendered layout. **LLM only** means no deterministic detector and requires contextual critique. The catalog also distinguishes “AI slop” signatures from general “Quality” defects. |
| Appropriate use | Use the deterministic checks as repeatable implementation and rendered-layout evidence; use the broader judgments as prompts for independent contextual review. Translate relevant findings through CareerPigeon’s actual task, state, accessibility, and product-truth contracts. |
| Limitations | This is not a peer-reviewed taxonomy or proof that every flagged treatment is harmful. A detected pattern does not establish user impact, product fit, or whether a deliberate exception is justified. The catalog and counts may change. |
| Freshness and recheck | Reopen the exact source at the start of each visual-design batch and before adding, removing, or reclassifying an anti-slop veto. Record the check date and current detector/judgment counts, then rerun the relevant personalized CLI, CLI, Browser, and contextual-review evidence described in `05-validation-and-iteration-protocol.md`. |

## Freshness and source-integrity rules

| Claim class | Re-check cadence | Required check |
|---|---|---|
| Law, regulation, platform policy, billing, privacy | Before every implementation or publication decision | Confirm current official status and jurisdiction; date the note |
| AI capability, model behavior, AI platform guidance | At the start of each design batch | Confirm the interaction still matches actual product capability and data use |
| Product precedent | Before using it in a design critique | Open the current product or official documentation; patterns change |
| Web standards and browser requirements | At least per major release cycle | Confirm criterion level, exceptions, and supported testing method |
| Practitioner and anti-slop heuristics | Treat as provisional | Triangulate with user evidence; never promote to a rule by repetition |

Known correction from the first pass: the FTC’s 2024 amended Negative Option
Rule was vacated by the Eighth Circuit on July 8, 2025. “Cancellation should be
at least as easy and legible as sign-up” remains a CareerPigeon trust standard,
not a claim that the vacated rule is current federal law.
[Eighth Circuit opinion](https://ecf.ca8.uscourts.gov/opndir/25/07/243137P.pdf),
[FTC federal-court report](https://www.ftc.gov/system/files/ftc_gov/pdf/2025-12-Final-Public.pdf)

WCAG 2.2 AA Success Criterion 2.5.8 is also more precise than “every target must
be 24 by 24 CSS pixels.” It permits spacing, equivalent-control, inline,
user-agent, and essential exceptions. CareerPigeon should generally use
24-by-24 as an internal minimum and larger touch targets for primary controls,
while testing conformance against the actual criterion.
[W3C target-size explanation](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

## How to use precedents

For each precedent:

1. inspect the live product or its current first-party documentation;
2. name the user problem the pattern solves;
3. isolate the transferable interaction or hierarchy;
4. state what must not be copied;
5. test the translated pattern with CareerPigeon content, states, and users.

Do not blend the visual averages of Linear, Notion, Stripe, GitHub, and GOV.UK.
That produces exactly the polished, generic “design by references” result this
research is intended to prevent.

## Screen-by-screen precedent translations

| CareerPigeon surface | Precedent to inspect | Transfer | Do not copy |
|---|---|---|---|
| Authenticated shell and dashboard | [Carbon dashboards](https://carbondesignsystem.com/data-visualization/dashboards/), [Asana project views](https://asana.com/features/project-management/project-views) | Operational hierarchy, personal work queue, stable orientation, metrics that route to decisions | Enterprise-dashboard density, issue-management vocabulary, a generic KPI-card wall |
| Auth and onboarding | [GOV.UK question pages](https://design-system.service.gov.uk/patterns/question-pages/), [Apple onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding) | One decision at a time, explain why information is needed, defer optional setup, teach in context | Government-service aesthetics, long tours, forced profile completion |
| Resume Workshop | [Google Docs suggestions](https://support.google.com/docs/answer/6033474), [GitHub pull-request review](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request) | Preserve the original, expose changes at the smallest useful unit, support accept/reject/comment, track review progress | Code-review language, noisy markup, collaboration features the product does not have |
| Tailored draft review | Google Docs and GitHub review precedents above, plus [Microsoft HAX correction](https://www.microsoft.com/en-us/haxtoolkit/guideline/support-efficient-correction/) | Evidence-linked diffs, selective correction, restore, explicit approval before export | A single “regenerate” escape hatch or undifferentiated confidence scores |
| Interview Coach | [Google PAIR explainability](https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/), [Microsoft HAX explanations](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-why-the-system-did-what-it-did/) | Keep practice primary; connect feedback to transcript evidence and a rubric; separate observation, inference, and advice | Chatbot chrome as the whole experience, personality judgments, analytics during active practice |
| Applications | [LinkedIn Job Tracker](https://www.linkedin.com/help/linkedin/answer/a8684146), [Notion views](https://www.notion.com/help/views-filters-and-sorts) | Small meaningful stage set; list and board over one dataset; notes, filters, and follow-up context | Copying an ATS, exposing every possible status, duplicating records between views |
| Recruiter intake and imported opportunities | [Linear Triage](https://linear.app/docs/triage) | Keep unreviewed opportunities outside active work; accept, dismiss, duplicate, or snooze with context preserved | Issue-tracker appearance, automatic acceptance, unexplained AI routing |
| Networking | Relationship history and reviewed-draft principles in [LinkedIn networking guidance](https://www.linkedin.com/business/talent/blog/talent-acquisition/how-to-grow-linkedin-network) and Google Docs suggestions | Put relationship context before generated wording; retain human authorship and explicit send control | Sales-CRM pressure, engagement scoring, auto-send, “network growth” vanity metrics |
| Profile, ranks, and progress | [Duolingo’s streak experiment](https://blog.duolingo.com/improving-the-streak/) as a behavior-mechanics case, contrasted with the anti-pressure requirements in `02` | Make progress legible, reversible, and tied to meaningful work; normalize pauses | Streak loss, public comparison, shame, ornamental XP without a user decision |
| Upgrade and cancellation | [Stripe customer portal](https://docs.stripe.com/customer-management) | Clear current plan, renewal, invoices, effective dates, immediate or period-end cancellation, explicit outcome | Stripe’s visual identity, retention obstruction, treating vendor behavior as legal advice |
| Landing and pricing | [Baymard on showing SaaS UI](https://baymard.com/blog/highlight-saas-ui), [Baymard SaaS guidance](https://baymard.com/blog/saas-website-ux-best-practices) | Show a concrete product artifact and workflow; make pricing a decision surface | Formulaic centered hero, invented social proof, generic feature-card choreography |
| Blog and trust pages | [GOV.UK content maintenance](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/plan-manage-content/manage-existing-govuk-content/), [Google Article data](https://developers.google.com/search/docs/appearance/structured-data/article) | Visible authorship, sources, dates, limits, corrections, and purposeful related navigation | Government editorial styling, SEO-first prose, excessive product CTAs |
| Privacy, terms, and public 404 | [GOV.UK personal-information guidance](https://www.gov.uk/service-manual/design/collecting-personal-information-from-users), [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Plain-language orientation, scannable legal reading, contextual data explanations, and explicit recovery routes | Fake simplification of governing terms, novelty 404s, or redirecting every dead route to the home page |
| Chrome extension | [Chrome Web Store best practices](https://developer.chrome.com/docs/webstore/best-practices), [Chrome privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) | Narrow purpose, exact permission explanation, preview-correct-save sequence, compact trustworthy states | Miniaturizing the full SPA, decorative onboarding, vague “works on this page” claims |

## Visual-language guardrails

These are constraints for visual exploration, not a finished art direction.

### Hierarchy and composition

- Start from the dominant object and decision on each screen: a work queue, a
  draft change, an interview exchange, an application record, or an article.
- Use shared layout primitives, but let reading, editing, triage, practice, and
  comparison produce visibly different compositions.
- Prefer spacing, grouping, alignment, and type hierarchy before adding
  containers. A card is warranted when the content has a real boundary or
  action model.

### Typography

- Choose a highly legible UI family and, only if it adds a deliberate editorial
  voice, a complementary display or reading family.
- Define type roles by purpose rather than by page: navigation, task title,
  section, record label, body, evidence, status, metadata, and editorial prose.
- Test long job titles, company names, resume bullets, source annotations,
  article headings, and error text before approving the scale.

### Color, surface, and state

- Choose the brand palette through comparative visual directions, not from a
  generic “career growth” color association.
- Reserve semantic roles for action, selection, success, warning, failure,
  uncertainty, and evidence. Never make the brand hue carry every state.
- Use borders, tonal shifts, and whitespace before defaulting to elevation.
  Shadows and gradients need a named job.

### Imagery, iconography, and motion

- Prefer real product artifacts, editorial diagrams, or carefully directed
  illustration over generic people-at-laptops, floating 3D objects, AI brains,
  sparkles, rockets, targets, and growth arrows.
- Use one coherent icon family. Pair unfamiliar or consequential icons with
  labels.
- Animate transitions that communicate causality, progress, preservation, or
  completion. Do not animate merely to make the product feel “alive.”

### Product-specific signature

Explore one restrained visual motif based on CareerPigeon’s real evidence
chain:

`career facts -> tailored artifact -> action -> response -> learning`

The motif may inform relationships, provenance, or transitions. It must not
become a decorative line, pigeon pattern, or progress metaphor stamped onto
every page.

## Visual-direction requirement

Before selecting a final style, create three genuinely different directions
using the same representative content and states:

1. calm editorial workbench;
2. precise operational workspace;
3. warm guided practice.

These are starting hypotheses, not three themes to blend. Each direction must
include the dashboard, one dense workflow, one AI review state, one public
page, one mobile/compact state, and one failure or empty state. Compare them
using `05-validation-and-iteration-protocol.md`; select or reject whole
principles deliberately rather than averaging the three into a safe midpoint.
