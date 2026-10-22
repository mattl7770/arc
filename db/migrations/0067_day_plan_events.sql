-- ============================================================================
-- ARC 0067 — day_plan_events: what the Coach put at the top of Home, and what
-- he did about it
--
-- Items 77/78 (docs/spikes/smart-day.md), built under the owner's correction of
-- 2026-10-21: *"none of this should be hard-coded … we want an intelligent
-- assistant/coach who reminds you to weigh in when it thinks you need that
-- reminder."* So no rule produces a prompt. The coach pass is handed FACTS
-- about the day (src/lib/home/day-facts.ts) and may end its reply with up to
-- three strict PLAN lines (src/lib/home/plan-lines.ts): pin an existing
-- mission row, or author a Coach item that opens one of a fixed set of
-- destinations. Code validates every line and keeps the plan itself in
-- `users.preferences.dayPlan` — the `coachPass` pattern, no table needed for a
-- value that is replaced whole by every pass.
--
-- THIS table is the history: one row per thing that happened to one plan item.
--
--   shown      it was on Home (the hero or a checklist row), once per item
--   started    he tapped it — the destination opened
--   dismissed  he tapped its Dismiss, or skipped a pinned row from the hero
--   done       the action's data arrived (a weight, a meal, a session …) or,
--              for a destination with no data of its own, the tap itself
--   expired    its `until` passed, or its day ended, while it was still open
--   replaced   a later pass wrote a new plan while it was still open
--
-- What reads it: a 14-day COUNT summary handed to the pass as facts
-- ("Coach items: 9 shown, 6 acted on …"). Nothing deterministic reads it to
-- change anything — no item is suppressed, re-ranked or switched off because
-- of what this table says (memory: judgment lives in the model, not rules).
--
-- ── WHAT IS NEVER HERE ──
--
-- A Coach item is never a mission row. It is not in `log_entries`, it never
-- counts in "N of M", and the adherence ledger cannot see it. A PINNED row is a
-- mission row, and its outcome stays where it always was (`log_entries.status`);
-- the `done` / `dismissed` rows here record what became of the PIN — that the
-- Coach's choice was followed — not a second copy of the completion.
--
-- ── THE COLUMNS ──
--
--   · `plan_id` is the app-generated id of the pass's plan (preferences) — no
--     FK, because the plan is a preferences value replaced whole.
--   · `item_key` is the item's identity within its plan: `pin:<log entry id>`,
--     `do:<action>` or `do:<action>:<target id>`. Free text.
--   · `action` is the destination of a `do` item. FREE TEXT, not a CHECK: the
--     destination list is a TypeScript enum the parser enforces, and adding a
--     door to it must not be a table rebuild. `kind` is ARC's own two-word
--     vocabulary and gets the CHECK, with the pairing rule (a pin has no
--     action, a do item always has one).
--   · `log_entry_id` → `log_entries` ON DELETE SET NULL (CLAUDE.md §9): a
--     regenerated or removed row must not take the history with it. `title` is
--     the snapshot of what Home said, for the same reason.
--   · `rank` 1–3: a plan holds at most three items.
--   · UNIQUE (plan_id, item_key, event): every event happens at most once per
--     item, so the writers are `INSERT OR IGNORE` and Home may record `shown`
--     on every render without growing the table.
--
-- Volume: a plan a pass, at most three items, a handful of events each — a few
-- dozen rows a day. Kept; it rides the ARCB1 snapshot like every table.
--
-- Conventions per CLAUDE.md §9: app-generated v4 UUID text PK declared PRIMARY
-- KEY NOT NULL (src/lib/db/id.ts); ISO-8601 text timestamps; created_at +
-- updated_at with an AFTER UPDATE trigger; enum vocabulary as text + CHECK;
-- GLOB shape checks with `[0-9]` classes.
--
-- Numbered 0067: main's head is 0066 (item 86). The runner is forward-only and
-- stamps PRAGMA user_version = 67. A new table nothing references, so reverting
-- the code leaves a database that behaves as 0066 left it. Run
-- `npm run db:bundle` after this file changes.
-- ============================================================================

CREATE TABLE day_plan_events (
  id text PRIMARY KEY NOT NULL,
  -- The LOGICAL day the plan belongs to.
  day text NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  plan_id text NOT NULL CHECK (length(plan_id) > 0),
  item_key text NOT NULL CHECK (length(item_key) > 0),
  kind text NOT NULL CHECK (kind IN ('pin', 'do')),
  action text,
  log_entry_id text REFERENCES log_entries (id) ON DELETE SET NULL,
  title text NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  event text NOT NULL CHECK (
    event IN ('shown', 'started', 'dismissed', 'done', 'expired', 'replaced')
  ),
  -- The instant it happened.
  at text NOT NULL CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((kind = 'pin' AND action IS NULL) OR (kind = 'do' AND action IS NOT NULL))
);

CREATE UNIQUE INDEX day_plan_events_once_idx ON day_plan_events (plan_id, item_key, event);
-- The summary's window read.
CREATE INDEX day_plan_events_day_idx ON day_plan_events (day);

CREATE TRIGGER day_plan_events_set_updated_at AFTER UPDATE ON day_plan_events FOR EACH ROW BEGIN
  UPDATE day_plan_events SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
