# ARC Data Model (v1)

**Status:** Draft — Foundation phase  
**Last updated:** 2026-07-24

This document defines the core schema for ARC. Keep it clean, normalized, and extensible.

> ⚠️ **Now SQLite, on-device (2026-07-24 pivot).** The live schema is `db/migrations/0001_init.sql`; this doc is the *intent*. The dialect changed (see `docs/architecture-migration.md` Phase 0): enums→`text`+CHECK, `uuid`→`text` (app-generated), timestamps→ISO-8601 `text`, `jsonb`→`text`+`json_valid()`. Most importantly, **`user_id`, RLS, and the auth wiring are gone** — one user on one device — so the composite FKs simplify to plain ones. Where the sections below say `uuid`, `timestamptz`, `user_id`, or RLS, read the SQLite equivalent.

---

## Design Principles

- Prefer clear, explicit tables over excessive JSON blobs (JSON is fine for flexible metadata)
- Everything important should be queryable
- Support versioning for protocols and stacks
- Track source of data (Function PDF, Oura, manual, AI-suggested, etc.)
- Single-user system, but design with clean ownership (user_id on everything)

---

## Core Tables (v1 Priority)

### users
- id (uuid, PK)
- email
- full_name
- date_of_birth
- biological_sex
- timezone
- created_at, updated_at
- preferences (jsonb)

### biomarkers
Reference table of known biomarkers.
- id
- slug (e.g. apo_b, hba1c, hs_crp)
- name
- category (cardiovascular, metabolic, hormone, inflammation, nutrient, etc.)
- unit
- description
- optimal_range_low / optimal_range_high (longevity-oriented)
- standard_range_low / standard_range_high
- higher_is_better (boolean | null)
- notes

### lab_results
- id
- user_id
- biomarker_id
- value (numeric)
- collected_at (date)
- lab_name (e.g. Function Health, Quest)
- report_id (FK to lab_reports)
- source (function_pdf, manual, api, etc.)
- notes
- created_at

### lab_reports
- id
- user_id
- source (function_health, etc.)
- collected_at
- file_path (storage path to original PDF)
- raw_extracted_json (jsonb)
- parsed_at
- notes

### protocols
Versioned protocols / stacks / routines.
- id
- user_id
- slug
- name
- description
- type (daily_routine, supplement_stack, meal_template, training_block, therapy_protocol, etc.)
- is_active
- current_version_id
- created_at, updated_at

### protocol_versions
- id
- protocol_id
- version_number
- content (jsonb) — flexible structure depending on type
- change_notes
- created_at
- created_by (user | ai)

### daily_logs
The execution layer.
- id
- user_id
- date (date)
- summary (text / AI brief)
- overall_adherence_score (optional)
- notes
- created_at, updated_at

### log_entries
Individual items logged against a day.
- id
- daily_log_id
- type (habit, meal, workout, supplement, therapy, metric, note, etc.)
- protocol_id (nullable)
- title
- status (pending, completed, skipped, partial)
- scheduled_time
- completed_at
- value (jsonb) — flexible payload
- source
- notes

### wearable_data
Normalized wearable metrics.
- id
- user_id
- date
- metric_type (sleep_score, hrv, rhr, strain, recovery, steps, spo2, temperature, etc.)
- value
- unit
- source_device (oura, whoop, ultrahuman, apple_watch, etc.)
- source_raw_id
- start_time / end_time (for sleep periods etc.)
- metadata (jsonb)
- created_at

### body_metrics
- id
- user_id
- measured_at
- weight_kg
- body_fat_pct
- muscle_mass_kg
- waist_cm
- etc.
- source
- notes

### ai_conversations
- id
- user_id
- title
- created_at, updated_at

### ai_messages
- id
- conversation_id
- role (user | assistant | system | tool)
- content
- tool_calls (jsonb)
- created_at

### experiments
n-of-1 experiments.
- id
- user_id
- title
- hypothesis
- start_date
- end_date
- status
- protocol_changes (jsonb)
- outcome_notes
- conclusion

---

## Future Tables (Not v1)

- genetics_variants
- cognitive_assessments
- progress_photos
- environment_logs (air quality, etc.)
- grocery_lists / recipes (can start as protocol content)
- reminders / notifications

---

## Notes

- Use UUIDs everywhere
- Heavy use of `created_at` / `updated_at`
- jsonb for flexibility in protocol content and log values
- Proper indexing on user_id + date fields
- Soft deletes where it makes sense later

---

## Implementation Status

**Shipped:** `db/migrations/0001_init.sql` (on-device SQLite) implements the ten v1 priority tables above — **this is the schema of record.** The original `supabase/migrations/20260722000000_initial_schema.sql` is the **superseded Postgres origin** (do not build on it). `ai_conversations`, `ai_messages` and `experiments` are specified but **not yet migrated** — they land with the Coach.

**Types are hand-authored** from the SQLite schema (Phase 1 of `docs/architecture-migration.md`). The old Supabase generator (`npm run db:types` → `src/types/database.ts`) is **retired**; that generated file is stale Supabase output pending removal — do not regenerate it.

> **Read the table below in light of the 2026-07-24 local-first pivot**, which removed `user_id`, RLS, auth and the `auth.users` linkage. Anything phrased around tenancy/RLS/auth describes the Postgres *origin's* rationale, not the shipped SQLite shape.

### Where the SQLite schema adds to / diverges from this spec

| Item | Note |
| --- | --- |
| No `user_id`, RLS, or auth | Single-user, on-device — dropped entirely. The composite `(id, user_id)` FKs collapse to simple FKs. |
| `users` is a one-row profile | No `auth.users` linkage and no signup trigger — just timezone / sex / DOB / preferences. |
| `updated_at` on all tables except `protocol_versions` | Versions are immutable by design; everything else gets an `AFTER UPDATE` trigger (non-recursive under the default `recursive_triggers=OFF`). |
| `text` PKs declared `PRIMARY KEY NOT NULL` | App-generated UUIDs; the `NOT NULL` is load-bearing — SQLite's `PRIMARY KEY` alone permits NULLs on a text key. |
| `unique (report_id, biomarker_id)` on `lab_results` | Re-parsing a PDF must not duplicate values. |
| `unique (source_device, source_raw_id)` on `wearable_data` | Idempotent device re-sync. |
| `bone_mass_kg`, `visceral_fat_rating`, `hip_cm` on `body_metrics` | Filling in the spec's "etc."; plus loose upper bounds restoring the Postgres `numeric` domains dropped by `numeric→real`. |
| Check constraints | Ordered ranges, 0–100 percentages, positive-and-bounded masses, enum vocab. Slug / `metric_type` shape now lives in the repository layer (SQLite has no portable regex). |

### Deliberate deviations

- **`wearable_data.metric_type` is `text`, not an enum.** Vendors add metrics on their schedule. See `/docs/decisions.md`.
- **`log_entries.scheduled_time` is `time`, not a timestamp.** The calendar date comes from the parent `daily_log`, so a 07:00 habit stays 07:00 across timezones.
- **`daily_logs.date` is a `date`.** "Today" is resolved in `users.timezone`.

This schema will evolve. When it does, update this document and note the change in `/docs/decisions.md`.
