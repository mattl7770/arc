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
- **Local-first, no-server, offline-except-AI** (adopted 2026-07-24, see `/docs/decisions.md`): personal data lives on-device; the app works with the network unplugged except for AI features; nothing personal sits at rest in any cloud. This is the concrete form of "full data ownership".
- Protocols are versioned and treatable like code
- The AI coach must be calm, precise, evidence-seeking, and slightly ruthless — never generic or hypey
- Every feature must either improve the daily operating system or stay completely out of the way
- Optimize for decades of use, not launch week metrics

---

## 3. Current Tech Stack

**Local-first, single-user, no-server** (pivoted 2026-07-24 from cloud Supabase — see the ADR and `docs/architecture-migration.md`):
- **iOS only** (owner call, 2026-07-25 — no Android target in any form; web kept only as a dev-time logic-check preview, never a shipped surface)
- Expo SDK 57 (React Native 0.86) + TypeScript (strict) + Expo Router
- **On-device SQLite via `op-sqlite`** (+ `sqlite-vec` for on-device RAG) — the whole data layer. No backend.
- NativeWind 4 (Tailwind v3) — chosen over Tamagui, see `/docs/decisions.md`
- **Frontier LLM called directly from the app**, key in the iOS Keychain (`expo-secure-store`), provider/model swappable in Settings. RAG + tools run client-side.
- **Apple Health** as the wearable hub (on-device; the vendor app does the cloud sync). Direct vendor API only where HealthKit lacks fidelity. *(Terra dropped — a cloud aggregator needs a server.)*
- Function Health as primary lab backend (PDF → on-device parse)
- **Backup:** encrypted iCloud snapshot; media referenced from iOS Photos (PhotoKit)

**Long-term consideration:** Native SwiftUI port once UX and data model are proven. (Local-first + on-device SQLite makes that port *easier*, not harder — no server contract to reproduce.)

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

Device choice is **undecided** (as of 2026-07) — candidates: Garmin (CIRQA), WHOOP, Ultrahuman ring, Oura ring. Rather than commit early, ARC stays device-agnostic; nothing in the code depends on the choice. (Relaxed from an earlier stated Oura/WHOOP preference to match the source brief — see the 2026-07-24 ADR in `/docs/decisions.md`.)

What is decided, and holds regardless of device:
- Always normalize every source into ARC’s own schema (`wearable_data.metric_type` is `text` precisely so a new vendor is not a migration)
- Support dual-device setups and source labeling
- Let the AI weight sources intelligently; prefer algorithm consistency where possible, but specialized quality can win
- **Apple Health is the ingestion hub** — it's on-device, so wearables stay offline for ARC (the vendor's own app does the cloud sync). Direct vendor API only where HealthKit lacks fidelity. **Terra is dropped**: a cloud aggregator needs a server, which breaks the offline/no-server architecture (2026-07-24).

---

## 9. Development Guidelines for AI Assistants

- Always read this file and `/docs` before major changes
- Prefer small, vertical, working slices
- Maintain clean TypeScript
- Set `PRAGMA foreign_keys = ON` on every DB connection (SQLite defaults it OFF) — see Database conventions below
- Write clear commit messages
- Update this CLAUDE.md and relevant docs when architecture decisions change
- When in doubt, optimize for long-term maintainability and clarity over cleverness
- Ask for clarification on product decisions rather than assuming

### Database conventions

The database is **on-device SQLite** (`op-sqlite`). The source of truth is `db/migrations/0001_init.sql`; rationale for each choice is in `/docs/decisions.md`, and the Postgres→SQLite port is `docs/architecture-migration.md`. *(The old Postgres/Supabase origin was deleted 2026-07-25; it survives in git history only.)*

- **Migrations** live in `db/migrations/NNNN_name.sql`, applied in order by the runner and tracked with `PRAGMA user_version`. Never edit a shipped migration; add the next number.
- **`PRAGMA foreign_keys = ON` on every connection** — SQLite defaults it OFF, and without it the FKs don't enforce. Keep `recursive_triggers` OFF (default) so the `updated_at` triggers don't recurse.
- **`text` primary keys holding app-generated v4 UUIDs**, no DB default, declared **`PRIMARY KEY NOT NULL`** — SQLite's `PRIMARY KEY` alone permits NULLs on a text key (and unlimited of them), so the `NOT NULL` is what makes a missing id fail loud instead of silently inserting a null-id row. Ids come from SQLite's `randomblob` (`src/lib/db/id.ts`), **not** `crypto.randomUUID()` — Hermes has no `crypto` global and Expo's runtime doesn't add one.
- **Timestamps are ISO-8601 `text`** (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), dates are `text` `YYYY-MM-DD`, times are `text` `HH:MM`. All sort chronologically as text, so ordering/indexing still works. GLOB `[0-9]` character classes check the shape (note: in GLOB `_` is literal — use `?` or `[0-9]`, not LIKE's `_`).
- **`created_at` + `updated_at` on every table**, stamped by a per-table `AFTER UPDATE` trigger. Exception: immutable tables like `protocol_versions` (no `updated_at`).
- **No `user_id`, no RLS, no auth** — one user on one device. The OS + app lock are the security boundary. If ARC ever goes multi-user, that's a schema migration then, not a shape carried now.
- **Enum vocabulary → `text` + `CHECK (col IN (...))`; vendor vocabulary → free `text`.** Wearable `metric_type` is free text so a new vendor metric isn't a migration.
- **JSON is `text` guarded by `CHECK (json_valid(col))`** (SQLite's json1 is built in).
- Deleting a protocol must never destroy execution history — prefer `ON DELETE SET NULL` over `CASCADE` for anything referencing a log.
- **Validate schema changes against real SQLite before shipping** — `npm run db:validate` runs the DDL headless via Node's built-in `node:sqlite` (that's how `0001_init.sql` was checked: 20 assertions over inserts, FKs, triggers, CHECKs, delete semantics, NOT-NULL ids and body-metric bounds).

---

## 10. Current Phase & Next Priorities

**Phase:** Foundation (July 2026)

> **Now pivoting to local-first (2026-07-24).** The authoritative, live picture is `docs/project-status.md`; the phased plan is `docs/architecture-migration.md`. The list below is the original foundation snapshot, annotated.

**Foundation milestones:**
1. ~~Solid project structure + this file~~ — **done.** Expo Router shell, five tabs, NativeWind, typed config.
2. ~~Schema v1~~ — **done, then ported.** Ten core tables built for Postgres, now **ported to on-device SQLite** (`db/migrations/0001_init.sql`, validated). `ai_conversations` / `ai_messages` / `experiments` still land with the Coach.
3. Function Health PDF → structured data pipeline (on-device parse)
4. ~~Authenticated app shell~~ — **cut.** No accounts in a single-user local app; a Face ID app lock replaces it (Phase 2). `useSession` / `app/login.tsx` are removed.
5. ~~First version of directive Home Screen~~ — **done** on mock data (chronological mission).
6. ~~Minimal AI Coach chat~~ — **done** as UX on a mock model; the real on-device model call is Phase 3.

**Infrastructure:** none required — local-first. The previously-created Supabase project is vestigial (delete whenever). The lab PDF becomes a local/iCloud file at `lab_reports.file_path`.

---

## 11. Key Documents

- `README.md` — Public/high-level overview
- `CLAUDE.md` — This file (AI brain)
- `/docs/project-status.md` — **Living tracker:** to-do queue, status board, design system. Start here for "where are we?"
- `/docs/data-model.md` — Detailed schema + what is actually shipped
- `/docs/information-architecture.md` — **Where every feature lives** (5 tabs + pushed sub-screens), the Log-tab spec, and the Modes model (locked 2026-07-25)
- `/docs/home-screen.md` — Home screen information architecture (detail)
- `/docs/ai-coach.md` — System prompt, tools, memory design
- `/docs/decisions.md` — Architecture Decision Records
- `/docs/architecture-migration.md` — **The local-first migration plan** (cloud → on-device), phased. Read before touching the data layer.
- `/docs/folder-structure.md` — Where code goes
- `db/migrations/0001_init.sql` — **The schema, source of truth** (on-device SQLite). `data-model.md` is the intent.
- *(The `supabase/` Postgres origin was deleted 2026-07-25 — it lives in git history only.)*

---

**Remember:**  
This is a personal system meant to run for decades. Clarity, ownership, and ruthlessly good daily UX beat feature count every time.

Now go build something excellent.
