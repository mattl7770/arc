# ARC — Project Status & Tracker

**Living document.** This is the running board for what's done, what's next, and how the app is put together. Update it in the same change that changes reality — a status line that lies is worse than none.

**Last updated:** 2026-07-26
**Current phase:** Foundation → the local data layer and the whole Log-tab capture surface are real
**Branch:** `claude/expo-project-scaffold-d14e9e`

> ✅ **Architecture pivot (2026-07-24) — largely complete: local-first, no-server, offline-except-AI, iOS-only.** ARC runs on **on-device SQLite** (`op-sqlite` + `sqlite-vec`); **Supabase is fully removed** (client + folder deleted 2026-07-25) and Android was dropped (iOS-only). The Coach will call a frontier model **directly from the app** (user's key in the iOS Keychain, Phase 3); backup is an **encrypted iCloud snapshot** (Phase 4). The app runs **fully offline except for AI features**. No backend, no auth, no personal data in any cloud; the only recurring cost is model tokens. See the ADRs in `docs/decisions.md` and the phased plan in **`docs/architecture-migration.md`**. Remaining pivot work: the Face-ID app lock (Phase 2) and the direct on-device Coach (Phase 3).

> **Parallel-build integration status (2026-07-26).** Six windows built in parallel. **Integrated + gated:** Data tab (Frame A), Settings + unit switching, **Protocols** (no migration), **Screenings + medical calendar** (0007), and the **agentic Coach** (model client + tool-use loop + proactive insights + reminders — migrations **0008/0009**, renumbered up from 0005/0006 at integration to sit above Screenings' 0007, forward-only). **Still building:** Exercise (Phase-1 spec done) and Nutrition (first slice shipped, migrations 0008–0010 — ⚠️ those numbers now collide with the Coach's; the integrator will renumber Nutrition's block to free slots above `0009` when it integrates). Migrations on `main`: `0001–0004`, `0007–0009`.

**Legend:** ✅ done · 🚧 in progress · 📋 planned (v1) · 🧊 later · ⚠️ needs a decision or has a caveat

> How to read this: the **To-Do** list is the work queue. The **Status Board** is the honest snapshot of what actually runs today. **Design & Styling** is the source of truth for the visual system. When these three disagree with the code, the code wins — fix the doc.

---

## 1. To-Do

### Local-first migration — phases (`docs/architecture-migration.md`)
- [x] **Phase 0** — schema ported Postgres → SQLite (`db/migrations/0001_init.sql`), **validated against real SQLite** (20 checks); `op-sqlite` + `sqliteVec` installed
- [x] **Phase 1 (largely done)** — migration runner (`PRAGMA user_version`), the local data-access layer (`Database` interface + repositories), and a **pre-migration `VACUUM INTO` backup** are all built and confirmed on device; Home's mission + the entire Log tab (command field, keypad, Capture, Nutrition, Exercise, Symptoms) read/write the DB. **Remaining:** wiring the Coach to the DB is Phase 3 (it's still a mock).
- [x] **Phase 2 (Supabase removal, done 2026-07-25)** — the dead Supabase client island (`supabase.ts`, `env.ts`, `use-session.ts`, `types/database.ts`, `login.tsx`, `gen-types.mjs`, `@supabase/supabase-js` + `async-storage` deps, `db:push`/`db:types`) was deleted in the full-app review. **Still to do:** Face ID app lock (`expo-local-authentication`).
- [ ] 📋 **Phase 3** — Coach calls the model directly (Keychain key via `expo-secure-store`, provider/model picker); on-device `sqlite-vec` RAG
- [ ] 📋 **Phase 4** — media (PhotoKit references for progress pics; compressed in-app copies for food logs) + encrypted iCloud backup
- [ ] 🧊 **Phase 5** — writable knowledge base + Coach research
- **Offline principle:** everything works with the network unplugged **except AI features** (Coach chat, LLM lab-PDF parse, food-photo analysis, Coach research). The lone non-AI online dependency is air-quality data; purchases stay manual (auto-import would need a server).

> **This is an unordered catalogue, not a sequence.** It lists everything known to be wanted; the owner picks what to build next as they go, so nothing here implies "do this before that". The `📋 / 🧊` marks are rough appetite (concrete-next vs. someday), not a queue position. Grouping is by domain, for findability. The full product vision this is measured against is `Health App Idea` (the owner's source brief); the reconciliation that seeded the newer items is the 2026-07-24 ADR in `docs/decisions.md`.

### Device / builds
- [x] Development-build config (`eas.json` + `expo-dev-client`) — see `docs/dev-build.md`
- [x] Diagnosed the Expo Go SDK-57 incompatibility (single-SDK runtime handshake)
- [ ] ⚠️ 📋 **First iOS dev build** — needs a paid Apple Developer account ($99/yr); free `eas go` bridge available meanwhile
- [ ] 📋 EAS account + `eas login` (user)
- [x] **Dev rebuild for `op-sqlite`** — done; persistence is confirmed on device (the data layer runs). No new native deps have been added since (the Log/Nutrition/Exercise/Symptoms work is all JS + SQL migrations; the pre-migration backup uses SQLite `VACUUM INTO`, no extra module), so **no rebuild is needed to run the current app**. Batch the next rebuild with `expo-secure-store` / `expo-local-authentication` when Phases 2–3 add them.

### Foundation & tooling
- [x] Expo SDK 57 + Expo Router + TypeScript (strict) scaffold
- [x] NativeWind 4 (Tailwind v3) with ARC design tokens
- [x] ESLint (expo config, React Compiler rules) + Prettier
- [x] `.env` support with build-time `EXPO_PUBLIC_*` handling
- [x] Five-tab navigation shell (Home · Coach · Log · Data · Settings)
- [x] ~~Supabase client~~ — built early, then **deleted 2026-07-25** with the local-first pivot (see App access below)
- [x] `.gitattributes` for cross-machine line endings
- [ ] 📋 Test runner (Jest + React Native Testing Library) — **none installed yet**
- [ ] 📋 CI (typecheck + lint + schema apply on push)
- [ ] 🧊 EAS build profiles for device/TestFlight
- [x] **Data-ownership posture decided** — CLAUDE.md §2's "local-first or strongly encrypted" is being *adopted*, not deferred: on-device data, encrypted iCloud backup, no cloud personal data (2026-07-24 ADR). Execution tracked in the migration phases above.

### Database (on-device SQLite)
- [x] v1 schema designed — 10 core tables, FKs, indexes, CHECK constraints (`docs/data-model.md`)
- [x] Built + verified as Postgres (37 PGlite tests) — now **superseded** by the SQLite port below; the Postgres file stays in git history as the origin
- [x] **Ported to SQLite** (Phase 0): `db/migrations/0001_init.sql` — enums→text+CHECK, uuid→text (app-generated), timestamps→ISO-8601 text; **RLS / grants / auth wiring / `user_id` tenancy all dropped** (one user, one device); composite FKs collapsed to simple ones
- [x] **Validated against real SQLite** (`npm run db:validate`) — 20 checks: schema executes, inserts across all 10 tables, forward FK, `updated_at` triggers (no recursion), enum/JSON/GLOB/range CHECKs reject bad data, ON DELETE SET NULL / CASCADE semantics, idempotency unique, NOT-NULL ids, body-metric bounds
- [x] `op-sqlite` installed + `sqliteVec` enabled (engine + on-device vector search)
- [x] **Migration runner** (Phase 1) — versioned SQL on boot via `PRAGMA user_version`, transactional, behind a testable interface (`src/lib/db/migrate.ts`); `npm run db:test` 9/9
- [x] **Data layer + repositories** (Phase 1) — `Database` interface + op-sqlite client (`src/lib/db/`), mission repository, hand-authored types; `npm run db:test` data-layer 17/17
- [x] Seed the biomarker reference catalogue locally (12 starter biomarkers, idempotent)
- [x] **Feature tables added as their screens went real:** `meals` (0002), `workouts` + `workout_sets` (0003, ON DELETE CASCADE), `symptoms` (0004), `screenings` + `appointments` (0007, preventive-screening ledger + medical calendar), and the Coach's `ai_conversations` + `ai_messages` (0008, append-only turns with a per-turn tool-call record) + `reminders` (0009). Schema of record is now **19 tables across 7 migrations** (`0001–0004`, `0007–0009`); each has its repository + headless tests. (Nutrition's food tables land as that branch integrates. The Coach's migrations were renumbered from 0005/0006 → 0008/0009 at integration to stay above Screenings' 0007 — forward-only.)
- [x] **Pre-migration backup wired** — `backupBeforeMigrate` (`client.ts`) snapshots the DB via SQLite `VACUUM INTO` before any migration touches existing data (no new native dep; warns-and-proceeds on failure). Supersedes the throwing stub; Phase 4's encrypted iCloud backup supersedes this.
- [~] 🚧 `ai_conversations` / `ai_messages` (migration **0005**) + `reminders` (**0006**) — **in progress** (Coach window). `experiments` still later.
- [x] ~~Supabase Storage bucket for lab PDFs~~ — **dropped**; the original PDF becomes a local / iCloud file, referenced by `lab_reports.file_path` (Phase 4)
- [x] **Preventive screenings + medical calendar** (built 2026-07-26, parallel window) — `screenings` + `appointments` (migration **0007**): cadenced preventive items (interval_months, last_completed, stored/derived next_due) + one-off calendar events (`screening_id` FK, SET NULL). Browse screen `/screenings` (grouped by due status + upcoming appointments, add/edit forms) reached from the Data tab; `dueScreenings()` is the seam Home's "what's due" card will consume (not yet surfaced there). OS-calendar sync / notifications deferred (native deps). `npm run db:test` screenings 44.
- [ ] 📋 **Lab breadth** — add `microbiome` (and other missing) values to `biomarker_category`; a biological-age / epigenetic-clock representation. Today's 11-category enum can't store either (brief §2)
- [~] 📋 **Exercise as measured data** — **started**: `workouts` + `workout_sets` (0003) store sessions, sets, reps, and canonical-kg loads (the Exercise screen). Still to add: VO2max, mobility, balance, and progressive-overload analytics over that data (brief §2).
- [~] 🧊 **Food model** — **started**: the `meals` table (0002) stores per-meal kcal + macros (the Nutrition screen). Still to add: pantry status, recipe bank, food-photo (CAL-AI-style) analysis records (brief §2).
- [ ] 🧊 **Environment & lifestyle** — screen time, social connection, substances (only air quality is noted today) (brief §2)
- [ ] 🧊 Future tables: genetics, cognitive, progress photos

### App access (no accounts — local-first)
- [x] ~~Auth gate · email sign-in · `/login` · redirect · sign-out~~ — **cut**: a single-user on-device app has no accounts. `useSession`, `app/login.tsx`, and the Supabase client were **deleted 2026-07-25**.
- [ ] 📋 **App lock** — Face ID / passcode on open (`expo-local-authentication`), Phase 2. The device + OS are the security boundary, not row policies.
- [ ] 📋 **Provider / model / API-key settings** — editable in-app, key held in the iOS Keychain (`expo-secure-store`), Phase 3

### Home screen
- [x] Five-section IA on mock data (`docs/home-screen.md`)
- [x] Derived "Do this next" hero (completing it advances the screen)
- [x] Header redesign (2026-07-24): date-only above the hero; readiness verdict + pillar segment bar (mock-up option D) moved below it
- [x] **Porcelain Ledger restyle** (2026-07-24): full app retheme — new tokens, serif/mono voices, light-only; philosophy in §3, alternatives archived in `docs/design-directions.md`
- [x] **De-boxing pass** (2026-07-24, after device review): section-dividing hairlines removed from the date and the metrics strip; quick actions dock cut entirely
- [x] **Chronological mission** (2026-07-24): one time-sorted list, category demoted to a row label; leading run of finished items auto-collapses so the list opens at *now* (`derive-mission.ts` owns sort + fold)
- [x] **Mission reads/writes the on-device DB** (Phase 1b): `useTodayMission` → `daily_logs` / `log_entries`; status persists across launches; foreground refresh handles the midnight rollover
- [x] **Mission state persisted** — status lives in the DB (only snooze is ephemeral); mock-day is the first-run seed, marked `seed:true` and purgeable
- [ ] 📋 Readiness / brief / metrics still mock — land with wearables + the Coach
- [ ] 📋 Remaining designed states: travel · sick/deload · data-gappy · first-run
- [ ] 📋 **Mode override** (Travel/Sick/Social/Manual) — needs the override model *and* a home in the UI; the dock button that used to stand in for it is gone (2026-07-24 ADR)
- [ ] 🧊 Snooze/skip → surface incomplete items intelligently later in the day

### AI Coach
> ✅ **Integrated (2026-07-26) — the *agentic* Coach is real.** Not just a chatbot: a direct streaming model call (`expo/fetch`, latest Claude), a **tool-use loop** that reads *and writes* the app through tools (consequential writes go through a **pending-write confirmation card**), **proactive insights**, **reminders**, and persisted threads (migrations 0008/0009). Behind an in-session API key (Keychain deferred, native); the honest mock is the fallback when no key is set. Built + adversarially reviewed; the HIGH backdate-corruption bug and the abort audit-gap were fixed pre-merge. **Two known follow-ups tracked** (spawned task, 2026-07-26): (1) make the Coach honor `UnitPreferences` (today it hardcodes lb/oz/in — mis-stores unqualified input for a kg/cm/ml user and shows lb where the Data tab shows kg); (2) single-source its trend math — `src/lib/ai/series.ts` recomputes body/training aggregations with different day/week definitions than the Data tab, so "this week" can disagree between the Coach and the Exercise tab. Both are latent for the imperial default. The full tool surface + capability spec lives in `docs/ai-coach.md`.
- [x] Chat interface with message send, streaming replies, retry (`docs/ai-coach.md`)
- [x] System prompt encoding the ARC Coach personality (`src/lib/ai/system-prompt.ts`)
- [x] Daily-brief placeholder (opens the thread; same text as the Home card)
- [x] Service seam (`src/lib/ai/coach-service.ts`) — honest mock today, one swap to a direct on-device model call later (Phase 3)
- [~] 🚧 **Wire the real model** — call the frontier provider **directly from the app** (latest Claude, `expo/fetch` streaming), key injected (in-memory this-session paste now; Keychain later). In progress. *(No Edge Function — that was the old cloud plan.)*
- [~] 🚧 Persist conversations to local `ai_conversations` / `ai_messages` (migration 0005) — in progress
- [~] 🚧 **Tool calling** (read trends/labs/logs, log captures, set reminders, …) — now **core**, in progress (was 🧊)
- [ ] 🧊 RAG over user history + longevity knowledge base
- [ ] 🧊 **Writable knowledge base** — the user can add/edit entries, and the Coach can do its own research to expand the corpus over time (grows the longevity knowledge plane, not just reads it)
- [ ] 🧊 **Vector DB for Coach long-term memory** (brief §7 names it explicitly; pairs with RAG)
- [ ] 🧊 **Predictive alerts** — flag a trend before the user would notice (brief §2; causal insights already noted in `ai-coach.md`)
- [ ] 🧊 n-of-1 experiment engine
- [ ] 🧊 Multi-modal input — voice logging, later vision (documented in `ai-coach.md`, unbuilt)

### Data domains (CLAUDE.md §4 lists these by intent; not a build sequence)
- [ ] 📋 **Labs** — Function Health PDF → structured extraction pipeline
- [x] **Daily logs** — the Log tab is real (fast capture: notes, metrics, water, weight, supplements/therapies, meals, workouts, symptoms), all persisting on-device. Habits are completed on Home's mission.
- [~] **Protocols** — the versioned stack/routine **editor is built** (2026-07-26, parallel build): `app/protocols.tsx` (list, pushed from Data's "The full file") + `app/protocol-edit.tsx` (create/edit; every content save is a new immutable `protocol_versions` row, no-op saves skipped). Repo `src/lib/db/repositories/protocols.ts` over the 0001 tables (no new migration); tests `db/protocols.test.mjs` (46). **Still to come: the protocol→mission generator** (active protocols → the day's `log_entries` on Home — flagged seam in the repo header) and the Coach's protocol tool.
- [ ] 📋 **Wearables** — **Apple Health as the hub** (on-device, offline for ARC; the vendor app does the cloud sync) → `wearable_data`; direct vendor API only where HealthKit lacks fidelity (e.g. WHOOP). **Terra dropped** — it's a cloud aggregator that needs a server, which breaks offline/no-server.
- [~] 📋 **Hydration tracking** (owner call, 2026-07-25) — a first-class daily metric. **Manual quick-add is built**: the Water tile → keypad with additive Glass/Bottle/Large estimates, stored in `wearable_data` (metric_type `water_ml`, canonical ml, `source_device='manual'`), with a running "N oz logged today" summary. **Automatic ingest is still to do** — ideally a smart bottle (HidrateSpark or similar) via **Apple Health** (its app syncs the bottle → HealthKit → ARC reads it, staying offline/no-server, consistent with the wearables hub); it lands on the same `water_ml` rows, so no migration.
- [ ] 🧊 **Write data back to Apple Health** (owner call, 2026-07-25) — ARC as a HealthKit *source*, not just a reader (e.g. push weight, workouts, hydration, supplement/med intake so other apps see them). Requires a **feasibility + importance assessment first** (HealthKit write scopes, which metric types are worth writing, privacy implications) — deferred until that's done.
- [~] **Nutrition · Supplements/Therapies · Body composition** — capture is real (meals with macros; supplement/therapy sheet; weight/body-fat/waist via the keypad → `body_metrics`). Still to come: the deeper Nutrition/Exercise sub-app features and the Data-tab dashboards/trends over all of it.
- [~] **Data tab** — Frame A "Standing Ledger" is **live** (`app/(tabs)/data.tsx`, 2026-07-26): the 12 seeded biomarker reference ranges + four live trend rows (Weight/Nutrition/Training/Symptoms, sparklines reading real on-device data) + a manage/browse index, plus a pushed **Labs** screen (`app/labs.tsx`). Still to come: real lab *values* (needs the PDF pipeline), wearable history (needs Apple Health), and deeper per-domain dashboards.

### Reporting, export & knowledge (from the brief; newly tracked 2026-07-24)
- [ ] 📋 **Data export** — CLAUDE.md §2 promises "easy export" as a non-negotiable; nothing implements or schedules it yet (brief §2)
- [ ] 🧊 **Progress reporting** — exportable periodic reports / accountability summaries (brief §2)
- [ ] 🧊 **Education / knowledge base module** — a *browsable* longevity reference in-app; today this exists only as a RAG corpus the Coach reads, not something the user can open (brief §2)

### Screens still to build
- [x] **Log tab** — direction A built **and wired to the on-device DB** (2026-07-25): the command field parses one-line entries offline (`weight 178`, `16 oz water`) and saves everything else as a note; the 6 quick-add tiles route (Nutrition/Workout → sub-apps, Water/Weight → keypad, Supplement/Therapy → capture); a "Log a symptom" row; "Logged today" reads live from the DB, newest-first, reloading on focus. Repos: `src/lib/db/repositories/logs.ts`, registry `src/lib/log/metrics.ts`, parser `src/lib/log/parse.ts`; `npm run db:test` log-layer 57.
- [x] **Metric keypad** drill-in — single-number entry (Weight / Water / Body-fat / Waist / HRV / RHR / Dose), **persisting** to `body_metrics` / `wearable_data` / `log_entries` in canonical units; Water gets additive quick-estimates (Glass / Bottle / Large) above the pad; live "recent" line per metric.
- [x] **Nutrition** sub-app screen — **real** (2026-07-25, parallel build): manual meal entry persists to a `meals` table (migration 0002, canonical macros); "Today" card sums the day, "Eaten today" lists it. Photo/text-AI logging (Phase 3, Coach), templates, grocery/pantry/recipes still to come.
- [x] **Exercise** sub-app screen — **real** (2026-07-25, parallel build): workouts + sets persist (migration 0003, `workouts` + `workout_sets`, weight canonical kg, ON DELETE CASCADE); live/past session logging via `app/workout-log.tsx`; week summary + recent sessions read live. Templates / progressive-overload analytics still to come.
- [x] **Capture sheet** (Supplement / Therapy) — **real** (2026-07-25): one-tap quick-log strip + manual add persist to `log_entries` (ad-hoc), shown in "Logged today".
- [x] **Symptom logging** (owner priority, built 2026-07-25) — `app/symptom.tsx` (common-symptom chips, 1–10 severity, note) persists to a `symptoms` table (migration 0004); reached from the Log tab's "Log a symptom" row; surfaces in "Logged today". Voice/NL symptom capture arrives with the Coach (Phase 3).
- [~] **Unit switching** (owner call, 2026-07-25) — **shipped for weight (lb/kg), volume (oz/ml), and length (in/cm)** (2026-07-26): Settings › Units toggles persist to `users.preferences`; the metric registry's `resolveDisplay` (`src/lib/log/metrics.ts`) drives display, honored by the keypad, the command parser, the Log feed, and the Data-tab weight trend. Storage stays canonical SI (no migration). **Distance (mi/km) and temperature (°F/°C) are stored but not yet consumed** — they light up when workouts-with-distance and environment/temperature metrics land.
- [ ] 📋 **Modes** (Normal/Travel/Sick/Deload/Social/Custom) on Home — adapts plan, priorities, Coach tone, adherence accounting; needs the override model (`docs/information-architecture.md`)
- [x] **Data tab** — Frame A "Standing Ledger" built (2026-07-26): live trends + biomarker reference ranges + manage index, + pushed **Labs** screen (see the Data-domains list above).
- [~] **Settings tab** — **real** (2026-07-26): a sectioned screen with live **Profile** editing (name/DOB/sex/timezone → `users` table) and **Units** (the unit-switching toggles above). Deferred rows are shown as disabled "Soon"/"Needs a build" chips: Coach model & API key (lands with the Coach's Keychain wiring), App lock (Face ID, native), Apple Health (native), backup/restore (Phase 4), data export.

> **Information architecture** — where every feature lives (5 tabs + pushed sub-screens), the Log-tab spec, and the Modes model: `docs/information-architecture.md` (locked 2026-07-25).

---

## 2. Status Board

### App as a whole
**🚧 Foundation, well underway — local-first and iOS-only.** The app builds for iOS (+ a web bundle kept only for logic-check previews). The **local data layer is live**: on-device SQLite via `op-sqlite`, a versioned migration runner (4 migrations, 14 tables), repositories, and a pre-migration `VACUUM INTO` backup — all confirmed running on device. **Home's mission and the whole Log-tab capture surface** (command field + offline parser, metric keypad, Capture, Nutrition, Exercise, Symptoms) read and write real data. Supabase is fully removed; the tree is iOS-only. The **Data** tab (Frame A "Standing Ledger") and the **Settings** tab (Profile + Units, with live lb/kg · oz/ml · in/cm switching that storage stays canonical under) are now real too. Four of five tabs read/write live data; only the **Coach** is still a mock model (its real agentic build is in an unmerged parallel branch). Home's readiness/brief/metrics remain mock (need wearables + Coach). Not yet a full daily tool, but the capture spine, the review surface, and preferences are real and persistent.

### Subsystems
| Area | Status | Notes |
| --- | --- | --- |
| Build & tooling | ✅ | tsc, lint, prettier all green; iOS + web bundle (iOS-only target) |
| Navigation shell | ✅ | Five tabs + not-found, file-based routing (no `/login` — single-user) |
| Design system | ✅ | Tokens defined and compiling; see §3 |
| Database schema | ✅ | **Ported to SQLite** (`db/migrations/0001_init.sql`), 20-check validation; Postgres origin retired |
| Local DB engine | ✅ | `op-sqlite` + `sqliteVec` running on device (persistence confirmed); migration runner + repositories + seed + pre-migration backup; op-sqlite isolated to `client.ts`. 7 migrations, 19 tables |
| DB types | ✅ | Hand-authored row types (`src/lib/db/types.ts`); the Supabase generator is deleted |
| Supabase client | ✅ | **Deleted 2026-07-25** (dead island removed in the full-app review) |
| **Home screen** | 🚧 | Mission reads/persists via the DB; readiness/brief/metrics still mock |
| **Coach** | ✅ | **Agentic** — real streaming model call (expo/fetch) + a tool-use loop that reads *and writes* the app through tools (consequential writes confirmed via a pending-write card), proactive insights, reminders, and persisted threads (0008/0009). Key is pasted in-session (Keychain deferred, native); the honest mock is the fallback when no key is set |
| App lock | 📋 | Face ID / passcode on open — Phase 2 (replaces the cut auth gate) |
| Log | ✅ | Fully wired: command field (offline parse), metric keypad, Capture (Supplement/Therapy), Nutrition, Exercise, and Symptoms all persist; "Logged today" reads live. Sub-apps are real (meals / workouts+sets / symptoms), not mockups. Deeper features (photo/text-AI, templates, builder) are follow-ups |
| Nutrition / Exercise / Symptoms | ✅ | Real capture — `meals` (0002), `workouts`+`workout_sets` (0003), `symptoms` (0004); manual entry persists, summaries read live |
| Data | ✅ | **Frame A "Standing Ledger"** — live trends (Weight/Nutrition/Training/Symptoms sparklines from real data), the 12 seeded biomarker reference ranges, a manage/browse index, + pushed **Labs**, **Protocols**, and **Screenings** screens. Real lab values + wearable history await their pipelines; the screen + trend reads are real |
| Settings | ✅ | **Real** — Profile (name/DOB/sex/timezone) + Units (lb/kg · oz/ml · in/cm live; mi/km · °F/°C stored, not yet consumed). Coach-key / app-lock / Apple-Health / backup / export shown as disabled "Soon" rows |
| Protocols | ✅ | Versioned stacks/routines — repo + editor (`app/protocols.tsx`, `protocol-edit.tsx`), no migration (tables ship in 0001), reached from Data. The protocol→mission generator is still to come |
| Screenings | ✅ | Preventive screenings + medical calendar (`screenings`/`appointments`, migration 0007) — browse + forms, reached from Data. Home "due" surfacing still to wire |
| Labs pipeline | 📋 | Not started |
| Wearables | 📋 | Not started; schema ready. Apple Health hub (Terra dropped) |
| Media / photos | 📋 | PhotoKit refs (progress pics) + compressed copies (food) — Phase 4 |
| iCloud backup | 📋 | Encrypted snapshot + restore — Phase 4 |
| Tests / CI | 🚧 | No app-level runner/CI yet, but the data layer has headless `node:sqlite` tests (`npm run db:test`: 9 migrate + 17 data-layer + 61 log + 20 nutrition + 26 exercise + 11 symptoms + 17 body/biomarkers + 29 trend-series + 14 user + 17 units + 46 protocols + 44 screenings + 19 ai-chat + 18 reminders + 48 coach-tools + 21 insights + 35 model-client = **452 across 17 suites**) plus schema validation (`db:validate`, 20) |

### Infrastructure
- **None required (local-first).** No backend to run or pay for; the only external calls are to the AI provider, made directly from the app. Recurring cost = model tokens (+ $99/yr Apple).
- **Supabase project (owner action):** the client code is **deleted**; the previously-created cloud project is now fully orphaned. Decommissioning it (a one-click owner action) revokes the still-bundled-in-`.env` anon key — worth doing.
- **`.env`:** the `EXPO_PUBLIC_SUPABASE_*` vars are no longer read by any code (safe for the owner to delete from `.env`). The model API key lives in the iOS Keychain, never in `.env`.

### Known caveats (things that will bite if forgotten)
- ⚠️ **`op-sqlite` is a native module** — the dev build that includes it is done (persistence runs on device). The current app needs no rebuild, but **adding any new native dep** (`expo-secure-store`, `expo-local-authentication`, …) will require a fresh `eas build` — batch them.
- ⚠️ **SQLite needs `PRAGMA foreign_keys = ON` per connection** (it defaults OFF) — the data layer must set it on every open, or the FKs in `0001_init.sql` silently won't enforce. `recursive_triggers` must stay OFF (default) so `updated_at` triggers don't recurse.
- ⚠️ The **Coach is a mock** — `src/lib/ai/coach-service.ts` returns a scripted, honest-preview reply with simulated streaming. No model, no data. `isCoachKeyConfigured` gates the "Preview" affordance; Phase 3 wires the direct, on-device model call.
- ⚠️ **Chat state is in-memory** — a reload resets the Coach thread (persistence lands with the real Coach, Phase 3). Home's mission and the Log feed already persist to the DB.
- ⚠️ **op-sqlite's `wrap()` adapter (`client.ts`) has no automated coverage** — the headless tests run against `node:sqlite`, a different engine. It's exercised on device (persistence works), but changes to the adapter (or the `VACUUM INTO` backup, which also only runs on device) are unverified by CI — test them on device.
- ⚠️ **Coach keyboard offset unverified (2026-07-25 review)** — on iOS the composer may float above the keyboard by the tab-bar height. The usual fix (`useBottomTabBarHeight` from `@react-navigation/bottom-tabs`) is **blocked by expo-router 57's no-`@react-navigation`-imports guard** (it fails the bundle). Verify on device; if it's wrong, derive the offset from the safe-area inset + tab-bar height rather than importing react-navigation.
- ⚠️ `.env` lives at the main-repo root too; it's protected via `.git/info/exclude`, but that file isn't shared — re-add the ignore on other machines.

---

## 3. Design & Styling — Porcelain Ledger

> **The philosophy in one line:** ARC is a beautifully printed lab report that happens to be alive.

Chosen 2026-07-24 from a six-direction exploration (all six specs archived in `docs/design-directions.md` — read that file before proposing any new visual direction). The interface earns trust the way a well-set medical document does: typography, whitespace, hairline rules, and one deep pine-green stamp of authority. Nothing glows, nothing gamifies, nothing is decorated. Bone-white paper is the identity; it will look the same in twenty years, which is the point of an app built for decades.

**How to make something look like ARC:** set it on paper, wrap it in a hairline, headline it in serif, print its numbers in mono, and only reach for pine if it is the one thing that matters on the screen.

Tokens live in `tailwind.config.js` (source of truth for every `className`) and are mirrored in `src/constants/theme.ts` for the few APIs that need literal colour strings (navigation theme, icon `color` props). **Any palette change must touch both files.**

### Colour

| Token | Hex | Meaning and use |
| --- | --- | --- |
| `paper` | `#F6F3EC` | The page. Every screen's background. Bone-white, slightly warm. |
| `paper-deep` | `#EFEADD` | Recessed paper: input fields, quiet chips (the PREVIEW badge). |
| `porcelain` | `#FDFCF8` | Card surface — a shade whiter than the page, like coated stock. Cards sit *on* paper. |
| `hairline` | `#E3DCCE` | The default rule: **card borders**. Not for slicing the page into sections — see "rules enclose objects" below. |
| `hairline-soft` | `#EFEADD` | Row separators inside a list (mission rows). |
| `hairline-strong` | `#C9C0AC` | Ghost-button borders, unchecked checkbox rings. |
| `ink` | `#1C1917` | Primary text. Warm near-black, never pure black. |
| `ink-secondary` | `#544E45` | Supporting text: briefs, item "why" lines, details. |
| `ink-muted` | `#8B8272` | Incidental: eyebrows, labels, timestamps, disabled, completed items. |
| `pine` | `#1E5C46` | **The one accent.** See discipline rule below. |
| `pine-on` | `#F8F6EF` | Text/icons on solid pine. |
| `pine-soft` | `#E7EEE6` | The hero card's background — the only tinted surface in the app. |
| `pine-tint` | `#CBDCCB` | The hero card's side/bottom border. |
| `signal-optimal` | `#22684E` | Readiness: optimal. |
| `signal-good` | `#77803A` | Readiness: good (olive). |
| `signal-caution` | `#B07C2A` | Readiness: caution. |
| `signal-poor` | `#96382C` | Readiness: poor. |
| `signal-unknown` | `#8B8272` | No data — same value as ink-muted, deliberately. |

> **The pine discipline rule (sacred):** pine appears on exactly five things — the "Do this next" hero (its soft surface, top rule, eyebrow, and Done button), primary actions (send button, a card's single CTA like "Open chat"), **completion stamps** (checkmark circles, the mission progress fill — completion is what pine *means*), the user's own chat bubbles, and the active tab. Plus two sanctioned micro-accents: the 1.5px "Coach presence" dot beside ARC-Coach eyebrows and the streaming caret. Nothing else. Not links-in-general, not decorations, not headings. If everything is emphasised, nothing is directive — the entire design stands on this restraint.

> Signal colours mark **biological states only** (readiness dot, segment bar, metric values carrying a verdict) — never UI chrome. Known accepted weakness from the design critique: `good` (olive) sits between `optimal` (green) and `caution` (amber) as a saturation slide rather than a distinct hue; direction F's categorical green/blue/gold/red taxonomy is the fix if the segment bar ever reads ambiguously on device.

### Light only — by decision, not omission
ARC is **light-mode only**: `userInterfaceStyle: "light"` in app.json, an unconditional nav theme in `app/_layout.tsx`, `StatusBar style="dark"`, and **zero `dark:` variants anywhere in the codebase** (a grep for `dark:` in app/ and src/ should return nothing — if it returns something, someone broke the system). Paper is the identity; a "dark porcelain" would be a different, worse design. If ARC ever needs a night mode, the archived **Night Watch (B)** direction is the designed candidate — it would be a second complete theme, not `dark:` variants bolted onto this one. See the ADR in `docs/decisions.md`.

### Typography — three voices
| Voice | Family | Used for | Class |
| --- | --- | --- | --- |
| **Serif** (authority) | Iowan Old Style → Palatino → Georgia (iOS system serifs) | Headlines, screen titles, the readiness verdict, "Today's Mission", "Today is handled" | `font-serif font-semibold` |
| **Sans** (voice) | System default | Body text, briefs, item titles, buttons, chat | (default) |
| **Mono** (data) | Menlo → Courier New | **Every measured value**: times (07:15), counters (3 of 11), metric values (42 ms), hero metadata line, segment-bar labels, the PREVIEW badge | `font-mono` |

The serif/mono split carries meaning: **serif speaks, mono measures.** A number set in mono is a datum; if you find a standalone measurement in sans, fix it. One deliberate exception: numbers **inside prose** (the readiness detail line, the Coach's sentences) stay sans — splitting fonts mid-sentence reads worse than the rule is worth. Eyebrows are 11px uppercase with `tracking-[2px]` (the "2px tracking" of the spec — not `tracking-widest`, which is em-relative).

> ⚠️ **Font-stack gotcha (cost an hour):** define `fontFamily` in tailwind.config.js as a plain **array** of family names. Do NOT use `nativewind/theme`'s `platformSelect` — its custom-function CSS syntax cannot carry a family name containing spaces, and "Iowan Old Style" silently compiled to an **empty declaration** (verified in the bundle's style registry). Plain CSS stacks parse correctly; native picks the first family.

### Shape & rhythm
- Cards: `rounded-card` (10px). Buttons: `rounded-btn` (6px). **No pills, no 24px super-rounding** — this is print, not bubblegum. Chat bubbles use `rounded-card` with one squared corner (`rounded-br-sm` user / `rounded-bl-sm` coach) like a ledger tab.
- **No shadows, no elevation, no glow — anywhere.** Layering is done with hairline borders and the paper/porcelain two-tone.
- The hero is "a stamped ledger entry": `border border-pine-tint` + `border-t-[3px] border-t-pine` on `bg-pine-soft`.
- **Rules enclose objects, never pages** (owner call, 2026-07-24, after device review). A hairline is correct on a **card edge** and **between rows of one list**, because both times it is drawing the boundary of a single object. A rule laid across the page to separate two sections is furniture: put one above a short block and one below it and you have drawn a box around it — which is exactly what the owner flagged. **Sections are separated by whitespace only.** If a section can't hold its own without a rule, it needs a heading or more air, not a line.
- Section rhythm on Home: `mt-5`–`mt-9`; airy density is part of the calm, and since the de-boxing pass it is the *only* thing separating sections, so don't tighten it casually.
- One shared container: `Screen` (`src/components/ui/screen.tsx`) — safe-area, `px-5` gutter, `bg-paper`.
- Tap targets are whole rows/cards; the IA target is ≤ 2 taps to act.

### Surface treatments (the recipes)
- **Card:** `rounded-card border border-hairline bg-porcelain p-4`.
- **Hero:** pine-soft + pine top rule (above); serif title; mono metadata; Done = solid pine `rounded-btn`; Snooze = `border-hairline-strong` ghost; Skip = bare muted text.
- **Eyebrow:** `text-[11px] uppercase tracking-[2px] text-ink-muted` (+ `font-medium` when it labels a section). The date eyebrow is bare — no folio rule under it (see "rules enclose objects" above).
- **Segment bar:** flat `h-[6px]` rectangles, `rounded-[1px]`, `gap-0.5`, mono-caps labels beneath. A typeset gauge, not a chart.
- **Mission row:** hairline-soft separators; pine-filled circle when done; times in mono; completed text drops to ink-muted.
- **Chat:** user = solid pine slip, right; coach = bordered porcelain slip, left. The Coach reads as typeset prose, not chat froth.
- **Metrics:** mono `text-lg font-semibold` values coloured by signal only when they carry a verdict; labels are eyebrows. No section heading — every cell already carries a caps label, and stacking caps on caps is noise; the 2×2 grid is its own boundary.

### Patterns worth reusing
- **Derived emphasis:** the hero isn't authored separately — it's the first unresolved mission item (`src/lib/home/derive-mission.ts`). One source of truth, so the UI can't contradict itself.
- **Whole-string class maps** for dynamic styles (`src/components/home/signal.tsx`): Tailwind only sees class names that appear literally in source — never build `bg-signal-${level}`.
- **Explicit hairlines**, not `divide-y` — that utility needs a CSS sibling selector RN doesn't have.

### Open design questions
- ⚠️ **Serif rendering on device** — Iowan Old Style at 600 weight on a real iPhone; if it renders as fake-bold or too bookish, Palatino is the next candidate in the stack. *Not raised in the 2026-07-24 device review, which is weak evidence it's fine — the owner was looking at boxes, not letterforms. Still unconfirmed.*
- ⚠️ **Pine-soft hero on paper** — enough contrast between `#E7EEE6` and `#F6F3EC` at real brightness? If the hero doesn't pop, deepen pine-soft before reaching for shadows (there are no shadows). *Same caveat: not raised, not confirmed.*
- ⚠️ **Does the metrics strip still land without its rule?** It is now the last thing on the screen with nothing but whitespace above it. If it reads as orphaned rather than quiet, the fix is more space or a serif heading — not the rule back.
- 📋 Extract shared primitives (Card, Eyebrow, GhostButton) once a third screen needs them, not before.
- 📋 Ionicons work but read slightly rounded against the print aesthetic; a stroke-consistent set is a candidate refinement.

---

## Related documents
- `CLAUDE.md` — product brain, principles, conventions
- `docs/design-directions.md` — the six explored visual directions + critique; A (Porcelain Ledger) chosen
- `docs/data-model.md` — schema intent + what shipped
- `docs/decisions.md` — architecture decision records
- `docs/home-screen.md` — Home IA + implementation notes
- `docs/ai-coach.md` — Coach spec
- `docs/dev-build.md` — device runbook (EAS dev build)
- `docs/folder-structure.md` — where code goes
