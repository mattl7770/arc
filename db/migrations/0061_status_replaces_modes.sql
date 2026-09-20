-- ============================================================================
-- ARC 0061 — day_statuses: the fact, without the fixed response
--             …and the row that retires day modes
--
-- Design: docs/spikes/coach-status-buttons-modes-retirement.md (owner's calls,
-- 2026-09-19). Two things land in one file because each new number is a
-- collision to re-check (seven in one week, 0053's header), and these two are
-- one change: the table exists so the mode registry can stop existing.
--
-- ── THE GOVERNING SPLIT ──
--
-- A STATUS IS A FACT THE USER STATES ABOUT THEMSELF. WHAT TO DO ABOUT IT IS
-- THE COACH'S CALL, EVERY TIME.
--
-- 0026's `day_modes` stored the fact AND a fixed response: Sick dropped every
-- `workout` row and injected "Immune support — Vitamin D, zinc"; Deload
-- injected "cut training volume ~40%". Those are clinical decisions as
-- constants, against the standing rule that the deterministic layer detects,
-- grounds and routes attention and never decides the response
-- (docs/ai-coach.md, src/lib/ai/system-prompt.ts). The owner's verdict on the
-- built thing was "the modes switcher right now doesn't do much", and it was
-- mechanically so.
--
-- So this table stores the fact ONLY. There is no registry behind it, nothing
-- branches on the label, and no row here ever adds or drops a mission item.
-- Deterministic readers need the row because they run on days the Coach is
-- never opened: the adherence ledger (which days are excused), the readiness
-- baselines (which days get no vote on what normal looks like), the self-review
-- report, and Home's one line. Everything else — what the day should actually
-- become — goes through a Coach turn, gated and approved, like every other
-- write.
--
-- ── WHY A TABLE, NOT A PREFERENCE AND NOT A MEMORY ──
--
-- A status has a SPAN. Reports resolve it per past day and the ledger needs
-- dates over a window, so a scalar in `users.preferences` (the timezone
-- cursor's shape) has no history to offer them, and a Coach memory is
-- "anything still true next month" with no expiry and no dates at all.
--
-- ── FREE-TEXT `label`, NO ENUM ──
--
-- Nothing branches on the value, so an enum would be a taxonomy nobody
-- maintains — and widening a CHECK on SQLite is a table rebuild. The five rail
-- chips (Sick · Traveling · Injured · Off day · Night out) are a UI set, not a
-- schema one; anything else the user types is a first-class status. The
-- repository trims and lower-cases; surfaces capitalise.
--
-- `'normal'` is refused outright, because normal is a COMMAND, never a row:
-- `set_status('normal')` closes every open row and inserts nothing. The single
-- `normal` row this feature writes is the day_modes retirement at the foot of
-- this file, and that one is a reset of the OLD system.
--
-- ── `excuses`: THE OWNER'S Q2(b), AND WHY THE DEFAULT IS 1 ──
--
-- The recommendation was uniform excusal — every status excuses the day's
-- skips, full stop. The owner took (b) instead: THE COACH DECIDES PER STATUS,
-- through an excusal flag on `set_status`. Hence this column, and hence the
-- shared excusal definition (src/lib/db/repositories/mission.ts,
-- `excusedDatesIn`) reading the FLAG rather than "every status".
--
-- The rail writes its row BEFORE any model turn — that is the whole point of
-- the rail: on a plane the fact lands and the turn fails as every turn fails
-- offline — so the chip's own write needs a deterministic default with no model
-- in the loop. It is **1**, and the argument is asymmetry of harm:
--
--   · All five chips say the same thing in five ways — *don't judge me by
--     today*. Sick, Traveling, Injured, Off day and Night out are each a
--     circumstance the user is declaring precisely so the day is not counted
--     against them.
--   · The wrong default is RECOVERABLE. The Coach can flip it on the very same
--     turn the chip's prompt opens, before the day is ever graded.
--   · The opposite default is SILENT. Defaulting to 0 would count a flu day as
--     a run of misses, and nothing on any screen would say a decision had been
--     made — the user would simply find their adherence dented by an illness
--     they reported.
--
-- A `0` status is therefore a deliberate act: the Coach recording a state that
-- is context without absolution. The doctrine's standing carve-out is the case
-- it was written for — A DELOAD IS A PLAN CHANGE, NEVER A STATUS — and the flag
-- is what makes that sentence cheap to keep rather than a refusal the registry
-- has to enforce: with a per-status flag the Coach can record a non-excusing
-- state without anything having to say no.
--
-- Stored as `integer NOT NULL CHECK (excuses IN (0,1))`, the app's boolean
-- shape (0001's `is_active`, 0055's `away`). No DEFAULT: every writer states
-- it, so a row can never carry a judgement nobody made.
--
-- ── SEVERAL AT ONCE, AND NOTHING IS EVER DELETED ──
--
-- Unlike a mode, statuses do not supersede each other — sick AND traveling is
-- an ordinary Tuesday. The predicate every accounting reader applies is *"any
-- status covers the day"*. Ending sets `end_date = today`, so today stays
-- covered: a Night out declared at 18:00 and ended at 23:00 is not a mis-tap,
-- and deleting the row would flip the evening's skips back to misses after Home
-- had already shown them excused.
--
-- ── `end_date` vs `ended`: TWO QUESTIONS, TWO COLUMNS ──
--
-- `end_date` says WHICH DAYS THE STATUS COVERS. `ended` says WHETHER IT IS
-- STILL RUNNING. They are not the same question, and collapsing them breaks one
-- of the two gestures the rail has to support:
--
--   · **Night out** is born bounded — `end_date = today`, because it ends
--     tonight (the owner's Q4(a)). Its chip must read ON for the rest of today.
--   · **Sick** is born open-ended, and the × must turn its chip OFF THE INSTANT
--     IT IS TAPPED while leaving today excused — i.e. `end_date = today`.
--
-- With one column those two rows are byte-identical and the rail cannot tell
-- "on, ends tonight" from "just turned off". So closing a status flips `ended`
-- and writes `end_date = today`; a bounded status is born `ended = 0` and
-- simply has no tomorrow.
--
-- `ended` NEVER changes which days a status covered. The accounting readers
-- (`statusDaysIn`, `excusingStatusDaysIn`) do not look at it at all — only the
-- rail, Home's line and the Coach's state block do, which is what "still
-- running" is for.
--
-- ── DATES ──
--
-- Every date here comes from the app's LOGICAL day (`todayISODate()`,
-- preference-aware — src/lib/db/date.ts), never from SQL `date('now')`. The one
-- exception in this file is the retirement row below, which is a migration and
-- cannot read a preference; its own note says what that costs.
--
-- ── NUMBERING ──
--
-- 0061. The spike names 0059 and both 0059 (meal_item_piece_name) and 0060
-- (timezone_zone_pair) have since merged; 0060's own header reserved 0061 for
-- this build. Re-checked against `git ls-tree main -- db/migrations/` at commit.
-- The runner is FORWARD-ONLY and silently skips any file at or below a device's
-- `PRAGMA user_version` (src/lib/db/migrate.ts), so a number below main's head
-- is stranded forever rather than merely late. The runner stamps
-- user_version = 61. Run `npm run db:bundle` after this file changes.
--
-- ── THE WAY BACK ──
--
-- Nothing reads `day_statuses` until code does, and no existing row is
-- rewritten, so reverting the code leaves a database that behaves as 0060 left
-- it — minus the retirement row, which is the one irreversible part and is
-- deliberately so (see its own note).
-- ============================================================================

CREATE TABLE day_statuses (
  id text PRIMARY KEY NOT NULL,
  -- Free text, trimmed and lower-cased by the repository. 40 is a label, not a
  -- note — the `note` column below is where prose goes. `'normal'` is refused:
  -- see the header. The comparison is against the stored form, which the
  -- repository guarantees is already lower-case.
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 40 AND label <> 'normal'),
  -- Inclusive local-calendar span — WHICH DAYS THIS COVERS. `end_date` NULL =
  -- open until ended.
  start_date text NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date text CHECK (
    end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  -- Has it been CLOSED by hand — the × on its chip, `set_status('normal')`, or
  -- the Coach bounding it? Distinct from `end_date`; see the header for the two
  -- rows this exists to tell apart. Every row is born running, so unlike
  -- `excuses` this one has a default: 0 is not a judgement, it is a fact about
  -- a row that has just been created.
  ended integer NOT NULL DEFAULT 0 CHECK (ended IN (0, 1)),
  -- Are this status's skipped mission items EXCUSED, not counted as misses?
  -- The owner's Q2(b): the Coach decides per status. The rail's chips write 1 —
  -- see the header for why that default and not the other one.
  excuses integer NOT NULL CHECK (excuses IN (0, 1)),
  -- The Coach's slot: "day 3, fever broke". `day_modes.label` was this and
  -- never got a writer.
  note text,
  -- Provenance as a column (0034's rule): the rail writes 'user', set_status
  -- writes 'coach'. Read by the state block so the model can tell what it set
  -- itself from what the user declared with a tap.
  source text NOT NULL CHECK (source IN ('user', 'coach')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A status cannot end before it begins. Text comparison is chronological for
  -- YYYY-MM-DD, which is why the format is GLOB-checked above.
  CHECK (end_date IS NULL OR end_date >= start_date)
);

-- Open-status and window resolution both scan by start_date and recency, the
-- same access pattern day_modes_start_idx serves.
CREATE INDEX day_statuses_start_idx ON day_statuses (start_date DESC);

CREATE TRIGGER day_statuses_set_updated_at AFTER UPDATE ON day_statuses FOR EACH ROW BEGIN
  UPDATE day_statuses SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ============================================================================
-- RETIRING DAY MODES
--
-- `day_modes` and every row in it STAY, forever. They decide how past days are
-- judged, and changing them would silently rewrite verdicts on days already
-- lived. The registry becomes a frozen read-only shim (label + excusesSkips)
-- and `setMode`/`clearMode` are deleted with the picker.
--
-- This row is required because of that deletion. Every mode the owner set from
-- Home was stored OPEN-ENDED (src/lib/modes/store.ts), his installed build
-- predates 0044, and with the picker gone nothing in the app could ever end
-- such a row — so `excusedDatesIn` would go on excusing every future day
-- forever, from a control that no longer exists. A `normal` row is the system's
-- own reset: newest-covering-row-wins makes it final from its start date
-- without editing a single historical row, and earlier dates are untouched by
-- construction.
--
-- It also CANCELS a future-dated mode range (set_mode's `from` could schedule
-- one) rather than converting it into a status. Converting would write a label
-- on the owner's behalf for a near-zero-odds case; he re-declares from the rail
-- in one tap.
--
-- The id is UNNUMBERED — 'modes-retired', not 'modes-retired-0061' — so a
-- renumber of this file cannot make the row lie about which migration wrote it.
--
-- `date('now')` IS UTC, AND THIS IS THE ONE UTC DATE IN THE FILE. A migration
-- cannot read the app's day preference, so a Pacific-evening install starts
-- this row on the local TOMORROW, and an old open-ended mode can still cover
-- that one evening. Accepted deliberately: the alternative, `'-1 day'`, could
-- re-judge a local yesterday the user has already lived and seen graded, which
-- is the worse error. Every `day_statuses` date comes from `todayISODate()`
-- instead.
-- ============================================================================
INSERT INTO day_modes (id, mode, start_date, end_date, label, note)
VALUES ('modes-retired', 'normal', date('now'), NULL, NULL,
        'Modes retired 2026-09 — ends all mode coverage from here on; history before this date is unchanged.');
