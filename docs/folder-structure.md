# Recommended Folder Structure (Expo + TypeScript)

> **Local-first layout (updated 2026-07-24).** ARC is on-device SQLite with no backend — the data layer lives under `db/` and `src/lib/db/`, not Supabase. See the local-first ADR in `docs/decisions.md`.

```
arc/
├── app/                          # Expo Router app directory
│   ├── (tabs)/
│   │   ├── index.tsx             # Home Screen
│   │   ├── coach.tsx             # AI Coach
│   │   ├── log.tsx               # Quick logging
│   │   ├── data.tsx              # Dashboard / biomarkers / trends
│   │   └── settings.tsx
│   ├── _layout.tsx
│   └── ...                       # (no login.tsx — single-user, no auth; app lock instead)
├── db/                           # On-device SQLite — the source of truth
│   ├── migrations/               # NNNN_name.sql, applied in order (PRAGMA user_version)
│   └── validate-schema.mjs       # headless node:sqlite validator (npm run db:validate)
├── src/
│   ├── components/
│   │   ├── home/
│   │   ├── coach/
│   │   ├── ui/                   # Design system primitives
│   │   └── ...
│   ├── lib/
│   │   ├── db/                   # op-sqlite client, migration runner, repositories
│   │   ├── ai/
│   │   ├── wearables/
│   │   ├── labs/                 # Function PDF parsing etc.
│   │   └── utils/
│   ├── hooks/
│   ├── stores/                   # Zustand or equivalent
│   ├── types/
│   └── constants/
├── docs/                         # Project documentation (source of truth)
│   ├── data-model.md
│   ├── home-screen.md
│   ├── ai-coach.md
│   ├── decisions.md
│   ├── architecture-migration.md
│   └── folder-structure.md
├── supabase/                     # ORIGIN / HISTORY ONLY — superseded, do not build on it
│   └── migrations/
├── assets/
├── CLAUDE.md                     # AI brain — critical
├── README.md
├── package.json
├── app.json / app.config.ts
├── tsconfig.json
├── tailwind.config.js            # if using NativeWind
├── .env.example
└── .gitignore
```

*(`src/lib/supabase.ts` and `src/types/database.ts` still exist but are vestigial — removed as the Supabase client is torn out in the migration's later phases.)*

## Key Rules

- Keep `CLAUDE.md` and `/docs` updated when architecture changes
- Business logic lives in `src/lib` and `src/hooks`, not in components
- Database types are **hand-authored** from the SQLite schema (`db/migrations/`) — the Supabase generator is retired
- Prefer feature-based grouping inside `components/` as the app grows
