# Architecture Decision Records (ADR)

## 2026-07-25 — iOS-only target, and the last Supabase remnants purged

**Decision (owner):**
- **ARC targets iOS only.** Android is not a target "in any form." Removed the `android` block from `app.json`, the Android build entries from `eas.json`, the `android` npm script, and the three Android adaptive-icon assets. **Web is kept** — not as a shipped target but as the dev-time logic-check preview path (see [[verify-on-device-not-web]]); it can be dropped later if we want a pure-iOS tree.
- **All Supabase remnants deleted.** The owner decommissioned the remote project, so the last artifacts went too: the whole `supabase/` folder (config, the Postgres-origin migration, seed, functions) and the `EXPO_PUBLIC_SUPABASE_*` lines in `.env`. This finishes the removal the 2026-07-25 review started (which had deleted the client island but kept `supabase/` as "history"). Nothing Supabase remains in the tree; the Postgres origin lives in git history only.

**Reasoning:** a single-user iOS app has no reason to carry Android config, icons, or an EAS Android profile — it's pure surface area to keep correct. The Supabase project being gone removes the last reason to keep its origin files or a live anon key in `.env`. Both are reversible via git history if ever needed.

**Consequences:** the `0001_init.sql` header no longer points at the deleted `supabase/` path (regenerated `migrations.generated.ts` to match); docs (README, folder-structure, CLAUDE.md §9/§11, data-model, dev-build, project-status) drop their Android and `supabase/`-origin references. Gates stay green.

---

## 2026-07-25 — Full-app review: fixes, and pulling the Supabase removal forward

**Context:** a full-app review ran five read-only reviewers in parallel (correctness/DB, UI/design-system, security/privacy, architecture/docs, plus the Log-wiring diff). Findings converged; the top three correctness bugs were reproduced against real SQLite. This ADR records the decisions in the fixes; the mechanical fixes themselves are self-explanatory.

**Decisions:**

- **The command parser requires ADJACENCY.** It was matching "a keyword anywhere + the first number anywhere", which silently mis-logged notes containing a common word (`took 2 pills, weight 181` → 2 lb; `great water views, walked 5 miles` → 5 oz). A note must never become a wrong measurement, so a number now only becomes a metric when it sits next to that metric's keyword/unit, and only a narrow set of unambiguous units (`lb/kg`, `bpm`, `ms`) may imply a metric with no keyword — `oz`/`ml`/`mg` require their keyword (food is logged in oz/g, so `16 oz` alone must not mean water). Everything else stays a note. (`src/lib/log/parse.ts`, `metrics.ts` `inferUnits`.)
- **Writes validate against the schema's domain.** Out-of-range values (`body-fat 150`, `weight 0`) tripped a `body_metrics` CHECK and threw out of the tap handler. `isLoggableCanonical` now gates both surfaces: the keypad disables "Log" with an inline hint; the command field saves the raw text as a note rather than crash or lose it (plus a try/catch backstop). (`metrics.ts`, `command-field.tsx`, `metric-entry.tsx`.)
- **The seed guard counts planned entries only.** Logging a note before opening Home on a new day left the daily_log non-empty and suppressed the whole day's seeded mission. The guard now uses `countMissionEntries` (ad-hoc-excluded), matching the mission filter. (`seed.ts`, `mission.ts`.)
- **The dead Supabase island was deleted now, not deferred to Phase 2.** `supabase.ts`, `env.ts`, `use-session.ts`, `types/database.ts`, `login.tsx`, `gen-types.mjs`, the `@supabase/supabase-js` + `@react-native-async-storage/async-storage` deps, and the `db:push`/`db:types` scripts were removed. Rationale: security + architecture reviewers agreed it's a closed graph nothing live imports (the app boots without `.env`), and `types/database.ts` was *actively wrong* (Postgres/RLS shape the SQLite port dropped) — a stray import would type-check against a schema that no longer exists. Deferring it bundled two unrelated things ("remove Supabase" + "add Face ID"); the removal is separable and zero-runtime-risk, so it shipped early. **Face ID app lock remains the real Phase 2 work.** *(Owner action still outstanding: decommission the remote Supabase project and strip `EXPO_PUBLIC_SUPABASE_*` from `.env` — a bundled anon key is why removing the code matters.)*
- **The Coach seam was corrected to the adopted architecture.** Comments across `coach-service.ts`, `system-prompt.ts`, `coach.tsx` still described the retired "Supabase Edge Function" plan; they now describe the direct, on-device model call (Keychain key), and `isCoachBackendLive` was renamed `isCoachKeyConfigured`. Comment/rename only — no behavior change.

**Consequences:** headless coverage grew to `db:test` log-layer 43/43 (adjacency, out-of-range, log-then-seed, UTC-range boundary, multi-measurement fan-out); the `@/` alias now resolves in the test loader. UI polish also landed (off-token radii → `rounded-btn`; decorative icons hidden from a11y; a keypad Dynamic-Type cap; a Coach keyboard offset; an app-wide `ErrorBoundary`; the migration-backup stub throws in `__DEV__`). **Deliberately deferred (flagged to the owner, not fixed here):** SQLCipher at-rest encryption (Phase 4) and the Face ID app lock (Phase 2); and one design call left to the owner — colour-only state on Home's pillar strip (WCAG 1.4.1) — because changing the approved Home visual is a product decision, not a review fix.

---

## 2026-07-25 — Wiring the Log tab: canonical units, an ad-hoc marker, and an offline parser

**Decision:** the Log tab now persists to the on-device DB. The shape of that wiring:

- **Storage is canonical SI; display is a conversion.** Every metric is stored in a canonical unit — weight **kg**, waist **cm**, water **ml** — and rendered in the user's display unit (lb / in / oz) through a single **metric registry** (`src/lib/log/metrics.ts`) that owns each metric's label, display unit, decimals, both conversion directions, and its persistence target. This makes the future lb/kg · in/cm · oz/ml **unit toggle a display-layer preference, not a migration** (it plugs into `fromCanonical`), and matches the schema's already-canonical `body_metrics.weight_kg` / `waist_cm`.
- **Persistence routing (one place, the registry):** weight / body-fat / waist → `body_metrics`; water / HRV / RHR → `wearable_data` (`source_device='manual'`, free-text `metric_type` — `water_ml`, `hrv`, `rhr`); dose and free notes → `log_entries`.
- **An `value.adhoc = true` marker separates Log captures from Home's mission.** `log_entries` holds both the planned mission (Home) and ad-hoc Log captures (a note, a spontaneous dose). Rather than a schema column, ad-hoc captures carry `adhoc:true` in their `value` JSON: `listMission` filters them **out**, the Log feed filters them **in**. Body/wearable captures live in their own tables, so they never touch the mission. (Seeded/planned entries carry no flag, so they're unaffected — and the Log feed correctly starts empty until the user logs something real.)
- **The command-field parser is deterministic and offline.** `src/lib/log/parse.ts` handles the common one-liners (`weight 178`, `16 oz water`, `hrv 48`, `180 lb`) via metric keywords and strong units; everything else is saved verbatim as a **note for the Coach**. Everyday-word units (`in`, `l`) never *imply* a metric on their own, so a plain sentence isn't misread as a measurement. Rich natural language ("ate eggs + oats, 45g protein" → a meal) needs the on-device model and lands with the Coach (Phase 3).
- **Water is modeled as `wearable_data(water_ml)`** with additive quick-estimates (Glass +8 / Bottle +16 / Large +24 oz). A smart bottle via Apple Health later adds rows to the same `metric_type`, no migration — as the hydration ADR intended.

**Small refinements to the 2026-07-25 Log-tab ADR below** (owner calls, same day): the **Meal tile is renamed Nutrition**; the tile grid is regrouped so the two gateway tiles share the right column (Row 1: Supplement · Water · Nutrition; Row 2: Weight · Therapy · Workout); **Nutrition, Exercise, and the Supplement/Therapy capture sheet ship as design mockups** (real layout, mock content, a quiet "mockup" footer) ahead of wiring.

**Reasoning:** canonical storage is the standard fix for a unit toggle and costs nothing now; a JSON marker avoids a migration for a distinction that may dissolve once the protocol→mission generator exists; an offline parser keeps fast capture working with the network unplugged (the offline-except-AI principle), and a note is never a wrong interpretation, so the fallback is safe.

**Consequences:** the registry is the single source of truth for units/targets — add a metric there, not in three UIs. `listMission` gained an `adhoc IS NULL` filter (verified: seeded mission intact, captures excluded). Headless coverage added: `npm run db:test` log-layer 26/26 (parser, conversions, routing, feed union/order, mission isolation). The test loader now resolves the `@/` alias (`db/ts-ext-hook.mjs`) so repositories can use it for runtime value imports. No new native deps → no dev rebuild to see it.

---

## 2026-07-25 — Log tab direction, Nutrition/Exercise sub-apps, and the Modes model

**Decision:** Full map + rationale in `docs/information-architecture.md`. In brief:

- **Log tab = direction A ("Open Line")** — chosen from a two-round design study. Three capture layers: a command/voice field (free notes + parse), a 3×2 quick-add tile grid, and a single-number metric keypad drill-in.
- **Quick-add tiles:** Supplement · Meal · Water · Weight · Workout · Therapy. **Meal and Workout are gateways** that push full sub-app screens (**Nutrition**, **Exercise**); the rest are quick-capture (sheet/keypad). Notes live in the command field; other body numbers in the keypad chips; medication folds into the Supplement sheet; habits are completed on Home, not re-logged.
- **Nutrition and Exercise are stack-pushed sub-app screens** (placeholders now), not Data sections — they're deep enough to own their space, which also keeps the Data hub from overloading. **Protocols stays in Data** for now but is the leading candidate to graduate the same way.
- **Modes** (Normal/Travel/Sick/Deload/Social/Custom) live on **Home** and adapt four things — the plan, priorities, the Coach's tone, and adherence accounting (excused misses). The override data model is built later with Protocols + the mission generator.

**Reasoning:** capture frequency drives layer (daily-many → tile, deep domain → sub-app, anything/notes → the field); Home owns "today" so the Mode control belongs there, not Settings; sub-app screens beat Data-sections for food/exercise because both are real mini-apps. Everything is defensible for v1 and reversible.

**Consequences:** the placement map in `docs/information-architecture.md` is the source of truth for where features go; `docs/home-screen.md` and CLAUDE.md §11 point to it. Building starts with the Log skeleton (structure on mock content; persistence/parsing is the next step).

---

## 2026-07-25 — Backup key: user-recorded recovery phrase, envelope-encrypted

**Decision:** The encrypted iCloud backup (Phase 4) is protected by a key the user can recover **from a one-time recovery phrase**, not by a device-only key. Concretely:

- **Envelope encryption.** A random 256-bit **data key (DEK)** encrypts the backup. The DEK never changes, so every past backup stays decryptable forever. The DEK is stored **wrapped** (encrypted) by a **key-encryption key (KEK)** derived from the recovery phrase, and the wrapped DEK travels with the backup (useless without the phrase).
- **Recovery phrase.** At backup setup the app generates a one-time phrase (wallet-seed / 1Password-Secret-Key style), shows it once, and makes the user confirm they've stored it (password manager / paper). This is the sole durable recovery path.
- **Day-to-day is frictionless.** The DEK (or the phrase) lives in the Face-ID-protected Keychain on the active device, so routine backups need no re-entry. The user only touches the phrase at **setup** and at **restore on a new phone**.
- **iCloud Keychain is a deferred, optional convenience.** Because of envelope encryption, syncing a second KEK via iCloud Keychain can be added later as an *additional* wrap of the same DEK — zero re-encryption, no migration. Not built now.

**Reasoning:**
- **Ownership and portability win the tie.** A recovery phrase is the user's, full stop — it works if ARC ever ports off iOS, if data is exported to the user's own storage, or if Apple changes iCloud Keychain in a decade. An iCloud-Keychain-only key chains a decade of health data to the survival of one Apple ID. For an ownership-first, decades-horizon, single-user app, that is decisive (CLAUDE.md §2).
- **Fewest long-term dependencies.** Recovery depends only on a string the user controls, not on Apple's escrow infrastructure remaining intact and accessible.
- **It's also less work now.** `expo-secure-store` does not expose the iCloud-Keychain sync flag (`kSecAttrSynchronizable`), so the sync option would need custom native code; the recovery-phrase path does not.
- **Fixes the audit finding directly** (2026-07-24 pre-Phase-1 audit): a device-only Keychain key makes the backup undecryptable after the exact event it exists to survive. The DEK is also kept strictly separate from the **model API key** — the "spend limit / rotate on device loss" mitigations are API-key concerns and are *harmful* applied to a backup key (rotating it orphans old blobs); the DEK never rotates.

**Consequences:**
- **The one accepted risk:** losing the phone **and** the recovery phrase means the backup is unrecoverable. That is the price of nobody-but-the-user being able to decrypt it. Mitigations: strong setup UX (generate, prompt to store, confirm), and the manual **data export** as an independent second escape hatch.
- **Phase 4 implementation notes** (not binding, decided at build): KDF Argon2id preferred (PBKDF2-HMAC-SHA256 as the widely-available fallback), AES-256-GCM for the wrap and the backup. Worth evaluating **SQLCipher** (op-sqlite supports it) so the on-device DB is encrypted at rest and a backup is just a copy of the already-encrypted file — one scheme covering both at-rest and backup.

---

## 2026-07-24 — Local-first, single-user, no-server architecture

**Decision:** ARC is a **local-first, single-user, server-less** app. All personal data lives **on the device** in SQLite, with `sqlite-vec` for on-device RAG. The Coach calls a frontier model **directly from the app** using a key the user supplies, held in the **iOS Keychain** and swappable at runtime via a settings screen (provider + model + key). The longevity **knowledge base lives on-device** and is writable — the user, and later the Coach's own research, can expand it. Media (food / progress photos) is **referenced from the iOS Photos library** (PhotoKit) or stored compressed, never duplicated wholesale. Backup is an **encrypted snapshot to iCloud**, the device holding the key. There is **no backend, no auth, no RLS, and no personal data at rest in any cloud.** Supabase is removed.

**This supersedes** the 2026-07-22 "Coach: client → Edge Function, never a client-side key" ADR, the cloud posture of the 2026-07-21 schema/RLS ADRs, and the 2026-07-24 data-ownership *deferral* (we are not deferring local-first — we are adopting it now).

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

1. **Today's Mission is one chronological list, not category groups.** The brief calls the home screen "directive and **chronological**"; the first build grouped items by category (Morning, Nutrition, Training…), which let a 21:45 supplement render above an 08:00 meal. Sorting by scheduled time makes the reading order the acting order, and guarantees the derived hero ("do this next") always points at the top of the list. Category survives as a per-row label. See `docs/home-screen.md` §3, `src/lib/home/derive-mission.ts`, and `src/hooks/use-today-mission.ts`.

2. **Progressive disclosure is allowed to hide history, never work.** The brief wants "beautiful progressive disclosure"; the home-screen doctrine had flatly refused collapsing. Both are honoured by a narrow rule: the run of already-settled items at the *top* of the day folds into one line so the list opens at *now*, and nothing else ever collapses. Anything still pending — including overdue items, and items settled out of order — stays visible. This is the bounded form of "collapsible if needed"; the thing the doctrine rejected (hiding pending work) is still rejected.

3. **The status bar / quick-actions questions were already settled this session** and the brief does not reopen them: the date-only header (readiness moved below the hero) stands, and the quick-actions dock stays cut (see the ADR below). The brief's "overrides for travel/sick/social" is retained as the **Mode override** backlog item, which needs a real home, not a restored dock.

4. **Data-ownership posture: cloud-first for v1, deferred deliberately.** ~~The brief and CLAUDE.md §2 both ask for "local-first or strongly encrypted". v1 is plain cloud Supabase with RLS; the ownership guarantee for now is **easy full data export**, not local-first or client-side encryption. Client-side encryption is rejected for v1 because it would blind the Coach's server-side RAG to most of the data. Revisit before genetics or mental-health data lands.~~
   > **SUPERSEDED 2026-07-24 (same day) by the "Local-first, single-user, no-server" ADR at the top of this file.** We are *not* deferring local-first — we adopted it. Personal data lives on-device; there is no cloud Supabase and no server-side RAG to protect. The Coach's RAG runs on-device, so the earlier objection (client-side encryption would blind server RAG) no longer applies. This decision is kept only as a record of the reasoning we changed our minds about.

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
- `isCoachKeyConfigured` (renamed from `isCoachBackendLive` on 2026-07-25, when the Edge-Function plan was retired for the direct on-device call) is the single flag the UI reads to show the "Preview" affordance.
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
