# Architecture Decision Records (ADR)

## 2026-07-24 — Rules enclose objects, never pages; the quick actions dock is cut

**Decision:** Two changes from the first on-device review of the Porcelain Ledger build.

1. **No horizontal rules between Home sections.** Hairlines are for **card edges** and **row separators inside a list**. Sections are separated by whitespace alone. The `border-b` folio rule under the date eyebrow and the `border-t` rules above the metrics strip and the dock are gone.
2. **Section 6 of `docs/home-screen.md`, the Quick Actions Dock, is removed** — component deleted, not hidden. The Home screen now ends at the metrics strip.

**Reasoning:**
On a real screen, a rule above a short block and a rule below it draw a box around it. The owner's words were "a few weird little boxes… around the date at the top and around the wearables data at the bottom" — three rules, read as three boxes. This is a general lesson, not three one-off fixes: a rule is legitimate when it traces the boundary of one object, and furniture when it slices the page.

The dock failed a different test. Its four buttons were Log, Coach, Mode, Data — and Log, Coach and Data are *tabs*, sitting an inch below in the tab bar. Mode was inert. It was a row of duplicate navigation charging rent at the bottom of the most protected screen in the app (CLAUDE.md §5: "Never let the home screen become a data dump" — a nav dump is the same failure).

**Consequences:**
- `src/components/home/quick-actions.tsx` is deleted. `docs/home-screen.md` §6 is struck through with the reasoning, so the IA doc can't be read later as a spec for rebuilding it.
- **Mode override (Travel/Sick/Social/Manual) no longer exists anywhere in the UI.** It was only ever an inert button. When the override model is real it needs a deliberate home — most likely the hero or a Settings-level day-state control — not a restored dock.
- The metrics strip is now the last element on the screen, with no rule and no heading. A heading was considered and rejected: every cell already carries a caps label, so a caps section header stacks caps on caps.
- Home section rhythm (`mt-5`–`mt-9`) is now the *only* separator between sections. Tightening it has more consequence than it used to.

---

## 2026-07-24 — Visual direction: Porcelain Ledger

**Decision:** ARC's design system is **Porcelain Ledger** — bone-white paper, warm ink, hairline rules, serif headlines, mono data, one deep pine-green accent. Chosen by Matt from six fully-specified candidate directions (archived in `docs/design-directions.md`) after reviewing complete Home + Coach mock-ups. Replaces the original cool-gray + teal theme. Full token set and usage rules: `docs/project-status.md` §3.

**Reasoning:**
The owner wasn't sold on the original colours or vibe. Six deliberately distinct territories were explored in parallel and audited for contrast and distinctness; Porcelain Ledger won because its metaphor — a beautifully printed lab report that happens to be alive — *is* the product: a permanent, trustworthy, decades-durable record of one person's biology. Print conventions (paper, hairlines, serif authority, mono data) age better than app trends.

**Consequences:**
- **Light-mode only.** Paper is the identity; `dark:` variants were removed rather than restyled, `userInterfaceStyle` is pinned to `light`. A future night mode would be the archived Night Watch (B) direction as a second complete theme, not bolted-on variants.
- **Three typographic voices with meaning:** serif speaks (headlines/verdicts), sans talks (body), mono measures (every datum). System fonts only — no font downloads to break in a decade.
- The accent discipline survives the restyle: pine marks the hero, primary actions, the user's chat voice, and the active tab. Nothing else.
- Fonts must be declared as plain CSS stacks in the Tailwind config — NativeWind's `platformSelect` silently drops family names containing spaces (verified against the compiled style registry).

---

## 2026-07-22 — Coach: client → Edge Function, never a client-side key

**Decision:** The Coach's model call lives behind a single service seam (`src/lib/ai/coach-service.ts`). The client never holds a provider API key; the real implementation will be a Supabase Edge Function that holds the key server-side and streams the reply back. Today that seam returns an honest mock with simulated streaming.

**Reasoning:**
An `EXPO_PUBLIC_ANTHROPIC_KEY` would be inlined into every client bundle — a shipped secret (see `.env.example`). Routing through an Edge Function keeps the key server-side and gives one place to run the agent loop, RAG, and tools later. Isolating it behind one function means the entire chat UI — hook, components, streaming contract — is written against the final interface today and does not change when the backend lands.

**Consequences:**
- The chat streams token-by-token now, so the UX that ships today is the UX that ships with the real model.
- `isCoachBackendLive` is the single flag the UI reads to show the "Preview" affordance.
- Conversations are in-memory until the `ai_conversations` / `ai_messages` migration lands.

---

## 2026-07-22 — The mock Coach is honest, not fake-smart

**Decision:** The placeholder Coach never fabricates data-grounded answers. It replies in-character but transparent — it states that it is a preview not yet connected to the model or the user's data — and the daily brief carries a visible "Preview" badge.

**Reasoning:**
A coach that confidently invents HRV numbers or protocol advice while disconnected from real data would train the user to distrust it exactly when it becomes real. Honesty about its own wiring is on-brand for "calm, precise, evidence-seeking" (docs/ai-coach.md) and avoids demoing fake intelligence.

---

## 2026-07-22 — Project Naming

**Decision:** Name the project **ARC** (Architecture for Resilience & Continuity)

**Reasoning:**  
Short, strong, systemic. Works as both a word and an acronym. Avoids collision with Bryan Johnson’s “Blueprint” while capturing the OS / protocol / long-term resilience nature of the system.

---

## 2026-07-22 — Starting Tech Stack

**Decision:** Begin with Expo + React Native (TypeScript) + Supabase.

**Reasoning:**  
Maximum iteration speed while discovering the correct UX and data model. User already has strong Expo experience. AI coding tools currently perform better on this stack. Clean path to native SwiftUI later once the product is proven.

**Consequences:**  
- Faster earlying of home screen, coach, and core loops  
- Will eventually need a native port decision  
- HealthKit integration via Expo modules + possible custom native code later

---

## 2026-07-22 — Lab Strategy

**Decision:** Use Function Health as the primary comprehensive lab backend. Ingest via PDF download + structured parsing.

**Reasoning:**  
Best current combination of breadth (160+ biomarkers), quality, and accessibility. Avoids building phlebotomy/logistics. PDF parsing is reliable enough in 2026 with strong LLMs.

---

## 2026-07-22 — Home Screen Philosophy

**Decision:** The home screen is sacred and must remain ruthlessly directive. Full data exploration lives elsewhere.

**Reasoning:**  
The primary job of the app is to make the highest-leverage next action obvious. Information density is the enemy of daily execution.

---

## 2026-07-22 — Scoring System

**Decision:** Do not start with a single composite “Don’t Die Score.” Begin with multi-pillar status + clear actions. Revisit biological age / velocity later.

**Reasoning:**  
Composite scores force arbitrary weightings and can demotivate. Better to keep signals separate and let the Coach synthesize.

---

## 2026-07-21 — Enum vs. Text in the Schema

**Decision:** Use a Postgres enum where ARC owns the vocabulary; use `text` where an external system owns it. In practice: enums for `biological_sex`, `biomarker_category`, `data_source`, `protocol_type`, `authorship`, `log_entry_type`, `log_entry_status`, `wearable_device`; plain `text` for `wearable_data.metric_type`.

**Reasoning:**  
Enums give typo protection and generate exact string unions in `src/types/database.ts`, which is worth a migration when we control the list. `metric_type` is the exception: Oura, WHOOP, Ultrahuman and Terra add metrics on their schedule, and an enum there would mean a migration every time a vendor ships a new field.

**Consequences:**  
- Adding an enum value is a one-line migration (`alter type ... add value`), never a data rewrite.
- `metric_type` is guarded by a `^[a-z0-9_]+$` check constraint instead of the type system, so the normalisation layer must own that vocabulary.

---

## 2026-07-21 — `user_id` on Child Tables + Composite Foreign Keys

**Decision:** Carry `user_id` on `log_entries` and `protocol_versions` even though the spec derives ownership through the parent. Enforce consistency with composite foreign keys — `(daily_log_id, user_id) → daily_logs(id, user_id)` and `(protocol_id, user_id) → protocols(id, user_id)` — backed by `unique (id, user_id)` on the parents. Same pattern for `lab_results → lab_reports`.

**Reasoning:**  
`docs/data-model.md` asks for “user_id on everything.” Denormalising it lets every RLS policy be a flat `auth.uid() = user_id` rather than an `EXISTS` subquery against the parent, which is materially faster per row. The composite FK is what makes the denormalised column trustworthy: it is structurally impossible to attach a row to another user’s parent. Verified by test.

**Consequences:**  
- Parent tables carry a redundant `unique (id, user_id)` index to serve as the FK target.
- Writers must set `user_id` explicitly on child inserts.

---

## 2026-07-21 — Delete Semantics

**Decision:** Deleting a protocol sets `log_entries.protocol_id` to NULL rather than cascading. Deleting a lab report cascades to the `lab_results` parsed out of it. Deleting a daily log cascades to its entries.

**Reasoning:**  
Execution history is the record of what actually happened and must survive protocol churn — losing a year of adherence data because a supplement stack was retired would be unacceptable. Parsed lab results, by contrast, are derived data: they can be regenerated from the stored PDF, so they follow their report. Manually entered results have `report_id` NULL and are untouched.

---

## 2026-07-21 — Protocol Versions Are Immutable

**Decision:** `protocol_versions` has `created_at` but deliberately no `updated_at` and no update path. Changing a protocol means inserting a new version and moving `protocols.current_version_id`.

**Reasoning:**  
“Protocols are versioned and treatable like code” (CLAUDE.md §2). A version you can edit in place is not a version. This also keeps n-of-1 experiments honest: an experiment can reference the exact version it ran against.

---

## 2026-07-21 — RLS Policy Shape

**Decision:** One `FOR ALL` policy per owned table, with `auth.uid()` wrapped in a scalar subquery: `using ((select auth.uid()) = user_id)`. `biomarkers` is global reference data with a read-only policy for authenticated users and no write policy at all.

**Reasoning:**  
The predicate is identical across select/insert/update/delete, so four separate policies would be four copies of one line. Wrapping `auth.uid()` in a subquery lets Postgres evaluate it once per statement as an InitPlan rather than once per row — the documented Supabase performance pattern. Biomarker rows are seeded by the service role, which bypasses RLS, so no write policy is needed or wanted.
