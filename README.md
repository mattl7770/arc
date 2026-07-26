# ARC

**Architecture for Resilience & Continuity** — a private, single-user operating system for longevity and healthspan.

ARC is not a wellness app. It is a personal command center: ingest high-quality data (labs, wearables, logs), maintain a clean versioned model of your biology, and surface the highest-leverage action every day.

The full product brief lives in [CLAUDE.md](CLAUDE.md). Architecture and specs live in [`/docs`](docs).

---

## Status

**Phase: Foundation.** Navigation, Supabase client, the live v1 schema, and the design system are in place, and the Home screen is a working slice on mock data. Auth isn't wired yet and the other four tabs are placeholders.

For the running to-do list, status board, and design system, see [docs/project-status.md](docs/project-status.md).

## Stack

| Concern    | Choice                                                |
| ---------- | ----------------------------------------------------- |
| App        | Expo SDK 57 · React Native 0.86 · TypeScript (strict)  |
| Navigation | Expo Router (file-based), JS bottom tabs               |
| Styling    | NativeWind 4 (Tailwind v3) — see `tailwind.config.js`  |
| Backend    | Supabase (Postgres · Auth · RLS · Storage · Functions) |

## Getting started

```bash
npm install
```

Copy the environment template and fill it in:

```bash
cp .env.example .env
```

The app boots without Supabase credentials so the shell is runnable immediately — `/login` reports whether your `.env` was picked up. Note that `EXPO_PUBLIC_*` vars are inlined at build time, so **restart the dev server** after editing `.env`; a hot reload is not enough.

```bash
npm start
```

## Scripts

| Script                 | Does                                          |
| ---------------------- | --------------------------------------------- |
| `npm start`            | Start the dev server                          |
| `npm run ios`          | Dev server, open iOS                          |
| `npm run android`      | Dev server, open Android                      |
| `npm run typecheck`    | `tsc --noEmit`                                |
| `npm run lint`         | ESLint (expo config, incl. React Compiler)    |
| `npm run format`       | Prettier, with Tailwind class sorting         |
| `npm run doctor`       | Expo dependency / config health check         |
| `npm run db:validate`  | Apply the schema headlessly and assert its invariants |
| `npm run db:test`      | Headless data-layer tests (migrate · repositories · log layer) |

## Layout

Defined in [docs/folder-structure.md](docs/folder-structure.md).

```
app/          Expo Router routes — (tabs)/ holds Home, Coach, Log, Data, Settings
src/lib/      Business logic: db/ (on-device SQLite), log/, ai/, home/, utils/
src/components/  ui/ = design primitives; home/, log/, coach/ = feature components
src/hooks/    Shared React hooks (use-today-mission, use-log-feed, use-coach-chat)
src/types/    Hand-authored view-model types (home, coach, log)
db/           SQLite migrations + headless validation/tests
supabase/     Postgres origin — HISTORY ONLY, superseded by db/ (do not build on it)
docs/         Source of truth for architecture. Read before changing anything.
```

Business logic belongs in `src/lib` and `src/hooks`, never in components.

## Conventions

- The home screen is sacred: directive, never a dashboard. See [docs/home-screen.md](docs/home-screen.md).
- Protocols are versioned and treated like code.
- RLS is enabled on every table, even though this is a single-user system.
- Update `CLAUDE.md` and `/docs` in the same change as any architecture decision.
