-- ============================================================================
-- ARC v1 core schema
--
-- Implements the tables in docs/data-model.md. Single-user system, but every
-- owned row carries user_id and is gated by RLS — that is a deliberate habit,
-- not a hedge (CLAUDE.md §9).
--
-- Conventions used throughout:
--   * uuid primary keys, gen_random_uuid() defaults
--   * timestamptz for instants, date for calendar days, time for wall-clock
--   * created_at / updated_at on every table except protocol_versions, which
--     is append-only by design
--   * enums where ARC owns the vocabulary; text where an external system does
--   * jsonb only for genuinely free-form payloads (preferences, protocol
--     content, log values, raw extraction, device metadata)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
--
-- Rule: an enum when ARC defines the vocabulary, text when an external system
-- does. `wearable_data.metric_type` is text precisely because Oura/WHOOP/Terra
-- add metrics on their schedule, not ours, and an enum there would mean a
-- migration every time a vendor ships a new field.
-- ----------------------------------------------------------------------------

create type public.biological_sex as enum (
  'male',
  'female',
  'intersex',
  'prefer_not_to_say'
);

create type public.biomarker_category as enum (
  'cardiovascular',
  'metabolic',
  'hormone',
  'inflammation',
  'nutrient',
  'organ',
  'immune',
  'hematology',
  'cancer',
  'toxin',
  'other'
);

create type public.data_source as enum (
  'function_pdf',
  'manual',
  'api',
  'device_sync',
  'apple_health',
  'health_connect',
  'terra',
  'ai_suggested',
  'import'
);

create type public.protocol_type as enum (
  'daily_routine',
  'supplement_stack',
  'meal_template',
  'training_block',
  'therapy_protocol',
  'sleep_protocol',
  'other'
);

create type public.authorship as enum (
  'user',
  'ai'
);

create type public.log_entry_type as enum (
  'habit',
  'meal',
  'workout',
  'supplement',
  'medication',
  'therapy',
  'metric',
  'note'
);

create type public.log_entry_status as enum (
  'pending',
  'completed',
  'skipped',
  'partial'
);

create type public.wearable_device as enum (
  'oura',
  'whoop',
  'ultrahuman',
  'apple_watch',
  'garmin',
  'eight_sleep',
  'withings',
  'manual',
  'other'
);

-- ----------------------------------------------------------------------------
-- Shared trigger function
-- ----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger function: stamps updated_at on every UPDATE.';

-- ============================================================================
-- users
--
-- Mirrors auth.users. The id IS the auth id — no separate profile key — so
-- `auth.uid() = id` is the whole ownership check.
-- ============================================================================

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  date_of_birth date,
  biological_sex public.biological_sex,
  timezone text not null default 'UTC',
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_date_of_birth_sane check (
    date_of_birth is null or date_of_birth > date '1900-01-01'
  )
);

comment on table public.users is
  'Application-level user profile, 1:1 with auth.users.';
comment on column public.users.timezone is
  'IANA timezone name. Drives what "today" means for daily_logs.';
comment on column public.users.preferences is
  'Free-form client preferences. Nothing queried by the backend belongs here.';

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- ============================================================================
-- biomarkers
--
-- Global reference data, not user-owned: the definition of ApoB is the same
-- for everyone. Readable by any authenticated user, writable only by the
-- service role (which bypasses RLS).
-- ============================================================================

create table public.biomarkers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  category public.biomarker_category not null default 'other',
  unit text,
  description text,
  optimal_range_low numeric,
  optimal_range_high numeric,
  standard_range_low numeric,
  standard_range_high numeric,
  higher_is_better boolean,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint biomarkers_slug_format check (slug ~ '^[a-z0-9_]+$'),
  constraint biomarkers_optimal_range_ordered check (
    optimal_range_low is null
    or optimal_range_high is null
    or optimal_range_low <= optimal_range_high
  ),
  constraint biomarkers_standard_range_ordered check (
    standard_range_low is null
    or standard_range_high is null
    or standard_range_low <= standard_range_high
  )
);

comment on table public.biomarkers is
  'Reference catalogue of known biomarkers. Global, not user-scoped.';
comment on column public.biomarkers.optimal_range_low is
  'Longevity-oriented optimal range, deliberately tighter than lab "normal".';
comment on column public.biomarkers.higher_is_better is
  'NULL where the metric is U-shaped and neither direction is simply better.';

create index biomarkers_category_idx on public.biomarkers (category);

create trigger biomarkers_set_updated_at
  before update on public.biomarkers
  for each row execute function public.set_updated_at();

-- ============================================================================
-- lab_reports
--
-- One row per ingested report (typically a Function Health PDF). The raw
-- extraction is kept alongside the parsed rows so a parser improvement can be
-- replayed without re-uploading.
-- ============================================================================

create table public.lab_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  source public.data_source not null default 'function_pdf',
  collected_at date not null,
  file_path text,
  raw_extracted_json jsonb,
  parsed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target for the composite FK from lab_results; keeps a result from ever
  -- pointing at another user's report.
  constraint lab_reports_id_user_id_key unique (id, user_id)
);

comment on table public.lab_reports is
  'An ingested lab report. Stores both the storage path to the original PDF and the raw structured extraction.';
comment on column public.lab_reports.file_path is
  'Supabase Storage path to the original PDF. The source of truth is the file, not the parse.';
comment on column public.lab_reports.parsed_at is
  'NULL until extraction succeeds. Non-null implies lab_results rows exist.';

create index lab_reports_user_collected_idx
  on public.lab_reports (user_id, collected_at desc);

create trigger lab_reports_set_updated_at
  before update on public.lab_reports
  for each row execute function public.set_updated_at();

-- ============================================================================
-- lab_results
--
-- One biomarker value at one point in time.
-- ============================================================================

create table public.lab_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  biomarker_id uuid not null references public.biomarkers (id) on delete restrict,
  report_id uuid,
  value numeric not null,
  collected_at date not null,
  lab_name text,
  source public.data_source not null default 'function_pdf',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Deleting a report discards the values parsed out of it. Manually entered
  -- results have report_id NULL and are unaffected (MATCH SIMPLE: a NULL in
  -- the FK means the constraint is not applied).
  constraint lab_results_report_fk foreign key (report_id, user_id)
    references public.lab_reports (id, user_id) on delete cascade,
  -- Re-parsing the same report must not duplicate rows.
  constraint lab_results_report_biomarker_key unique (report_id, biomarker_id)
);

comment on table public.lab_results is
  'A single biomarker measurement. report_id is NULL for manual entries.';
comment on constraint lab_results_report_biomarker_key on public.lab_results is
  'Idempotency guard: one value per biomarker per report.';

-- The trend query — one biomarker for one user over time.
create index lab_results_user_biomarker_collected_idx
  on public.lab_results (user_id, biomarker_id, collected_at desc);
create index lab_results_user_collected_idx
  on public.lab_results (user_id, collected_at desc);
create index lab_results_report_idx
  on public.lab_results (report_id) where report_id is not null;

create trigger lab_results_set_updated_at
  before update on public.lab_results
  for each row execute function public.set_updated_at();

-- ============================================================================
-- protocols / protocol_versions
--
-- Protocols are treated like code (CLAUDE.md §2): the protocol row is the
-- stable identity, every change is a new immutable version, and
-- current_version_id is the pointer to what is live.
-- ============================================================================

create table public.protocols (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  type public.protocol_type not null,
  is_active boolean not null default true,
  -- FK added after protocol_versions exists (mutual reference).
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint protocols_slug_format check (slug ~ '^[a-z0-9_-]+$'),
  constraint protocols_user_id_slug_key unique (user_id, slug),
  constraint protocols_id_user_id_key unique (id, user_id)
);

comment on table public.protocols is
  'Stable identity for a versioned protocol / stack / routine.';
comment on column public.protocols.current_version_id is
  'The live version. NULL only between creating a protocol and its first version.';

create table public.protocol_versions (
  id uuid primary key default gen_random_uuid(),
  protocol_id uuid not null,
  user_id uuid not null references public.users (id) on delete cascade,
  version_number integer not null,
  content jsonb not null default '{}'::jsonb,
  change_notes text,
  created_by public.authorship not null default 'user',
  created_at timestamptz not null default now(),
  constraint protocol_versions_version_number_positive check (version_number > 0),
  constraint protocol_versions_protocol_fk foreign key (protocol_id, user_id)
    references public.protocols (id, user_id) on delete cascade,
  constraint protocol_versions_protocol_id_version_number_key
    unique (protocol_id, version_number)
);

comment on table public.protocol_versions is
  'Immutable snapshot of a protocol. Never updated in place — that is the point of versioning, so there is no updated_at.';
comment on column public.protocol_versions.content is
  'Shape depends on protocols.type. Deliberately jsonb: a supplement stack and a training block do not share columns.';
comment on column public.protocol_versions.created_by is
  'Whether this version was authored by the user or proposed by the Coach.';

alter table public.protocols
  add constraint protocols_current_version_fk
  foreign key (current_version_id) references public.protocol_versions (id)
  on delete set null;

create index protocols_user_active_idx
  on public.protocols (user_id, is_active) where is_active;
create index protocol_versions_protocol_idx
  on public.protocol_versions (protocol_id, version_number desc);
create index protocol_versions_user_idx
  on public.protocol_versions (user_id);

create trigger protocols_set_updated_at
  before update on public.protocols
  for each row execute function public.set_updated_at();

-- ============================================================================
-- daily_logs / log_entries
--
-- The execution layer. One daily_log per user per calendar day; log_entries
-- are the individual checklist items behind it.
-- ============================================================================

create table public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  date date not null,
  summary text,
  overall_adherence_score numeric(5, 2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_logs_adherence_range check (
    overall_adherence_score is null
    or (overall_adherence_score >= 0 and overall_adherence_score <= 100)
  ),
  constraint daily_logs_user_id_date_key unique (user_id, date),
  constraint daily_logs_id_user_id_key unique (id, user_id)
);

comment on table public.daily_logs is
  'One row per user per calendar day. "Day" is resolved in the user timezone, which is why date is a date and not a timestamptz.';
comment on column public.daily_logs.summary is
  'The Coach daily brief for this day.';
comment on column public.daily_logs.overall_adherence_score is
  'Percentage, 0-100. NULL where the day was not scored.';

create table public.log_entries (
  id uuid primary key default gen_random_uuid(),
  daily_log_id uuid not null,
  user_id uuid not null references public.users (id) on delete cascade,
  type public.log_entry_type not null,
  protocol_id uuid references public.protocols (id) on delete set null,
  title text not null,
  status public.log_entry_status not null default 'pending',
  scheduled_time time,
  completed_at timestamptz,
  value jsonb,
  source public.data_source not null default 'manual',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint log_entries_daily_log_fk foreign key (daily_log_id, user_id)
    references public.daily_logs (id, user_id) on delete cascade
);

comment on table public.log_entries is
  'An individual item logged against a day — the rows behind Today''s Mission.';
comment on column public.log_entries.scheduled_time is
  'Wall-clock time of day; the calendar date comes from the parent daily_log. Stored as time (not timestamptz) so a 07:00 habit stays 07:00 across timezones.';
comment on column public.log_entries.protocol_id is
  'Which protocol generated this item, if any. ON DELETE SET NULL so deleting a protocol never destroys execution history.';
comment on column public.log_entries.value is
  'Type-dependent payload (grams, reps, dose, mood...). Anything worth charting should graduate to a real column.';

create index log_entries_daily_log_idx on public.log_entries (daily_log_id);
create index log_entries_user_status_idx on public.log_entries (user_id, status);
create index log_entries_protocol_idx
  on public.log_entries (protocol_id) where protocol_id is not null;

create trigger daily_logs_set_updated_at
  before update on public.daily_logs
  for each row execute function public.set_updated_at();

create trigger log_entries_set_updated_at
  before update on public.log_entries
  for each row execute function public.set_updated_at();

-- ============================================================================
-- wearable_data
--
-- Everything normalised into ARC's own shape (CLAUDE.md §8): one row per
-- metric per period, always labelled with the device it came from so dual-ring
-- and ring-plus-strap setups stay disambiguated.
-- ============================================================================

create table public.wearable_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  date date not null,
  metric_type text not null,
  value numeric not null,
  unit text,
  source_device public.wearable_device not null,
  source_raw_id text,
  start_time timestamptz,
  end_time timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wearable_data_metric_type_format check (metric_type ~ '^[a-z0-9_]+$'),
  constraint wearable_data_period_ordered check (
    start_time is null or end_time is null or start_time <= end_time
  )
);

comment on table public.wearable_data is
  'Normalised wearable metrics. Deliberately tall/narrow so a new metric is a new row, not a migration.';
comment on column public.wearable_data.metric_type is
  'e.g. sleep_score, hrv, rhr, strain, recovery, steps, spo2, temperature. Text, not an enum: vendors add metrics on their schedule, not ours.';
comment on column public.wearable_data.source_raw_id is
  'Vendor id for this record. Powers the idempotent re-sync guard below.';

create index wearable_data_user_date_idx
  on public.wearable_data (user_id, date desc);
create index wearable_data_user_metric_date_idx
  on public.wearable_data (user_id, metric_type, date desc);

-- Re-syncing a device must update rows, not duplicate them.
create unique index wearable_data_device_raw_id_key
  on public.wearable_data (source_device, source_raw_id)
  where source_raw_id is not null;

create trigger wearable_data_set_updated_at
  before update on public.wearable_data
  for each row execute function public.set_updated_at();

-- ============================================================================
-- body_metrics
-- ============================================================================

create table public.body_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  measured_at timestamptz not null,
  weight_kg numeric(6, 3),
  body_fat_pct numeric(5, 2),
  muscle_mass_kg numeric(6, 3),
  bone_mass_kg numeric(6, 3),
  visceral_fat_rating numeric(5, 2),
  waist_cm numeric(6, 2),
  hip_cm numeric(6, 2),
  source public.data_source not null default 'manual',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint body_metrics_weight_positive check (weight_kg is null or weight_kg > 0),
  constraint body_metrics_muscle_positive check (muscle_mass_kg is null or muscle_mass_kg > 0),
  constraint body_metrics_bone_positive check (bone_mass_kg is null or bone_mass_kg > 0),
  constraint body_metrics_waist_positive check (waist_cm is null or waist_cm > 0),
  constraint body_metrics_hip_positive check (hip_cm is null or hip_cm > 0),
  constraint body_metrics_body_fat_range check (
    body_fat_pct is null or (body_fat_pct >= 0 and body_fat_pct <= 100)
  )
);

comment on table public.body_metrics is
  'Body composition over time. Every column is nullable because a scale, a DEXA scan, and a tape measure each fill in a different subset.';

create index body_metrics_user_measured_idx
  on public.body_metrics (user_id, measured_at desc);

create trigger body_metrics_set_updated_at
  before update on public.body_metrics
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row Level Security
--
-- Enabled on every table. Owned tables use one FOR ALL policy because the
-- predicate is identical across select/insert/update/delete; splitting it
-- would be four copies of the same line.
--
-- auth.uid() is wrapped in a scalar subquery so Postgres evaluates it once per
-- statement (an InitPlan) rather than once per row — the documented Supabase
-- RLS performance pattern.
-- ============================================================================

alter table public.users enable row level security;
alter table public.biomarkers enable row level security;
alter table public.lab_reports enable row level security;
alter table public.lab_results enable row level security;
alter table public.protocols enable row level security;
alter table public.protocol_versions enable row level security;
alter table public.daily_logs enable row level security;
alter table public.log_entries enable row level security;
alter table public.wearable_data enable row level security;
alter table public.body_metrics enable row level security;

create policy "Users can access their own profile"
  on public.users for all to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Reference data: readable by any signed-in user, writable only by the service
-- role, which bypasses RLS. Deliberately no insert/update/delete policy.
create policy "Biomarkers are readable by authenticated users"
  on public.biomarkers for select to authenticated
  using (true);

create policy "Users can access their own lab reports"
  on public.lab_reports for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can access their own lab results"
  on public.lab_results for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can access their own protocols"
  on public.protocols for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can access their own protocol versions"
  on public.protocol_versions for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can access their own daily logs"
  on public.daily_logs for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can access their own log entries"
  on public.log_entries for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can access their own wearable data"
  on public.wearable_data for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can access their own body metrics"
  on public.body_metrics for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ============================================================================
-- Auth wiring
--
-- Create the public.users row when someone signs up, so public.users is never
-- out of step with auth.users. SECURITY DEFINER because the signing-up user
-- has no rights to public.users at this point; search_path is pinned to empty
-- and every name is schema-qualified.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Creates the public.users profile row on signup.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The trigger only fires on future signups. If an account already exists —
-- likely, since email auth was enabled before this migration ran — backfill it.
-- Idempotent: safe to re-run.
insert into public.users (id, email, full_name)
select
  u.id,
  u.email,
  nullif(u.raw_user_meta_data ->> 'full_name', '')
from auth.users u
where u.email is not null
on conflict (id) do nothing;

-- ============================================================================
-- Grants
--
-- Supabase already grants these to `authenticated` by default for tables
-- created in `public`. Stating them explicitly makes this migration
-- self-contained and makes the read-only intent of `biomarkers` legible at the
-- privilege layer, not just the policy layer.
--
-- Grants decide which verbs a role may attempt; RLS decides which rows those
-- verbs may touch. Both have to allow an operation for it to succeed.
-- ============================================================================

grant select, insert, update, delete on
  public.users,
  public.lab_reports,
  public.lab_results,
  public.protocols,
  public.protocol_versions,
  public.daily_logs,
  public.log_entries,
  public.wearable_data,
  public.body_metrics
  to authenticated;

-- Reference data: the app reads it, the service role maintains it.
grant select on public.biomarkers to authenticated;
