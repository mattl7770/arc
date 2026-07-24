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
- [ ] 📋 Read from `daily_logs` / `log_entries` instead of mock
- [ ] 📋 Persist mission state (currently in-memory only)
- [ ] 📋 Remaining designed states: travel · sick/deload · data-gappy · first-run
- [ ] ⚠️ Wire up the "Mode" quick action (Travel/Sick/Social/Manual) — present but inert
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

## 3. Design & Styling

**North star:** calm, precise, premium, directive. The opposite of a hype-y consumer wellness app. Restraint is the aesthetic — the design should feel like a well-made instrument, not a dashboard.

Tokens live in `tailwind.config.js` (source of truth for `className`) and are mirrored in `src/constants/theme.ts` for the few APIs that need literal colour strings (navigation, status bar). **Keep those two in sync.**

### Colour

**Neutral ramp — `ink`** (cool, low-chroma greys; the whole UI is built from these):
`50 #F6F7F9` · `100 #ECEEF2` · `200 #D9DDE4` · `300 #B8BFCB` · `400 #8C96A7` · `500 #697386` · `600 #525B6B` · `700 #3E4552` · `800 #252B35` · `900 #151A21` · `950 #0B0F14`

**Accent — `accent` (teal)** · `DEFAULT #3FA7A0` · `muted #2C7A75` (light-mode text) · `soft #E4F2F1` (hero background)
> **The rule:** accent marks the single most important action on a screen, and the user's own voice/input — nothing else. On Home that is the "Do this next" hero. In Coach it is the user's message bubbles and the send button; the Coach itself replies in neutral ink, because it is a considered voice, not a chat buddy. If everything is emphasised, nothing is directive.

**Signal — readiness / adherence** · `optimal #4BA07A` · `good #7FB069` · `caution #D9A441` · `poor #C4614C` · `unknown #697386`
> Used for the readiness dot, pillar dots, and metric values that carry a verdict. Carried consistently everywhere a status appears.

### Light & dark
Both are first-class, driven by the OS setting (`userInterfaceStyle: "automatic"`, NativeWind `darkMode: media`). Every surface pairs a light and a `dark:` class.
> ⚠️ Do **not** set `darkMode: 'class'` in the Tailwind config — it silently disables every `dark:` variant until something sets a `dark` class, on native as well as web. (Learned the hard way; see commit `8c316ef`.)

Typical surface pairing:
```tsx
className="bg-white dark:bg-ink-950"      // page
className="bg-ink-50 dark:bg-ink-900"     // card
className="text-ink-900 dark:text-ink-50" // primary text
className="text-ink-500 dark:text-ink-400"// secondary text
className="border-ink-100 dark:border-ink-800" // hairline
```

### Type scale (measured on the running Home screen)
| Role | Size / weight | Class | Tracking |
| --- | --- | --- | --- |
| Screen verdict / hero title | 24px / 600 | `text-2xl font-semibold` | tight |
| Metric value | 20px / 600 | `text-xl font-semibold` | tight |
| Section heading | 18px / 600 | `text-lg font-semibold` | tight |
| Body | 15px / 400 | `text-[15px]` | normal |
| Secondary / caption | 13px / 400 | `text-[13px]` | normal |
| Eyebrow / label | 11–12px / 500, UPPERCASE | `text-xs uppercase tracking-widest` | wide |

Headlines use `tracking-tight`; uppercase eyebrows use `tracking-widest`. Numbers use `tabular-nums` so they don't jitter as values change.

### Layout & rhythm
- One shared container: `Screen` (`src/components/ui/screen.tsx`) — safe-area aware, `px-5` gutter, themed background.
- Vertical rhythm between major sections: **`mt-7` to `mt-9`**. Generous whitespace is part of "calm."
- Corners: cards `rounded-3xl`, controls/pills `rounded-full`, small chips `rounded-2xl`.
- Tap targets are whole rows/cards where possible — the IA target is ≤ 2 taps to act.

### Patterns worth reusing
- **Derived emphasis:** the hero isn't authored separately — it's the first unresolved item (`src/hooks/use-mission.ts`). One source of truth, so the UI can't contradict itself.
- **Whole-string class maps** for dynamic styles (`src/components/home/signal.tsx`): Tailwind only sees class names that appear literally in source, so map to complete strings rather than building `bg-signal-${level}`.
- **Explicit hairlines**, not `divide-y` — that utility needs a CSS sibling selector RN doesn't have.

### Open design questions
- ⚠️ **Vertical rhythm** on Home — does the section spacing read as calm or sparse on a real device? (Needs your eye.)
- ⚠️ **Coach voice** — does the low-recovery brief hit "calm, precise, slightly ruthless"? It sets the tone for the real Coach.
- 📋 No component library yet beyond `Screen` / `Placeholder` — extract shared primitives (Card, Pill, Row) once a second screen needs them, not before.
- 📋 Iconography is Ionicons for now; revisit if a more distinctive set fits the "instrument" feel.
- 🧊 Typography is system default; a custom display face is a later, deliberate choice.

---

## Related documents
- `CLAUDE.md` — product brain, principles, conventions
- `docs/data-model.md` — schema intent + what shipped
- `docs/decisions.md` — architecture decision records
- `docs/home-screen.md` — Home IA + implementation notes
- `docs/ai-coach.md` — Coach spec (next build)
- `docs/folder-structure.md` — where code goes
