# Architecture Migration — Cloud shell → Local-first, no-server

**Status:** Planned (not started) · **Decided:** 2026-07-24 · **ADR:** `docs/decisions.md` → "Local-first, single-user, no-server architecture"

This is the ordered plan to take ARC from its current cloud-Supabase shell to the local-first, server-less architecture the owner chose. Read the ADR first for the *why*; this doc is the *how*.

## The target, in one paragraph

Everything runs on the phone. Personal data lives in **on-device SQLite**; the Coach retrieves context with **`sqlite-vec`**; the model is called **directly from the app** with a user-supplied key in the **iOS Keychain**, swappable in Settings. The **knowledge base is on-device** and writable. Photos are **referenced from iOS Photos** or stored compressed. Backup is an **encrypted snapshot to iCloud**. No backend, no auth, no cloud personal data. Only recurring cost is model tokens (+ the $99/yr Apple membership any iOS app needs).

## The invariant

**The app builds and runs at the end of every phase.** No phase leaves `main` broken. Each phase is independently commit-able and reviewable on device.

## What survives untouched

The entire UI, the design system (Porcelain Ledger), the view-model types in `src/types/home.ts`, the Coach chat UX, and — crucially — **the schema itself**. We are porting the schema's *dialect*, not redesigning it. Table and column names stay identical, so screens and hooks barely move.

---

## Phase 0 — Foundations & schema port

- [ ] Add the on-device DB dependency. **Sub-decision:** `op-sqlite` (fastest, first-class loadable-extension support for `sqlite-vec`) vs `expo-sqlite` (purest Expo dependency surface, extension support is newer). *Lean: `op-sqlite`, for the `sqlite-vec` support.*
- [ ] Add `sqlite-vec`, `expo-secure-store` (Keychain), `expo-local-authentication` (Face ID), `expo-image-manipulator` (photo compression).
- [ ] **Port the schema** `supabase/migrations/…sql` → SQLite dialect, preserving every table/column name:
  - `enum` → `text` + `CHECK (col IN (...))`
  - `uuid` → `text` (generate with a uuid v4 helper at insert time)
  - `timestamptz` → `text` (ISO-8601) · `date` → `text` (`YYYY-MM-DD`) · `time` → `text` (`HH:MM`)
  - `jsonb` → `text` (JSON), parsed in the app
  - Drop RLS, `auth.*`, grants, and the `handle_new_user` trigger (no auth, no multi-tenancy). Keep `updated_at` triggers.
  - `user_id`: drop as a tenancy key. Keep columns only where a table genuinely needs them; a single-user app has an implicit owner.
- [ ] Land the ported schema as `db/migrations/0001_init.sql` (new home; the Supabase file stays in git history as the origin).

## Phase 1 — Local data layer

- [ ] **Migration runner:** apply versioned SQL on app boot, tracked by SQLite's `PRAGMA user_version`. Idempotent, forward-only.
- [ ] **Data-access layer** (`src/lib/db/…`): typed repository functions (read/write per domain) replacing Supabase queries. Hand-authored TS types from the SQLite schema replace the generated `database.ts` (the old generator retires).
- [ ] Wire **Home** and **Coach** to read/write the local DB instead of mock data (`mock-day.ts` becomes a one-time seed, or a dev-only fallback).
- [ ] Seed the biomarker reference catalogue locally.

## Phase 2 — Remove the cloud

- [ ] Delete the Supabase client, `useSession`-as-gate, RLS assumptions, and `EXPO_PUBLIC_SUPABASE_*` env wiring.
- [ ] App opens directly to Home — optionally behind a **Face ID** unlock (`expo-local-authentication`). That biometric gate *is* the auth model now.
- [ ] Remove `@supabase/*` deps; prune `.env.example`.
- [ ] The live Supabase project is now unused (free tier) — owner may delete it whenever; nothing in the app depends on it.

## Phase 3 — The Coach goes real, on-device

- [ ] **Settings screen:** provider + model picker + API-key field. Key stored via `expo-secure-store` (Keychain), **never** in plain storage or `.env`.
- [ ] Rewrite `coach-service.ts`: swap the mock for a **direct streaming call** to the chosen provider with the stored key. Rename `isCoachBackendLive` → something like `isCoachKeyConfigured` (the gate is "has the user pasted a key", not "is a server up").
- [ ] **On-device RAG** with `sqlite-vec`: vector tables for (a) personal history and (b) the knowledge base. At query time the app retrieves relevant slices locally and assembles the prompt client-side.
  - **Sub-decision — embeddings source:** simplest is to embed via the provider's embedding endpoint at write time (cheap, needs network), store the vector locally. A fully-offline on-device embedding model is a later nicety, not a blocker.
- [ ] Persist conversations to the local `ai_conversations` / `ai_messages` tables (their migration lands here, in SQLite).

## Phase 4 — Media & backup

- [ ] **Photos:** capture → either a **PhotoKit reference** + thumbnail (photo stays in iOS Photos / iCloud Photos, zero duplication) or a compressed (~1024px, HEIC) copy in the app's document dir. Default to the reference approach to keep the app's footprint at ~just structured data.
- [ ] **Encrypted iCloud backup:** snapshot the SQLite file, encrypt with a Keychain-held key, write to the app's iCloud container. **Restore** flow on fresh install. The existing "data export" backlog item is the manual sibling of this.
- [ ] Retention: keep hot recent data at full fidelity; downsample old high-res wearable samples so the DB stays lean.

## Phase 5 — Later (tracked, not now)

- [ ] **Writable knowledge base:** the user adds/edits entries, and the Coach does its own research to expand the corpus (see `project-status.md` §1).
- [ ] Predictive alerts · n-of-1 experiments · voice logging · vision analysis of food photos.

---

## Cross-cutting cleanup (do as touched, not in a big-bang)

- [ ] **CLAUDE.md §3** (stack: drop Supabase, state on-device SQLite) and **§9** (DB conventions: the whole RLS / `auth.uid()` / `user_id`-on-every-table section is Postgres-multi-tenant lore that no longer applies — replace with the SQLite conventions).
- [ ] **`docs/data-model.md`:** annotate as SQLite; note the dialect mapping.
- [ ] **`docs/project-status.md`:** the Supabase/auth/RLS to-do items are superseded by this plan; the status board's "Supabase / Auth / Storage" rows get reframed as "Local DB / App lock / iCloud backup".
- [ ] Retire `scripts/gen-types.mjs` and `db:types` / `db:push` (no live DB to generate from).

## Open sub-decisions (small, made at their phase)

1. `op-sqlite` vs `expo-sqlite` (Phase 0) — lean `op-sqlite`.
2. Embedding source: provider API vs on-device model (Phase 3) — lean provider API to start.
3. Photo storage: PhotoKit reference vs compressed copy (Phase 4) — lean reference.

None of these three is hard to reverse; the one irreversible choice (the DB engine, SQLite) is already made.
