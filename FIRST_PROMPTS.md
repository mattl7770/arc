# First Prompts for Claude Code / Codex

Use these in order after you copy the foundational files into your repo.

---

## Prompt 1 — Project Initialization

```
Read CLAUDE.md and all files in /docs carefully.

Then scaffold a clean Expo (TypeScript) + Expo Router project with the exact folder structure recommended in docs/folder-structure.md.

Include:
- Basic tab navigation (Home, Coach, Log, Data, Settings)
- Supabase client setup
- NativeWind (or Tamagui if you prefer — state your choice)
- Proper TypeScript config
- .env.example support
- A clean root layout and placeholder screens

Do not add extra features. Just make the skeleton excellent and aligned with the docs.
```

---

## Prompt 2 — Database Schema

```
Read docs/data-model.md and CLAUDE.md.

Create the initial Supabase migration for the v1 core tables:
- users
- biomarkers
- lab_reports
- lab_results
- protocols
- protocol_versions
- daily_logs
- log_entries
- wearable_data
- body_metrics

Use best practices: UUIDs, timestamps, proper foreign keys, indexes on user_id + date fields, and RLS enabled (even though single user).

Also generate corresponding TypeScript types.
```

---

## Prompt 3 — Home Screen Shell

```
Read docs/home-screen.md and CLAUDE.md.

Build the first version of the Home Screen with the exact information architecture described.

Use clean placeholder/mock data for now. Focus on layout, hierarchy, and making the “Do this next” + Today’s Mission feel directive and excellent.

Make it look premium and calm.
```

---

## Prompt 4 — Basic AI Coach

```
Read docs/ai-coach.md and CLAUDE.md.

Implement a basic Coach tab with:
- Chat interface
- Ability to send messages
- Simple system prompt incorporating the personality
- Placeholder for daily brief

Do not build full RAG or tools yet. Just the excellent chat UX foundation.
```

---

After these four, we will move to Function Health PDF parsing and real data flows.
