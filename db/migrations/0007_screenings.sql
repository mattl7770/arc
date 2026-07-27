-- ============================================================================
-- ARC 0007 — preventive screenings + medical calendar
--
-- The screening ledger (owner brief §2): recurring preventive items with a
-- cadence (colonoscopy every 10 years, skin check yearly, dental twice a
-- year…) plus one-off appointments. `screenings` is the standing obligation;
-- `appointments` is the calendar event that (optionally) satisfies one.
-- Browsable in the Data tab; Home later surfaces what's *due* from
-- screenings.next_due (docs/information-architecture.md). Distinct from the
-- Coach's generic `reminders` (0006, parallel window): next_due is domain
-- data with a cadence behind it — the Coach may later create a reminder FROM
-- a due screening, but the two stores stay separate.
--
-- Numbered 0007: 0005 (ai-chat) + 0006 (reminders) are reserved by the Coach
-- window (docs/project-status.md); the runner tolerates the gap until the
-- branches merge — versions must only increase.
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql: app-generated v4 UUID text ids
-- (PRIMARY KEY NOT NULL, no default — src/lib/db/id.ts), calendar dates as
-- text YYYY-MM-DD (GLOB-checked), ISO-8601 UTC text timestamps, enum
-- vocabulary as text + CHECK, created_at/updated_at with an AFTER UPDATE
-- trigger (recursive_triggers stays OFF). The appointments FK relies on
-- PRAGMA foreign_keys = ON, which the client sets on every connection.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- screenings — one row per standing preventive item. All three cadence fields
-- are nullable on purpose: interval_months NULL means one-off / age-triggered
-- (e.g. "first colonoscopy at 45"); last_completed NULL means never done yet;
-- next_due NULL means untracked (nothing to surface). The repository derives
-- next_due = last_completed + interval_months when both exist (month math with
-- end-of-month clamping lives in TS, not SQL), but an explicit next_due — a
-- doctor's told-you date — always wins, so the column stores the answer rather
-- than re-deriving it on every read.
-- ----------------------------------------------------------------------------
CREATE TABLE screenings (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other' CHECK (
    category IN (
      'imaging', 'bloodwork', 'exam', 'dental', 'vision', 'derm', 'cardio',
      'other'
    )
  ),
  -- Cadence in whole months (12 = yearly, 120 = decennial); NULL = one-off.
  interval_months integer CHECK (interval_months IS NULL OR interval_months > 0),
  last_completed text CHECK (
    last_completed IS NULL
    OR last_completed GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  next_due text CHECK (
    next_due IS NULL OR next_due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A next_due at or before the last completion is always nonsense (the
  -- derived path is strictly later; a told-you date follows the visit) — same
  -- cross-column sanity shape as wearable_data's start/end in 0001. Fails a
  -- typo'd override loud instead of minting a phantom "overdue".
  CHECK (last_completed IS NULL OR next_due IS NULL OR last_completed <= next_due)
);

-- Due/overdue reads filter and order on next_due; untracked rows stay out.
CREATE INDEX screenings_next_due_idx
  ON screenings (next_due) WHERE next_due IS NOT NULL;

-- ----------------------------------------------------------------------------
-- appointments — one-off calendar events (a booked colonoscopy, a dentist
-- slot, a one-time consult). scheduled_at is an ISO-8601 UTC instant (like
-- body_metrics.measured_at) built from the local wall-clock the user picks —
-- instants compare and sort as text, which is what "upcoming" reads need.
-- screening_id links a booking to the standing item it satisfies; ON DELETE
-- SET NULL because deleting a screening must never destroy calendar history
-- (same rationale as log_entries.protocol_id in 0001).
-- ----------------------------------------------------------------------------
CREATE TABLE appointments (
  id text PRIMARY KEY NOT NULL,
  title text NOT NULL,
  provider text,
  scheduled_at text NOT NULL,
  location text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (
    status IN ('scheduled', 'completed', 'cancelled')
  ),
  screening_id text REFERENCES screenings (id) ON DELETE SET NULL,
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX appointments_scheduled_idx ON appointments (scheduled_at);
CREATE INDEX appointments_screening_idx
  ON appointments (screening_id) WHERE screening_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- updated_at triggers (see 0001_init.sql for why there is no WHEN self-guard).
-- ----------------------------------------------------------------------------
CREATE TRIGGER screenings_set_updated_at AFTER UPDATE ON screenings FOR EACH ROW BEGIN
  UPDATE screenings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER appointments_set_updated_at AFTER UPDATE ON appointments FOR EACH ROW BEGIN
  UPDATE appointments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
