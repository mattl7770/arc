-- ============================================================================
-- ARC 0064 — coach_nudges: the notifications the Coach plans for itself
--
-- Round-2 device note (2026-09-23): *"coach sends push notifications"*. The
-- plan is docs/spikes/coach-notifications.md; the owner accepted all six of its
-- recommendations on 2026-09-25. ARC has no server, so "push" means LOCAL
-- notifications, and the Coach can only think while ARC is open: a pass that
-- runs on an open (the daily look, the first open after 18:00, a new signal)
-- may end its reply with up to two strict lines,
--
--     NUDGE 2026-09-26 07:30 Leg day. Eat before you lift.
--
-- and deterministic code parses them, applies the caps and quiet hours, and
-- writes one row here per nudge it accepts (src/lib/notifications/
-- nudge-plan.ts, src/lib/db/repositories/coach-nudges.ts). The OS schedule is
-- then rebuilt from these rows by the same reconciliation pass that owns every
-- other notification ARC sends (src/lib/notifications/reminders.ts), so a row
-- here is the whole truth about a nudge: nothing is scheduled that is not a
-- pending row, and a cancelled row is gone from the phone at the next resync.
--
-- ── ONE ROW, THREE STATES ──
--
--   pending    planned. Its moment is either still ahead (it is on the OS
--              schedule and listed on the Coach tab, with Cancel) or already
--              past (it fired, as far as ARC can know — permission and Focus
--              are the phone's business). A past pending row is history: it
--              counts against its day's cap and is never cancelled.
--   delivered  he TAPPED it. The one moment ARC knows he saw it; the tap also
--              put its text into the thread as the Coach's latest message.
--   cancelled  he cancelled it on the Coach tab, turned nudges off, moved
--              quiet hours over it, or a later pass replaced it.
--
-- No 'rejected' state: a line the caps refused never becomes a row. What the
-- model proposed and code dropped is not a nudge, and a table of them would be
-- a log nobody reads.
--
-- ── A LOGICAL DAY PLUS A CLOCK TIME, NOT AN INSTANT ──
--
-- `day` is the LOGICAL day the nudge belongs to (src/lib/db/date.ts, B3) and
-- `time` is the wall clock. The fire instant is derived at every resync by
-- `fireInstant` — the protocol-reminder function — so a trip re-anchors a
-- nudge the way it re-anchors a protocol item, and a 01:00 nudge under an
-- 04:00 boundary lands on the next calendar morning. Storing an ISO instant
-- would pin it to the zone it was planned in.
--
-- ── `body`, NOT `text` ──
--
-- The plan names the column `text`, which is also a type name. `body` is what
-- the notification field is called and reads unambiguously in SQL. The 160
-- CHECK is a backstop above the parser's own 140-character cap, so the parser
-- can move without a migration.
--
-- ── reminders.checkin ──
--
-- The owner's Q5: *"tapping a check-in opens the Coach thread and the Coach
-- speaks first (check-ins only); a plain reminder opens with 'Talk about
-- this'."* A check-in is a reminder the user asked to be CHECKED IN on ("check
-- in with me tonight about the knee"), and nothing on a 0009 row could tell one
-- from "take creatine at 3". One bit, set by `set_reminder`'s optional
-- `checkin` flag. `NOT NULL DEFAULT 0`: every reminder already on the phone is
-- a plain one, which is true rather than convenient — there was no other kind.
--
-- Conventions per CLAUDE.md §9: app-generated v4 UUID text PK declared PRIMARY
-- KEY NOT NULL (src/lib/db/id.ts); ISO-8601 text timestamps; created_at +
-- updated_at with an AFTER UPDATE trigger (recursive_triggers stays OFF); enum
-- vocabulary as text + CHECK; GLOB shape checks with `[0-9]` classes.
--
-- Numbered 0064: main's head is 0063 and no live branch holds 0064 (checked
-- across the sibling worktrees at commit). The runner is forward-only and
-- silently skips any file at or below a device's user_version, so the number
-- is re-checked at merge, not at authoring. The runner stamps PRAGMA
-- user_version = 64 after applying this file.
-- ============================================================================

CREATE TABLE coach_nudges (
  id text PRIMARY KEY NOT NULL,
  -- The logical day it belongs to.
  day text NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Wall-clock HH:MM on that day.
  time text NOT NULL CHECK (time GLOB '[0-2][0-9]:[0-5][0-9]'),
  -- What the lock screen shows: the Coach's line, plain text, no numbers (the
  -- parser enforces the last two; the CHECK only refuses empty and runaway).
  body text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 160),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'cancelled')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Every read is "this day onward, in time order": the Coach tab's list, the
-- resync's source, the per-day cap, and the pass directive's pending set.
CREATE INDEX coach_nudges_day_time_idx ON coach_nudges (day, time);

CREATE TRIGGER coach_nudges_set_updated_at AFTER UPDATE ON coach_nudges FOR EACH ROW BEGIN
  UPDATE coach_nudges SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- A check-in: the Coach speaks first when he taps it.
ALTER TABLE reminders ADD COLUMN checkin integer NOT NULL DEFAULT 0
  CHECK (checkin IN (0, 1));
