# Screen traceability matrix

Date: 2026-07-27

Priority:

- **P0:** central to the requested visual overhaul;
- **P1:** important supporting experience;
- **P2:** baseline-quality surface, not a current research centerpiece;
- **Internal:** outside the first user-facing overhaul.

| Surface | Priority | Design contract | Primary precedent | Representative task | Critical states | Validation emphasis |
|---|---:|---|---|---|---|---|
| Landing page | P0 | `06` Landing page | Linear landing, Notion product, Baymard | Understand product, inspect real workflow, choose next step | First visit, responsive, reduced motion, unavailable media | Five-second comprehension, product specificity, CTA prediction |
| Dashboard | P0 | `06` Dashboard | Linear My Issues, Carbon dashboard guidance | Identify and complete the next useful action | Loading, partial, first use, no active work, stale, shared-data failure | Priority comprehension, time to action, progress interpretation |
| Shared shell/navigation | P0 | `06` Shared shell | Linear workspace navigation, WAI keyboard guidance | Move between modules without losing orientation | Gated module, notification, collapsed nav, compact nav, bootstrap failure | Findability, location awareness, keyboard/focus, cross-module vocabulary |
| Resume Workshop | P0 | `06` Evidence workbench | GitHub review, Google Docs suggestions | Inspect facts, edit source context, preserve and approve work | Importing, parsing, conflict, autosave failure, recently deleted | Authority-chain comprehension, no lost edits, review progress |
| Tailored draft editor | P0 | `06` Evidence workbench | GitHub review, HAX correction | Review unsupported and supported changes, edit, approve, export | Generating, partial, unsupported, failed generation, version conflict | Provenance, granular control, export consequence |
| Interview Coach | P0 | `06` Practice room | Prepra active practice and feedback; PAIR/HAX explanation patterns | Practice, inspect evidence-backed feedback, challenge, retry | Voice unavailable, recording, quota, retry, archived/deleted session | Focus, recording clarity, evidence linkage, contestability, recovery |
| Applications | P0 | `06` Operational records | Asana My Tasks list/filter/view controls; Notion shared-view model; LinkedIn Job Tracker | Scan, filter, move stage, snooze, follow up | Empty, filtered empty, stale, edit/delete, pagination | View-task fit, context preservation, next-action clarity |
| Networking | P0 | `06` Operational records | Dex person-first history and reminders; reviewed-draft patterns | Review history, edit message, defer, confirm no auto-send | No contacts, stale reminder, generated draft, notification | Human authorship, history-first hierarchy, cadence control |
| Personal Recruiter | P0 | `06` Operational records | Linear Triage, PAIR explanations | Understand why role appeared, save/dismiss/snooze, continue | Cohort gate, running, no results, stale, failed run | Fit interpretation, uncertainty, reversible triage |
| Blog index | P0 | `06` Blog index | Notion Tools & Craft, Linear Now | Find a useful guide by need or topic | Small corpus, featured story, search/no results, compact | Editorial hierarchy, topic findability, visual authorship |
| Blog category/topic | P0 | `06` Topic pages | Notion topic rail, GOV.UK related navigation | Understand topic and choose a deliberate reading path | Sparse topic, no current content, long archive | Reading-path comprehension, non-grid fallback |
| Blog article | P0 | `06` Article page | Linear long-form, Google Article guidance | Read, verify, understand limits, continue appropriately | Long article, figures, corrections, updated content, no related story | Reading comfort, source/freshness trust, CTA relevance |
| Auth | P1 | `02` Auth/onboarding | GOV.UK forms, platform-native auth patterns | Sign in or register and recover from error | Login/register, validation, curated server error, redirect | Error recovery, field preservation, compact keyboard flow |
| Onboarding | P1 | `02` and `06` focused forms | GOV.UK question pages, Apple onboarding | Provide minimum career context and reach first artifact | Resume, skip/defer, resume later, validation, completion | Time to value, optional-step understanding, no forced completion |
| Profile/progress | P1 | `06` Personal context | User-owned settings patterns, progress research | Edit context and understand effect on modules | Missing setup, conflict, privacy control, rank/progress empty | Field-effect comprehension, agency, no pressure mechanics |
| Extension public page | P1 | `02` Chrome extension | Chrome Web Store guidance | Understand capture workflow and decide to install | Browser unsupported, FAQ, compact, permission explanation | Purpose and permission comprehension |
| Extension popup/runtime | P1 | `02` Chrome extension | Chrome platform UI, focused-form pattern | Preview parsed fields, correct, explicitly save | Unsupported page, parsing, partial fields, error/retry, saved | Compact hierarchy, data-boundary understanding, correction |
| Plans/pricing public | P2 | `02` Plans/upgrade | Clear comparison patterns | Understand free/paid distinction and choose | Billing period, registration handoff, unavailable checkout | Plan comprehension; no research-led visual priority |
| Upgrade/subscription | P2 | `02` Plans/upgrade | Account-management patterns | Understand current state and manage plan | Current plan, success/failure, period-end, cancel | Consequence clarity; baseline usability |
| Privacy/terms | P2 | `02` Privacy/terms | Long-form legal reading patterns | Find and understand relevant policy section | Long content, anchors, updated date, compact | Findability, readability, contextual product links |
| Public 404 | P2 | `02` Public recovery | GOV.UK not-found guidance | Recover from stale or mistyped link | Product path, blog path, malformed URL | No silent redirect or dead end |
| Admin/admin-flows | Internal | Excluded from first pass | Internal operations research if later scoped | Operate and inspect system | Authorization, data/error states | Separate internal-tools project |

## Coverage rule

A P0 screen cannot enter visual design without:

- a screen brief from `05`;
- at least one annotated precedent in `07` or an explicit reason no external
  precedent is appropriate;
- realistic primary, empty, failure, and compact states;
- a traceability ledger entry for material visual decisions;
- validation against the representative task above; and
- cross-surface review beside at least one other P0 module, the dashboard, and
  one public/editorial surface.
