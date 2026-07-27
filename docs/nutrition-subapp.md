# Nutrition sub-app — design & build spec

**Status:** Phase-1 orient — awaiting owner review. The Phase-2 offline vertical slice described in §9 is built on this branch; everything marked *long tail* is **not** built and waits for that review.
**Last updated:** 2026-07-26
**Branch:** `claude/arc-setup-conventions-6f1e42` (parallel build; reserved migrations 0008–0010)
**Mission:** turn ARC's Nutrition screen into a complete, best-in-class food-logging sub-app on the level of Cal AI — photo → macros plus the full serious-logging loop — adapted to ARC's local-first, Porcelain-Ledger world.

---

## 1. What the research found (Phase 0)

Four competitor studies + a sourcing/tech sweep (web-backed, July 2026). Full citations at the end of each subsection; the load-bearing conclusions:

### Cal AI (the target bar)
- **The product is speed**: one photo → itemized calories/macros in seconds, no typing. MyFitnessPal's own CEO (which acquired Cal AI, Dec 2025) describes it on record as "speed over accuracy."
- The result screen does **multi-item detection with per-item confidence** and **in-line quick-edit** (tap an item → change food / portion / macros) — the correction never leaves the just-logged context. There's a "fix with AI" re-run path. Notably it does *not* learn your dishes; repeat home meals need repeat fixes.
- One capture screen mode-switches between **photo / barcode / nutrition-label scan**; describe-in-words is the no-camera fallback.
- Accuracy reality (third-party, directional): ~87% on simple foods, ~62% mixed meals, ~50% home-cooked; hidden fats/sauces and portion size are the systematic failure modes. Vendor claims ~90%.
- Everything else — streaks, Milestones badge room, $0.99 Streak Restore, Public Groups, the 28-step quiz → paywall — is subscription-retention machinery, **not** logging. ARC copies none of it.
- Sources: calai.app; App Store id6480417616; TechCrunch 2026-03-02 (acquisition, "speed over accuracy"); CNBC 2025-09-06; screensdesign.com teardown.

### MacroFactor (the serious-logger bar)
- **Adaptive TDEE** is the best-in-class core: expenditure reverse-derived from logged intake vs. smoothed weight trend, adjusted conservatively weekly — not a static formula. Needs ≥6/7 days logged + weekly weigh-ins to update.
- **Logging speed is measured, not claimed**: their published Food Logging Speed Index counts discrete actions — search-log 10 actions, multi-add 6, barcode 5, quick-add 3. That's the benchmark ARC's manual paths should hit.
- Their AI photo/describe feature is **retrieve-then-generate**: LLM decomposes the meal, then queries the *real verified food database*; it only synthesizes an entry when no match exists, and everything lands in an editable "Plate" before commit. This is the correct architecture for ARC's photo path.
- Recipes can be assembled **retroactively from the timeline** (tap foods already logged → "Create recipe") and later "exploded" back to ingredients.
- **Adherence-neutral by explicit philosophy**: no red numbers over target, no good/bad food labels, no streaks, no congratulation pop-ups — with cited behavior-science reasoning. This aligns exactly with ARC's calm/no-gamification identity and the Modes "excused, not a miss" doctrine.
- Sources: strongerbyscience.com/macrofactor-algorithms-philosophy; macrofactor.com/{expenditure-modifiers, best-food-logging-app, adherence-neutral, ai-food-logging}; help.macrofactorapp.com arts. 3/6/14/26/258.

### MyFitnessPal + Lose It (the incumbents)
- The genuinely load-bearing mechanics, in order: **recents/frequents ahead of search** (most people rotate ~30–50 foods — this is *the* daily-speed lever), **saved meals** (one tap for a repeated multi-item breakfast), **copy-from-yesterday**, **barcode scan** (fastest *and* most accurate path for packaged food — MFP paywalling it in 2022 is a monetization anti-pattern, not product), **quick add** (numbers-only escape hatch), and a **weekly digest** zoom-out.
- Database reality: ~70% of MFP entries are user-generated/unverified; the visible "verified" checkmark is the trust affordance that makes the mess navigable. Peer-reviewed validation (Evenepoel 2020, JMIR): MFP is accurate for energy/macros/fiber/sugar (r ≈ 0.9+), *not* for sodium/cholesterol.
- MFP tracks only 6 micronutrients (Premium); Cronometer tracks 84 from lab-analyzed sources only — the quality bar for micros.
- Bloat ARC must not copy: ads, social feed (MFP itself retired its Newsfeed in 2024 for low usage), gamification, persona goal-templates, paywalled logging speed.
- Lose It's Snap It (photo AI since 2016!) maps detected foods against **the user's own logging history** — a real accuracy lever ARC should copy.
- Sources: support/blog.myfitnesspal.com (partially bot-blocked; cited via snippets); JMIR 2020;22(10):e18237 (PMC7641788); TechCrunch/Engadget 2016 (Snap It).

### Food data & licensing (the offline catalog)
- **USDA FoodData Central is public domain (CC0)** — the cleanest source. Foundation Foods + SR Legacy are the lab-analyzed sets (~8k foods, small downloads); Branded Foods is 2.9 GB of label-transcribed data — overkill on-device.
- **Open Food Facts (barcodes) is ODbL**, and ODbL §4.5(c) exempts internal/private use from share-alike — a single-user, never-redistributing on-device cache is clean; attribution is best practice. Live API: `GET world.openfoodfacts.org/api/v2/product/{barcode}` (custom User-Agent required; 15 req/min). **No small offline subset exists** — the right pattern is a grow-your-own local cache of barcodes actually scanned (precedent: Waistline, OpenNutriTracker).
- **Per-100 g is the canonical storage convention** in both FDC and OFF; per-serving is derived at render time via household-measure→gram data.
- FDA-mandatory label fields mean branded/OFF data is trustworthy for fiber, sodium, potassium, calcium, iron, vitamin D — and *unreliable* for magnesium and omega-3s (lab-analyzed sources only).
- Longevity-relevant micro shortlist (Linus Pauling Inst., PNAS "longevity vitamins"): fiber, sodium (ceiling), potassium, calcium, magnesium, iron, zinc, B6/B12/folate, C, D, E, K, omega-3 EPA/DHA.
- Starter-catalog convention across serious trackers: a curated staples subset (~100–300 rows) covers the bulk of real logging; everything else arrives via barcode/AI/custom foods.

### Camera + vision tech (the AI path's physics)
- **expo-camera** (SDK 57) does *both* photo capture and barcode scanning in one `CameraView` (ean13/ean8/upc_a/upc_e/code128 + 8 more). It's a **native dep → one more EAS dev-client build** (a bridge ARC already crossed for op-sqlite; batch with `expo-secure-store`/`expo-local-authentication` per project-status). `expo-image-manipulator` downsizes/compresses photos client-side (Expo-Go-safe).
- Claude vision economics: image block = base64 JPEG; tokens = ceil(w/28)×ceil(h/28). A ~1024 px photo ≈ 1,369 tokens ≈ **$0.0014 (Haiku-tier) to ~$0.004 (Sonnet-tier) per photo**. Resize to ~1024 px, quality ~0.65 — well under every limit, and only a small compressed JPEG ever leaves the device (fits the privacy posture).
- Accuracy ground truth (peer-reviewed, 2026, multi-dataset): LLM photo estimation MAPE ≈ **36% for energy**, portion size dominating; systematic underestimation of large portions; "not yet suitable for precise dietary assessment" without human review. Prompt design measurably moves quality.
- Sources: docs.expo.dev (camera/imagepicker/imagemanipulator); platform.claude.com vision docs; doi.org/10.3390/nu18122017; openfoodfacts API docs.

### The design consequences (what ARC adopts / rejects)

| Adopt | Reject |
| --- | --- |
| Photo → itemized, per-item-confidence, **editable review, never auto-commit** | Auto-committed AI guesses |
| Retrieve-then-generate: ground AI output in the local catalog + the user's own history | Bare vision-LLM numbers |
| Recents-with-last-portion ahead of search; favorites; one-tap re-log of a whole meal | Streaks, badges, social, any retention theater |
| Barcode as a first-class *free* path (OFF + grow-your-own cache) | Paywalled/gated logging speed |
| Quick numbers-only add; MacroFactor-grade action counts | 28-step onboarding quizzes |
| Versioned daily targets; **Coach proposes** target updates (MacroFactor's math, ARC's authorship model) | Silent black-box auto-adjustment |
| Adherence-neutral display: no red numbers, no shame states | Over-target warnings, good/bad food labels |
| Longevity micro shortlist on catalog foods, honest about source quality | Fake 84-nutrient completeness on every food |
| Weekly zoom-out via the existing Data-tab trend | A second dashboard inside Nutrition |

---

## 2. Feature set & screen map

The sub-app stays a **stack-pushed screen family off the Log tab** (per `docs/information-architecture.md`); the Data tab keeps the trend/zoom-out role.

```
app/nutrition.tsx            Nutrition home (reworked)     ── slice
  ├─ app/food-search.tsx     Search + recents + favorites  ── slice
  │    └─ app/food-new.tsx   Create a custom food          ── slice
  ├─ app/meal-detail.tsx     One meal: items, edit, re-log ── slice
  ├─ app/nutrition-targets.tsx  Daily targets editor       ── slice
  ├─ (capture screen: photo/barcode)                       ── long tail (needs expo-camera + model client)
  └─ (AI review "plate" screen)                            ── long tail (needs model client)
```

**Nutrition home** (`app/nutrition.tsx`, reworked):
- **Today card** — mono kcal headline; when targets exist, `of 2,200 target` plus a thin progress track; P/C/F (and fiber when targeted) each with mono `142 / 180g` and a thin track. No targets set → totals alone plus a quiet "Set daily targets" row. The fake placeholder constants (2200/180/160/70) are **deleted** — real denominators or none.
- **Log a meal** — the one pine action stays "Describe or snap a meal" (stub until the Coach model client lands; see §6). Below it: **Add food** (→ food-search) and **Manual entry** (the existing working form, kept as-is).
- **Eaten today** — unchanged list, but rows now push meal-detail and show an item count when itemized.

**Food search** (`app/food-search.tsx`, optional `mealId` param):
- Search field autofocused. Before any query: **Recents** (each with its last portion, one-tap `+` re-add — the single biggest speed lever) and **Favorites**. Results ranked prefix-first, favorites boosted.
- Tapping a result expands an **inline portion editor**: serving stepper (when the food has a named serving) or grams, live-computed macros, "Add".
- **Multi-add**: with no `mealId`, the first add creates a meal named by day-part (Breakfast / Lunch / Dinner / Snack, timed now — the items carry the detail) and subsequent adds append to it; a quiet "N added" line + Done. With `mealId`, adds append to that meal. Matches MacroFactor's 6-action multi-add.
- Footer row: "Create a food" → food-new (query prefilled).

**Create food** (`app/food-new.tsx`): name, brand, serving name + grams, macros entered **per serving or per 100 g** (toggle; stored per-100 g canonically), fiber optional. Custom foods are `source='user'`.

**Meal detail** (`app/meal-detail.tsx`, `id` param): name + time, item rows (portion, kcal, macro line, quiet remove), totals, "Add food" (→ search with `mealId`), **"Log again"** (duplicates the whole meal at now — the copy-from-yesterday loop), delete meal (confirm; ghost, not red drama).

**Targets** (`app/nutrition-targets.tsx`): kcal / protein / carbs / fat / fiber, any subset; saving appends a **new immutable version** effective today. A quiet provenance line ("Since Jul 26 · set by you"). The Coach later proposes versions with `created_by='ai'` — same table, same screen.

### Porcelain-Ledger translation (Cal-AI richness → ARC calm)

- **No rings.** A goal ring is a gamified gauge; ARC's equivalent is a **thin horizontal track** (`h-1`, `bg-hairline` rail, `bg-ink-secondary` fill) under a mono `1,840 / 2,200` pair. Data reads like a typeset table, progress reads like a filled rule.
- **Pine discipline:** the screen's one pine accent stays the "Describe or snap" action. Progress fills are ink-secondary; when a macro **meets** its target the fill turns pine — completion is what pine means (same semantics as the mission progress fill). Overshoot never turns any colour: the bar caps at 100% and the mono numbers keep counting — adherence-neutral, signal colours stay biological-only.
- **Mono everywhere a number is a measurement**; serif for the screen's headings; no shadows; `rounded-card`/`rounded-btn` only; press feedback via `active:opacity-*` / `active:bg-paper-deep`.
- **Confidence is typography, not colour:** AI-estimated values render with an `≈` prefix and a muted `est` tag, not an alarm hue.

---

## 3. Data model (migrations 0008–0010)

Designed to extend `meals` (0002) **without touching its shape or its four exports** (`logMeal`, `listTodayMeals`, `todayTotals`, `dailyIntakeSeries` — the Data-tab trend and the Coach read-tools keep working unchanged).

### The one structural idea

`meals` stays the day-facing record and keeps carrying its own kcal/macro columns. A meal **may** now be *itemized*: child `meal_items` rows, each a snapshot of a food+portion. **When a meal has items, the repository maintains the meal's macro columns as the item sums** (recomputed in the same transaction as every item change). Existing free-form meals (no items) behave exactly as today — and when a free-form meal with typed totals gains its *first* item, those totals are preserved as their own "(as logged)" item rather than silently overwritten, so the forgotten egg *adds to* the 800-kcal dinner instead of replacing it. `todayTotals`/`dailyIntakeSeries` read only `meals` and are automatically correct for both kinds. Repository functions are the only writers, which is what keeps the denormalized sums trustworthy.

### `0008_food_catalog.sql` — `foods` + `meal_items`

**`foods`** — the on-device catalog (seeded + user + AI + barcode-cached):

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | app v4 UUID (`newId`) |
| `name` | text NOT NULL | display name |
| `name_norm` | text NOT NULL | lowercased search key, written by the repo |
| `brand` | text | NULL for generic foods |
| `barcode` | text | EAN/UPC digits; **partial UNIQUE index** where not null |
| `serving_name` / `serving_grams` | text / real | a household serving ("1 egg" / 50); pair-or-none CHECK; grams > 0 |
| `kcal_100g` | real | ≥ 0, ≤ 950 (pure fat ≈ 884) |
| `protein_g_100g` `carbs_g_100g` `fat_g_100g` `fiber_g_100g` | real | each NULL or 0–100 (per definition of per-100 g) |
| `micros` | text | JSON object, `json_valid` CHECK; longevity shortlist keys (`sodium_mg`, `potassium_mg`, `calcium_mg`, `magnesium_mg`, `iron_mg`, `zinc_mg`, `vitamin_d_mcg`, `b12_mcg`, `folate_mcg`, `omega3_g` …) per 100 g; only values the source actually knows — absent beats guessed |
| `source` | text NOT NULL DEFAULT 'user' | CHECK IN (`'seed','user','ai','openfoodfacts'`) — ARC-owned vocabulary (the shared `DataSource` describes *log* provenance; a catalog row's provenance is a different axis) |
| `is_favorite` | integer NOT NULL DEFAULT 0 | 0/1 CHECK — single-user, so a flag beats a join table |
| `created_at` / `updated_at` | text | defaults + AFTER UPDATE trigger (mutable: favorites, edits) |

Indexes: `foods_name_norm_idx`, partial-unique `foods_barcode_idx`.

**`meal_items`** — a food+portion snapshot inside a meal:

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | |
| `meal_id` | text NOT NULL → `meals(id)` **ON DELETE CASCADE** | items are part of the meal record (same reasoning as `workout_sets`) |
| `food_id` | text → `foods(id)` **ON DELETE SET NULL** | provenance only — deleting a catalog food never destroys eating history (delete-semantics ADR) |
| `name` | text NOT NULL | snapshot of the food name at log time — the row stays meaningful alone |
| `grams` / `serving_qty` | real | either/both, > 0; NULL grams allowed (an "≈300 kcal lasagna" AI item) |
| `kcal` `protein_g` `carbs_g` `fat_g` `fiber_g` | real | ≥ 0, **snapshot at log time** (catalog edits never rewrite history) |
| `confidence` | text | NULL or `'high','medium','low'` — persisted for AI items so the Coach can weigh them |
| `created_at` / `updated_at` | text | defaults + trigger (portions are editable) |

Indexes: `meal_items_meal_idx`, `meal_items_food_idx` (recents + FK perf).

### `0009_nutrition_targets.sql` — versioned daily targets

**`nutrition_targets`** — append-only, immutable rows (the `protocol_versions` pattern: a target you can edit in place is not a version):

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | |
| `effective_date` | text NOT NULL | `YYYY-MM-DD` GLOB; the active row for a day = latest `effective_date ≤ day` (created_at tiebreak) |
| `kcal` | real | NULL or > 0 |
| `protein_g` `carbs_g` `fat_g` `fiber_g` | real | NULL or ≥ 0; CHECK: at least one of the five is non-NULL |
| `created_by` | text NOT NULL DEFAULT 'user' | CHECK IN (`'user','ai'`) — the existing `Authorship` vocabulary; `'ai'` is the Coach's future proposal path |
| `notes` | text | e.g. the Coach's rationale |
| `created_at` | text | **no `updated_at`, no trigger — immutable by design** |

History stays honest: "was I under target in March?" is answered against March's targets, not today's. **No seed row** — the current screen's placeholder constants were admitted fakes; the honest state is "no denominators until Matt sets them" (one 30-second visit to the targets screen).

Adaptive targets are deliberately **not** an automatic loop: the versioned table is exactly the substrate for the Coach to propose a new version (`created_by='ai'`, with reasoning in `notes`) from weight trend + intake — MacroFactor's math, ARC's authorship model. Long tail, with the Coach.

### `0010_food_seed.sql` — the starter catalog

~150–200 curated staples (`source='seed'`, fixed UUIDs), per-100 g values authored from USDA lab-analyzed knowledge (FDC is public domain), each with a household serving where one is natural, fiber where meaningful, micros only where confidently known. Coverage per the research convention: proteins (chicken/beef/fish/eggs/dairy/tofu/legumes), staple carbs (rice/oats/potato/bread/pasta), produce, fats/nuts/oils, common beverages, condiments, and a handful of composite restaurant archetypes (pizza slice, burger, burrito, sushi roll…) to absorb eating-out logging before the AI path exists. Values are approximate by nature; every row is editable in-app, and future catalog updates are **new append-only migrations** (a shipped migration is never edited). The catalog grows organically afterwards: customs (`user`), AI-synthesized entries (`ai`), scanned barcodes (`openfoodfacts`).

Migration-number note: the runner (`pendingMigrations` + `bundle-migrations.mjs`) tolerates branch-local gaps (0004 → 0008 here) and `migrate.test.mjs` already asserts `user_version === max(version)`, so this branch runs standalone in headless tests; **the integrator finalizes actual numbers at merge** (reserved block 0008–0010, per `project-status.md`). ⚠️ **Do not install this branch's build on the phone before that renumbering is final**: a device at `user_version = 10` would *silently skip* the Coach's lower-numbered 0005–0007 when they merge (`pendingMigrations` only applies versions above the current), and renumbering these files *after* a device ran them as 8–10 would re-run their DDL and fail at boot. Same hazard class the 0002/0003 parallel build had; the merge-then-install order is what resolves it.

---

## 4. Repository & type surface

All new code depends only on the `Database` interface. **No existing export changes.**

**New file `src/lib/db/repositories/foods.ts`:** `normalizeFoodName`, `createFood`, `updateFood`, `deleteFood`, `getFood`, `searchFoods` (tokenized LIKE over `name_norm`, prefix-ranked, favorites boosted — a few hundred rows need no FTS5; revisit if the catalog ever passes ~5k), `setFoodFavorite`, `listFavoriteFoods`, `listRecentFoods` (from `meal_items` join, newest-first, **with each food's last-used portion**), `findFoodByBarcode`.

**Additions to `src/lib/db/repositories/nutrition.ts`** (existing four exports untouched): `logMealWithItems` (transactional; meal macros = item sums), `getMeal`, `deleteMeal` (CASCADE clears items), `updateMealMeta` (name/time/notes), `listMealItems`, `mealItemCounts` (per-day map for the home list), `addMealItem` / `updateMealItemPortion` / `removeMealItem` (each recomputes the parent's totals in-transaction; the first item into a typed free-form meal preserves those totals as an "(as logged)" item; a meal whose items all lack a macro sums that macro to NULL, and a meal emptied of items returns to free-form NULLs), `relogMeal` ("Log again" — `ai_suggested` provenance survives the copy, so an estimate stays labelled an estimate), `setNutritionTargets`, `activeNutritionTargets`.

**Pure helpers:** `src/lib/nutrition/servings.ts` — `gramsForQty`, `macrosForGrams` (per-100 g × grams/100), used by UI and repo, headless-tested. `src/lib/nutrition/format.ts` — `fmtInt`, `macroLine`, `portionLabel` (nutrition.tsx's local copies move here; the Data-tab's own copy is untouched).

**Types** (`src/lib/nutrition/types.ts`, feature-local per convention): `FoodRow`, `NewFood`, `FoodSource`, `MealItemRow`, `NewMealItem`, `NewMealWithItems`, `RecentFood`, `NutritionTargetsRow`, `NewNutritionTargets`, `EstimateConfidence`.

**Hook:** `useNutrition` gains `targets` (active row or null) and `itemCounts` — additive, same sanctioned useState-initializer + `useFocusEffect` shape.

---

## 5. The offline story

Consistent with **offline-except-AI** (CLAUDE.md §2): everything in the Phase-2 slice — catalog search, recents/favorites, portion math, quick add, custom foods, meal grouping, targets, re-log — runs with the network unplugged, forever. The online exceptions, both long-tail:

1. **AI photo/describe estimation** — the *only* AI-online path (§6), consistent with Coach chat and lab-PDF parse.
2. **Barcode lookup** — scan resolves **locally first** (`findFoodByBarcode` over the grown cache), then Open Food Facts *when online*; every hit is written back as a `foods` row (`source='openfoodfacts'`, barcode filled), so a pantry converges to fully-offline scanning within days of normal use. A miss offline falls back to search/manual/photo. (OFF etiquette: custom `User-Agent "ARC/0.1 (matt.lawrence2@gmail.com)"`, well under 15 req/min by construction; ODbL private-use carve-out applies, attribution noted in-app later.)

No bulk database ships on-device beyond the seed: the full OFF/FDC dumps are server-scale bloat for one user (research §1); the catalog grows from *this* user's actual eating.

---

## 6. The AI logging flow (photo → macros; words → macros)

**Hard dependency, flagged:** the Coach window is currently building the real on-device model client (Phase 3: direct provider call, key in Keychain, `expo/fetch` streaming — `docs/project-status.md`). The nutrition AI path **must reuse that client** — one model path in the app, never a second. Until it merges, ARC ships the **seam**, not the call.

### The seam (built in the slice)

`src/lib/nutrition/estimate.ts`:
- `EstimateInput = { kind:'text', description } | { kind:'photo', base64Jpeg, mediaType:'image/jpeg', description? }`
- `MealEstimate = { title, items: MealEstimateItem[], notes? }`; `MealEstimateItem = { name, grams|null, kcal, protein_g, carbs_g, fat_g, fiber_g|null, confidence:'high'|'medium'|'low', foodId|null }`
- `isMealEstimationAvailable(): boolean` — mirrors `isCoachKeyConfigured`, flips with the model client.
- `estimateMeal(input)` — today throws `MealEstimationUnavailableError`; the UI (the existing pine button's hint) stays honest, exactly like the mock Coach. Callers are written against the final contract now.

### The call (long tail, after the client lands)

1. Capture via `CameraView.takePictureAsync()` (or `expo-image-picker`), downscale to ~1024 px JPEG at ~0.65 quality via `expo-image-manipulator` → base64 (~1,369 vision tokens, ≈ $0.001–0.004/photo; only the compressed copy leaves the device).
2. One Messages call through the Coach's client: image block first, then a **visual-estimation prompt** (the phrasing peer-review showed matters): itemize the plate; estimate portions in grams from visual cues; per-item confidence; JSON-only output matching `MealEstimate`; flag hidden-fat uncertainty explicitly.
3. **Ground, don't trust**: returned item names are matched against the local catalog + this user's recents (`searchFoods`/`listRecentFoods`) — Lose It's own-history lever + MacroFactor's retrieve-then-generate. A catalog hit swaps in known per-100 g macros scaled to the estimated grams (`foodId` set); only unmatched items keep raw model numbers (`source='ai'` food row optional).
4. **Editable review, never auto-commit** (the one lesson every player agrees on, and MAPE ≈ 36% demands): a "plate" screen listing items with `≈` values, portion steppers, per-item confidence tags, remove/add — then one Save → `logMealWithItems(..., source:'ai_suggested')` with per-item `confidence` persisted. Same screen serves photo and describe-in-words.
5. Describe-in-words uses the identical pipeline minus the image block — and can ship the moment the model client merges, before any camera work.

**Sequencing:** model client merges → describe-in-words + review screen → camera build (expo-camera) → photo path → barcode scanning (same CameraView). Safety posture: estimates are labelled estimates; the Coach never presents AI macros as measurements (`docs/ai-coach.md` uncertainty rules apply).

---

## 7. Barcode plan (long tail; designed now)

`expo-camera`'s `CameraView` with `barcodeScannerSettings: { barcodeTypes: ['ean13','ean8','upc_a','upc_e'] }`, single-fire + preview pause. Resolution order: local `foods.barcode` → OFF v2 API (online) → write-back to catalog → portion sheet (label serving prefilled from OFF `serving_size` when present). Offline miss → search/manual/photo. **Native dep flag:** expo-camera requires an EAS dev-client rebuild — batch with `expo-secure-store` / `expo-local-authentication` (Phases 2–3) per the project-status caveat. Nutrition-label photo scan (Cal AI's third mode) rides the photo pipeline later at zero extra infrastructure — the prompt just reads the label.

---

## 8. Deliberately out (and why)

- **Streaks / badges / celebration** — retention theater; adherence lives with Modes and the Coach's accounting (excused ≠ missed).
- **Red over-target states** — adherence-neutral by design (MacroFactor's cited reasoning; ARC's calm).
- **Auto-adjusting targets** — replaced by Coach-proposed versioned targets (§3).
- **A nutrition dashboard inside the sub-app** — the Data tab is the zoom-out; one weekly-trend surface, not two (its `dailyIntakeSeries` feed is untouched).
- **Shipping a big food database** — grow-your-own cache instead (§5).
- **Meal templates as a separate system** — deferred to protocols (`meal_template` protocol type already exists in 0001); "Log again" + recents cover the daily need meanwhile. Retroactive MacroFactor-style "bundle these logged items into a template" is noted for that build.
- **Micros beyond the shortlist** — honest sparse data over fake completeness; Cronometer-grade panels only if a lab-analyzed import lands later.

---

## 9. The Phase-2 slice (built on this branch) & build sequence

**Built now (offline, self-standing):** migrations 0008/0009/0010 + `foods.ts` repo + `nutrition.ts` additions + `servings.ts`/`format.ts` helpers + types + reworked `nutrition.tsx` + `food-search.tsx` + `food-new.tsx` + `meal-detail.tsx` + `nutrition-targets.tsx` + the `estimate.ts` seam + headless suite `db/foods.test.mjs` + `db:bundle` regeneration.

**Build sequence after owner review (long tail):**
1. Describe-in-words + AI review screen (once the Coach model client merges — coordinate with that window).
2. expo-camera EAS rebuild (batched) → photo path → barcode.
3. Coach-proposed targets; retroactive meal-templates-into-protocols; weekly digest surface on Data if wanted; micros daily rollup.

**Verification gates:** `npm run typecheck` · `lint` · `format:check` · `db:validate` · `db:test` (new suite included) · `npx expo export --platform ios`.

---

## 10. Flags & integrator-merge points

| # | Item | Kind |
| --- | --- | --- |
| 1 | `src/lib/db/migrations.generated.ts` regenerated (0008–0010 added) | **INTEGRATOR-MERGE** (regenerate `db:bundle` at merge) |
| 2 | `package.json` `db:test` line gains `db/foods.test.mjs` | **INTEGRATOR-MERGE** |
| 3 | `app/_layout.tsx` gains 4 routes (`food-search`, `food-new`, `meal-detail`, `nutrition-targets`) | **INTEGRATOR-MERGE** |
| 4 | Migration numbers 0008/0009/0010 | integrator finalizes at merge (strictly increasing). **Don't install this branch on the device before then** — §3's silent-skip / re-run hazard |
| 5 | Coach model client (`src/lib/ai/*`) | **DEPENDENCY** — estimate.ts reuses it; do not build a second model path |
| 6 | `expo-camera` (+ `expo-image-manipulator`, maybe `expo-image-picker`) | **NATIVE DEP, not added** — EAS rebuild required; batch with secure-store/local-auth |
| 7 | Data tab / Coach read-tools | untouched — all existing nutrition exports stable |
| 8 | Seed catalog values | curated approximations (USDA-derived, public domain); every row user-editable; updates = new migrations |
| 9 | `docs/project-status.md`, `decisions.md`, CLAUDE.md §4 currency | integrator-owned at merge; proposed ADR below |

**Proposed ADR (for `docs/decisions.md`, integrator to lift):** *2026-07-26 — Nutrition became a food-logging sub-app.* Foods catalog + meal-items extend `meals` without breaking it (items snapshot macros; repos maintain parent sums); targets are append-only versions (`protocol_versions` pattern, Coach-proposable); the AI photo/NL path is a seam over the Coach's model client (one model path), grounded retrieve-then-generate with a mandatory editable review; barcode = OFF + grow-your-own offline cache (ODbL private-use carve-out); adherence-neutral display, no gamification — per the competitor research digest in `docs/nutrition-subapp.md` §1.
