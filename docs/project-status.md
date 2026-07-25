# ARC — Project Status & Tracker

**Living document.** This is the running board for what's done, what's next, and how the app is put together. Update it in the same change that changes reality — a status line that lies is worse than none.

**Last updated:** 2026-07-24
**Current phase:** Foundation
**Branch:** `claude/expo-project-scaffold-d14e9e`

> ⚠️ **Architecture pivot (2026-07-24): local-first, no-server, offline-except-AI.** ARC is moving off cloud Supabase to **on-device SQLite** (`op-sqlite` + `sqlite-vec`), with the Coach calling a frontier model **directly from the app** (user's key in the iOS Keychain, swappable in Settings) and **encrypted iCloud backup**. The app runs **fully offline except for AI features**. No backend, no auth, no personal data in any cloud; the only recurring cost is model tokens. See the ADR in `docs/decisions.md` and the phased plan in **`docs/architecture-migration.md`**. **Phase 0 (schema port) is done** — items below that still mention Supabase/auth/RLS/`useSession` describe what remains in the *code* today and are retired phase-by-phase.

**Legend:** ✅ done · 🚧 in progress · 📋 planned (v1) · 🧊 later · ⚠️ needs a decision or has a caveat

> How to read this: the **To-Do** list is the work queue. The **Status Board** is the honest snapshot of what actually runs today. **Design & Styling** is the source of truth for the visual system. When these three disagree with the code, the code wins — fix the doc.

---

## 1. To-Do

### Local-first migration — phases (`docs/architecture-migration.md`)
- [x] **Phase 0** — schema ported Postgres → SQLite (`db/migrations/0001_init.sql`), **validated against real SQLite** (16 checks); `op-sqlite` + `sqliteVec` installed
- [ ] 📋 **Phase 1** — migration runner (`PRAGMA user_version`) + local data-access layer; wire Home & Coach to the DB instead of mock
- [ ] 📋 **Phase 2** — remove Supabase / RLS / `useSession`; Face ID app lock (`expo-local-authentication`)
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
- [ ] ⚠️ 📋 **Dev rebuild for `op-sqlite`** — it's a native module, so the JS-only dev client can't load it. The next `eas build` picks it up; the running app is unaffected until Phase 1 imports it. (Batch this with any other native deps — `expo-secure-store`, `expo-local-authentication` — added in later phases, to save rebuilds.)

### Foundation & tooling
- [x] Expo SDK 57 + Expo Router + TypeScript (strict) scaffold
- [x] NativeWind 4 (Tailwind v3) with ARC design tokens
- [x] ESLint (expo config, React Compiler rules) + Prettier
- [x] `.env` support with build-time `EXPO_PUBLIC_*` handling
- [x] Five-tab navigation shell (Home · Coach · Log · Data · Settings)
- [x] Supabase client (lazy, boots with no `.env`)
- [x] `.gitattributes` for cross-machine line endings
- [ ] 📋 Test runner (Jest + React Native Testing Library) — **none installed yet**
- [ ] 📋 CI (typecheck + lint + schema apply on push)
- [ ] 🧊 EAS build profiles for device/TestFlight
- [x] **Data-ownership posture decided** — CLAUDE.md §2's "local-first or strongly encrypted" is being *adopted*, not deferred: on-device data, encrypted iCloud backup, no cloud personal data (2026-07-24 ADR). Execution tracked in the migration phases above.

### Database (on-device SQLite)
- [x] v1 schema designed — 10 core tables, FKs, indexes, CHECK constraints (`docs/data-model.md`)
- [x] Built + verified as Postgres (37 PGlite tests) — now **superseded** by the SQLite port below; the Postgres file stays in git history as the origin
- [x] **Ported to SQLite** (Phase 0): `db/migrations/0001_init.sql` — enums→text+CHECK, uuid→text (app-generated), timestamps→ISO-8601 text; **RLS / grants / auth wiring / `user_id` tenancy all dropped** (one user, one device); composite FKs collapsed to simple ones
- [x] **Validated against real SQLite** — 16 checks: schema executes, inserts across all 10 tables, forward FK, `updated_at` triggers (no recursion), enum/JSON/GLOB/range CHECKs reject bad data, ON DELETE SET NULL / CASCADE semantics, idempotency unique
- [x] `op-sqlite` installed + `sqliteVec` enabled (engine + on-device vector search)
- [ ] 📋 **Migration runner** — apply versioned SQL on boot, tracked by `PRAGMA user_version` (Phase 1)
- [ ] 📋 Seed the biomarker reference catalogue locally (never populated)
- [ ] 📋 Local tables for `ai_conversations`, `ai_messages`, `experiments` (land with the Coach)
- [x] ~~Supabase Storage bucket for lab PDFs~~ — **dropped**; the original PDF becomes a local / iCloud file, referenced by `lab_reports.file_path` (Phase 4)
- [ ] 📋 **Preventive screenings + medical calendar** table(s) — colonoscopy, skin checks, imaging cadence, appointment tracking (brief §2; nothing exists today)
- [ ] 📋 **Lab breadth** — add `microbiome` (and other missing) values to `biomarker_category`; a biological-age / epigenetic-clock representation. Today's 11-category enum can't store either (brief §2)
- [ ] 📋 **Exercise as measured data** — VO2max, mobility, balance, progressive-overload metrics; today only a `training_block` protocol + `workout` log entry exist, training has no metrics of its own (brief §2)
- [ ] 🧊 **Food model** — pantry status, recipe bank, food-photo (CAL AI-style) analysis records (brief §2)
- [ ] 🧊 **Environment & lifestyle** — screen time, social connection, substances (only air quality is noted today) (brief §2)
- [ ] 🧊 Future tables: genetics, cognitive, progress photos

### App access (no accounts — local-first)
- [x] ~~Auth gate · email sign-in · `/login` · redirect · sign-out~~ — **cut**: a single-user on-device app has no accounts. `useSession`, `app/login.tsx`, and the Supabase client are removed in Phase 2.
- [ ] 📋 **App lock** — Face ID / passcode on open (`expo-local-authentication`), Phase 2. The device + OS are the security boundary, not row policies.
- [ ] 📋 **Provider / model / API-key settings** — editable in-app, key held in the iOS Keychain (`expo-secure-store`), Phase 3

### Home screen
- [x] Five-section IA on mock data (`docs/home-screen.md`)
- [x] Derived "Do this next" hero (completing it advances the screen)
- [x] Header redesign (2026-07-24): date-only above the hero; readiness verdict + pillar segment bar (mock-up option D) moved below it
- [x] **Porcelain Ledger restyle** (2026-07-24): full app retheme — new tokens, serif/mono voices, light-only; philosophy in §3, alternatives archived in `docs/design-directions.md`
- [x] **De-boxing pass** (2026-07-24, after device review): section-dividing hairlines removed from the date and the metrics strip; quick actions dock cut entirely
- [x] **Chronological mission** (2026-07-24): one time-sorted list, category demoted to a row label; leading run of finished items auto-collapses so the list opens at *now* (`useMission` owns sort + fold)
- [ ] 📋 Read from `daily_logs` / `log_entries` instead of mock
- [ ] 📋 Persist mission state (currently in-memory only)
- [ ] 📋 Remaining designed states: travel · sick/deload · data-gappy · first-run
- [ ] 📋 **Mode override** (Travel/Sick/Social/Manual) — needs the override model *and* a home in the UI; the dock button that used to stand in for it is gone (2026-07-24 ADR)
- [ ] 🧊 Snooze/skip → surface incomplete items intelligently later in the day

### AI Coach
- [x] Chat interface with message send, streaming replies, retry (`docs/ai-coach.md`)
- [x] System prompt encoding the ARC Coach personality (`src/lib/ai/system-prompt.ts`)
- [x] Daily-brief placeholder (opens the thread; same text as the Home card)
- [x] Service seam (`src/lib/ai/coach-service.ts`) — honest mock today, one swap to a direct on-device model call later (Phase 3)
- [ ] ⚠️ 📋 **Wire the real model** — call the frontier provider **directly from the app** with the Keychain key, streaming; rename `isCoachBackendLive` → `isCoachKeyConfigured` (Phase 3). *(No Edge Function — that was the old cloud plan.)*
- [ ] 📋 Persist conversations to local `ai_conversations` / `ai_messages` (needs the migration)
- [ ] 🧊 Tool calling (log_entry, update_protocol, …)
- [ ] 🧊 RAG over user history + longevity knowledge base
- [ ] 🧊 **Writable knowledge base** — the user can add/edit entries, and the Coach can do its own research to expand the corpus over time (grows the longevity knowledge plane, not just reads it)
- [ ] 🧊 **Vector DB for Coach long-term memory** (brief §7 names it explicitly; pairs with RAG)
- [ ] 🧊 **Predictive alerts** — flag a trend before the user would notice (brief §2; causal insights already noted in `ai-coach.md`)
- [ ] 🧊 n-of-1 experiment engine
- [ ] 🧊 Multi-modal input — voice logging, later vision (documented in `ai-coach.md`, unbuilt)

### Data domains (CLAUDE.md §4 lists these by intent; not a build sequence)
- [ ] 📋 **Labs** — Function Health PDF → structured extraction pipeline
- [ ] 📋 **Daily logs** — the Log tab (fast capture: habits, meals, supplements, …)
- [ ] 📋 **Protocols** — versioned stack/routine editor
- [ ] 📋 **Wearables** — **Apple Health as the hub** (on-device, offline for ARC; the vendor app does the cloud sync) → `wearable_data`; direct vendor API only where HealthKit lacks fidelity (e.g. WHOOP). **Terra dropped** — it's a cloud aggregator that needs a server, which breaks offline/no-server.
- [ ] 🧊 Nutrition · Supplements/Meds/Therapies · Body composition
- [ ] 📋 **Data tab** — biomarker trends, wearable history, body comp dashboards

### Reporting, export & knowledge (from the brief; newly tracked 2026-07-24)
- [ ] 📋 **Data export** — CLAUDE.md §2 promises "easy export" as a non-negotiable; nothing implements or schedules it yet (brief §2)
- [ ] 🧊 **Progress reporting** — exportable periodic reports / accountability summaries (brief §2)
- [ ] 🧊 **Education / knowledge base module** — a *browsable* longevity reference in-app; today this exists only as a RAG corpus the Coach reads, not something the user can open (brief §2)

### Screens still to build
- [ ] 📋 Log · Data · Settings (still placeholders)

---

## 2. Status Board

### App as a whole
**🚧 Foundation — a navigable shell mid-pivot to local-first.** The app builds for iOS/Android/web; Home and Coach are working slices on mock data / a mock model. As of 2026-07-24 the architecture is moving off cloud Supabase to **on-device SQLite** — Phase 0 (schema ported to SQLite and validated) is done; the local data layer, the real on-device Coach, and encrypted backup are the next phases (`docs/architecture-migration.md`). Three of five tabs are placeholders. Not yet a daily tool; on track as a foundation.

### Subsystems
| Area | Status | Notes |
| --- | --- | --- |
| Build & tooling | ✅ | tsc, lint, prettier all green; iOS + Android + web bundle |
| Navigation shell | ✅ | Five tabs + not-found, file-based routing (`/login` removed in Phase 2) |
| Design system | ✅ | Tokens defined and compiling; see §3 |
| Database schema | ✅ | **Ported to SQLite** (`db/migrations/0001_init.sql`), 16-check validation; Postgres origin retired |
| Local DB engine | 🚧 | `op-sqlite` + `sqliteVec` installed; data-access layer is Phase 1. Needs a dev rebuild (native module) |
| DB types | 📋 | Hand-authored from the SQLite schema in Phase 1; the Supabase generator retires |
| Supabase client | ⚠️ | Still in the tree; **removed in Phase 2**. Unused at runtime |
| **Home screen** | 🚧 | Full IA on **mock data**; not reading the DB, not persisted |
| **Coach** | 🚧 | Chat UX complete with streaming; behind a **mock model** (honest preview), not persisted |
| App lock | 📋 | Face ID / passcode on open — Phase 2 (replaces the cut auth gate) |
| Log | 📋 | Placeholder screen only |
| Data | 📋 | Placeholder screen only |
| Settings | 📋 | Placeholder screen only |
| Labs pipeline | 📋 | Not started |
| Wearables | 📋 | Not started; schema ready. Apple Health hub (Terra dropped) |
| Media / photos | 📋 | PhotoKit refs (progress pics) + compressed copies (food) — Phase 4 |
| iCloud backup | 📋 | Encrypted snapshot + restore — Phase 4 |
| Tests / CI | 📋 | No runner, no CI (schema has a standalone SQLite validation) |

### Infrastructure
- **None required (local-first).** No backend to run or pay for; the only external calls are to the AI provider, made directly from the app. Recurring cost = model tokens (+ $99/yr Apple).
- **Supabase project:** the previously-created cloud project is now **vestigial** — nothing depends on it. Free tier; the owner can delete it whenever.
- **`.env`:** the `EXPO_PUBLIC_SUPABASE_*` vars retire in Phase 2. The model API key lives in the iOS Keychain, never in `.env`.

### Known caveats (things that will bite if forgotten)
- ⚠️ **`op-sqlite` is a native module** — it can't load in the JS-only dev client. A fresh `eas build` is required before Phase 1's data layer will run on device.
- ⚠️ **SQLite needs `PRAGMA foreign_keys = ON` per connection** (it defaults OFF) — the data layer must set it on every open, or the FKs in `0001_init.sql` silently won't enforce. `recursive_triggers` must stay OFF (default) so `updated_at` triggers don't recurse.
- ⚠️ The **Coach is a mock** — `src/lib/ai/coach-service.ts` returns a scripted, honest-preview reply with simulated streaming. No model, no data. `isCoachBackendLive` gates the "Preview" affordance; Phase 3 wires the direct model call and renames it.
- ⚠️ Mission and chat state are both **in-memory** — a reload resets them (until the DB layer lands, Phase 1).
- ⚠️ **Supabase is still in the tree but unused at runtime** (`src/lib/supabase.ts`, `useSession`, `src/types/database.ts`, `db:push`/`db:types` scripts) — all removed in Phase 2. Don't build on them.
- ⚠️ `src/types/database.ts` is stale Supabase output — it's **replaced by hand-authored SQLite types in Phase 1**, not regenerated.
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
| **Serif** (authority) | Iowan Old Style → Palatino → Georgia (iOS system serifs; Android falls back to its default for now) | Headlines, screen titles, the readiness verdict, "Today's Mission", "Today is handled" | `font-serif font-semibold` |
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
- **Derived emphasis:** the hero isn't authored separately — it's the first unresolved mission item (`src/hooks/use-mission.ts`). One source of truth, so the UI can't contradict itself.
- **Whole-string class maps** for dynamic styles (`src/components/home/signal.tsx`): Tailwind only sees class names that appear literally in source — never build `bg-signal-${level}`.
- **Explicit hairlines**, not `divide-y` — that utility needs a CSS sibling selector RN doesn't have.

### Open design questions
- ⚠️ **Serif rendering on device** — Iowan Old Style at 600 weight on a real iPhone; if it renders as fake-bold or too bookish, Palatino is the next candidate in the stack. *Not raised in the 2026-07-24 device review, which is weak evidence it's fine — the owner was looking at boxes, not letterforms. Still unconfirmed.*
- ⚠️ **Pine-soft hero on paper** — enough contrast between `#E7EEE6` and `#F6F3EC` at real brightness? If the hero doesn't pop, deepen pine-soft before reaching for shadows (there are no shadows). *Same caveat: not raised, not confirmed.*
- ⚠️ **Does the metrics strip still land without its rule?** It is now the last thing on the screen with nothing but whitespace above it. If it reads as orphaned rather than quiet, the fix is more space or a serif heading — not the rule back.
- 📋 Extract shared primitives (Card, Eyebrow, GhostButton) once a third screen needs them, not before.
- 📋 Ionicons work but read slightly rounded against the print aesthetic; a stroke-consistent set is a candidate refinement.
- 🧊 Android serif (falls back to system default today) — decide when Android becomes real.

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
