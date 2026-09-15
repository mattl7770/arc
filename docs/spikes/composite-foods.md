# C4 — Composite foods

**Status: BUILT** (2026-09-14, branch `claude/c3-c5-estimator`). The owner took the recommended option at every question — (a) a composite is one item among many, (a) "ate half" halves the *corrected* value, (a) fraction chips plus an amount field — and the design below shipped as written, with four deltas recorded in `docs/nutrition-subapp.md` §12k:

1. **It shipped as `0058`, not `0049` — and §3.1's warning is why.** The header below says *"reserving a number does not hold it… re-check at merge, not at authoring time"*, and that is exactly what happened: `main`'s head moved 0047 → 0054 while this branch was being written, and `claude/c12-c13-exercise` took 0055–0056. `0049` is **still unused on main**, which is the trap — the runner is forward-only and silently skips anything at or below a device's `user_version`, so a free-looking number below the head is stranded on the phone forever, with nothing failing in any test that starts from an empty database. Renumbered at the moment of commit; the full argument is in `0057`'s header.
2. **It holds two columns, not three.** `resolved_by` on `meal_items` (§3.6) was **not** built: it is a provenance feature in its own right, not a composite one, and the owner's decision list did not carry it. The argument in §3.6 stands and is worth its own round.
3. **The token table below was measured before `ml` landed (0047).** Against the real baseline — 542 tokens, not 449 — C4 cost **+149**, which is within a rounding error of the +153 predicted. The `ESTIMATOR_PROMPT_CEILING` §3.5 recommends was built, at 1,000, and guards **both** estimator prompts.
4. **The two review screens now share one table** (`src/components/nutrition/estimate-review.tsx`) rather than each growing a copy of the tree.

The original proposal follows unchanged.
**Reserved migration:** `0049` (`docs/backlog-2026-09.md:70`). Head on `main` was `0044` when this was drafted and `0045` (`0045_workout_drafts.sql`) a few hours later — **re-check `git ls-tree main -- db/migrations/` at merge, not at authoring time.** Reserving a number does not hold it; the backlog records five collisions in two days, and A-phase work moved the head while this proposal was being written.
**Citations verified against `main` at `950c846`.** `main` moves several times a day; if a line number below misses, the surrounding quote is the anchor.
**Scope fence from the owner:** *specifically composite foods like pizza, **not** a general modifier system.*

---

## 1. Current state

### `meal_items` is flat, and nothing in it can express "part of"

```
db/migrations/0014_food_catalog.sql:83-101
```

The table has `id`, `meal_id` (→ `meals`, `ON DELETE CASCADE`), `food_id` (→ `foods`, `ON DELETE SET NULL`), a name snapshot, `grams` / `serving_qty`, the five macro columns, and `confidence`. `micros` arrived by `ALTER` in `0017_meal_item_micros.sql:25`. There is **no self-reference and no grouping column** — every row is a sibling of every other row in the same meal.

Read order is insertion order: `ORDER BY mi.created_at, mi.rowid` (`src/lib/db/repositories/nutrition.ts:350-360`).

### The meal's totals are a flat `sum()` over every row

```
src/lib/db/repositories/nutrition.ts:182-190   recomputeMealTotals
```

`UPDATE meals SET kcal = (SELECT sum(kcal) FROM meal_items WHERE meal_id = ?) …` — with no filter of any kind. **This is the double-count hazard.** If a composite parent carried its own macros alongside its children's, the pizza would be counted twice in `meals.kcal`, and from there into `todayTotals` (`:72`), `dailyIntakeSeries` (`:104`), the Eat tab's hero (`src/lib/nutrition/remaining.ts:106-116`) and the readiness pillar (`src/lib/home/readiness.ts:556-561`).

### Two other reads would break silently on a parent row

- **`partialMealMetrics`** (`src/lib/db/repositories/nutrition.ts:393-427`) marks a meal "knowingly short" on a metric when `max(mi.kcal IS NULL)` is true for any item. A macro-less composite header trips that on every metric, and `dayFigure` (`src/lib/nutrition/remaining.ts:106-116`) drops the Eat tab out of `remaining` mode into `eaten` mode — the hero stops counting down and prints the authored fallback (`unguardedNote`, `:160-190`) for a meal that is in fact fully priced.
- **`mealItemCounts`** (`src/lib/db/repositories/nutrition.ts:362-372`) is a bare `count(*)`. It drives the `N items` tally on the Eat tab row (`app/nutrition.tsx:214`), which under a collapsed composite would say `4 items` over a plate drawing two — the tally rule in `docs/design-research/implementation/00-design-spec.md:169` ("Tallies must reconcile").

### The estimator's contract is a flat array

```
src/lib/nutrition/estimate.ts:38-67     MealEstimateItem / MealEstimate
src/lib/nutrition/estimate.ts:127-153   MEAL_ESTIMATION_SYSTEM_PROMPT
src/lib/nutrition/estimate.ts:199-248   parseMealEstimate
```

The prompt's second rule is the opposite of what C4 asks for: *"Itemize the meal: one entry per distinct food, not one blob."* (`estimate.ts:133`). A photographed pepperoni pizza comes back today as either one `Pepperoni pizza` item or three unrelated sibling rows with no statement that they are one thing.

Grounding maps flatly over `estimate.items` (`estimate.ts:459-495`) and re-prices any item whose name is an exact or leading-phrase catalog match (`isConfidentMatch`, `:441-446`). The seed catalog **does** contain whole-dish archetypes — `'Pizza, cheese slice'`, `'Cheeseburger, fast food'`, `'Chicken burrito'`, `'California sushi roll'` (`db/migrations/0016_food_seed.sql:187-190`) — so a whole-dish item can already ground, which is exactly what must not happen to a composite header.

### The review sheet and the meal screen both draw one flat table

- `app/meal-estimate.tsx:695-758` — one `Block device="plate"`, a `SectionLabel` whose note is the live kcal total (`:435-438`, `:696-699`), then one `Divider`-ruled row per item: name + `≈ confidence` (`:715-721`), a grams `TextInput` (`:724-732`), kcal (`:735-737`), a remove `×` (`:738-745`), a mono macro sub-line (`:747-751`).
- `app/meal-detail.tsx:636-710` — the same anatomy with inline portion editing instead of a text field.
- `app/meal-revise.tsx:234-255` — the plain-English correction path calls `replaceMealItems` (`src/lib/db/repositories/nutrition.ts:325-337`), which **deletes every row for the meal and re-inserts from a flat list**. A composite tree passed through that today comes back flattened.

### Provenance exists — but not on `meal_items`

`resolved_by` (`'user' | 'catalog' | 'ai'`) lives on `recipe_ingredients` only: `db/migrations/0034_recipe_photo_autoresolve.sql:99-105`, with the rationale at `:13-39` (*"a number of unknown origin entering the rollup… wearing the same face as a number the user asserted"*) and the disclosure it enables at `src/lib/db/repositories/recipes.ts:501` (`estimatedCount`). `meal_items` carries only `confidence` (`0014:95`), and **only the AI paths stamp it** — `app/meal-estimate.tsx:384` and `app/meal-revise.tsx:248`; templates deliberately drop it (`src/lib/db/repositories/meal-templates.ts:68`); catalog, barcode and manual never set it.

---

## 2. The owner's words

> *"Take a photo of a pepperoni pizza… one composite item (pepperoni pizza) as well as rows below that are pizza crust, cheese, and pepperoni. If I ate the whole pizza but took the pepperoni off half, I could change just one thing. If I ate only half, I could change the entire thing together."*
> — `docs/backlog-2026-09.md:38`, with the scope fence in the same cell: *"Specifically composite foods like pizza, not a general modifier system."*

And, parked (`docs/backlog-2026-09.md:63`):

> *"**'Slices' as a food unit** — convenient for composite foods; back burner."*

**Slices stay parked here.** Everything below is expressed in grams and in fractions of the whole. Nothing in this design needs a slice, and nothing in it blocks slices later: a slice count is a `serving_name`/`serving_grams` pair on the composite row, which `0014:57-58` already supports and which the seed catalog already uses (`'1 slice'`, `0016:187`).

---

## 3. Proposed design

### 3.1 Data model — migration `0049` is needed

Two `ALTER TABLE meal_items ADD COLUMN`s and one index. **No new table:** a component is a `meal_item` in every other respect, and a second table would have to duplicate the whole snapshot/macro/micros column set.

```sql
-- 0049_composite_meal_items.sql
ALTER TABLE meal_items ADD COLUMN parent_item_id text
  REFERENCES meal_items (id) ON DELETE CASCADE;

ALTER TABLE meal_items ADD COLUMN is_composite integer NOT NULL DEFAULT 0
  CHECK (is_composite IN (0, 1));

CREATE INDEX meal_items_parent_idx ON meal_items (parent_item_id);
```

**`ON DELETE CASCADE`, not `SET NULL`.** A component has no meaning outside its composite — the argument `0014:35-36` already records for `meal_items → meals` (*"an item has no meaning outside its meal, like workout_sets"*). The delete-semantics rule that prefers `SET NULL` protects *execution history* from *catalog churn*; a pizza's cheese is not execution history in its own right.

**Why a flag as well as a parent id.** "Is this row a composite?" is answerable without the flag — `EXISTS (SELECT 1 FROM meal_items c WHERE c.parent_item_id = mi.id)` — and a derived answer cannot drift. The flag is proposed anyway, for one reason that is about the sums and not about convenience: `recomputeMealTotals` and `partialMealMetrics` need a **cheap, indexable predicate that is true of a parent even in the instant between deleting its last child and deleting it**, and a correlated subquery inside the totals recompute is the shape most likely to be copied wrong by the next query that needs it. The cost is a denormalisation, governed the way every other denormalisation here is: **the repository is the only writer** (`docs/nutrition-subapp.md:223`).

#### The invariants (repository-maintained, test-pinned)

| # | Invariant | Why |
| --- | --- | --- |
| 1 | `is_composite = 1` ⟹ `parent_item_id IS NULL` | **One level only.** The pizza's cheese does not decompose. This is what keeps C4 a composite-foods feature and not the general modifier system the owner ruled out. |
| 2 | `is_composite = 1` ⟹ `kcal`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `micros`, `confidence` are all **NULL** | The parent is a **header, not a row of numbers**. See fail-safe, below. |
| 3 | `parent_item_id IS NOT NULL` ⟹ the parent exists, sits in the same `meal_id`, and has `is_composite = 1` | A component orphaned into another meal is a corrupt ledger. |
| 4 | A composite always has **≥ 1 component** | Removing the last component removes the composite. A header over nothing is a row named "Pepperoni pizza" with no numbers — indistinguishable from an unpriced meal, the state `replaceMealItems` already refuses at the meal level (`nutrition.ts:325-328`). |
| 5 | A composite's `grams` = the sum of its components' grams when **every** component has grams; NULL otherwise | Never a fabricated total. The same NULL discipline as `sumOrNull` (`nutrition.ts:143-149`). |

**No cross-column `CHECK`, and that is 0034's finding rather than laziness.** The obvious constraint is `CHECK (is_composite = 0 OR kcal IS NULL)`. `0034:41-56` records that SQLite validates an `ADD COLUMN` `CHECK` **against existing rows**, passes it on an empty fixture and rejects the whole `ALTER` on a populated one — *"which is exactly how that would have shipped"*. Here the new columns default to `0`/NULL so it would in fact pass, but the precedent's real lesson holds: **validate against a populated fixture** (`npm run db:validate`, which runs the DDL headless through `node:sqlite`), and put the invariant where it can say something useful when it breaks — the repository and the tests.

#### The roll-up: children only, never both — and fail-safe about it

**The parent's stored macros are NULL (invariant 2), and every sum additionally filters `is_composite = 0`.** Two belts, because the risk is asymmetric:

- A **NULL-macro parent** means a query that forgets the rule under-counts by zero — `sum()` skips NULL (`nutrition.ts:182-187`). It fails safe.
- A **sum-carrying parent** means a forgetful query silently doubles the pizza. It fails dangerous, on the number the whole app is built on.

So the storage makes the dangerous mistake impossible, and the filter is added anyway so the intent is legible at every call site.

The number the reader *sees* on a collapsed composite is the **derived** sum of its components, computed at read time, never stored. That satisfies the ledger rule (`00-design-spec.md:168`, *"the visible meals must add to 2,180"*) by construction rather than by maintenance: the headline **is** the children's sum, so it cannot disagree with them.

#### Repository changes

| Function | Change |
| --- | --- |
| `recomputeMealTotals` (`nutrition.ts:182-190`) | `WHERE meal_id = ? AND is_composite = 0` on all four sub-selects. |
| `partialMealMetrics` (`:393-427`) | `AND mi.is_composite = 0`. Without it, every composite meal drops the Eat tab out of countdown mode. |
| `mealItemCounts` (`:362-372`) | `AND mi.parent_item_id IS NULL` — **a different filter, for a different question.** The sums want leaves; the tally wants *what the collapsed ledger draws*, which is one row per pizza. Both get a comment naming their question, because they will otherwise be "corrected" to match each other. |
| `removeMealItem` (`:339-347`) | If the removed row was its parent's last component, remove the parent too (invariant 4), in the same transaction. |
| `replaceMealItems` (`:325-337`) | Must take a **tree**, not a flat list, or `app/meal-revise.tsx` flattens every composite it touches. |
| `listMealItems` (`:350-360`) | SQL unchanged; the tree is assembled in JS (below). |
| **new** `addCompositeItem(db, mealId, header, components)` | One transaction: insert the header (macros NULL, `is_composite = 1`), insert each component with `parent_item_id`, recompute. |
| **new** `scaleCompositeItem(db, parentId, factor)` | See 3.3. |

#### The shape the UI reads

A pure assembler, `src/lib/nutrition/composite.ts`, in the style of `servings.ts` / `remaining.ts` (pure, headless-tested, no `Database`):

```ts
export type MealItemNode =
  | { kind: 'item'; item: MealItemWithServing }
  | { kind: 'composite'; item: MealItemWithServing;
      components: MealItemWithServing[];
      rolled: { grams: number | null; kcal: number | null; protein_g: number | null;
                carbs_g: number | null; fat_g: number | null; fiber_g: number | null } };

export function assembleMealItems(rows: MealItemWithServing[]): MealItemNode[];
```

Top-level order stays the existing `created_at, rowid` order; components keep that order inside their parent. A row whose `parent_item_id` names a parent not present in `rows` is emitted **top-level** rather than dropped — a ledger never silently loses a row it is holding.

### 3.2 How the estimator recognises and returns a composite

The JSON contract gains one optional key on an item:

```
{"name": string, "grams": number|null, "kcal": number, "protein_g": number,
 "carbs_g": number, "fat_g": number, "fiber_g": number|null,
 "confidence": "high"|"medium"|"low",
 "components": [{"name", "grams", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"}]|null}
```

**When `components` is present and non-empty, `parseMealEstimate` drops the parent's own macros and keeps only the children's.** Not "reconciles them" — drops them. One fact gets one number, and this removes any possibility of a pizza whose headline disagrees with its parts. It is also the parser's existing posture: it already never trusts the model's shape, defaults missing macros and downgrades an unknown confidence to `'low'` (`estimate.ts:188-248`).

Prompt rules, drafted verbatim (measured in 3.5):

```
- A named prepared dish whose parts a person would change separately — a pizza, a burger, a
  burrito, a sandwich, a salad with dressing — comes back as ONE item carrying a "components"
  array of at most 4 parts, and NO macros of its own. Everything else is a plain item with no
  "components". Never decompose a single ingredient or a packaged product.
```

The criterion is *"parts a person would change separately"*, not a dish list — the dishes are examples, the way the owner's scenarios are examples (standing rule: **judgment lives in the model, not a rule table**). The 4-part cap is a hard number because a nine-row pizza is a data dump, and the **parser** enforces it (`slice(0, 4)`) rather than hoping.

**Grounding must not price the parent** (`groundMealEstimate`, `estimate.ts:459-495`). Today a `Pepperoni pizza` item with grams would hit `isConfidentMatch` against the seeded `Pizza, cheese slice` only on an exact or leading-phrase match — but `Cheeseburger, fast food` and `Chicken burrito` sit one leading phrase away from what a model will actually write, and a catalog re-price on the header would contradict the components beneath it. So: **recurse into `components`, and skip any item that has them.** Single-token component names (`"cheese"`, `"crust"`) fail `isConfidentMatch` by design (`:441-446`) and keep the model's numbers — correct, since grounding "cheese" against the alphabetically-first cheese is the exact failure that rule exists to prevent.

### 3.3 Editing — what the parent does to the children, and back

**Editing the parent's amount = proportional scaling.** The owner's *"If I ate only half, I could change the entire thing together"*, made arithmetic:

```
scaleCompositeItem(db, parentId, factor)
```

multiplies **every component's** `grams`, `kcal`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g` and every value inside `micros` by `factor`, in one transaction, then recomputes. The parent's displayed grams and kcal follow because they are derived (3.1). Proportional is the only honest reading of "I ate half a pizza": halving the crust and not the cheese would be a claim about *which* half, which nothing knows.

Two details decide whether this feels right:

- **Nothing is rounded on write.** `meal_items` macros are `real` (`0014:88-94`) and rendering rounds (`fmtInt`). 720 g → ×0.5 → ×2 returns to 720 g. Round on write and the pizza loses a gram every time the owner changes his mind.
- **Scaling acts on the components' *current* values, not on a hidden original.** There is no base column and there should not be one: the current state is the only state the record has, and a hidden original would make the visible numbers stop being the record. *(This is owner question 2.)*

**Editing one component = today's mechanism, unchanged.** *"If I ate the whole pizza but took the pepperoni off half"* is the pepperoni row's grams going 40 → 20, through `updateMealItemPortion` (`nutrition.ts:271-322`) and the tested `rescaleLoggedItem` (`src/lib/nutrition/servings.ts`), which already re-derives from the catalog food when there is one and scales the snapshot when there is not. **Editing a component never touches its siblings and never pushes back onto the parent** — the parent has no numbers to push onto. It changes what the parent *displays*, which is the point.

**Removing a component** is the existing `×` (`meal-detail.tsx:685-692`, `meal-estimate.tsx:738-745`). Removing the last one removes the composite (invariant 4), and the screen says so before it happens: `Removing the last part removes "Pepperoni pizza".`

**Removing the composite** removes its components, by the FK, with `PRAGMA foreign_keys = ON` (CLAUDE.md §9).

### 3.4 How the review sheet draws it — Conformed Set

**Device: unchanged.** The Items block stays the single `Block device="plate"` it already is (`meal-estimate.tsx:695`). A composite is **not** a nested plate — `00-design-spec.md:44`: *"a block gets exactly one device. Never nest devices"*, enforced at runtime in `__DEV__`. A composite is content inside a plate, the same class as a pillar cell inside a field.

**Collapsed by default.** The composite row keeps the anatomy of every other row, so the table stays a table:

| slot | collapsed composite | plain item (today) |
| --- | --- | --- |
| leading | a **disclosure chevron** (`chevron-forward` → `chevron-down`), 16px, `palette.inkSecondary` | — |
| name | serif 15px `ink` — `Pepperoni pizza` | same |
| tag | mono 10px `ink-muted` — `3 parts` | `≈ medium` |
| amount | the mono `TextInput`, **the whole-dish handle** | grams field |
| kcal | mono 13px — the components' sum | its own kcal |
| trailing | `×` | `×` |

The composite row carries **no `≈ confidence` of its own.** It has none — it is a sum, and its confidence is the components'. The screen's `est · AI` stamp (`meal-estimate.tsx:675-677`) already says the whole proposal is an estimate.

**Expanded:** the components are ruled rows **inside the same plate**, indented `pl-6` (24pt, clearing the chevron column), each preceded by a `Divider`, each carrying its own grams field, kcal, `≈ confidence` and `×`. **No new mark, no fill, no left rule** — a margin rule inside a plate would read as a nested `margin` device, and the drawing set's own answer to subordination is indentation on a ruled table. The last component is followed by the next top-level `Divider`, so the plate's rhythm is unbroken.

**What a tap does, and what it says back.**

- **Tap the chevron** → the parts appear. It says nothing in words; it *draws* the answer. `accessibilityState={{ expanded }}` on the row, and the row is grouped so it speaks as one phrase — `"Pepperoni pizza, 3 parts, 1,840 kcal"` — the rule `readiness-strip.tsx:107-109` applies to a pillar cell.
- **Type `360` into the composite's amount** → every component row visibly halves, live, before anything is written. **That is the confirmation.** The owner watches the arithmetic happen instead of reading a sentence promising it. The Items label's total (`:434-437`, `:695-698`) moves with it, because it is already derived from the live rows — that code needs no change at all.
- **Type into a component's grams** → that row re-prices; the composite's headline follows; siblings do not move.
- **Fraction chips.** Under the expanded composite, one row of label-voice chips — `½ · ⅓ · ¼ · ⅔ · ¾` — each ≥44pt, each a `scaleCompositeItem` against the current amount. Grams stays the precise handle; the chips are the fast one, because "I ate half" is the sentence actually spoken. Outlined, never accent: in the `review` phase the accent is `Save meal` and stays there (`meal-estimate.tsx:774-793`; the screen's stated "accent budget: one per phase", `:89-90`).
- The pending-write line above `Save` (`:766-771`) is unchanged and already correct: nothing is written until Save.

**`app/meal-detail.tsx` gets the same tree**, with its inline `PortionEditRow` (`:1150`) on components instead of a text field, plus the one extra line a composite earns there — the provenance disclosure (3.6).

### 3.5 Model / prompt changes, with the honest token cost

Measured with `db/coach-eval.test.mjs`'s own estimators (`:382-383` — ~3.6 chars/token for prose, ~2.8 for dense JSON):

| | chars | prose tok |
| --- | --- | --- |
| `MEAL_ESTIMATION_SYSTEM_PROMPT` today (`estimate.ts:127-153`) | 1,616 | **449** |
| \+ the composite rule (3.2, verbatim) | 354 | **+98** |
| \+ the `components` clause on the JSON schema line | 199 | **+55** |
| **after C4** | ~2,169 | **~602** |

> **Re-measured 2026-09-14 after A8 landed on `main`.** The first draft of this table said 296 tokens, measured hours earlier. Backlog A8 (caffeine / fiber / sodium) then merged and added five prompt lines plus a `micros` key on the schema line (`estimate.ts:140-144`, `:150-152`) — **+153 tokens, a 52% growth in one merge, on a prompt nothing guards.** That is the argument for the ceiling below, made by events rather than by assertion.

**Neither Coach ceiling moves.** `db/coach-eval.test.mjs:651` guards `toWireTools(COACH_TOOLS)` at 9,250 and `:657` guards `buildCoachSystemPrompt` at 3,700. The estimator is a **different system prompt on a tool-less turn** — `estimate.ts:270` passes `tools: []` — so it is measured by neither. It is also guarded by **nothing at all**, which is how a 296-token prompt became a 449-token prompt inside a day without anyone noticing. **Recommend adding an `ESTIMATOR_PROMPT_CEILING` assertion to `db/nutrition-v2.test.mjs` in this round**, in §6's accounting style, so the next addition has something to trip.

Three smaller facts, stated because they are easy to assume wrongly:

- **The prompt is not the cost of a photo request.** A ~1024px JPEG is ~1,369 vision tokens (`docs/nutrition-subapp.md:76`), so the prompt is ~25% of a photo turn's input before this change and ~31% after. On describe-in-words it is the bulk.
- **The estimator's system block does not cache today.** Prompt-cache minimums are 512 on Opus 5, 1,024 on Sonnet 5, 4,096 on Haiku (`src/lib/ai/model-client.ts:60-62`), and `buildMessagesRequest` puts the breakpoint on the system block (`:269`). At 449 tokens it is under every floor; at ~602 it would clear **Opus 5's** and no other. Not a reason to do anything — recorded so nobody claims it as a win.
- **The parser already validates a nested per-item object, and that is the precedent `components` follows.** A8 taught `parseMealEstimate` to take the model's `micros` object through `coerceMicros` / `serializeMicros` — unknown keys and non-numbers dropped, nothing usable serialising back to NULL rather than `{}` (`estimate.ts:235-238`). `components` is the same move on a different key, so C4 adds a shape to an established pattern rather than a new kind of trust.

**Output** grows by roughly one component array per composite — ~120–180 tokens for a three-part pizza, and only on meals that have one.

### 3.6 Provenance — `resolved_by` on `meal_items`

The rule `0034:13-39` established for recipe lines applies here with more force, because a composite's decomposition is a **deeper fiction than a flat estimate**: the split between crust and cheese is not visible in a photograph the way the pizza is. Same column, same three-value vocabulary, on `meal_items`:

```sql
ALTER TABLE meal_items ADD COLUMN resolved_by text
  CHECK (resolved_by IS NULL OR resolved_by IN ('user', 'catalog', 'ai'));

UPDATE meal_items SET resolved_by = 'ai'   WHERE confidence IS NOT NULL;
UPDATE meal_items SET resolved_by = 'user' WHERE confidence IS NULL;
```

**The backfill is a record of what happened, not a guess** — 0034's own standard (`:58-62`). Only the two AI paths stamp `confidence` (`app/meal-estimate.tsx:384`, `app/meal-revise.tsx:248`); templates deliberately drop it (`meal-templates.ts:68`); catalog, barcode and manual never set it. So `confidence IS NOT NULL` is exactly "the estimator priced this".

**One honest loss, named:** a meal cooked from a recipe (`logRecipe`, `src/lib/db/repositories/recipes.ts:654`) lands items with no confidence, so its AI-priced lines backfill as `'user'`. The truth survives one level up in `recipe_ingredients.resolved_by`, and going forward `logRecipe` should carry each line's `resolved_by` onto the meal item it stamps. Worth doing in this round — it is three tokens of SQL.

**Going forward:** a composite header takes `'ai'` when the model proposed the decomposition and `'user'` once the owner edits it; components take `'catalog'` when grounding matched (`groundMealEstimate` sets `foodId`), `'ai'` otherwise, `'user'` once hand-edited.

**What it buys on screen** is one line under a composite on `meal-detail`, in the metadata cut — the disclosure `estimatedCount` already makes for a recipe (`recipes.ts:501`):

> `Parts estimated by AI` · or · `2 of 3 parts matched to your catalog`

### 3.7 The tests that would pin it

In `db/nutrition-v2.test.mjs` (the suite that already owns items, rescale and grounding):

1. A composite with three components: `meals.kcal` equals the **components'** sum, and moves by exactly the right amount when one component changes. *The double-count guard, asserted as a number.*
2. A composite header with NULL macros does **not** appear in `partialMealMetrics`, and `dayFigure` stays in `remaining` mode. *This is the regression that would otherwise ship silently — the Eat tab hero quietly stops counting down.*
3. `mealItemCounts` returns `1` for a meal holding one three-part composite, and `2` for that plus a beer.
4. Deleting a composite deletes its components (FK cascade).
5. Deleting the **last** component deletes the composite; deleting a non-last one does not.
6. `scaleCompositeItem(×0.5)` halves every component including `micros`, and `×0.5` then `×2` round-trips exactly (the no-rounding-on-write rule).
7. Editing one component leaves its siblings byte-identical and moves only the parent's derived totals.
8. `parseMealEstimate` on a reply with `components`: parent macros dropped, a 5-component array truncated to 4, `components: []` treated as a plain item.
9. `groundMealEstimate` grounds components and **never** sets `foodId` on a composite header — pinned with `Cheeseburger, fast food` in the fixture, the seeded row most likely to be matched wrongly (`0016:188`).
10. `assembleMealItems` on an orphaned component (parent absent) emits it top-level rather than dropping it.
11. `replaceMealItems` round-trips a tree (the `meal-revise` path) without flattening it.
12. `db/screens-render.test.mjs`: `meal-estimate` and `meal-detail` render a meal holding a composite, collapsed and expanded.

---

## 4. Alternatives considered

| Alternative | Why not |
| --- | --- |
| **A `composite_foods` table** (a header table with its own macros, `meal_items.composite_id`) | Duplicates the whole snapshot/micros/confidence column set, and puts the parent's numbers somewhere `recomputeMealTotals` does not look — which sounds safe until a later query joins it. Two `ALTER`s on a table that is already the right shape beat a second table. |
| **The parent carries the sum of its children** (denormalised, as `meals` does) | Symmetrical with `meals`, and wrong here for one reason: it fails dangerous. Any query that forgets the `is_composite = 0` filter doubles the pizza in the day's calories. NULL fails safe. |
| **A generic `modifiers` / options system** (extra oil, no cheese, ×2 shots) | Ruled out by the owner in the same sentence that asked for this. It is also a far bigger surface — a modifier would have to attach to catalog foods, templates and recipes too. C5's `add_item` / `remove_item` effects cover the common cases from the other direction, with no schema at all. |
| **Recursive composites** (a burrito inside a combo meal) | Invariant 1 forbids it. Nothing in the request needs it, a tree-walking `sum()` means a recursive CTE, and every screen would need a variable indent. One level *is* the feature. |
| **"Slices" as the composite handle** | Parked by the owner (`backlog-2026-09.md:63`). Grams + fraction chips cover "ate half" today and leave the door open (`0014:57-58`). |
| **Composite as a one-off recipe** (make the pizza a `recipes` row and log it) | The recipe machinery already does decomposition, provenance and rollup (`0031`/`0034`) — but a recipe is *a living document you open for years* (`0034:72-75`), and a photographed restaurant pizza is a one-off record of a meal. It would fill the recipe book with garbage. |

---

## 5. Effort

| | |
| --- | --- |
| Migration `0049` + `db:validate` | 0.5 h |
| Repository: 6 changed functions, 2 new, `composite.ts` assembler | 3–4 h |
| Estimator: schema, prompt, parser, grounding recursion | 2 h |
| `app/meal-estimate.tsx` review tree + disclosure + fraction chips | 3–4 h |
| `app/meal-detail.tsx` tree + provenance line | 2 h |
| `app/meal-revise.tsx` tree round-trip | 1 h |
| `resolved_by` column, backfill, `logRecipe` carry-through | 1 h |
| The 12 tests + `db:bundle` + the full gate | 3 h |
| **Total** | **~2 focused days.** |

**No native dependency, so no EAS rebuild** — it runs on the binary already on the phone. Device verification (does a collapsed pizza read right at 375pt; do the chips feel like the sentence) is a separate pass.

**Depends on nothing. Blocks nothing.** But it touches the same three files as C5 (`estimate.ts`, `meal-estimate.tsx`, `parseMealEstimate`), so **build C4 and C5 on one branch, or the second one rebases onto a changed parser and a rebuilt review screen.**

---

## 6. Questions only the owner can answer

**Q1. Where does the composite sit — one item in an ordinary meal, or is the meal the pizza?**
You photograph a pizza and a beer. Today that is one meal with two items.

- **(a) A composite is one item among many.** The meal is `Dinner`; it holds `Pepperoni pizza` (3 parts) and `Lager`. **← recommended.** Nothing about meals changes, `Eaten today` still reads `2 items`, and a composite is a unit of *food*, which is what it is.
- (b) The meal *is* the composite — named `Pepperoni pizza`, its items are the parts. Simpler to draw; a beer alongside then has nowhere to go without renaming the meal.
- (c) Both — a composite alone becomes the meal's name, a composite among siblings stays an item. Two behaviours for one thing, and the hardest to predict.

**Q2. After you hand-correct one part, does "ate half" halve the corrected value or the original?**
You took the pepperoni off half (40 g → 20 g), then realise you only ate half the pizza.

- **(a) Halve what is there now** — pepperoni 20 → 10, crust and cheese halved too. **← recommended.** The current state is the only state the record has; anything else means the visible numbers are not the record.
- (b) Scale from the original estimate and re-apply your correction afterwards. Arguably "what you meant", but it needs a hidden original column, and the screen would then be showing numbers that are not what is stored.
- (c) Refuse to scale a composite whose parts have been hand-edited, and say so. Safest; most annoying.

**Q3. How do you say "I ate half"?**

- **(a) A fraction chip row (`½ · ⅓ · ¼ · ⅔ · ¾`) plus the grams field.** **← recommended.** The chips are the sentence you actually say; grams is there for when you know it.
- (b) Grams only. Nothing new to draw, but "half a pizza" becomes arithmetic you do in your head.
- (c) A percent field. One control, but you will type `50` and it will feel like a form.
- (d) Wait for "slices" and make it a slice count. Parked by you, and it only helps for pizza.
