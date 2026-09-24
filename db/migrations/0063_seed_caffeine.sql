-- ============================================================================
-- ARC 0063 — caffeine on the seed foods that carry it
--
-- Owner, on the device, 2026-09-23: *"Important micro should show on key items;
-- i.e., displaying caffeine on a latte"*. The item row learned to show it
-- (src/lib/nutrition/key-micro.ts) — but only an AI-estimated latte had a figure
-- to show. The 0016 starter catalog predates the `caffeine_mg` key (A8,
-- 2026-09-14), so 0 of its 187 rows record caffeine, the app's own
-- 'Latte, whole milk' and 'Coffee, black' included. A latte logged from search,
-- recents or favorites therefore printed no caffeine, and the day's Caffeine
-- cell under the macro bars undercounted every one of them.
--
-- Data-only: no schema change. This is the catalog-update migration 0016's
-- header anticipated ("a future catalog-update migration can reference rows by
-- id") — 0016 is shipped and is never edited.
--
-- ── WHICH ROWS: every seed row that carries caffeine, by its fixed id ──
--
-- Five, matched by the fixed v4 id 0016 minted for each (every install shares
-- them) — never by name. A name substring would be the fuzzy match CLAUDE.md §7
-- refuses for biomarkers, in spirit: 'cola' is inside 'chocolate', and
-- 'coffee' would be inside a user's 'Decaf coffee'.
--
-- Values are per 100 g — the basis every 0016 row is measured in — from USDA
-- FoodData Central (SR Legacy, public domain, CC0), the source 0016 was authored
-- from. The SR Legacy NDB number is on each FDC record:
--
--   Coffee, black         40    NDB 14209  coffee, brewed from grounds, tap water
--   Latte, whole milk     37.4  derived — see below
--   Cola                  8     NDB 14400  carbonated cola, contains caffeine
--   Dark chocolate 70-85% 80    NDB 19904  chocolate, dark, 70-85% cacao solids
--                                          (the record 0016 took this row's iron
--                                          and magnesium from)
--   Milk chocolate        20    NDB 19120  candies, milk chocolate
--
-- **The latte is derived, and says so.** FDC's latte is a survey (FNDDS) recipe,
-- not an SR Legacy measurement. What SR Legacy does measure is the espresso in
-- it: NDB 14210, espresso, restaurant-prepared, 212 mg per 100 g — 63.6 mg in a
-- 30 g shot. The row's own serving is 12 oz (340 g); at two shots that is
-- 127.2 mg a serving, 37.4 mg per 100 g. Two shots is the latte this app already
-- reasons with (docs/nutrition-subapp.md §12l: a two-shot latte's 126 mg), and
-- cafés pour one or two: a one-shot latte is half this figure. No screen and no
-- Coach edit writes a food's micros, so a single-shot latte is his own food
-- (Add food) or a Describe, not an edit to this row.
--
-- **Left without caffeine, on purpose** — absent beats guessed (0016's header,
-- docs/nutrition-subapp.md §3): 'Kombucha' (tea-brewed, but its caffeine varies
-- with the brew and SR Legacy has no figure for it), 'Chocolate chip cookie' (a
-- few milligrams from its chips, with no figure to cite), and 'Trail mix'
-- (chocolate only sometimes). The catalog has no tea, espresso, cappuccino or
-- energy drink row, so there is none to fill; adding catalog rows is a
-- different change from recording a figure on the ones that exist.
--
-- ── A ROW THE USER CHANGED IS HIS, AND IS LEFT ALONE ──
--
-- No screen edits a catalog food, but the Coach can: `edit_record` over
-- `food_catalog` (src/lib/ai/domains/read-domains.ts) rewrites the name, the
-- brand, the four per-100 macros and the basis through `updateFood`, which
-- keeps `source = 'seed'`; and it can delete one. So each UPDATE below writes
-- only where the row is still, column for column, the food 0016 seeded, and
-- only the one key it adds:
--
--   * `source = 'seed'` — provenance never changes, so this is belt and braces;
--   * `name_norm` is still the seeded name — a row renamed 'Decaf latte' is the
--     user's food now, and 37.4 mg would be a guess about it;
--   * `brand` and `barcode` are still NULL — a latte he gave his café's name is
--     that café's latte;
--   * `basis = 'g'` — the figure is per 100 GRAMS, and 0047 converts nothing:
--     a row switched to millilitres has per-100 figures in a different unit;
--   * the serving and all five per-100 figures are still 0016's, exactly — a
--     latte re-priced as his café's single-shot oat latte, name kept, is his
--     food too, and two shots of caffeine would be 1.5–2× what it holds.
--     Exact equality is safe here: every value was written from the same
--     decimal literal, and the Coach's edit writes back what it read for any
--     figure it was not asked to change. Deliberately NOT `updated_at =
--     created_at`: starring a food stamps `updated_at` and changes nothing
--     about the food;
--   * `micros` is NULL or a JSON object with NO `caffeine_mg` — a caffeine
--     figure already there (a 0 included) is never overwritten;
--   * `json_set` ADDS the key and keeps every other key as it stands, so a
--     sodium or potassium already on the coffee survives beside it.
--
-- A deleted seed row simply matches nothing.
--
-- ── WHAT THIS DOES NOT TOUCH, AND HOW A REPEAT LOG STILL GETS THE FIGURE ──
--
-- `meal_items` are the record of what was eaten (0014, 0017): a latte logged
-- before this migration keeps the micros it was logged with. Rewriting history
-- from a catalog figure would be rewriting what the record says.
--
-- `meal_template_items` are not written here either, but for a different
-- reason: they do not need to be. A REPEAT log — "Log again" (`relogMeal`) and
-- a template (`logMealFromTemplate`) — fills, at log time, every micro key the
-- linked food records and the snapshot does not, for the snapshot's own amount
-- (`repeatMicros`, src/lib/db/repositories/nutrition.ts). So yesterday's
-- latte logged again, or the 'Morning latte' template, logs with its caffeine
-- from the first launch after this migration, and so will any key a later
-- catalog update adds. One rule in the repository rather than a one-off
-- backfill of one table here.
--
-- What changes, then, is every latte logged from now on — fresh from the
-- catalog, again from yesterday, or from a template — and an old one
-- re-portioned on the meal screen, which re-derives each figure the food
-- records (`rescaleLoggedItem`), caffeine now among them.
--
-- The AFTER UPDATE trigger (0014) stamps `updated_at` on the rows filled; that
-- is a real catalog change and is left to say so.
--
-- ── THE NUMBER: 0063 ──
--
-- Main's head is 0062 (exercise load basis); the owner's phone is at 0061. The
-- runner is forward-only and silently skips any file at or below a device's
-- user_version, so this is the next free number above main — re-check the
-- sibling worktrees at merge. The runner stamps PRAGMA user_version = 63.
-- ============================================================================

-- Each UPDATE names the row by its 0016 id and then restates 0016's own values
-- for it, so the WHERE clause reads as the seed line it is checking against.

-- Coffee, black — NDB 14209, 40 mg per 100 g (96 mg in the row's 240 g cup).
UPDATE foods
SET micros = json_set(COALESCE(micros, '{}'), '$.caffeine_mg', 40)
WHERE id = 'a1cef987-d928-48db-a726-e9b98b742263'
  AND source = 'seed'
  AND name_norm = 'coffee, black'
  AND brand IS NULL
  AND barcode IS NULL
  AND basis = 'g'
  AND serving_name = '1 cup' AND serving_amount = 240
  AND kcal_100g = 1 AND protein_g_100g = 0.1 AND carbs_g_100g = 0 AND fat_g_100g = 0
  AND fiber_g_100g = 0
  AND json_type(COALESCE(micros, '{}')) = 'object'
  AND json_type(COALESCE(micros, '{}'), '$.caffeine_mg') IS NULL;

-- Latte, whole milk — two shots of NDB 14210 espresso in 340 g: 37.4 per 100 g.
UPDATE foods
SET micros = json_set(COALESCE(micros, '{}'), '$.caffeine_mg', 37.4)
WHERE id = 'bb7b36af-e57e-44fd-9062-37a158612e02'
  AND source = 'seed'
  AND name_norm = 'latte, whole milk'
  AND brand IS NULL
  AND barcode IS NULL
  AND basis = 'g'
  AND serving_name = '12 oz' AND serving_amount = 340
  AND kcal_100g = 44 AND protein_g_100g = 2.3 AND carbs_g_100g = 3.5 AND fat_g_100g = 2.4
  AND fiber_g_100g = 0
  AND json_type(COALESCE(micros, '{}')) = 'object'
  AND json_type(COALESCE(micros, '{}'), '$.caffeine_mg') IS NULL;

-- Cola — NDB 14400, 8 mg per 100 g (28 mg in the row's 355 g can).
UPDATE foods
SET micros = json_set(COALESCE(micros, '{}'), '$.caffeine_mg', 8)
WHERE id = 'c458157a-1d0c-42b4-833c-d36cc8ef994c'
  AND source = 'seed'
  AND name_norm = 'cola'
  AND brand IS NULL
  AND barcode IS NULL
  AND basis = 'g'
  AND serving_name = '1 can (12 oz)' AND serving_amount = 355
  AND kcal_100g = 42 AND protein_g_100g = 0 AND carbs_g_100g = 10.6 AND fat_g_100g = 0
  AND fiber_g_100g = 0
  AND json_type(COALESCE(micros, '{}')) = 'object'
  AND json_type(COALESCE(micros, '{}'), '$.caffeine_mg') IS NULL;

-- Dark chocolate, 70-85% — NDB 19904, 80 mg per 100 g (8 mg in a 10 g square).
UPDATE foods
SET micros = json_set(COALESCE(micros, '{}'), '$.caffeine_mg', 80)
WHERE id = '8ec296da-6053-4ccd-8fbb-a94fedc0ef08'
  AND source = 'seed'
  AND name_norm = 'dark chocolate, 70-85%'
  AND brand IS NULL
  AND barcode IS NULL
  AND basis = 'g'
  AND serving_name = '1 square' AND serving_amount = 10
  AND kcal_100g = 598 AND protein_g_100g = 7.8 AND carbs_g_100g = 45.9 AND fat_g_100g = 42.6
  AND fiber_g_100g = 10.9
  AND json_type(COALESCE(micros, '{}')) = 'object'
  AND json_type(COALESCE(micros, '{}'), '$.caffeine_mg') IS NULL;

-- Milk chocolate — NDB 19120, 20 mg per 100 g (9 mg in the row's 44 g bar).
UPDATE foods
SET micros = json_set(COALESCE(micros, '{}'), '$.caffeine_mg', 20)
WHERE id = '0cf7bd11-58bb-4105-a346-f095009e613e'
  AND source = 'seed'
  AND name_norm = 'milk chocolate'
  AND brand IS NULL
  AND barcode IS NULL
  AND basis = 'g'
  AND serving_name = '1 bar' AND serving_amount = 44
  AND kcal_100g = 535 AND protein_g_100g = 7.7 AND carbs_g_100g = 59.4 AND fat_g_100g = 29.7
  AND fiber_g_100g = 3.4
  AND json_type(COALESCE(micros, '{}')) = 'object'
  AND json_type(COALESCE(micros, '{}'), '$.caffeine_mg') IS NULL;
