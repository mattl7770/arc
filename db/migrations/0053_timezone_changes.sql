-- ============================================================================
-- ARC 0053 — timezone_changes: the day ARC's clock moved zones
--
-- Owner ask (backlog D4): *"way to note when days have timezone changes"*, and
-- *"this should work automatically"*. The design is docs/spikes/timezone-days.md;
-- the owner's three calls, settled 2026-09-14, are: ANNOTATE the day and never
-- re-attribute a row; EXCUSE that day's missed mission items without setting a
-- mode; keep the nutrition verdict QUIET on it.
--
-- iOS changes the device zone by itself, usually within minutes of the phone
-- attaching to a foreign carrier, and nothing in ARC ever noticed. A calendar
-- day containing a zone change is `24 + Δ` hours long — a London→New York hop
-- makes a 29-hour day, an LA→Auckland one a 19-hour day — and every ARC figure
-- whose denominator is "a day" was silently reading one against the other.
--
-- ── WHAT A ROW IS ──
--
-- One row per OBSERVED zone change. Not per day and not per trip: a change is
-- an event with a before and an after, and the days it marks fall out of it.
--
-- Both `from_local_date` and `to_local_date` are LOGICAL days — the B3 day
-- boundary is applied (src/lib/db/date.ts `logicalDateAtOffset`) — computed
-- from the one instant under the OLD offset and under the NEW one. They are
-- equal in the common case (an afternoon landing) and differ when the change
-- crossed the day boundary. BOTH are marked: the change belongs to the seam
-- between two days, and the seam is what a reader needs to see — the tail of
-- the old day that never happened, or the date lived twice.
--
-- ── THE SIGN, WHICH IS THE WHOLE TRAP ──
--
-- `Date.prototype.getTimezoneOffset()` returns minutes **WEST** of UTC: UTC−8
-- is `+480`, UTC+1 is `−60`. These columns store the **NEGATION** — minutes
-- EAST of UTC, so UTC+1 is `+60` and UTC−8 is `−480`, and the number reads the
-- way a human says the zone. The conversion happens once, in
-- `offsetEastMinutes` (src/lib/timezone/classify.ts), and is pinned by a test
-- for the same reason the HealthKit percent fraction is: a later tidy-up that
-- "fixed" the sign would invert every stored row with nothing to catch it.
--
-- ±840 is the real range of IANA offsets (UTC−12 … UTC+14).
--
-- ── WHY DST IS NOT IN HERE ──
--
-- An offset change is either TRAVEL (the zone itself changed) or DST (the same
-- zone's own annual shift), and DST must mark nothing: the day is 23 or 25
-- hours long, which readiness, the mission and the nutrition verdict have
-- always lived with, and which is not news about the user's life.
--
-- Hermes has no `Intl`, so there is no zone id to compare — see
-- src/lib/timezone/classify.ts for the January/July probe that decides it
-- exactly, with no tzdata and no dependency. The classification happens at the
-- observer, and a DST change writes NO ROW: only the offset cursor moves.
--
-- The alternative was a `kind text CHECK (kind IN ('travel','dst'))` column
-- carrying DST rows that mark nothing. Rejected on 0045's argument: a row that
-- must be filtered is a filter every future reader has to remember, the
-- forgetting is silent, and the failure — a DST Sunday excusing a day's mission
-- items and dropping itself out of the HRV baseline — looks exactly like
-- working software. There is no flag to forget if the row is not there.
-- Everything in this table marks its days; that is what the table means.
--
-- ── THE CURSOR IS NOT HERE EITHER ──
--
-- "The last offset ARC saw" is a single scalar and a machine cursor, so it
-- lives in the `users.preferences` blob beside the other cursors
-- (src/lib/db/repositories/user.ts `getTimezoneCursor`). The first observation
-- on a fresh install writes the cursor and NO row: you cannot report a change
-- you did not see.
--
-- ── NUMBERING ──
--
-- 0053, which is what docs/backlog-2026-09.md reserved for D4. Re-checked
-- against `git ls-tree main -- db/migrations/` at commit (2026-09-14): main's
-- head had moved 0045 → 0047 while this was being built (B1 exercise measures,
-- B2 ml unit), and no branch in the repo holds 0048–0053. The runner SILENTLY
-- SKIPS any number at or below a device's
-- `PRAGMA user_version`, so a collision strands a migration forever — re-check
-- `git ls-tree main -- db/migrations/` before merging (seven collisions in a
-- week). Conventions per CLAUDE.md §9 / 0001_init.sql: app-generated UUID text
-- ids (PRIMARY KEY NOT NULL, no default — src/lib/db/id.ts), ISO-8601 UTC text
-- timestamps, YYYY-MM-DD dates GLOB-checked, created_at/updated_at with an
-- AFTER UPDATE trigger (recursive_triggers OFF). Run `npm run db:bundle` after
-- this file changes.
-- ============================================================================

CREATE TABLE timezone_changes (
  id text PRIMARY KEY NOT NULL,
  -- The instant the change was OBSERVED (ISO-8601 UTC). Not when the plane
  -- landed: ARC learns of it on the next foreground, which is minutes to hours
  -- later, and claiming otherwise would be inventing a fact.
  changed_at text NOT NULL,
  -- Minutes EAST of UTC — the NEGATION of getTimezoneOffset(). See the header.
  from_offset_min integer NOT NULL CHECK (from_offset_min BETWEEN -840 AND 840),
  to_offset_min integer NOT NULL CHECK (to_offset_min BETWEEN -840 AND 840),
  -- The LOGICAL day at `changed_at` under the old offset, and under the new
  -- one. Equal in the common case; different when the change crossed the day
  -- boundary. Both are marked.
  from_local_date text NOT NULL CHECK (
    from_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  to_local_date text NOT NULL CHECK (
    to_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A "change" that changed nothing is a bug in the observer, not a row.
  CHECK (from_offset_min <> to_offset_min)
);

-- The query shape is `WHERE from_local_date = ? OR to_local_date = ?`, asked by
-- every record row that renders, by the readiness baselines and by every Coach
-- turn. SQLite will not use an index for an OR unless BOTH sides are indexed,
-- so there are two.
CREATE INDEX timezone_changes_from_date_idx ON timezone_changes (from_local_date);
CREATE INDEX timezone_changes_to_date_idx ON timezone_changes (to_local_date);

CREATE TRIGGER timezone_changes_set_updated_at
AFTER UPDATE ON timezone_changes FOR EACH ROW BEGIN
  UPDATE timezone_changes
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;
