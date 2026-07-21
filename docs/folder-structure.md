# Recommended Folder Structure (Expo + TypeScript)

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
│   ├── login.tsx
│   └── ...
├── src/
│   ├── components/
│   │   ├── home/
│   │   ├── coach/
│   │   ├── ui/                   # Design system primitives
│   │   └── ...
│   ├── lib/
│   │   ├── supabase.ts
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
│   └── folder-structure.md
├── supabase/
│   ├── migrations/
│   ├── functions/
│   └── seed.sql
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

## Key Rules

- Keep `CLAUDE.md` and `/docs` updated when architecture changes
- Business logic lives in `src/lib` and `src/hooks`, not in components
- Database types should be generated from Supabase where possible
- Prefer feature-based grouping inside `components/` as the app grows
