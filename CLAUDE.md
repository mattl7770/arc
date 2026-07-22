# CLAUDE.md — ARC Project Brain

**Last updated:** 2026-07-22  
**Project:** ARC — Architecture for Resilience & Continuity  
**Owner:** Matt  
**Type:** Personal longevity operating system (single-user, high-agency)

This file is the single source of truth for all AI coding assistants (Claude Code, Codex, Cursor, etc.). Read this fully before making any changes.

---

## 1. Vision

ARC is a private, exhaustive, AI-powered personal operating system for longevity and healthspan optimization. It is built primarily for one user (Matt) with extreme customization, full data ownership, and long-term extensibility.

It is **not** a consumer wellness app. It is closer to a personal command center + chief of staff + protocol engine.

**Core loop:**
1. Ingest high-quality data (labs, wearables, manual logs, genetics, photos, etc.)
2. Maintain a clean, versioned model of the user’s biology and behavior
3. Surface the highest-leverage actions every day through a ruthlessly directive home screen
4. Continuously improve protocols via n-of-1 experimentation and AI analysis

---

## 2. Non-Negotiable Principles

- **Actionability > Information density** on the home screen
- Full data ownership and easy export
- Prefer local-first or strongly encrypted patterns where reasonable
- Protocols are versioned and treatable like code
- The AI coach must be calm, precise, evidence-seeking, and slightly ruthless — never generic or hypey
- Every feature must either improve the daily operating system or stay completely out of the way
- Optimize for decades of use, not launch week metrics

---

## 3. Current Tech Stack

**Starting stack (velocity first):**
- Expo SDK 57 (React Native 0.86) + TypeScript (strict) + Expo Router
- Supabase (Postgres + Auth + Row Level Security + Storage + Edge Functions)
- NativeWind 4 (Tailwind v3) — chosen over Tamagui, see `/docs/decisions.md`
- Frontier LLMs via API (with strong RAG + tool calling)
- Apple Health / Health Connect as wearable hub
- Terra (or direct APIs) for Oura, WHOOP, Ultrahuman, etc.
- Function Health as primary lab backend (PDF ingestion)

**Long-term consideration:** Native SwiftUI port once UX and data model are proven.

---

## 4. Core Data Domains (v1 focus)

Prioritized order for implementation:

1. **Biomarkers / Labs** (Function Health PDFs + manual entry)
2. **Daily Logs & Habits** (the execution layer)
3. **Protocols** (versioned stacks, routines, meal templates, training blocks)
4. **Wearables** (sleep, HRV, recovery, strain, activity, temperature, etc.)
5. **Nutrition** (meals, templates, grocery lists, micronutrients)
6. **Supplements / Medications / Therapies**
7. **Body Composition & Progress** (weight, photos, DEXA, etc.)
8. **AI Coach Memory & Experiments**
9. Genetics, cognitive tests, environment, etc. (later)

---

## 5. Home Screen Philosophy (Sacred)

The home screen must answer one question extremely well:

> “What should I do right now, and what are the non-negotiables for today?”

**Structure (target):**
- Top status bar (recovery / key signals / biological age or multi-pillar status)
- Hero “Do this next” card
- Today’s Mission (ordered, dynamic checklist)
- AI Coach daily brief (short)
- Minimal live metrics
- Quick actions

Full data dashboards live elsewhere. Never let the home screen become a data dump.

---

## 6. AI Coach Requirements

- Name: Just “Coach” or “ARC Coach” for now
- Personality: Calm, precise, slightly ruthless, deeply familiar with the user, evidence-based
- Capabilities:
  - Daily brief generation
  - Proactive suggestions
  - Chat with full context
  - Protocol recommendations and versioning
  - n-of-1 experiment design
  - Correlation and insight generation
- Must use RAG over user history + curated longevity knowledge
- Must have tool access (logging, protocol updates, reminders, etc.)
- Safety: Never give definitive medical advice that should come from a doctor. Flag uncertainty.

---

## 7. Function Health Integration

- Primary source for comprehensive bloodwork (160+ biomarkers)
- Ingestion method: User downloads PDF → app parses via LLM/structured extraction → clean tables
- Store both raw PDF and structured data
- Support historical uploads and trend analysis
- Optimal ranges should be longevity-oriented where possible (not just lab “normal”)

---

## 8. Wearables Strategy

Preferred direction (as of 2026-07):
- Primary sleep/recovery: Oura or Ultrahuman ring
- Daytime/strain: WHOOP (or dual same-device strategy)
- Avoid heavy dependence on Apple Watch wrist feel
- Always normalize into ARC’s own schema
- Support dual-device setups and source labeling

---

## 9. Development Guidelines for AI Assistants

- Always read this file and `/docs` before major changes
- Prefer small, vertical, working slices
- Maintain clean TypeScript
- Use Supabase RLS properly (even for single user — good habit)
- Write clear commit messages
- Update this CLAUDE.md and relevant docs when architecture decisions change
- When in doubt, optimize for long-term maintainability and clarity over cleverness
- Ask for clarification on product decisions rather than assuming

### Database conventions

Follow the patterns already established in `supabase/migrations/`. Rationale for each is in `/docs/decisions.md`.

- **Migration filenames need a 14-digit timestamp** (`YYYYMMDDHHMMSS_name.sql`). Shorter prefixes are silently ignored by `supabase db push`. Use `supabase migration new <name>` to get it right.
- **Never hand-edit `src/types/database.ts`** — it is generated. Change the schema, push, then run `npm run db:types`.
- `uuid` primary keys with `gen_random_uuid()`; `timestamptz` for instants, `date` for calendar days, `time` for wall-clock.
- `created_at` + `updated_at` on every table, with a `set_updated_at()` trigger. The exception is immutable tables like `protocol_versions`.
- **`user_id` on every owned table**, so every RLS policy is a flat `auth.uid() = user_id` rather than a subquery through a parent. Where the column is denormalised, enforce it with a composite FK to the parent's `unique (id, user_id)`.
- **Enum when ARC owns the vocabulary, `text` when a vendor does.** Wearable `metric_type` is text for exactly this reason.
- RLS on every table: one `FOR ALL` policy, with `auth.uid()` wrapped as `(select auth.uid())` so Postgres evaluates it once per statement instead of once per row.
- Deleting a protocol must never destroy execution history — prefer `ON DELETE SET NULL` over `CASCADE` for anything referencing a log.

---

## 10. Current Phase & Next Priorities

**Phase:** Foundation (July 2026)

**Immediate priorities:**
1. ~~Solid project structure + this file~~ — **done.** Expo Router shell, five tabs, NativeWind, typed config.
2. ~~Supabase schema v1 (biomarkers, protocols, daily_logs, etc.)~~ — **done.** Ten core tables migrated with RLS; types generated. `ai_conversations`, `ai_messages` and `experiments` are still pending and land with the Coach.
3. Function Health PDF → structured data pipeline
4. Basic authenticated app shell + navigation — *partly done:* navigation and the session hook exist, but nothing gates the tabs yet and `app/login.tsx` is still a placeholder.
5. First version of directive Home Screen (even with mocked data)
6. Minimal AI Coach chat interface

**Live infrastructure:** a Supabase project exists with email auth and the Data API enabled. Storage is not set up yet — the `lab_reports.file_path` column is ready for it but nothing writes there.

---

## 11. Key Documents

- `README.md` — Public/high-level overview
- `CLAUDE.md` — This file (AI brain)
- `/docs/project-status.md` — **Living tracker:** to-do queue, status board, design system. Start here for "where are we?"
- `/docs/data-model.md` — Detailed schema + what is actually shipped
- `/docs/home-screen.md` — Information architecture
- `/docs/ai-coach.md` — System prompt, tools, memory design
- `/docs/decisions.md` — Architecture Decision Records
- `/docs/folder-structure.md` — Where code goes
- `supabase/migrations/` — The schema as built. The migration is the source of truth; `data-model.md` is the intent.
- `src/types/database.ts` — **Generated.** Never edit by hand; run `npm run db:types`.

---

**Remember:**  
This is a personal system meant to run for decades. Clarity, ownership, and ruthlessly good daily UX beat feature count every time.

Now go build something excellent.
