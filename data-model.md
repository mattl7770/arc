# ARC Data Model (v1)

**Status:** Draft — Foundation phase  
**Last updated:** 2026-07-22

This document defines the core schema for ARC. Keep it clean, normalized, and extensible.

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

This schema will evolve. When it does, update this document and note the change in `/docs/decisions.md`.
