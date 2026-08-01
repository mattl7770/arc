# CareerPigeon design-research scope and screen inventory

Date: 2026-07-27

## Research boundary

This document is an inventory of the product jobs and surfaces CareerPigeon
needs to support. It is not a visual critique, benchmark, or recommendation
based on the current implementation. The redesign research treats the current
screens as a list of responsibilities only, then compares those
responsibilities with external best practices and exceptional product
patterns.

## High-level product model

CareerPigeon is a job-search workspace. It combines a public product and
editorial layer with an authenticated workspace for preparing applications,
practicing interviews, tracking applications, building relationships, and
maintaining career/profile context. A Chrome extension captures applications
from Gmail into the tracker.

The primary user journey is:

`understand the product -> create an account -> set up career context -> prepare -> apply -> follow up -> practice -> learn -> adjust`

The redesign should treat that as one coherent journey with distinct focused
work surfaces, not as a collection of unrelated pages.

## Surface inventory

### Public product and acquisition

| Surface | Route / source | User job | Important states or transitions |
|---|---|---|---|
| Landing page | `/` · `frontend/src/pages/LandingPage.jsx` | Understand the promise, what the modules do, and start | First visit, feature exploration, CTA to registration, theme choice, responsive/mobile reading |
| Authentication | `/auth` · `AuthPage.jsx` | Sign in or create an account | Login/register mode, validation, password visibility, curated errors, redirect after auth, plan query carry-through |
| Plans / pricing | `/plan` · `PlanPage.jsx` | Compare free and paid value, choose billing period, start | Monthly/quarterly/annual selection, plan comparison, registration handoff, pricing confidence |
| Chrome extension page | `/extension` · `ExtensionPage.jsx` | Understand the Gmail capture workflow and install | Gmail-only explanation, browser-local parsing/privacy explanation, install CTA, FAQ |
| Chrome extension popup/runtime | `extension/entrypoints/popup/*` · `extension/wxt.config.ts` | Preview a captured application, correct extracted fields, and explicitly save it to the tracker | Unsupported page, authentication, parsing/loading, partial extraction, correction, duplicate, save, error/retry, compact viewport |
| Privacy and terms | `/privacy`, `/terms` | Decide whether the product’s data and contractual boundaries are acceptable | Long-form reading, contents navigation, legal links, contact paths, mobile readability |
| Blog index | `/blog` (static build) · `frontend/blog/src/blog-index.njk` | Find useful job-search guidance | Latest post, topics, more guides, trust links, RSS, transition into product |
| Blog category | `/blog/<category>` · `category.njk` | Browse a focused body of guidance | Empty category, published list, category context, breadcrumbs, article return path |
| Blog article | `/blog/<slug>` · `post.njk` | Read, understand, verify, and act on a guide | Breadcrumbs, byline/freshness, takeaways, figures with “show numbers”, long-form sections, related guides, product bridge |
| Trust pages | `/blog/about`, `/editorial-standards`, `/methodology`, `/correction-policy` | Evaluate who publishes, how claims are sourced, and how corrections work | Cross-linking, source/methodology explanation, visible correction/freshness model |
| Public 404 | `/404` / static artifact | Recover from a dead or mistyped public URL | Helpful navigation back to product/blog, no misleading dead end |

Current content inventory: three published blog posts, three topic categories,
and four trust pages. The content model also supports drafts, related guides,
takeaways, source-backed figures, canonical URLs, and freshness metadata.

### Authenticated workspace

| Surface | Route / source | User job | Important states or transitions |
|---|---|---|---|
| Onboarding | `/onboarding` · `OnboardingPage.jsx` | Establish target role, resume, skills, and initial context | New account, progressive setup, upload/import, validation, resumability, completion, skip/defer decisions |
| Dashboard | `/dashboard` · `DashboardPage.jsx` | See current career-search state and choose the next useful action | Loading/empty/partial data, career level and XP, four skill tracks, quests, XP activity, friends/leaderboard, quick actions, next-step prioritization |
| Resume Workshop | `/resume` · `ResumeWorkshopPage.jsx` and `resumeWorkshop/*` | Import, review, edit, and maintain the Master resume / fact context | Import states, parser summary, review, structured editing, Fact Bank, Resume Hub, versions, save/conflict/recovery, deletion/recently deleted |
| Tailored draft editor | `/tailor/drafts/:draftId` · `TailorDraftEditorPage.jsx` | Review and approve a role-specific draft before use | Original vs suggestion, per-change explanation, accept/edit/reject, missing-fact handling, save, export/finish, recovery/error |
| Interview Coach | `/interview-coach` · `InterviewCoachPage.jsx` | Practice a mock interview and improve answers over multiple sessions | Session setup, opener, answer capture, voice/text modes, active conversation, quota, errors/retry, session history/archive/delete, end-of-session feedback/report |
| Applications | `/applications` · `ApplicationsPage.jsx` | Maintain the application pipeline and decide what to do next | Kanban/list views, stages, create/edit/delete, search/filter/pagination, job links, ATS/job-fit context, reminders/follow-up, empty/loading/error states |
| Networking | `/networking` · `NetworkingPage.jsx` | Track relationships and prepare personal outreach | Contact ledger, interaction history, draft generation/editing, status/cadence, notifications, empty and privacy-sensitive states |
| Personal Recruiter | `/recruiter` · `RecruiterPage.jsx` | Review recommended roles and act on fit-ranked opportunities | Cohort gating, recommendation feed, fit explanation, accept/dismiss, shortlist, run status, no-results, stale/retry states |
| Profile and progress | `/profile` · `ProfilePage.jsx` | Maintain personal/career context and understand progress | Basic profile, skills/ranks, friends, notifications, recruiter profile where enabled, Resume Workshop readiness, save conflicts, privacy/account controls |
| Upgrade and subscription | `/upgrade` · `UpgradePage.jsx` | Compare entitlements, start or manage a plan, cancel | Current plan, billing period, checkout handoff, success/failure, cancellation/retention flow, period-end state, recovery |

### Cross-cutting workspace surfaces

The authenticated pages share a shell with navigation, module visibility and
gating, notifications, theme preference, responsive sidebar/mobile navigation,
profile menu, upgrade prompts, gamification context, and loading/bootstrap
failure handling. Those should be researched as one system because they shape
every module’s discoverability, orientation, and sense of continuity.

### Adjacent / operator surfaces

The codebase also contains `/admin` and `/admin-flows`. They are operator
surfaces rather than ordinary user product screens; they are excluded from the
first redesign research pass unless the scope expands to internal operations.

## What was actually inspected

- Route table: `frontend/src/App.js`.
- Authenticated shell and navigation: `frontend/src/components/Layout.jsx`.
- Page-level responsibilities: `frontend/src/pages/AGENTS.md` plus the route page files.
- Blog build and content model: `frontend/blog/README.md`, `frontend/blog/AGENTS.md`,
  `frontend/blog/src/*`, `frontend/blog/scripts/lib/blog-data.cjs`, and
  `frontend/content/blog/*`.
- Local public screens in a browser: `/`, `/extension`, `/plan`, the static blog
  index, and a published blog article. Authenticated responsibilities were
  confirmed from source because a signed-in account was not required or used
  for this inventory.

## Research principle

The next documents should answer: “What should a world-class version of each
job feel like and why?” They should not answer: “How do we polish this current
layout?”
