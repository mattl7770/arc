# P1 — "Slices" as a food unit

**Status: PROPOSED** (2026-09-15; revised twice the same day after review — the second
pass narrowed the migration to one column on one table and dropped a phase). Parked
by the owner — *"back burner"* — and nothing here is scheduled. This is the argument
for what a slice IS in ARC's data model, written so that when the item comes off the
back burner the shape is settled and the one migration it needs is numbered.
**Backlog:** `docs/backlog-2026-09.md:65` (Parked). **Migration, if built:** `0059` —
the head on `main` is `0058` (`db/migrations/`; `docs/backlog-2026-09.md:72`); re-check
at merge, because the runner is forward-only and a number at or below a device's
`user_version` is never applied (`db/migrations/0058_composite_meal_items.sql:93-100`).

**The short version.** A slice is not a unit — `0047` settled that there are two of
those and no conversion between them. A slice is a **count of pieces**, and a count
is a **ratio**: three slices of an eight-slice pizza is `× 3/8`, the arithmetic the
composite fraction chips already do. What the app lacks is a place to write the count
down and a control that speaks it: one nullable column on `meal_items` (`piece_name`,
the noun `serving_qty` counts on a composite header, and nowhere else), a count field
beside the chips that the **owner** fills — the model's `pieces` only pre-fills it —
and two phases, the first standing without the second. No existing row is touched.

---

## 1. Current state

### The unit vocabulary is two words, and 0047 argues for exactly that

`foods.basis` and `meal_items.unit` are `'g' | 'ml'` (`db/migrations/0047_ml_unit.sql:14-19`).
The header is explicit: *"ONE new unit. No density table, no general unit system, no
`oz`/`cup`/`slice` in the schema"* (`0047:9-10`); *"Nothing converts"*, because a ml↔g
factor needs a density per food nobody has measured (`:21-26`); and the refusal is cheap
because *"energy and macros are already the common currency"* — totals sum across units
(`:28-33`). The same header parks this feature by name, and the nutrition doc repeats it
(`docs/nutrition-subapp.md:502`). Nothing below adds a basis or converts.

### A slice already exists — as a named serving on a catalog food

`foods` carries a household serving as a pair, `serving_name` and `serving_grams`
(renamed `serving_amount` by 0047), pair-or-none by a table-level CHECK
(`db/migrations/0014_food_catalog.sql:57-58,69`); the seed uses it for slices —
`'Bacon, cooked'` at `'1 slice'` / 8 g, `'Deli turkey'` at `'3 slices'` / 57 g
(`db/migrations/0016_food_seed.sql:34,36`). Tapping a food in search opens a stepper
when the food names a serving (`app/food-search.tsx:584-607`, 0.5 steps, `:201-215`);
Add builds the item through `itemForPortion(food, { servingQty })` (`:191-193`), which
stores the derived `amount` beside `serving_qty` (`src/lib/nutrition/servings.ts:64-70`),
and the row prints `3 × 1 slice (24 g)` through `portionLabel`
(`src/lib/nutrition/format.ts:99-109`). Create a food takes `slice` and `107` today
(`app/food-new.tsx:469-470`, pair-or-none at `:270-274`). For a catalog food, **option
(a) below is not a proposal; it shipped in 0014.**

### The composite path cannot reach a serving, and 3 of 8 is not one of the fractions

The owner's sentence is *"convenient for composite foods"*, and that is where the
mechanism stops. A composite header (0058) is written with `food_id` NULL — *"a header
is a dish, not a catalog food"* (`src/lib/db/repositories/nutrition.ts:213-216`) — and
`serving_qty` NULL (`:224`); the review sheet sends the header only `name`, `unit` and
`components` (`src/lib/nutrition/review-rows.ts:272`), as does the offline drain's own
builder (`src/lib/nutrition/estimate-queue.ts:152`). `portionLabel` needs the joined
`food_serving_name` (`format.ts:103`), and meal-detail passes hard-coded nulls — *"A
composite has no serving of its own"* (`app/meal-detail.tsx:799-802`), gated on
`node.rolled.amount != null` at `:794`. Its parts are in grams
(`src/lib/nutrition/estimate.ts:40-54`), and a slice is not a fraction of any part; it
is a fraction of the whole. The whole-dish handles are the grams field and three chips,
`½ · ⅓ · ¼` (`src/components/nutrition/estimate-review.tsx:60-64`;
`meal-detail.tsx:41-45`), both scaling every part from its current value
(`review-rows.ts:342-356,373-395`; `nutrition.ts:459-495`); the composite spike proposed
`⅔` and `¾` too (`docs/spikes/composite-foods.md:224`), which did not ship. So "3 of the
8 slices" is `× 0.375`, reachable only by doing `720 × 3 ÷ 8` in one's head and typing
`270`. C5's `scale_item` can do the arithmetic (`review-rows.ts:466-470`), but the answer
leaves 270 g behind and nothing that says "slices". And **the model prices what it
sees, not what was eaten**: *"Estimate each portion from visual cues (glass and plate
size, utensils)"* (`estimate.ts:267-270`); what was left is a thing it may ask about
(`:286-287`). §4.1 is built on this — any count the model returns is a count of what it
priced.

### What reads `serving_qty`, exhaustively

Six writers: `insertMealItem` (`nutrition.ts:206-235`), `updateMealItemPortion`
(`:344-375`), `scaleCompositeItem` nulling it on parts (`:476`), `relogMeal`'s copy
(`:748-761`), `insertTemplateItem` (`meal-templates.ts:29-52`, fed by `saveMealAsTemplate`
at `:89`), and `logMealFromTemplate` (`:188`). Four readers: the recents rails
`listRecentFoods` / `listRecentBarcodeFoods` (`src/lib/db/repositories/foods.ts:148,188`),
both `JOIN foods f ON f.id = mi.food_id` (`:151,191`); `portionLabel` (`format.ts:103-104`);
the templates screen (`app/meal-templates.tsx:50`); meal-detail's edit-mode predicate
(`meal-detail.tsx:324-326`). **No sum reads it** (`nutrition.ts:250-264,520-530,558-562`).

### The serving name is the one column on an item that is not a snapshot

Every column on `meal_items` is a snapshot at log time, and since 0047 so is the unit
(`docs/nutrition-subapp.md:509`). The exception is the serving's **name**: `listMealItems`
joins it live from `foods` (`nutrition.ts:499-508`) as `food_serving_name`
(`src/lib/nutrition/types.ts:194`), and when the food is gone the label degrades to the
bare amount (`format.ts:103-107`); `meal_template_items` never had the join, so a template
row prints `100 g` for two eggs (`meal-templates.tsx:48-52`). A real gap, and **not this
feature's gap** — the first draft was wrong to fold it in (§3 row b-wide; §7 Q4).

### The Coach never sees a portion; the estimator has its own ceiling

No Coach tool carries a food portion (§4.8). The estimator's prompts are a separate
one-shot cost under `ESTIMATOR_PROMPT_CEILING = 1000`, asserted against both
(`estimate.ts:309-343`; `db/nutrition-v2.test.mjs:2169-2199`). Measured with §36's own
estimator (`s.length / 3.6`, `:2172`), each literal array joined as the test joins it:
the estimation prompt (`estimate.ts:256-307`) is 3,318 chars ≈ **922 tok**, as its
accounting says (`:336`); the revision prompt (`:719-764`) is 2,873 chars ≈ **798 tok**,
which no comment records — **202 of headroom**, not the 225 the first draft claimed.

---

## 2. The owner's words

> **"Slices" as a food unit** — convenient for composite foods; back burner.
> — `docs/backlog-2026-09.md:65`

And the scope fence he set for the unit system, which governs this one too:

> *"it could get complex having too many and being too creative with it."*
> — quoted at `db/migrations/0047_ml_unit.sql:6-7`

---

## 3. The options, weighed

| # | Option | Verdict |
| --- | --- | --- |
| (a) | A slice is a **named serving** on the food | **Already shipped for catalog foods** (§1). Does not reach a composite: a header has no `food_id` and no `serving_qty` (`nutrition.ts:216,224`). Kept as the catalog half; no code |
| (b-wide) | **Snapshot the serving name onto every item** — a `serving_name` column on `meal_items` and `meal_template_items`, backfilled from the join, the live join retired, and the same column holding a piece noun on a composite | **Rejected, and it was the first draft's recommendation.** Three faults. It puts two vocabularies in one column — `'3 slices'` is a *serving phrase* (one serving is three slices) and `slice` is a *piece noun*, so `2 × 3 slices` is six slices and `3 × slice` is three, in the same column: the class of lie `0047:41-45` refuses to carry. Its backfill UPDATE fires `meal_items_set_updated_at` (`0014:109-111`) on every serving-logged row on the owner's phone, for a feature about composites. And it is scope the owner did not ask for: after it, correcting a catalog food's serving name stops fixing the label on rows already logged — a behaviour change nobody requested, carried as a prerequisite of a parked convenience. The gap it closes is real and is its own item (§7 Q4) |
| (b) | **A count and its noun on the composite header only** — `serving_qty` is the count, a new nullable `meal_items.piece_name` is the noun, non-null only on a header | **Recommended.** One column, one table, no backfill, no row touched, no join retired; `portionLabel` reads `piece_name ?? food_serving_name`, so a catalog row prints `2 × 1 egg` from the live join exactly as today and a header prints `3 × slice` from its own column. The two vocabularies never share a column. The grams-per-piece is **not** stored: it is `amount ÷ serving_qty`, and a stored copy would disagree with the first the moment a part is hand-edited (§4.1) |
| (c) | A third basis `'piece'` beside `g` / `ml` | **Rejected.** A basis is what the per-100 columns are per 100 *of* (`0047:14-16`); "per 100 pieces" is meaningless, and "per piece" needs a piece↔gram factor per food — the density table 0047 refuses, one axis over. It is also the CHECK widening that rebuilds three tables |
| (d) | Do nothing — the fraction chips cover the pizza | **The composite spike's own row for this feature:** *"Parked by the owner. Grams + fraction chips cover 'ate half' today and leave the door open"* (`docs/spikes/composite-foods.md:301`). Still true. What has changed since is only that the chips shipped as three of the eight-slice fractions, not the five proposed (`:224`), and that the record never says "slices" — a thinner case than a new mechanism usually has, which is why §5 keeps the cheapest phase standing alone |

**Why (b) and not (a) alone:** the owner's sentence is about composites, and (a) cannot
express one. **Why the count is `serving_qty` and not a new `pieces` column:** it already
means "how many of the named thing" — the food's serving (live join) or the header's own
piece noun; a second count column would be the same concept wearing a second name, the
reverse of 0047's argument for renaming `grams` to `amount` (`0047:39-50`). **Why the
noun is its own column:** a column that means two things needs a comment at every read
site (`0047:44`); `piece_name` means one thing.

**Why composites only, in every phase.** A model-counted *plain* item ("3 slices of
toast") would carry the noun into three places built for a serving count: the recents
rail re-adds by `lastServingQty` as a count of the catalog's serving
(`app/food-search.tsx:178-180`; `app/barcode-scan.tsx:488`), a template round-trip copies
`serving_qty` and comes back through the join as `3 × 1 slice` (`meal-templates.ts:89,188`),
and meal-detail's `beginEdit` enters serving mode on any grounded item with a
`serving_qty` (`meal-detail.tsx:324-326`). A header has no `food_id`, is flattened out of
a template (`meal-templates.ts:76-80`), and never reaches `beginEdit`, so on a header the
column has no such neighbours. Plain-item counts are a later extension, not designed here.

---

## 4. Proposed design

### 4.1 The principle: the count and the parts describe the same food

> **The unit says what the number is measured in. The count says how many of a named
> piece the parts, as they stand, add up to. The first count DECLARES that
> correspondence; every later change PRESERVES it by scaling the parts.**

The declaration is the half the first draft got wrong. A composite's parts are the
whole dish as priced (§1), so a count typed onto an uncounted composite can only mean
*"what is priced here is N pieces"* — never *"I ate N"*. Had the empty field taken `3`
as a label on a photographed whole pizza, the row would have read `3 × slice` over eight
slices of macros and the day's kcal would have counted the whole pizza — the headline
disagreeing with the parts, which 0058 built two belts to make impossible
(`0058:58-73`). So the empty field asks one question, and its label says which:

- **Uncounted** — the field is labelled `THIS IS`; typing `8` declares the parts to be
  eight slices. **Nothing scales**: `serving_qty = 8`, `piece_name = 'slice'`, every
  part and `meals.kcal` byte-identical.
- **Counted** — the field is labelled `I ATE`; typing `3` over `8` scales every part by
  `3/8` and writes `serving_qty = 3`: the parts and the count still describe the same food.

Two entries for the pizza case — `8`, then `3` — and the model's `pieces` (phase 2)
performs the first. Five consequences, each keeping 0047 intact:

1. **Nothing converts.** "Grams per slice" is `rolled.amount ÷ serving_qty`, derived
   every render, never written.
2. **A count is a fact about the whole.** Whatever scales the whole (chips, the
   whole-dish field, the count field) moves it; an edit to one part does not — you still
   ate three slices; they were lighter. 0058's asymmetry: *"a part edit never moves its
   siblings and never pushes back onto the parent"* (`docs/nutrition-subapp.md:899`).
3. **The current state is the record.** 3 → 4 scales every part by `4/3` from what it
   reads now — the owner's own answer to the composite spike's question 2
   (`docs/spikes/composite-foods.md:335-340`).
4. **The correspondence is testable.** Across any sequence of count edits and chips,
   `rolled.kcal ÷ serving_qty` is constant — the per-piece energy fixed at the
   declaration. A part hand-edit is the one thing allowed to move it (consequence 2),
   and §4.9 asserts exactly that boundary.
5. **A slice is not comparable across days, and is not meant to be.** Nothing sums or
   trends `serving_qty` (§1); "slices over time" would need the stored per-piece weight
   that is (b)'s rejected half.

> **Considered and rejected — storing the denominator.** `3 of 8`, a `pieces_total`
> beside `serving_qty`, is information about the photo, not the meal: once the parts are
> scaled to three slices, "8" is history of the estimate, and it invites a nonsense edit
> ("of 10", after the scale). The denominator lives exactly as long as it is needed — the
> count at focus, `countFrom` in §4.5 — and is never written.

### 4.2 Migration `0059` — one column, one table, no backfill

```sql
-- 0059_meal_item_piece_name.sql
ALTER TABLE meal_items ADD COLUMN piece_name text;
```

Then `npm run db:bundle` and commit `src/lib/db/migrations.generated.ts` — the step that
makes a migration reachable from Metro at all (`db/bundle-migrations.mjs:4-11`; 0058's
header names it at `:104`) — then `npm run db:validate`. **That command passes unchanged
and asserts nothing about this column**: `db/validate-schema.mjs` inserts into nine
tables (`users` … `body_metrics`, `:83-106`) and never names a meal table; what it adds
here is the `--check` that fails on a stale bundle (`package.json:16`). The assertion
that the column exists and behaves is `db/migrate.test.mjs` §9 (§4.9).

**The rule the column holds.** `piece_name` is non-null only on a composite header
(`is_composite = 1`), beside a non-null `serving_qty`, and names **one piece** of the
dish in the singular (`slice`, `wing`, `roll`). It is NULL on every row that exists today
and on every part and plain item forever; a catalog item's count keeps counting the
food's serving through the live join, untouched. `MealItemRow` and `NewMealItemFields`
(so `NewMealItemComponent`, `types.ts:199-217`) gain the field; `MealItemWithServing`
(`:194`) and its 27 references across 7 files stay as they are.

**No CHECK on the pairing, and that is 0034's finding.** The obvious constraint is
cross-column, and SQLite validates one on `ADD COLUMN` against existing rows
(`0034:41-56`; `0047:86-92`; `0058:81-91`). It would pass here, every existing row having
the column NULL, but the precedent's lesson is to put the invariant where it says
something useful when it breaks: the writers (§4.4) and the tests (§4.9).

**No backfill, no restamp, and a short way back.** Nothing that exists is a counted
composite, so there is no history to record and 0014's `AFTER UPDATE` trigger
(`0014:109-111`) never fires; the export gains one NULL column. That column is the only
one-way piece — nullable, unread while NULL, droppable by a later forward migration;
everything else in §4 is code and reverts with the commit.

### 4.3 A header may carry a count — invariant 2, restated

Today `insertMealItem` nulls a header's `serving_qty` beside its macros
(`nutrition.ts:220-231`). Invariant 2 lists *"kcal, protein_g, carbs_g, fat_g, fiber_g,
micros and confidence"* (`0058:45-47`), the doc adds *"amount"*
(`docs/nutrition-subapp.md:878`), and neither names `serving_qty`. The invariant exists
so that *"a query that forgets the rule under-counts by zero"* (`0058:64-65`), and it
does not reach a count: no sum reads `serving_qty`, and the two non-display readers, the
recents rails, inner-join on `food_id` (`foods.ts:151,191`), which a header never has
(`nutrition.ts:216`). §4.9 asserts both. So the header keeps the pair when supplied, and
invariant 2 gains one clause in 0059's header and the doc:

> *A header carries no number that sums. It may carry a **count** of what it is —
> `serving_qty` and its `piece_name` — because that is a fact about the whole and not
> about any part.*

**Parts never carry the pair**; a slice is not a fraction of the cheese. That holds by
the writers, not a CHECK: `scaleCompositeItem` nulls both on each part (`:476`), and the
two builders that construct part rows explicitly — `priced()` in `review-rows.ts:250-266`
and in `estimate-queue.ts:134-147` — gain `piece_name: null` beside their existing
`serving_qty: null` (`:257`; `:139`). **The last part takes the count with it:**
invariant 4 deletes the header when its last part goes (`0058:51-53`) — `removeMealItem`
(`nutrition.ts:430-435`), `removeRow` (`review-rows.ts:309-310`) — so nothing new is
needed, and §4.9 pins that the pair goes with the header.

### 4.4 Repository rules and the carriers

| Function | Change |
| --- | --- |
| `insertMealItem` (`nutrition.ts:206-235`) | stops nulling `serving_qty` on a header (`:224`); writes `piece_name` on every row — the pair when supplied on a header, NULL otherwise |
| `scaleCompositeItem(db, parentId, factor)` (`:459-495`) | in the same transaction, `serving_qty = serving_qty * ?` on the header where not NULL; `piece_name = NULL` beside `serving_qty = NULL` on each part (`:476`). The chips and the whole-dish field route through it, so `½` on six slices reads `3 × slice` |
| **new** `setCompositeCount(db, parentId, count, name?)` | refuses a non-finite or ≤ 0 count the way `:460-462` refuses a factor; refuses a non-header. Reads the header's `serving_qty`. **NULL → the declaration:** writes `serving_qty = count`, `piece_name = name ?? 'piece'`, scales nothing — the parts as stored are the dish being counted (§4.1). **Otherwise** `scaleCompositeItem(db, parentId, count / current)` and then writes `serving_qty = count` explicitly (and `piece_name` when given), so 3 → 4 → 3 lands on exactly 3, not on a product of two floats |
| **new** `clearCompositeCount(db, parentId)` | nulls the pair on a header, scales nothing — the route to re-declaring a count the model got wrong (§7 Q3) |
| `updateMealItemPortion` (`:344-375`) | unchanged; it never runs on a header, and a part's `piece_name` is already NULL |
| `removeMealItem` (`:422-439`) | unchanged. Removing a part leaves the count (a slice without its pepperoni is still a slice); removing the last part removes the header and the count (§4.3) |
| `relogMeal.copy` (`:748-761`) | carries `piece_name` beside `serving_qty` (`:753`), so a re-logged pizza is a counted pizza |
| `saveMealAsTemplate` (`meal-templates.ts:75-98`), `logMealFromTemplate` (`:169-197`), `insertTemplateItem` (`:29-52`) | **unchanged.** A template flattens a composite to its leaves (`:76-80`), so the pair never reaches `meal_template_items` — the same honest loss the doc records for the header's name |
| `MealRevisionItem` (`estimate.ts:687-701`) | gains `pieces?: { name: string; count: number } \| null` |
| its three builders — `meal-revise.tsx:96-108` (`toRevisionItem`), `estimate-queue.ts:158-169` (`revisionRow`, the 0057 offline-drain path), `review-rows.ts:498-518` (`rowsToRevisionSubject`, the C5 typed-answer path) | each carries `pieces` from the header's `serving_qty` / `piece_name` |
| `buildMealRevisionRequest` (`:767-804`) | the header's tail (`:792-794`) becomes ` — 8 × slice, 3 parts`, built by `countLabel` (§4.5) |
| `rowsToMealItems` (`review-rows.ts:249-275`) and the drain's `toMealItems` (`estimate-queue.ts:133-155`) | send `serving_qty` / `piece_name` on the header from the row's `pieces`; both `priced()` builders send `piece_name: null` |

**One convention on the wire.** The revision request prints an item's amount, kcal,
macros and micros and never its serving count (`estimate.ts:776-787`), so a deli-turkey
row shows the model `57 g, 104 kcal, …` today and tomorrow. The only count the model sees
is a header's piece count; no `2 × 3 slices` sits beside `8 × slice`, and no rail is owed.

### 4.5 The review sheet — the owner's count, then the model's

**`ReviewItem` gains three fields** (`review-rows.ts:93-99`): `pieces: { name; count } |
null`; `countText: string`, the sibling of `amountText`; and `countFrom: { count: number
| null } | null`, the count as it stood at focus — an inner `null` means the row had none
and this focus is a declaration. `rowsFromEstimate` (`:237-246`) seeds `pieces` from the
estimate item in phase 2 and `null` before.

**The control is a field and a noun, not a stepper.** On an uncounted composite it is
its own row under the chips; once counted it joins them:

```
I ATE     ½   ⅓   ¼                     (uncounted)
THIS IS   [   ] × piece

I ATE     ½   ⅓   ¼      [ 8 ] × slice  (counted)
```

The count is the parts' own `AmountField` anatomy (`estimate-review.tsx:66-97`) with
`accessibilityLabel` `Pieces in ${row.name}` while uncounted and `${row.name}, pieces
eaten` once counted — every comparable control here carries one (`:91`, `:186-188`,
`:245`). The noun is a label-voice Pressable at `min-h-[44px]` (`accessibilityLabel`
`Name one piece of ${row.name}`) that swaps to a one-line `TextInput` on tap and commits
on blur, meeting the spec's target rule (`00-design-spec.md:101`). A field rather than
the catalog stepper because 8 → 3 is one keypad entry and ten taps at the stepper's 0.5
step (`food-search.tsx:204`), and because it is the whole-dish grams field's sibling with
the same live, snapshot-from-focus semantics — one scaling mechanism. With no count the
field is empty and the noun reads `piece` in muted ink.

**Pure functions** (`review-rows.ts`, headless):

- `beginCountEdit(rows, key)` sets `scaleFrom = components` and `countFrom = { count:
  pieces?.count ?? null }`; `endCountEdit` drops both.
- `setCompositeCount(rows, key, text)`: writes `countText`. `parseCount` accepts a finite
  number `> 0` and `≤ 100` (the amount ceiling's cousin, `estimate.ts:448-449`);
  mid-typing (`"abc"`) holds the text and moves nothing (`:382-386`), except that **an
  empty field on a counted row clears the count** — `pieces = null`, `countFrom =
  { count: null }`, parts untouched — which is how a wrong model count is re-declared
  (§7 Q3). With `countFrom.count` **null** the number *declares*: `pieces = { name:
  pieces?.name ?? 'piece', count }`, parts still. With it **set**, the parts become
  `from.map(scaleRow(c, count / countFrom.count))` from `scaleFrom`, non-compounding as
  `scaleCompositeTo` is (`:373-395`). A null `countFrom` at the keystroke (a sibling
  control dropped it mid-focus) is taken now from the current row — a declaration only
  if `pieces` is null.
- `setPiecesName(rows, key, name)` — trimmed, non-empty, else unchanged.
- **The invariant, stated once:** *`countFrom` is never consumed against parts it did
  not describe.* Every writer that nulls `scaleFrom` nulls `countFrom` too —
  `setRowAmount` on a part (`:289`), `scaleComposite` (`:352`), `removeRow` (`:311`),
  `applyAnswer` (`:477,484`), `endCompositeScale` (`:365`). Chips and the grams field
  multiply `pieces.count` by the factor they apply to the parts; a part hand-edit leaves
  the count (§4.1, 2). On the screen the chips' handler ends the count edit first, so the
  two are never live at once; headless, a chip mid-focus still cannot compound: parts `P`
  counted `8`; `⅓` → `P/3`, count `8/3`, baselines dropped; `3` re-snapshots and scales
  by `3 ÷ 8/3 = 9/8` → `3P/8`, what `3` before the chip would have given.
- `applyAnswer`'s `scale_item` on a composite goes through `scaleComposite` (`:466-470`)
  and so moves the count — a C5 "3 of the 8" leaves `3 × slice`.

**What it prints.** One formatter: `countLabel(qty, noun)` in `format.ts` returns
`${fmtQty(qty)} × ${noun}` — the two tokens `portionLabel` already builds at `:104`,
lifted out so the review sheet's sub-line, `portionLabel` and the revision tail cannot
drift; `fmtQty` rounds to one decimal (`format.ts:19-22`). The header keeps its `3 parts`
tag (`estimate-review.tsx:178,201-205`); its mono sub-line (`:226`) becomes `8 × slice ·
P 96g · C 224g · F 80g`, and after a `⅓` chip reads `2.7 × slice`, a third of eight.
**Device: unchanged** — one `Block device="plate"` (`:278`), parts indented inside it
(`:27-33`); no accent, Save keeps it (`:35-40`); no signal colour, a count is not
biology; no filler.

### 4.6 The estimator (phase 2): how it reports "8 slices"

**The contract.** The item gains one optional key, read on a composite header and
ignored anywhere else (`estimate.ts:56-97`): `"pieces": {"name": string, "count":
number}|null`. The rule the prompt states is a **criterion with three examples**, not a
dish list — judgment in the model, the parser validating shape only, the way
`QuestionEffect` is *"a wire format for what the model decided, not a decision table"*
(`estimate.ts:108-117`):

```
- If what you priced is a countable number of pieces (slices, wings, rolls), give
  "pieces": the singular noun and the count; else null.
```

**The count is of what was priced.** A whole pizza comes back `{slice, 8}`; three slices
on a plate `{slice, 3}`. That is §4.1's declaration made by the model instead of the
owner — why phase 2 is a convenience and not a dependency. When the plate does not show
how much was eaten the model already has the C5 machinery to ask (`:286-287`), and a
`scale_item` answer moves the count with the parts.

**The parser** (`parseMealEstimate`, `:568-626`): `parsePieces(raw)` → a trimmed
non-empty noun and a finite count `> 0` and `≤ 100`, else `null`; read only when
`components` is non-null. A reply with no `pieces`, or with it on a plain item, is
today's reply. **Grounding** (`groundMealEstimate`, `:1083-1138`) never prices a header
(`:1125-1135`) and never touches `pieces`. There is no catalog-versus-model contest to
adjudicate, because the count never lands on a grounded item (§3); had it, `:1088-1093`
— *"a mismatch keeps the model's own numbers, which are at least self-consistent"* —
already answers it, and the first draft was wrong to put that to the owner.

**The token cost, measured** — §36's estimator (`nutrition-v2.test.mjs:2172`), the
post-change prompts assembled and measured rather than summed from deltas:

| | chars | tokens |
| --- | --- | --- |
| estimation prompt today (`estimate.ts:256-307`) | 3,318 | **922** |
| + the pieces rule, after the composite bullet (`:266`) | +137 | +38 |
| + `"pieces"` on the schema line, after `confidence` (`:300`) | +50 | +14 |
| − the trim the constant already names (`estimate.ts:338-341`): fold the hidden-fats bullet (`:275-276`, 128 chars) and "prefer underestimating" (`:281`, 64 chars) into one bullet of 156 chars | −36 | −10 |
| **estimation prompt after** | 3,473 | **≈ 965**, against 1,000 |
| revision prompt today (`:719-764`) | 2,873 | **798** |
| + the schema clause (after `:758`) | +50 | +14 |
| + one rail after the composite rule (`:734`): *Keep "pieces" as it arrived unless the correction itself changes the count.* | +77 | +21 |
| **revision prompt after** | 3,002 | **≈ 834** |

To be exact about the rule at `:322`: this proposal **nets +43 on the estimation prompt**
after the fold and raises no ceiling, which is what that rule binds. If §36 prints over
970, the constant's second named trim (`:339`, three confidence definitions to two) is
next. The same commit adds the revision figure to the accounting comment (`:324-336`).

### 4.7 What each surface prints

| Surface | Today | After |
| --- | --- | --- |
| **Eat tab row** (`app/nutrition.tsx:344`) | time · name · macro cells · kcal | **unchanged** — no item portion is drawn there, and none should be |
| **meal-detail, composite sub-line** (`meal-detail.tsx:792-811`) | `270 g · P 36g …` | `3 × slice (270 g) · P 36g …`. The `node.rolled.amount != null` guard at `:794` moves *inside* the argument (`amount: node.rolled.amount`), the nulls at `:801-802` become `serving_qty: node.item.serving_qty, piece_name: node.item.piece_name`, and `format.ts:103-105` decides — it already prints the bare `3 × slice` when the amount is NULL, which is precisely the mixed-unit composite where the count is the only whole-dish figure there is |
| **meal-detail, expanded composite** (`:826-855`) | parts, then `I ATE ½ ⅓ ¼` | the rows of §4.5. Chips keep writing immediately through `scaleParts` (`:846`); the count opens the one-editor-at-a-time edit state (`:328-330`) and its Save calls `setCompositeCount`; an emptied field calls `clearCompositeCount` |
| **meal-detail, plain item** (`renderItemRow`, `:438-439`) | `2 × 1 egg (100 g)` | identical string, through the same join |
| **Review sheet, composite** (`estimate-review.tsx:168-258`) | `3 parts`, grams field, chips | as §4.5; the whole-dish grams field is unchanged and keeps multiplying the count |
| **Templates** (`meal-templates.tsx:48-52`) | `100 g` | **unchanged** (§3 row b-wide; §7 Q4) |
| **Revision request** (`estimate.ts:792-794`) | `— 3 parts` | `— 8 × slice, 3 parts` |

**A catalog food's slice weight** comes from three existing sources: Create a food
(`food-new.tsx:469-470`, `source = 'user'`); C2's food-entry prompt, which already asks
for a household serving (`estimate.ts:916-917`, pair-or-none at `:988-998`, `source:
'ai'` at `:870-873`); and Open Food Facts' `serving_size` / `serving_quantity`
(`src/lib/nutrition/openfoodfacts.ts:160-176`) — a loaf's `"2 slices (57g)"` is a
two-slice serving, and splitting that string is parsing prose into a unit, not in v1.
**For a composite no catalog food is minted** (`nutrition.ts:213-216`; a one-off pizza
*"would fill the recipe book with garbage"*, `composite-foods.md:302`).

### 4.8 The Coach: a measured zero

Schema delta **0 / 0**. No Coach tool carries a food portion — `log_recipe`'s
`servings`/`grams` is a cooked-dish weight (`src/lib/ai/tools/write-tools.ts:1848-1872`),
and nothing under `src/lib/ai` names `meal_items` (search: no match) — so there is no
property to add and nothing to trim for; 0047 measured the same zero
(`docs/nutrition-subapp.md:569-573`), and both ceilings stand at 9,250 / 3,700
(`db/coach-eval.test.mjs:814-822`). What the Coach reads, the meal's summed columns,
moves only because the parts scale, as with the chips; re-run `coach-tools` §37 (`:2674`).

### 4.9 Tests that would pin it

Headless, `node:sqlite`. Section numbers are the next free integer above each file's
highest today — **re-check at merge**: `db/coach-tools.test.mjs` carries three §37s
(`:2674,:2735,:2802`) and two §38s (`:2857,:2901`); `a7cef11` on `main` repaired that.

**`db/nutrition-v2.test.mjs`, §41 onward** (§40 is the last, `:2492`; file ends `:2528`):

1. A composite logged with `serving_qty 8` / `piece_name 'slice'`: the header holds both,
   `amount` and every macro NULL, `meals.kcal` the parts' sum, unchanged from §30 (`:1849`).
2. **The negative:** `recomputeMealTotals`, `partialMealMetrics` and `mealItemCounts`
   are byte-identical before and after the header gains a count; `listRecentFoods` and
   `listRecentBarcodeFoods` are unchanged by it (the inner join, §4.3) — §31's shape (`:1897`).
3. `scaleCompositeItem(× 0.5)` halves every part **and** the count (8 → 4); `× 2` returns
   it to exactly 8; no part has a non-null `piece_name` after.
4. **The declaration moves nothing:** `setCompositeCount(8, 'slice')` on an uncounted
   header leaves every part and `meals.kcal` byte-identical and writes the pair. **The
   correspondence holds:** after `8 → 3`, `meals.kcal` is `3/8` of the original and
   `meals.kcal ÷ serving_qty` equals the per-piece figure at declaration; after `3 → 4`
   it still does; `3 → 4 → 3` lands on exactly 3; a part hand-edited (40 → 20) is scaled
   from 20 and is the one step that moves the per-piece figure. 0 or `NaN` throws as
   `:460-462` does; a non-header is refused.
5. Editing or removing one part leaves the header's count byte-identical (§4.1, 2);
   removing the last part removes the header and its pair (invariant 4).
6. Review rows: with no count, `setCompositeCount` declares and the parts stand; with
   one, `8 → 3` equals `× 3/8` of the frozen parts and `3` then `30` from one focus does
   not compound; **a `⅓` chip then `3` from the same focus lands every part on `3/8` of
   the pre-chip values**; chips and the grams field multiply the count; an emptied field
   clears it and the next number declares afresh; `setPiecesName` refuses an empty noun;
   after any of these, no part carries `piece_name`.
7. `applyAnswer` with `scale_item 0.375` on the composite moves the count to 3.
8. `rowsToMealItems` carries the pair onto the header and `piece_name: null` onto every
   part; `replaceMealItems` round-trips it (§35's shape, `:2100`); `relogMeal` copies it;
   `saveMealAsTemplate` flattens the header away and the parts keep their grams.
9. All three revision builders carry `pieces`; `buildMealRevisionRequest` prints
   `— 8 × slice, 3 parts` through `countLabel`; **the 0057 drain** — a revision queued
   offline against a counted composite (§29's shape, `:1749`) — keeps the count.
10. The parser: `pieces` with a noun and count lands on a header; an empty noun, a count
    of 0, 101 or `"three"` → null; `pieces` on a plain item or a component is ignored; a
    reply with no `pieces` parses exactly as today (the §34 fixture, `:2016`, unchanged).
11. Grounding never prices a header and never rewrites `pieces`; the drain's `toMealItems`
    carries the pair onto the header.
12. §36 re-asserts both prompts under `ESTIMATOR_PROMPT_CEILING` with the fold landed in
    the same commit, and prints both figures.

**`db/migrate.test.mjs`, §9** (after §8 at `:584`; `stageAt` is `:146`): stage a
populated database at **0058** with a catalog item at `2 × '1 egg'`, a composite and a
plain item; migrate to 0059. `user_version` is 59, `piece_name` is NULL on every staged
row, a header accepts the pair, `listMealItems` still joins the egg's serving name.

**`db/foods.test.mjs`, §16** (after §15 at `:826-860`, untouched: its `portionLabel`
calls pass no `piece_name` and read as today): `portionLabel` prints `3 × slice (270 g)`
from `piece_name`, prefers it over a joined `food_serving_name`, and prints
`2 × 1 egg (100 g)` from the join alone; `countLabel(2.6667, 'slice')` is `2.7 × slice`.

**`db/screens-render.test.mjs`, §20** (the highest today is §19 at `:2715`; the file's
order is non-monotonic — §7b at `:995` follows §8 at `:989` — so the number is chosen
above the maximum, not by position): meal-detail over a counted composite renders
`3 × slice (270 g)`, and over one whose parts are in **mixed units** renders `3 × slice`
with no amount; `THIS IS` and the empty field appear only on an uncounted composite with
its parts expanded, `I ATE` with the field only on a counted one; both accessibility
labels render.

**The gate.** The whole of `npm run db:test` — **56 suites** (`package.json:17`), 4,805
assertions on `main` at the A9 gate (`docs/project-status.md:11`), the render suite under
its own loader (`register-render-hooks.mjs`, the script's last entry) — plus `npm run
typecheck`, `npm run db:validate` (20/20, fresh bundle), `npx expo export --platform ios
--clear`, and lint at 0 errors. The number that matters is 0 failed across 56.

---

## 5. Effort, phases, and the way back

| Phase | Piece | Size |
| --- | --- | --- |
| **1 — a count on a composite** | `0059` + `db:bundle` + `db:validate` + migrate §9; the header keeps the pair; `scaleCompositeItem` moves it; `setCompositeCount` / `clearCompositeCount`; `piece_name: null` in both `priced()` builders; `portionLabel` + `countLabel` + foods §16; `ReviewItem`'s three fields and the pure functions; the field and noun on both `I ATE` rows with their labels; meal-detail's sub-line and edit state; `MealRevisionItem.pieces` and its three builders; nutrition-v2 §41–49; screens §20 | 1.5 days |
| **2 — the model's `pieces`** | both schema lines, the rule, the rail, `parsePieces`, the drain's `toMealItems`, the fold, §36 re-measured and its comment extended; §50–52 | 0.5 day |
| | **Total** | **≈ 2 days** |

**Phase 1 stands without phase 2.** It gives the owner a count on a photographed pizza
with **no model change**: two keypad entries, `8` then `3`, which is what makes the
feature independent of §6's first bullet. Phase 2 performs the first entry for him; if it
is never built, or the model does not return `pieces` for the right things, nothing is
orphaned. Abandoned after phase 1, the column is nullable and unread and every other
change is code (§4.2). **No native module, so no EAS rebuild** — it runs on the binary
already on the phone, offline except for the estimate itself; the noun and the count ride
the model request the pizza already makes. The day boundary (`src/lib/db/date.ts:168,232`)
is untouched.

> **Considered and rejected — a provenance stamp on the count.** Nothing distinguishes a
> model-declared count from an owner-declared one. True, and it is the gap every part
> amount has: a hand-edited review figure keeps the model's `confidence`
> (`review-rows.ts:263`), and a chip on meal-detail stamps nothing (`nutrition.ts:459-495`).
> The general answer is `resolved_by` on `meal_items`, designed in the composite spike
> (`composite-foods.md:252-268`) and not built; stamping one number and not the others
> would be a half-pair. When `resolved_by` lands, the count takes it.

> **Considered and rejected — the serving-name snapshot as a prerequisite.** The first
> draft carried option (b-wide) as its phase 1 to "close the one non-snapshot column".
> The review's point holds: a day of work and a backfill over every serving-logged row on
> the device, for a behaviour change the owner never asked for, in service of a parked
> feature that does not need it. The gap is one backlog line on its own merits (§7 Q4).

---

## 6. What only a device can settle

- **Whether the model returns `pieces` for the right things.** Phase 2's rule is a
  criterion with three examples, tested against a mock; the first photographed pizza and
  plate of two eggs are the test. Phase 1 means a wrong answer costs one keypad entry.
- **Whether the label switch reads.** `THIS IS` becomes `I ATE`, and the field moves up a
  row, the moment the first count lands. If it reads as the control jumping, the fallback
  is one row in both states and a label switch only.
- **The `I ATE` row at 375pt.** Three 44pt chips, a `w-14` field, a noun and the label,
  at `pl-6`, is roughly 330pt of a ~343pt plate interior; if it wraps, the field and noun
  take a second line. The sub-line is about twelve characters longer, in 10pt mono.
- **`2.7 × slice`** — a third of eight slices to one decimal. Honest, and possibly
  alarming. Two remedies, and the device pass picks: replace the chips once a composite
  is counted, so a fraction of a counted dish is typed as a count (§7 Q2b); or keep the
  chips and let the decimal stand. Rounding to `3` is not a remedy — it prints a count
  the parts do not add up to, the disagreement §4.1 exists to prevent.
- **Clear-then-type versus select-and-type.** `selectAllOnFocus`
  (`src/components/ui/select-on-focus.ts:65`; used at `estimate-review.tsx:90`) means
  typing over a focused `8` scales, while backspacing to empty and then typing declares
  afresh. Two gestures for "change 8 to 6"; if that is a trap in the hand, §7 Q3b is the
  explicit affordance.

---

## 7. Questions for the owner

**1. On a photographed pizza, what does the first number typed into an uncounted
composite mean?**

- (a) **(Recommended)** *"This dish is N pieces."* The field is drawn on every composite,
  labelled `THIS IS` and empty until filled; typing `8` declares the parts to be eight
  `piece`s (tap the noun to make it `slice`) and nothing scales. From then on it is
  labelled `I ATE` and scales: `3` lands on three slices' worth. Two entries for a whole
  pizza you ate part of; the model's `pieces` (phase 2) performs the first.
- (b) *"I ate N."* One entry — but the app does not know how many pieces the dish was,
  so it cannot scale, and the row would read `3 × slice` over a whole pizza's macros.
  Rejected in §4.1; listed so the choice is visible.
- (c) Only when the model gives a count — the feature then hangs on §6's first bullet.

**2. Does the count field sit beside the `½ ⅓ ¼` chips, or replace them once the
composite is counted?**

- (a) **(Recommended)** Beside them. The chips are one tap and you chose them in the
  composite spike; a count is the precise handle, a chip the fast one — the pairing the
  grams field already has. A chip on a counted dish prints the honest `2.7 × slice`.
- (b) Replace them once the composite has a count. `½` of a counted pizza becomes typing
  `4`; no decimal counts ever appear. The chips stay on uncounted composites.

**3. When the model's count is wrong — it said 8, the pizza was 6 slices — how do you
re-declare it without scaling?**

- (a) **(Recommended)** Clear the field. An empty count means "no count"; the next number
  declares afresh and moves nothing. No new furniture; one gesture to learn (§6).
- (b) A `Recount` link beside the noun that clears the count. One more control, no
  gesture ambiguity.
- (c) Tap the noun — the noun editor also re-declares the count. Overloads a rename control.

**4. The serving name on a logged item is joined live from the catalog, so deleting the
food erases `2 × 1 egg` and a template prints `100 g` for two eggs. Should snapshotting
it be its own backlog item?**

- (a) **(Recommended)** Yes — one line in `docs/backlog-2026-09.md`, built on its own
  merits when it bothers you, with its own migration and backfill.
- (b) Build it with this feature after all (the first draft's phase 1: a day more, every
  serving-logged row restamped, a corrected catalog serving name no longer reaching
  logged rows).
- (c) Leave the join alone; the degradation to a bare amount is acceptable.
