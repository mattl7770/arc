# Architecture Decision Records (ADR)

## 2026-07-24 — Local-first, single-user, no-server architecture

**Decision:** ARC is a **local-first, single-user, server-less** app. All personal data lives **on the device** in SQLite, with `sqlite-vec` for on-device RAG. The Coach calls a frontier model **directly from the app** using a key the user supplies, held in the **iOS Keychain** and swappable at runtime via a settings screen (provider + model + key). The longevity **knowledge base lives on-device** and is writable — the user, and later the Coach's own research, can expand it. Media (food / progress photos) is **referenced from the iOS Photos library** (PhotoKit) or stored compressed, never duplicated wholesale. Backup is an **encrypted snapshot to iCloud**, the device holding the key. There is **no backend, no auth, no RLS, and no personal data at rest in any cloud.** Supabase is removed.

**This supersedes** the 2026-07-22 "Coach: client → Edge Function, never a client-side key" ADR, the cloud posture of the 2026-07-22 schema/RLS ADRs, and the 2026-07-24 data-ownership *deferral* (we are not deferring local-first — we are adopting it now).

**Reasoning:**
- **One user for the foreseeable future.** Auth, RLS, `user_id` tenancy and a hosted Postgres all exist to isolate *many* users over a network. For one person on one phone they are pure overhead — removing them makes the app *simpler to build and to run*, not merely cheaper.
- **The client-side-key objection doesn't apply here.** The original ADR banned a client-held model key because a *distributed* app would ship a shared secret to thousands of devices. This key is *yours*, in hardware-backed Keychain, on *your* device — revocable and spend-limited. The threat that justified the server is absent.
- **Privacy by construction.** Personal health data never sits at rest in anyone's cloud; the only cloud copy is an encrypted blob the device alone can decrypt. This satisfies CLAUDE.md §2's "local-first or strongly encrypted" directly instead of deferring it.
- **Storage fits comfortably.** Structured data + on-device vectors total well under 1 GB per decade; photos are the only variable and stay small via compression or PhotoKit references. Single-digit GB over ten years on a 128–256 GB phone. (Worked through with the owner, 2026-07-24.)
- **Zero recurring cost but tokens.** No server, no hosting bill; ongoing cost is per-token model usage plus the $99/yr Apple membership any iOS app needs.
- **The model stays swappable.** `coach-service.ts` already isolates the model call; a settings screen makes provider/model/key user-editable at runtime.

**Consequences:**
- **Removed:** Supabase (client, hosted project, migration-as-live-schema), email auth, RLS policies, `useSession` as a gate. The live Supabase project becomes vestigial (free tier — the owner can delete it whenever).
- **The schema survives as the app's spine**, ported Postgres → SQLite (enums → `text` + `CHECK`, `uuid` → `text`, `timestamptz` → ISO-8601 `text`, `jsonb` → `text`). Table and column names are preserved so the UI and view-model types barely move.
- **New surfaces:** an on-device migration runner, a local data-access layer, a settings screen for provider/model/key, `sqlite-vec` RAG, PhotoKit media references, and encrypted iCloud backup/restore.
- **On-device key posture:** Keychain storage (`expo-secure-store`) + a provider-side spend limit + key rotation on device loss are the three mitigations that keep this safe.
- **Upgrade path preserved.** If ARC ever goes multi-user or ships publicly with a shared key, a thin server returns *behind the same `coach-service.ts` seam* — the app doesn't change. Nothing here burns that bridge.
- CLAUDE.md §3 (stack) and §9 (DB conventions — RLS / `auth.uid()`) and `docs/data-model.md` need updating to match; tracked in the plan.

**Full step-by-step:** `docs/architecture-migration.md`.

---

## 2026-07-24 — Reconciling the app with the source brief (`Health App Idea`)

**Context:** The owner's original product brief (`Health App Idea`, kept outside the repo) was diffed against the shipped app and the docs. Most of it already agreed; the decisions below resolve the points that didn't. The full diff and the resulting backlog additions live in `docs/project-status.md` §1.

**Decisions:**

1. **Today's Mission is one chronological list, not category groups.** The brief calls the home screen "directive and **chronological**"; the first build grouped items by category (Morning, Nutrition, Training…), which let a 21:45 supplement render above an 08:00 meal. Sorting by scheduled time makes the reading order the acting order, and guarantees the derived hero ("do this next") always points at the top of the list. Category survives as a per-row label. See `docs/home-screen.md` §3 and `src/hooks/use-mission.ts`.

2. **Progressive disclosure is allowed to hide history, never work.** The brief wants "beautiful progressive disclosure"; the home-screen doctrine had flatly refused collapsing. Both are honoured by a narrow rule: the run of already-settled items at the *top* of the day folds into one line so the list opens at *now*, and nothing else ever collapses. Anything still pending — including overdue items, and items settled out of order — stays visible. This is the bounded form of "collapsible if needed"; the thing the doctrine rejected (hiding pending work) is still rejected.

3. **The status bar / quick-actions questions were already settled this session** and the brief does not reopen them: the date-only header (readiness moved below the hero) stands, and the quick-actions dock stays cut (see the ADR below). The brief's "overrides for travel/sick/social" is retained as the **Mode override** backlog item, which needs a real home, not a restored dock.

4. **Data-ownership posture: cloud-first for v1, deferred deliberately.** The brief and CLAUDE.md §2 both ask for "local-first or strongly encrypted". v1 is plain cloud Supabase with RLS; the ownership guarantee for now is **easy full data export**, not local-first or client-side encryption. Client-side encryption is rejected for v1 because it would blind the Coach's server-side RAG to most of the data. Revisit before genetics or mental-health data lands. Tracked in §1 as a ⚠️ item; CLAUDE.md §2's principle is aspirational until then, not a description of what's built.

5. **Wearable choice stays open.** The brief lists Garmin CIRQA / WHOOP / Ultrahuman / Oura as undecided. CLAUDE.md §8 had asserted a firmer dual-device preference; it's been relaxed to match — all four are candidates, everything normalises into ARC's own schema, so no code depends on the decision and it costs nothing to defer.

**Consequences:**
- The brief's exhaustive feature set seeded a large batch of backlog items (preventive screenings + medical calendar, food/pantry/recipe/photo-analyzer model, microbiome + epigenetic-clock lab breadth, exercise-as-measured-data, environment breadth, education module, reporting + export, predictive alerts, vector memory). All are in §1, marked as appetite not sequence.
- **§1 is now explicitly an unordered catalogue.** The owner builds in the order they choose; the doc stopped implying a phase order (the earlier "per CLAUDE.md priority order" framing is gone).

---

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
