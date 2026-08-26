# ARC

**Architecture for Resilience & Continuity** — a private, single-user operating system for longevity and healthspan.

ARC is not a wellness app. It is a personal command center: ingest high-quality data (labs, wearables, logs), maintain a clean versioned model of your biology, and surface the highest-leverage action every day.

The full product brief lives in [CLAUDE.md](CLAUDE.md). Architecture and specs live in [`/docs`](docs).

---

## Status

**Phase: Foundation.** ARC is **local-first, no-server, iOS-only**: all data lives in on-device SQLite (21 migrations, 36 tables, 25 repositories), and the app works with the network unplugged except for AI features. **All five tabs are real and read/write live data** — Home (a directive mission generated from your own protocols), Coach (an agentic assistant with 24 tools, confirmation-gated writes, and persisted threads), Log, Data, and Settings — plus 33 pushed sub-screens. There are no accounts and no `/login`; a Face ID app lock is the security boundary.

Still to come: the on-device RAG embedder, media + encrypted iCloud backup, an app-level test runner and CI, and a further EAS build for `react-native-svg`.

For the running to-do list, status board, and design system, see [docs/project-status.md](docs/project-status.md).

## Stack

| Concern    | Choice                                                          |
| ---------- | --------------------------------------------------------------- |
| App        | Expo SDK 57 · React Native 0.86 · TypeScript (strict)            |
| Navigation | Expo Router (file-based), JS bottom tabs                          |
| Styling    | NativeWind 4 (Tailwind v3) — see `tailwind.config.js`            |
| Data       | **On-device SQLite** via `op-sqlite` (+ `sqlite-vec` for RAG)     |
| Backend    | **None.** No server, no auth, no personal data in any cloud       |
| AI         | A frontier model called directly from the app; key in the iOS Keychain, provider/model swappable in Settings |

## Getting started

```bash
npm install
```

```bash
npm start
```

That's the whole setup. **No `.env` is required** — there is no backend to point at, and the model API key is entered in-app (Settings › Coach) and stored in the iOS Keychain, never in a file. The database is created and migrated on first launch.

> ARC targets a real iPhone via an EAS dev build (`docs/dev-build.md`). The web bundle exists only for quick logic checks — never judge look or behaviour by it.

## Scripts

| Script                 | Does                                          |
| ---------------------- | --------------------------------------------- |
| `npm start`            | Start the dev server                          |
| `npm run ios`          | Dev server, open iOS                          |
| `npm run typecheck`    | `tsc --noEmit`                                |
| `npm run lint`         | ESLint (expo config, incl. React Compiler)    |
| `npm run format`       | Prettier, with Tailwind class sorting         |
| `npm run doctor`       | Expo dependency / config health check         |
| `npm run db:bundle`    | Regenerate `migrations.generated.ts` from `db/migrations/` (run after adding one) |
| `npm run db:validate`  | Apply the schema headlessly and assert its invariants (20 checks) |
| `npm run db:test`      | Headless `node:sqlite` data-layer tests — 36 suites, 1,170 assertions |

## Layout

Defined in [docs/folder-structure.md](docs/folder-structure.md).

```
app/          Expo Router routes — (tabs)/ holds Home, Coach, Log, Data, Settings
src/lib/      Business logic: db/ (on-device SQLite), log/, ai/, home/, utils/
src/components/  ui/ = design primitives; home/, log/, coach/ = feature components
src/hooks/    Shared React hooks (use-today-mission, use-log-feed, use-coach-chat)
src/types/    Hand-authored view-model types (home, coach, log)
db/           SQLite migrations + headless validation/tests
docs/         Source of truth for architecture. Read before changing anything.
```

Business logic belongs in `src/lib` and `src/hooks`, never in components.

## Conventions

- The home screen is sacred: directive, never a dashboard. See [docs/home-screen.md](docs/home-screen.md).
- **Never fabricate data.** An empty day shows an honest empty state; the app does not invent plausible-looking history to fill a screen.
- Protocols are versioned and treated like code.
- Migrations are **forward-only** (`PRAGMA user_version`) — never edit a shipped one, and never number a new one below the head, or the runner skips it silently.
- One user, one device: no `user_id`, no RLS, no auth. The OS plus the app lock are the security boundary.
- Update `CLAUDE.md` and `/docs` in the same change as any architecture decision.
