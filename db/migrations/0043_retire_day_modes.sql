-- ============================================================================
-- ARC 0043 — retire the Modes feature (owner call, 2026-08-25)
--
-- Numbered 0043: next free above the current max (0042 workout identity —
-- measured by listing db/migrations at authoring time, NOT off a doc's
-- remembered head; this file was first authored as 0040 against a stale
-- inventory and caught in review). ⚠️ The runner applies only
-- `version > user_version` (src/lib/db/migrate.ts), so a migration numbered at
-- or below a device's head is SKIPPED SILENTLY — re-measure against main's
-- head again at merge time and renumber if it has moved (it has, five times).
--
-- Modes (0026 `day_modes` + the registry, Home control, set_mode Coach tool)
-- was removed after the owner twice judged it thin on hardware. Every writer
-- is gone from the code; this migration ends mode COVERAGE without touching
-- mode HISTORY.
--
-- Why a row must be written at all: the active mode for a date is the most-
-- recently-inserted row whose inclusive range covers it (day-modes.ts), and
-- every mode ever set from Home was OPEN-ENDED (`end_date` NULL). With the
-- Home picker deleted there is no surface left that could end one — so a
-- forgotten open-ended Sick row would keep excusing every future day's skips
-- in the reports ledger, forever, invisibly.
--
-- The fix uses the resolution's own newest-wins rule: ONE open-ended `normal`
-- row starting today. Inserted last, it out-ranks every earlier open-ended row
-- and any mode scheduled for a day that has not arrived — while dates BEFORE
-- its start_date are not covered by it at all, so every past day keeps exactly
-- the verdict it was lived under (reports re-resolve per historical day, and
-- that reading must never shift — the same immutability rule as protocol
-- versions).
--
-- `date('now')` is UTC. If this runs in the evening west of Greenwich the row
-- can start on the LOCAL calendar's tomorrow, leaving today itself resolvable
-- to an old open-ended mode for a few hours. That is accepted on purpose: the
-- alternative ('-1 day') could re-judge a real, already-lived local yesterday,
-- and preserving history outranks a one-day lag in the shutdown.
--
-- The table, its trigger and its index stay — historical rows are read by the
-- reports assembly (getActiveMode per past day) and exported with everything
-- else. The literal id is deliberate and readable; nothing joins on it.
-- ============================================================================
INSERT INTO day_modes (id, mode, start_date, end_date, label, note)
VALUES (
  'modes-retired-0043',
  'normal',
  date('now'),
  NULL,
  NULL,
  'Modes feature removed 2026-08-25 — this row ends all mode coverage from here on.'
);
