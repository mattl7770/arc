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
- environment_logs (air quality, etc.)

**Shipped since this list was written** — kept here rather than deleted so the list reads as a record of what happened, not only of what is left:

- ~~progress_photos~~ — **built 2026-08-12, migration 0035**, as `progress_photos` + `progress_photo_analyses` (`docs/progress-photos-subapp.md`). The image is a FILE under Documents and the row holds a bare NAME, the 0033 convention; weight context is a read-time date join, never a stored FK.
- ~~grocery_lists / recipes~~ — built 2026-08-12, migrations 0031 (`recipes`, `recipe_ingredients`) and 0032 (`grocery_items`, `grocery_name_prefs`); `docs/recipes-grocery.md`. They did **not** start as protocol content.
- ~~reminders / notifications~~ — built as `reminders` (0009).

---

## Notes

- Use UUIDs everywhere
- Heavy use of `created_at` / `updated_at`
- jsonb for flexibility in protocol content and log values
- Proper indexing on user_id + date fields
- Soft deletes where it makes sense later

---

## Implementation Status

**Shipped:** `db/migrations/0001_init.sql` (on-device SQLite) implements the ten v1 priority tables above — **this is the schema of record.** The Postgres/Supabase origin it was ported from was **deleted 2026-07-25** (git history only). Four feature tables were added 2026-07-25 as their screens went real: **`meals`** (0002, Nutrition), **`workouts`** + **`workout_sets`** (0003, Exercise, ON DELETE CASCADE), and **`symptoms`** (0004). **`screenings`** + **`appointments`** followed 2026-07-26 (0007, preventive screenings + medical calendar; `appointments.screening_id` → screenings, ON DELETE SET NULL so calendar history survives; `screenings.next_due` is stored, derived from `last_completed + interval_months` in the repository unless explicitly overridden). `ai_conversations`, `ai_messages` (0005) and `reminders` (0006) are in flight with the Coach (parallel window); `experiments` is specified but **not yet migrated**.

**Types are hand-authored** from the SQLite schema (`src/lib/db/types.ts` for rows; `src/types/*` for view-models). The old Supabase generator (`npm run db:types` → `src/types/database.ts`) and the generated file were **deleted 2026-07-25**.

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
