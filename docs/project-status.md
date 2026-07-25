# ARC — Project Status & Tracker

**Living document.** This is the running board for what's done, what's next, and how the app is put together. Update it in the same change that changes reality — a status line that lies is worse than none.

**Last updated:** 2026-07-22
**Current phase:** Foundation
**Branch:** `claude/expo-project-scaffold-d14e9e`

**Legend:** ✅ done · 🚧 in progress · 📋 planned (v1) · 🧊 later · ⚠️ needs a decision or has a caveat

> How to read this: the **To-Do** list is the work queue. The **Status Board** is the honest snapshot of what actually runs today. **Design & Styling** is the source of truth for the visual system. When these three disagree with the code, the code wins — fix the doc.

---

## 1. To-Do

### Device / builds
- [x] Development-build config (`eas.json` + `expo-dev-client`) — see `docs/dev-build.md`
- [x] Diagnosed the Expo Go SDK-57 incompatibility (single-SDK runtime handshake)
- [ ] ⚠️ 📋 **First iOS dev build** — needs a paid Apple Developer account ($99/yr); free `eas go` bridge available meanwhile
- [ ] 📋 EAS account + `eas login` (user)

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

### Database
- [x] v1 schema migration — 10 core tables, RLS, triggers, indexes
- [x] Pushed to the live project (`20260722000000` applied)
- [x] Types generated from the live database
- [x] `db:push` / `db:types` scripts (Windows-safe)
- [ ] 📋 Migration for `ai_conversations`, `ai_messages`, `experiments` (lands with the Coach)
- [ ] 📋 Seed the biomarker reference catalogue (`supabase/seed.sql` is empty)
- [ ] 📋 Supabase Storage bucket for lab PDFs (wire up `lab_reports.file_path`)
- [ ] 🧊 Future tables: genetics, cognitive, progress photos, environment

### Auth & app shell
- [ ] ⚠️ 🚧 **Auth gate** — `useSession` + `/login` exist but nothing guards the tabs; `app/login.tsx` is a placeholder
- [ ] 📋 Real email sign-in / sign-up flow on `/login`
- [ ] 📋 Redirect unauthenticated users to `/login` from the root layout
- [ ] 📋 Sign-out + session surfacing in Settings

### Home screen
- [x] Six-section IA on mock data (`docs/home-screen.md`)
- [x] Derived "Do this next" hero (completing it advances the screen)
- [x] Header redesign (2026-07-24): date-only above the hero; readiness verdict + pillar segment bar (mock-up option D) moved below it
- [x] **Porcelain Ledger restyle** (2026-07-24): full app retheme — new tokens, serif/mono voices, light-only; philosophy in §3, alternatives archived in `docs/design-directions.md`
- [x] **De-boxing pass** (2026-07-24, after device review): section-dividing hairlines removed from the date and the metrics strip; quick actions dock cut entirely
- [ ] 📋 Read from `daily_logs` / `log_entries` instead of mock
- [ ] 📋 Persist mission state (currently in-memory only)
- [ ] 📋 Remaining designed states: travel · sick/deload · data-gappy · first-run
- [ ] 📋 **Mode override** (Travel/Sick/Social/Manual) — needs the override model *and* a home in the UI; the dock button that used to stand in for it is gone
- [ ] 🧊 Snooze/skip → surface incomplete items intelligently later in the day

### AI Coach
- [x] Chat interface with message send, streaming replies, retry (`docs/ai-coach.md`)
- [x] System prompt encoding the ARC Coach personality (`src/lib/ai/system-prompt.ts`)
- [x] Daily-brief placeholder (opens the thread; same text as the Home card)
- [x] Service seam (`src/lib/ai/coach-service.ts`) — honest mock today, one swap to an Edge Function later
- [ ] ⚠️ 📋 **Wire the real model** — Supabase Edge Function holding the provider key, streaming; flip `isCoachBackendLive`
- [ ] 📋 Persist conversations to `ai_conversations` / `ai_messages` (needs the migration)
- [ ] 🧊 Tool calling (log_entry, update_protocol, …)
- [ ] 🧊 RAG over user history + longevity knowledge base
- [ ] 🧊 n-of-1 experiment engine

### Data domains (per CLAUDE.md priority order)
- [ ] 📋 **Labs** — Function Health PDF → structured extraction pipeline
- [ ] 📋 **Daily logs** — the Log tab (fast capture: habits, meals, supplements, …)
- [ ] 📋 **Protocols** — versioned stack/routine editor
- [ ] 📋 **Wearables** — Terra / Apple Health / Health Connect → `wearable_data`
- [ ] 🧊 Nutrition · Supplements/Meds/Therapies · Body composition
- [ ] 📋 **Data tab** — biomarker trends, wearable history, body comp dashboards

### Screens still to build
- [ ] 📋 Log · Data · Settings (still placeholders)

---

## 2. Status Board

### App as a whole
**🚧 Foundation — a navigable shell with two real screens.** The app builds for iOS, Android and web, connects to a live Supabase backend, and both the Home screen and the Coach chat are working slices (on mock data / a mock model). Nothing is gated behind auth yet, and three of five tabs are placeholders. Not yet usable as a daily tool; on track as a foundation.

### Subsystems
| Area | Status | Notes |
| --- | --- | --- |
| Build & tooling | ✅ | tsc, lint, prettier, expo-doctor all green; iOS + Android + web bundle |
| Navigation shell | ✅ | Five tabs + `/login` + not-found, file-based routing |
| Design system | ✅ | Tokens defined and compiling; see §3 |
| Supabase client | ✅ | Lazy init; verified against the live project |
| Database schema | ✅ | 10 tables live with RLS; 37 behavioural tests pass |
| Generated types | ✅ | From the live DB; `public` schema byte-identical to local |
| **Auth** | ⚠️ 🚧 | Session hook + login route exist; **tabs are not gated**, login is a placeholder |
| **Home screen** | 🚧 | Full IA built on **mock data**; not reading Supabase, not persisted |
| **Coach** | 🚧 | Chat UX complete with streaming; behind a **mock model** (honest preview), not persisted |
| Log | 📋 | Placeholder screen only |
| Data | 📋 | Placeholder screen only |
| Settings | 📋 | Placeholder screen only |
| Labs pipeline | 📋 | Not started |
| Wearables | 📋 | Not started; schema ready |
| Storage (PDFs) | 📋 | Not set up; `file_path` column ready |
| Tests / CI | 📋 | No runner, no CI |

### Live infrastructure
- **Supabase project:** live, email auth enabled, Data API on. Migration `20260722000000` applied and in sync.
- **Storage:** not configured yet.
- **`.env`:** present in the worktree, verified — anon key valid, all 10 tables reachable, RLS blocks anon reads/writes.

### Known caveats (things that will bite if forgotten)
- ⚠️ The **Coach is a mock** — `src/lib/ai/coach-service.ts` returns a scripted, honest-preview reply with simulated streaming. No model, no data. `isCoachBackendLive` gates the UI's "Preview" affordance; flip it when the Edge Function lands.
- ⚠️ Mission and chat state are both **in-memory** — a reload resets them.
- ⚠️ `useSession` is imported by nobody yet, so **nothing touches Supabase at runtime** until auth is wired.
- ⚠️ `EXPO_PUBLIC_*` vars are inlined at build time — **restart the dev server** after editing `.env`.
- ⚠️ `src/types/database.ts` is **generated** — never hand-edit; run `npm run db:types`.
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
