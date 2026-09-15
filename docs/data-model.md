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
- started_on (date, 0043) — the day the PHASE CLOCK starts
- carry_over (0|1, **0050**) — whether a missed item is re-offered on a later day
- checkoff_mode (strict | adjusting, **0050**) — whether a completion moves the every-N-days clock
- created_at, updated_at

The last three are **execution POLICY and live on the row, not in the version**,
for one reason stated three ways: editing the plan must not restart a titration
(0043), must not change whether yesterday's miss is still owed, and a version
*restore* must bring back the plan and not the policy. Both 0050 columns default
to today's behaviour (`0`, `'strict'`), so the migration changes nothing that
lands on a day. Full reasoning: `db/migrations/0050_protocol_carry_over.sql` and
`docs/spikes/protocol-carryover.md`.

### protocol_versions
- id
- protocol_id
- version_number
- content (jsonb) — flexible structure depending on type
- change_notes
- created_at
- created_by (user | ai)

**Content is schema 2** (`src/lib/protocols/types.ts`): ordered `phases`, each
with a `duration_days` (null = open-ended, legal only on the last), each holding
`items` of `{ id, title, scheduled_time, dose, notes, cadence, remind }`.
`cadence` is one of daily · specific weekdays · every-N-days · an N-per-week
quota. `remind` (**C10**) is whether the item asks iOS for a notification at its
`scheduled_time`; it is in the CONTENT, unlike the two policy columns above,
because it is a fact about one item and items exist nowhere else — so restoring
a version restores which items nudged you, and the diff says a reminder was
turned on. It is forced off whenever `scheduled_time` is null: a notification
needs a moment to fire at.

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

- ~~progress_photos~~ — **built 2026-08-12, migration 0036**, as `progress_photos` + `progress_photo_analyses` (`docs/progress-photos-subapp.md`). The image is a FILE under Documents and the row holds a bare NAME, the 0033 convention; weight context is a read-time date join, never a stored FK.
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
- **`daily_logs.date` is a `date`.** See "Which day is this" below.

### Which day is this — the one definition

Every `date` column in the schema (`daily_logs.date`, `meals.date`, `workouts.date`,
`symptoms.date`, `wearable_data.date`, `progress_photos.taken_on`, …) stores a
**logical day**, and exactly one function decides it: `logicalDate` /
`todayISODate` in **`src/lib/db/date.ts`**. Nothing else in `src/` or `app/` may
derive a day; a headless source scan (`db/day-boundary.test.mjs` §5) fails the
build on any second implementation.

- **The day starts when the user says it does (B3).** `dayStartsAt` is a local
  wall-clock `"HH:MM"` in the `users.preferences` blob under `day.startsAt`,
  default `"00:00"`. No migration — `0048` was reserved for a column that proved
  unnecessary. An instant whose local clock reads earlier than the boundary is
  attributed to the previous calendar day, so under `"04:00"` a 01:00 snack is
  yesterday's.
- **Timestamps are untouched.** `created_at`, `measured_at` and every other
  instant stay UTC. Only the `date` attribution moves.
- **Existing rows are never rewritten** when the setting changes. A stored `date`
  is the day that entry was filed under at the time; the Settings control says so.
- **The boundary is a wall-clock rule**, not a timezone rule — `users.timezone`
  is stored and deliberately not consulted. D4 (automatic timezone handling)
  plugs into the single comparison in `logicalDate`.

Two seams deliberately keep the plain **calendar** day, both documented at the
code:

| Seam | Why |
|---|---|
| **Apple Health day buckets** (`hk:<metric>:<date>` in `wearable_data`) and noon-to-noon sleep sessions — `src/lib/health/mapping.ts`, `sync.ts` | The `<date>` is the upsert key, so re-attributing it would insert new rows beside the old ones instead of updating them, double-counting the 14-day re-window and stranding everything older. These rows also mirror the Health app: ARC's steps for a day must equal the phone's or neither can be checked. The discriminator inside the shared table is `source_raw_id` — an `hk:` id is a device bucket, NULL is a manual capture. |
| **A bare-time one-off reminder's day** — `resolveOneOffDay`, `src/lib/db/repositories/reminders.ts` | It answers *when does the OS fire this*, not *what does this count as*. Under a 04:00 boundary the logical today at 01:00 is yesterday, and a reminder dated in the past never fires at all. |

This schema will evolve. When it does, update this document and note the change in `/docs/decisions.md`.
