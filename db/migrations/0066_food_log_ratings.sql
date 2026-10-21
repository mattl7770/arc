-- ============================================================================
-- ARC 0066 — was this estimate right? `food_log_ratings`
--
-- Owner, device round 3, item 86: *"good/bad rating for food logs & questions
-- asked to collect data and make them better"*. His decision: the rating is
-- about HOW ACCURATE THE LOG WAS. A "bad" asks ONE question — was the portion,
-- the item or the macros off? — and the correction he then makes becomes an
-- example the estimator sees next time (docs/nutrition-subapp.md §23).
--
-- ── WHY A TABLE, AND NOT A COLUMN ──
--
-- No existing column honestly fits. `meal_items.confidence` is the MODEL's
-- claim about its own number, written once at estimate time; a rating is the
-- USER's verdict on it, written later, and the two answer different questions
-- (a 'high' item can be rated off — that is the very case worth learning from).
-- `meals.notes` is free text the user reads; a verdict the estimator parses
-- would be a machine field hiding in prose. And a rating carries a pair of
-- snapshots — the items as they stood when he said "off", and as they stood
-- after he fixed them — which is a record of its own, not a property of the
-- meal's current state.
--
-- ── ONE ROW PER MEAL, AT THE MEAL ──
--
-- A rating is of the LOG — the meal — not of one item: the question is one
-- question (portion · item · macros), and "which item?" would be a second.
-- Which item was wrong is in the before → after pair. `meal_id` is UNIQUE: a
-- changed mind replaces the verdict (the repository upserts), it does not add
-- a second one to disagree with the first.
--
-- ── ON DELETE CASCADE, and why that is not history being destroyed ──
--
-- CLAUDE.md §9 prefers SET NULL for anything referencing a log, so that
-- deleting a PROTOCOL never takes the record of a day lived under it. This is
-- the other direction: the rating is ABOUT the meal — an annotation of one
-- log's accuracy — and with the meal gone there is nothing left for it to be
-- about. A NULL `meal_id` would be a verdict on nothing. The meal screen's
-- delete and the Eat tab's combine both carry the rating rows in what their
-- Undo restores (`takeMeal` / `combineMeals`, src/lib/db/repositories/
-- nutrition.ts), so an Undo still puts back every row exactly. The correction
-- an estimator example was built from goes with its meal: a deleted meal is a
-- log he took back, and learning from it would teach the estimator a meal that
-- did not happen.
--
-- ── THE CHECKS ──
--
--   · `rating` is ARC's own vocabulary, closed at two (CLAUDE.md §9: text +
--     CHECK). `issue` is the one question's three answers, NULL until it is
--     answered (an "off" is recorded before the question is).
--   · A "good" carries no issue and no snapshots. This cross-column CHECK is
--     safe where 0034's lesson says such CHECKs are not: that lesson is about
--     an ALTER over a populated table, and this table is new — there is no row
--     on any device for it to reject.
--   · `before_items` / `after_items` are JSON arrays of top-level items (name,
--     amount, unit, kcal, protein_g, carbs_g, fat_g), guarded by json_valid.
--     `after_items` is NULL until something actually changed.
--
-- ── THE NUMBER: 0066 ──
--
-- Main's head is 0065; this number is reserved for item 86. The runner is
-- forward-only and stamps PRAGMA user_version = 66.
--
-- ── THE WAY BACK ──
--
-- A new table nothing else references: reverting the code leaves a database
-- that behaves as 0065 left it. Run `npm run db:bundle` after this file
-- changes.
-- ============================================================================
CREATE TABLE food_log_ratings (
  id text PRIMARY KEY NOT NULL,
  meal_id text NOT NULL UNIQUE REFERENCES meals (id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('good', 'bad')),
  issue text CHECK (issue IS NULL OR issue IN ('portion', 'item', 'macros')),
  -- The meal's items when he said "off" — what the estimate had become by then.
  before_items text CHECK (before_items IS NULL OR json_valid(before_items)),
  -- The same items after his fix; NULL while nothing has changed.
  after_items text CHECK (after_items IS NULL OR json_valid(after_items)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    rating = 'bad' OR (issue IS NULL AND before_items IS NULL AND after_items IS NULL)
  )
);

-- The examples read: the latest corrections first.
CREATE INDEX food_log_ratings_rating_idx ON food_log_ratings (rating, updated_at DESC);

CREATE TRIGGER food_log_ratings_set_updated_at AFTER UPDATE ON food_log_ratings FOR EACH ROW BEGIN
  UPDATE food_log_ratings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
