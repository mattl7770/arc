# Nutrition sub-app — design & build spec

**Status:** **Round 5 (2026-08-11) shipped — the hub was rebuilt as the Eat TAB ROOT.** What is left leads (guarded per metric), one accent button reading `Log` opens a full-screen sheet holding every entry path, **Kitchen** carries the recipe book and grocery list with live counts, **Over time** carries 14-day energy + protein, and `Set daily targets` is a first-class control that retires once satisfied. The macro cells are boxed by owner call. Photo-library upload landed on the estimator in the same pass. Spec: `docs/information-architecture.md` › *The Eat tab, redrawn*; mockup: `docs/design-research/eat-tab-redesign.html`; the four ADRs are in `docs/decisions.md` (2026-08-11). Round 3 shipped the acquisition + editing gaps. Barcode scanning (live, with OFF lookup), inline portion editing, and AI photo/describe estimation are all wired; the only remaining online paths are barcode-OFF and AI, both gated. **Round 4 (2026-08-08) shipped as its own spec: the recipe book, grocery list, AI recipe import, and Coach integration live in `docs/recipes-grocery.md`** (migrations 0030/0031). **Weekly macro charts remain open** — a Data-tab/nutrition-history visualization, consciously deferred out of round 4 and tracked in `docs/project-status.md` §1 (Data tab).
**Last updated:** 2026-09-23 (§12n — micros round 2; §14 — undo, combine, a multi-scan meal's name)

> ### Round 6 — the capture round (owner, 2026-08-14). Four requests off the device; **no migration**.
>
> Full detail in §12b. The short version, in the order the requests were taken:
>
> **1. The Log sheet's close control was under the status bar, and it was never a magic number.** *"In the menu to log where you decide which logging method to use, the back button is not accessible because it is too high up on the screen."* `SafeAreaView` in react-native-safe-area-context v5 is a **native** view: it walks `self.superview` for an `RNCSafeAreaProvider` and falls back to `self` when it finds none. An RN `Modal` on iOS presents its own `UIViewController`, so the provider react-navigation installs around the Stack is in the React tree and **unreachable in the native one** — the walk ends at `self`, which never posts the change notification and, unlike the provider, implements no `safeAreaInsetsDidChange` and no non-zero-frame retry. The inset latched at zero at attach time and never corrected, so `pt-2` was the whole offset. The fix is a `SafeAreaProvider` **inside** the Modal, now in one place: `ModalScreen` (`src/components/ui/screen.tsx`). **All three of ARC's chooser modals had it** — the Log sheet, Home's mode picker, the exercise picker. The app lock's Modal was immune by accident: it centres its content and asks for no inset.
>
> **2. The scanner shows what you last logged.** `listRecentBarcodeFoods` — `listRecentFoods` narrowed to `barcode IS NOT NULL`. No table, no migration: the scan already caches a `foods` row and the log already writes a `meal_items` row, so the list is the join those two facts imply.
>
> **3. Photo and Describe sit under Log on the Eat tab.** Two outlined buttons, no accent — the pine on `Log` stays the screen's only claim to being the next action.
>
> **4. The photo logger reads barcodes.** One `CameraView`, one `AVCaptureSession`: expo-camera adds the scanner as an `AVCaptureMetadataOutput` **alongside** the `AVCapturePhotoOutput`, and switches it on from the presence of `onBarcodeScanned`. A code in frame is **offered below the Capture button, never forced**, and taking the offer hands off to `/barcode-scan` rather than growing a second portion sheet.
>
> **And `expo-camera` moved behind a guarded seam** (`src/lib/media/camera.ts`). Both camera screens were route files with a static native import — the app-LAUNCH crash that has already shipped twice. It also made them untestable; both are now on the headless render walk.

> ### Correcting a logged meal in plain English — `app/meal-revise.tsx` (owner, 2026-08-12)
>
> *"I should be able to use plain-text input to have AI edit a meal. I.e. 'Actually, that was cooked in olive oil not butter' and it then makes those changes."* Until now that correction was item-shaped: open the meal, find the butter row, remove it, search the catalog for olive oil, add it, set its grams — six interactions to state one fact, at the exact moment a correction is least likely to be made.
>
> **It reuses the estimator wholesale rather than growing a second pipeline.** `reviseMeal` (`src/lib/nutrition/estimate.ts`) hands the model the meal as it stands plus the correction and asks for **the whole revised item list in the estimator's own JSON shape** — so `parseMealEstimate` validates it, `groundMealEstimate` re-prices it against the catalog, and the review screen is the same editable table with the same guarantees. One schema, one parser, one review.
>
> **A full list rather than a patch, deliberately.** It is what makes the model's restraint *checkable*: the rows that should not have moved sit on screen next to the ones that did, and the user reads them before anything is written. The system prompt leads with that restraint (*"Change ONLY what the correction implies… do not re-estimate the meal"*) rather than with estimation.
>
> **It is a pushed screen, not an inline field.** A revision replaces a record already counted into the day, the week and the Coach's snapshot — a pending write in the strict sense of 00-design-spec.md §5, which gets a proposal, a stated consequence and a confirm. Inline on the meal screen it would have had to draw the old numbers and the new ones at once, the one thing §5 forbids.
>
> **`replaceMealItems`** (`repositories/nutrition.ts`) swaps the items in one transaction and re-derives the totals; the meal's date, time, name, notes, `source` and `recipe_id` are untouched, because a revision to what was in the bowl is not permission to restamp any of them. An empty revision is **refused** — emptying a meal silently returns it to free-form NULL totals, indistinguishable from a meal nobody priced, and emptying is what `removeMealItem` and Delete are for. Pinned by `db/nutrition-v2.test.mjs` §§20/20b.
**Branch:** `claude/arc-setup-conventions-6f1e42` (rebased on `main` — Settings/units, Protocols, Screenings, the agentic Coach + Keychain key store, Home brief, notifications; nutrition migrations **0014–0018**, no new migration this round — the schema already supported barcode caching and `ai_suggested` meals)
**Mission:** turn ARC's Nutrition screen into a complete, best-in-class food-logging sub-app on the level of Cal AI — photo → macros plus the full serious-logging loop — adapted to ARC's local-first, Porcelain-Ledger world.

> **Build status (2026-07-27, round 3).** The full Cal-AI-level loop is now real. The offline spine (round 1–2) is complete; round 3 lit up the acquisition/editing gaps: **barcode scanning** (`expo-camera` → local cache → Open Food Facts → cache-back, `app/barcode-scan.tsx`), **inline portion editing** of a logged item (`app/meal-detail.tsx` → the tested `updateMealItemPortion`), and **live AI estimation** (`src/lib/nutrition/estimate.ts` now calls the Coach's `runCoachTurn`; photo/describe → grounded → editable `ai_suggested` review the user confirms, `app/meal-estimate.tsx` — **never auto-committed**). The two online exceptions (barcode-OFF, AI) are both gated; everything else works offline. **Native deps added this round: `expo-camera` + `expo-image-manipulator` → one shared EAS rebuild, since done (2026-08-25).** §5–§7 describe the paths; §12 records round 3.

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

## 3. Data model (migrations 0014–0016, then 0017–0018)

> **Numbering note (final):** the tables below were originally authored as 0008–0010; when the branch rebased onto the Coach-inclusive `main`, the Coach's `ai_chat`/`reminders` had taken 0008/0009, so the whole nutrition set was renumbered to a contiguous block **above** Exercise's reserved 0011–0013: `foods`+`meal_items` = **0014**, `nutrition_targets` = **0015**, seed = **0016**, `meal_items.micros` = **0017**, `meal_templates` = **0018**. The schema is identical; only the file numbers moved (§11).

Designed to extend `meals` (0002) **without touching its shape or its four exports** (`logMeal`, `listTodayMeals`, `todayTotals`, `dailyIntakeSeries` — the Data-tab trend and the Coach read-tools keep working unchanged).

### The one structural idea

`meals` stays the day-facing record and keeps carrying its own kcal/macro columns. A meal **may** now be *itemized*: child `meal_items` rows, each a snapshot of a food+portion. **When a meal has items, the repository maintains the meal's macro columns as the item sums** (recomputed in the same transaction as every item change). Existing free-form meals (no items) behave exactly as today — and when a free-form meal with typed totals gains its *first* item, those totals are preserved as their own "(as logged)" item rather than silently overwritten, so the forgotten egg *adds to* the 800-kcal dinner instead of replacing it. `todayTotals`/`dailyIntakeSeries` read only `meals` and are automatically correct for both kinds. Repository functions are the only writers, which is what keeps the denormalized sums trustworthy.

### `0014_food_catalog.sql` — `foods` + `meal_items`

**`foods`** — the on-device catalog (seeded + user + AI + barcode-cached):

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | app v4 UUID (`newId`) |
| `name` | text NOT NULL | display name |
| `name_norm` | text NOT NULL | lowercased search key, written by the repo |
| `brand` | text | NULL for generic foods |
| `barcode` | text | EAN/UPC digits; **partial UNIQUE index** where not null |
| `serving_name` / `serving_amount` | text / real | a household serving ("1 egg" / 50, "1 can" / 330); pair-or-none CHECK; amount > 0. **In the food's `basis`** (§12e) |
| `kcal_100g` | real | ≥ 0, ≤ 950 (pure fat ≈ 884) |
| `protein_g_100g` `carbs_g_100g` `fat_g_100g` `fiber_g_100g` | real | each NULL or 0–100 (per definition of per-100 g) |
| `micros` | text | JSON object, `json_valid` CHECK; longevity shortlist keys (`sodium_mg`, `potassium_mg`, `calcium_mg`, `magnesium_mg`, `iron_mg`, `zinc_mg`, `vitamin_d_mcg`, `b12_mcg`, `folate_mcg`, `omega3_g`, `caffeine_mg` …) per 100 g; only values the source actually knows — absent beats guessed. **An arbitrary-key JSON column is why the vocabulary can grow without a migration** (§12d) |
| `source` | text NOT NULL DEFAULT 'user' | CHECK IN (`'seed','user','ai','openfoodfacts'`) — ARC-owned vocabulary (the shared `DataSource` describes *log* provenance; a catalog row's provenance is a different axis) |
| `is_favorite` | integer NOT NULL DEFAULT 0 | 0/1 CHECK — single-user, so a flag beats a join table |
| `basis` | text NOT NULL DEFAULT 'g' | CHECK IN (`'g','ml'`) — what this food is MEASURED IN (0047, §12e). Every per-100 column above is per 100 **of this** |
| `created_at` / `updated_at` | text | defaults + AFTER UPDATE trigger (mutable: favorites, edits) |

Indexes: `foods_name_norm_idx`, partial-unique `foods_barcode_idx`.

**`meal_items`** — a food+portion snapshot inside a meal:

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | |
| `meal_id` | text NOT NULL → `meals(id)` **ON DELETE CASCADE** | items are part of the meal record (same reasoning as `workout_sets`) |
| `food_id` | text → `foods(id)` **ON DELETE SET NULL** | provenance only — deleting a catalog food never destroys eating history (delete-semantics ADR) |
| `name` | text NOT NULL | snapshot of the food name at log time — the row stays meaningful alone |
| `amount` / `serving_qty` | real | either/both, > 0; NULL amount allowed (an "≈300 kcal lasagna" AI item). `amount` is in the row's `unit` (§12e) |
| `kcal` `protein_g` `carbs_g` `fat_g` `fiber_g` | real | ≥ 0, **snapshot at log time** (catalog edits never rewrite history) |
| `unit` | text NOT NULL DEFAULT 'g' | CHECK IN (`'g','ml'`) — the food's `basis`, SNAPSHOTTED at log time like the name and the macros (0047, §12e) |
| `confidence` | text | NULL or `'high','medium','low'` — persisted for AI items so the Coach can weigh them |
| `created_at` / `updated_at` | text | defaults + trigger (portions are editable) |

Indexes: `meal_items_meal_idx`, `meal_items_food_idx` (recents + FK perf).

### `0015_nutrition_targets.sql` — versioned daily targets

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

### `0016_food_seed.sql` — the starter catalog

~150–200 curated staples (`source='seed'`, fixed UUIDs), per-100 g values authored from USDA lab-analyzed knowledge (FDC is public domain), each with a household serving where one is natural, fiber where meaningful, micros only where confidently known. Coverage per the research convention: proteins (chicken/beef/fish/eggs/dairy/tofu/legumes), staple carbs (rice/oats/potato/bread/pasta), produce, fats/nuts/oils, common beverages, condiments, and a handful of composite restaurant archetypes (pizza slice, burger, burrito, sushi roll…) to absorb eating-out logging before the AI path exists. Values are approximate by nature; every row is editable in-app, and future catalog updates are **new append-only migrations** (a shipped migration is never edited). The catalog grows organically afterwards: customs (`user`), AI-synthesized entries (`ai`), scanned barcodes (`openfoodfacts`).

The first such catalog update is **`0063_seed_caffeine.sql`** (2026-09-23, §15): 0016 predates the `caffeine_mg` key, and 0063 adds it to the five seed rows that carry caffeine, by id, only where the user has not changed the row.

Migration-number note (resolved): the branch is now rebased onto the Coach-inclusive `main` (which has migrations through 0009), and the nutrition set is numbered **0014–0018** — strictly above `main`'s max and above Exercise's reserved 0011–0013, so `pendingMigrations` applies them cleanly on any device already past 9. The earlier "integrator finalizes numbers" caveat is discharged: the collision with the Coach's 0008/0009 was real (they renumbered from 0005/0006 to slot above Screenings' 0007), and this branch renumbered above them. The runner still tolerates the 0010–0013 gap; `migrate.test.mjs` asserts `user_version === max(version)` (now 18).

---

## 4. Repository & type surface

All new code depends only on the `Database` interface. **No existing export changes.**

> ⚠️ **This section no longer lists the exports, and that is the fix.** It carried a hand-copied inventory of two growing files, and it was stale twice: the recipe-folders round (2026-08-12) found `updateMealTime`, `replaceMealItems` and the six photo functions missing, and the capture round (2026-08-14) found the *corrected* list already missing `listRecentBarcodeFoods` — a paragraph that had been wrong, was fixed, and went wrong again inside two days. An inventory of a file that grows is stale by construction, so what follows describes the SHAPE and names only the functions whose behaviour needs explaining. **The authority is the file:**
>
> ```
> grep '^export function' src/lib/db/repositories/nutrition.ts
> grep '^export function' src/lib/db/repositories/foods.ts
> ```

**`src/lib/db/repositories/foods.ts`** — the catalog. Create/update/delete/get, `searchFoods` (tokenized LIKE over `name_norm`, prefix-ranked, favorites boosted — a few hundred rows need no FTS5; revisit if the catalog ever passes ~5k), favorites, and two recents readers over the `meal_items` join, newest-first, **each carrying the food's last-used portion**: `listRecentFoods` (everything) and `listRecentBarcodeFoods` (narrowed to `barcode IS NOT NULL` — the scanner's running list, §12b). Barcodes resolve through `findFoodByBarcode` (digits-only, offline) and cache through `cacheBarcodeFood` (idempotent on re-scan).

**`src/lib/db/repositories/nutrition.ts`** — the day's record. The original four (`logMeal`, `listTodayMeals`, `todayTotals`, `dailyIntakeSeries`) are **untouched and still are**; everything since is additive. The rules that matter, none of which the function names carry:

- **The repository is the only writer of a meal's macro columns.** `logMealWithItems` / `addMealItem` / `updateMealItemPortion` / `removeMealItem` / `replaceMealItems` each recompute the parent's totals **in the same transaction**, which is what makes the denormalized sums trustworthy.
- **The first item into a typed free-form meal preserves those totals as their own "(as logged)" item** — the forgotten egg adds to the 800-kcal dinner rather than replacing it.
- **A meal whose items all lack a macro sums that macro to NULL**, and a meal emptied of items returns to free-form NULLs. Never a fabricated zero.
- **`relogMeal` keeps provenance:** `ai_suggested` survives the copy, so an estimate stays labelled an estimate.
- **Targets are append-only** (`setNutritionTargets` / `activeNutritionTargets`, the `protocol_versions` pattern).
- **The 0033 meal-photo functions are the ROW half only.** The FILE half is `src/lib/media/meal-photo-store.ts`, and calling the row functions directly is exactly how a name and its bytes come to disagree.

**Pure helpers:** `src/lib/nutrition/servings.ts` — `amountForQty`, `macrosForAmount` (per-100 × amount/100; unit-blind, because the amount is in the food's own basis — §12e), used by UI and repo, headless-tested. `src/lib/nutrition/format.ts` — `fmtInt`, `fmtAmount`, `macroLine`, `portionLabel` (nutrition.tsx's local copies move here; the Data-tab's own copy is untouched).

**Types** (`src/lib/nutrition/types.ts`, feature-local per convention): `FoodRow`, `NewFood`, `FoodSource`, `MealItemRow`, `NewMealItem`, `NewMealWithItems`, `RecentFood`, `NutritionTargetsRow`, `NewNutritionTargets`, `EstimateConfidence`.

**Hook:** `useNutrition` gains `targets` (active row or null) and `itemCounts` — additive, same sanctioned useState-initializer + `useFocusEffect` shape.

---

## 5. The offline story

Consistent with **offline-except-AI** (CLAUDE.md §2): everything in the Phase-2 slice — catalog search, recents/favorites, portion math, quick add, custom foods, meal grouping, targets, re-log — runs with the network unplugged, forever. The online exceptions, both long-tail:

1. **AI photo/describe estimation** — the *only* AI-online path (§6), consistent with Coach chat and lab-PDF parse.
2. **Barcode lookup** — scan resolves **locally first** (`findFoodByBarcode` over the grown cache), then Open Food Facts *when online*; every hit is written back as a `foods` row (`source='openfoodfacts'`, barcode filled), so a pantry converges to fully-offline scanning within days of normal use. A miss offline falls back to search/manual/photo. (OFF etiquette: custom `User-Agent "ARC/0.1 (personal longevity app)"` — no personal identifier, matching the shipped value in `src/lib/nutrition/openfoodfacts.ts`; well under 15 req/min by construction; ODbL private-use carve-out applies, attribution noted in-app later.)

No bulk database ships on-device beyond the seed: the full OFF/FDC dumps are server-scale bloat for one user (research §1); the catalog grows from *this* user's actual eating.

---

## 6. The AI logging flow (photo → macros; words → macros)

**Hard dependency, flagged:** the Coach window is currently building the real on-device model client (Phase 3: direct provider call, key in Keychain, `expo/fetch` streaming — `docs/project-status.md`). The nutrition AI path **must reuse that client** — one model path in the app, never a second. Until it merges, ARC ships the **seam**, not the call.

### The seam (built in the slice)

`src/lib/nutrition/estimate.ts`:
- `EstimateInput = { kind:'text', description } | { kind:'photo', base64Jpeg, mediaType:'image/jpeg', description? }`
- `MealEstimate = { title, items: MealEstimateItem[], notes? }`; `MealEstimateItem = { name, grams|null, kcal, protein_g, carbs_g, fat_g, fiber_g|null, micros: JsonText|null, confidence:'high'|'medium'|'low', foodId|null }` — `micros` carries the model's own **sodium and caffeine** for the portion it estimated (§12d), or the catalog food's full snapshot once grounded
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
- **A second nutrition dashboard competing with the Data tab** — the Data tab keeps its single-row glance (`dailyIntakeSeries`, untouched). Round 2's `app/nutrition-history.tsx` is the *domain's own* drill-down (per-day totals, macro averages, per-day adherence vs each day's targets), reached from within Nutrition — not a duplicate of the Data hub and not an edit to `data.tsx`.
- **Shipping a big food database** — grow-your-own cache instead (§5).
- ~~**Meal templates as a separate system** — deferred to protocols~~ — **BUILT in round 2** in the nutrition domain (`meal_templates` + `meal_template_items`, 0018), because a "saved meal" is a nutrition record, not a versioned protocol. Captured retroactively (save a logged meal), logged in one tap (`logMealFromTemplate` stamps fresh snapshots — a stamp, not a link). The `meal_template` protocol *type* remains for prescriptive plan templates; the two don't overlap.
- **Micros beyond the shortlist** — honest sparse data over fake completeness; Cronometer-grade panels only if a lab-analyzed import lands later. Round 2 tracks the longevity shortlist (`src/lib/nutrition/micros.ts`), snapshotted per item (0017) and rolled up daily against general reference values (never a good/bad verdict).

---

## 9. The Phase-2 slice (built on this branch) & build sequence

**Built now (offline, self-standing):** migrations 0014/0015/0016 + `foods.ts` repo + `nutrition.ts` additions + `servings.ts`/`format.ts` helpers + types + reworked `nutrition.tsx` + `food-search.tsx` + `food-new.tsx` + `meal-detail.tsx` + `nutrition-targets.tsx` + the `estimate.ts` seam + headless suite `db/foods.test.mjs` + `db:bundle` regeneration.

**Build sequence after owner review (long tail):**
1. Describe-in-words + AI review screen (once the Coach model client merges — coordinate with that window).
2. expo-camera EAS rebuild (batched) → photo path → barcode.
3. Coach-proposed targets; retroactive meal-templates-into-protocols; weekly digest surface on Data if wanted; micros daily rollup.

**Verification gates:** `npm run typecheck` · `lint` · `format:check` · `db:validate` · `db:test` (new suite included) · `npx expo export --platform ios`.

---

## 10. Flags & integrator-merge points

| # | Item | Kind |
| --- | --- | --- |
| 1 | `src/lib/db/migrations.generated.ts` regenerated (0014–0018 added) | **INTEGRATOR-MERGE** (regenerate `db:bundle` at merge) |
| 2 | `package.json` `db:test` line gains `db/foods.test.mjs` | **INTEGRATOR-MERGE** |
| 3 | `app/_layout.tsx` gains 4 routes (`food-search`, `food-new`, `meal-detail`, `nutrition-targets`) | **INTEGRATOR-MERGE** |
| 4 | Migration numbers 0014–0018 | **resolved** — already renumbered above `main`'s Coach 0008/0009 and Exercise's 0011–0013 (§3); strictly increasing, applies cleanly on any device past 9 |
| 5 | Coach model client (`src/lib/ai/*`) | **DEPENDENCY** — estimate.ts reuses it; do not build a second model path |
| 6 | `expo-camera` (+ `expo-image-manipulator`, maybe `expo-image-picker`) | **NATIVE DEP, not added** — EAS rebuild required; batch with secure-store/local-auth |
| 7 | Data tab / Coach read-tools | untouched — all existing nutrition exports stable |
| 8 | Seed catalog values | curated approximations (USDA-derived, public domain); every row user-editable; updates = new migrations |
| 9 | `docs/project-status.md`, `decisions.md`, CLAUDE.md §4 currency | integrator-owned at merge; proposed ADR below |

**Proposed ADR (for `docs/decisions.md`, integrator to lift):** *2026-07-26 — Nutrition became a food-logging sub-app.* Foods catalog + meal-items extend `meals` without breaking it (items snapshot macros; repos maintain parent sums); targets are append-only versions (`protocol_versions` pattern, Coach-proposable); the AI photo/NL path is a seam over the Coach's model client (one model path), grounded retrieve-then-generate with a mandatory editable review; barcode = OFF + grow-your-own offline cache (ODbL private-use carve-out); adherence-neutral display, no gamification — per the competitor research digest in `docs/nutrition-subapp.md` §1.

---

## 11. Round 2 — what shipped, and what changed vs this spec

Round 2 (2026-07-27, rebased on `main` after Settings/units + Protocols + Screenings merged) built the offline serious-logging loop the mission asked for. Changes against the original plan above:

**Built (offline, migrations 0017–0018):**
- **Micronutrient snapshots** — `meal_items` gains a `micros` JSON column (0017, `ALTER ADD COLUMN`); `itemForPortion` snapshots the catalog food's per-100 g micros scaled to the portion, so micros survive a catalog edit or a food's deletion (same discipline as the macro snapshot, and it lets the AI path carry micros the catalog lacked). Vocabulary + reference DVs in `src/lib/nutrition/micros.ts` (the longevity shortlist). Daily rollup: `dayMicroTotals` → `app/nutrition-micros.tsx` (mono numbers + thin neutral tracks vs a general reference, sodium framed as a ceiling; read-only, no pine, no good/bad colour).
- **Meal templates** — `meal_templates` + `meal_template_items` (0018), a stamp not a link (`logMealFromTemplate` copies snapshots, so editing/deleting a template never touches logged meals). Captured retroactively via "Save as template" on `app/meal-detail.tsx`; browsed and one-tap-logged from `app/meal-templates.tsx`. Repo: `src/lib/db/repositories/meal-templates.ts`.
- **Cross-day trends** — `nutritionHistory(db, days, today)` returns per-day totals + each day's *own-era* targets; `app/nutrition-history.tsx` shows a 7/14/30-day window, averages over logged days, a dependency-free kcal sparkline, and per-day adherence. Read-only, no pine, and it does **not** touch `data.tsx`.
- **AI seam aligned to the real client** — now that the Coach's `model-client.ts` (`runCoachTurn`, streaming Messages loop) is known (it lives on the Coach branch, not `main`), `estimate.ts` ships the *pure* `buildMealEstimationRequest` (produces the `AgenticRequest` shape the client consumes, image block included) + `parseMealEstimate` (tolerant JSON validator). `estimateMeal` still throws until the client is on `main`; the wiring is the ~5 lines documented in the file. **No second model path.**

**Plan corrections:** meal templates moved from "deferred to protocols" (§8) into the nutrition domain — a saved meal is a nutrition record, not a versioned protocol. The Cal-AI goal-ring → thin-pine-track translation (§2) is now realized on every progress surface (Today card, micros, history) with the round-1 discipline (fill turns pine only at target completion; micros/history stay neutral, being read-only ledgers).

**Migration numbers (final, after the Coach-collision rebase): the whole nutrition set is 0014–0018** — `food_catalog` 0014, `nutrition_targets` 0015, `food_seed` 0016, `meal_item_micros` **0017**, `meal_templates` **0018** — a contiguous block above `main`'s Coach 0008/0009 and Exercise's reserved 0011–0013. No device-install caveat remains: the numbers are strictly above `main`'s max, so they apply cleanly.

**Round-2 integrator-merge points** (in addition to §10): `migrations.generated.ts` (now **12 migrations** after the rebase — `main`'s 7 + nutrition's 0014–0018), `package.json` `db:test` (union: `main`'s 17 Coach/Data suites + `db/foods.test.mjs` + `db/nutrition-v2.test.mjs` = 19), and `app/_layout.tsx` (my 7 nutrition routes coexist with `main`'s route list). The `db/screenings.test.mjs` floor-fix I made in round 2 is **no longer in this branch** — `main`'s Coach integration (commit `44d7d74`) had already hardened the same assertion to `>= 7`, so the rebase kept `main`'s identical version. Verified: `db:test` is **19 suites / 577 assertions**, all green, with the Coach's tables and my nutrition tables coexisting.

---

## 12. Round 3 — barcode, inline editing, live AI estimation

Round 3 (2026-07-27, rebased onto `main` with the Keychain key store / Home brief / notifications) lit up the acquisition + editing gaps. **No new migration** — the schema already supported barcode caching (`foods.barcode` + `source='openfoodfacts'`, 0014) and AI meals (`meals.source='ai_suggested'`, `meal_items.confidence` + `micros`).

**Built:**
- **Barcode scanning** (`app/barcode-scan.tsx`, native `expo-camera`) — a scan resolves LOCAL-FIRST (`findFoodByBarcode` over the grown cache), then **Open Food Facts** on a miss when online, caching every hit back into `foods` via `cacheBarcodeFood` (idempotent — a re-scan returns the existing row, never a duplicate). A miss (offline or not-in-OFF) falls back to manual entry with the barcode prefilled, so the next scan hits. The OFF mapping (`src/lib/nutrition/openfoodfacts.ts`) is pure + fetch-injected (headless-tested): macros/fiber in grams, sodium/potassium/calcium/iron converted grams→mg, everything out of the schema's range dropped to NULL so `createFood` never throws; the uncertain vitamins/magnesium/omega-3 are deliberately *not* mapped (research §1: label data is unreliable for those). **The one online-except-AI path.**
- **Inline portion editing** (`app/meal-detail.tsx`) — tap a logged item → an inline editor (serving stepper when the catalog food names one, grams always) → `updateMealItemPortion` (the round-2 repo fn, previously called from no screen). The re-scale (`rescaleLoggedItem`, `servings.ts`) RE-DERIVES macros + micros from the catalog food when it's still present, else scales the item's snapshot proportionally by grams; returns null (not editable) for a food-less item logged without grams.
- **Live AI estimation** (`src/lib/nutrition/estimate.ts` + `app/meal-estimate.tsx`) — `estimateMeal` now runs the built request through the Coach's `runCoachTurn` (one turn, no tools), reusing the Coach's key (`api-key-store`, iOS Keychain) and streaming fetch (`expo/fetch`, loaded through a guarded require so the headless test still loads the module). `groundMealEstimate` re-prices each item against the catalog (Lose-It's own-history lever). Results land in an **editable review** (grams-editable, per-item ≈ confidence, remove) that is **NEVER auto-committed** — an explicit Save writes `logMealWithItems(source:'ai_suggested')`. Describe-in-words works as soon as a key is set; photo capture uses `expo-camera` + `expo-image-manipulator` (downscale to ~1024 px before the base64 leaves the device).

**Entry points:** the pine "Describe or snap" on Nutrition now opens the AI review; a "Scan" button sits beside "Add food"; food-search gained "Scan a barcode" (into the same meal); food-new accepts a `barcode` param.

**Native deps (flag):** `expo-camera` (~57.0.3) + `expo-image-manipulator` (~57.0.6) added, with the `expo-camera` config plugin (camera permission) in `app.json`. **These needed one shared EAS rebuild** before barcode/photo could run on device; it happened 2026-08-25, and neither has been observed running; describe-in-words and everything offline run without it.

**Round-3 integrator-merge points** (additive): `package.json` (2 new deps + `db:test` gains `db/barcode.test.mjs`), `app/_layout.tsx` (+2 routes: `barcode-scan`, `meal-estimate`), `app.json` (expo-camera plugin). Reuses `main`'s `api-key-store` + `model-client` (imported, not edited) — the AI estimation is the same one model path the Coach uses. **Tests:** `db/barcode.test.mjs` (21) + `db/nutrition-v2.test.mjs` grew to 53 (rescale, scaleMicros, grounding) → `db:test` **628 across 20 suites**; typecheck / lint / format:check / db:validate / `expo export ios` all green.

---

## 12b. Round 6 — the capture round (2026-08-14)

Four owner requests off the device, in one change, **with no migration**. Everything here is headless-verified only; §12c is the device checklist.

### 1. The chooser's close control was under the status bar (item 10)

> *"In the menu to log where you decide which logging method to use, the back button is not accessible because it is too high up on the screen."*

The screen is `src/components/nutrition/log-sheet.tsx`, opened by the Eat tab's one `Log` button. It already did what looked like the right thing: a native `Modal`, a `SafeAreaView edges={['top','bottom']}`, and the same `pt-2` every pushed screen uses. The inset it was asking for was **zero**, and this is why.

`SafeAreaView` in `react-native-safe-area-context` v5 is not a JS component reading React context — it is a native view. `RNCSafeAreaViewComponentView.findNearestProvider` walks **`self.superview`**, the UIKit chain, looking for an `RNCSafeAreaProviderComponentView`, and returns `self` when there is none:

```objc
- (UIView *)findNearestProvider {
  UIView *current = self.superview;
  while (current != nil) {
    if ([current isKindOfClass:RNCSafeAreaProviderComponentView.class]) return current;
    current = current.superview;
  }
  return self;
}
```

An RN `Modal` on iOS presents its own `UIViewController`. Its React children are in the same React tree — so context flows — but in the **native** tree they hang off the presented controller's view, not off the app root. The provider react-navigation installs around the Stack is therefore invisible to that walk, and `_providerView` becomes `self`.

That fallback has no way to ever be right. Insets are read in `didMoveToWindow` and `finalizeUpdates`, and refreshed only on the `RNCSafeAreaDidChange` notification — which a *provider* posts and `self` never does. And unlike `RNCSafeAreaProvider`, the safe-area **view** implements no `safeAreaInsetsDidChange` and carries no "wait until the frame is non-zero" retry. (The provider has both; its comment reads *"This gets called before the view size is set by react-native so make sure to wait so we don't set wrong insets to JS."* — the exact hazard, guarded in one class and not the other.) So the view latches whatever UIKit had at attach time, which during a modal presentation is `UIEdgeInsetsZero`, and never corrects.

Top padding 0 + `pt-2` = the control sitting **eight points from the physical top of the screen**: under the status bar, behind the Dynamic Island. Exactly the report.

**The fix is a provider inside the Modal, not a tuned padding.** A real `RNCSafeAreaProvider` in the modal's own native hierarchy gives the view below it a source that measures, retries and posts; `SafeAreaProvider` additionally seeds itself from the parent React context, so the first frame already carries the app's insets instead of flashing at zero. It stays correct across rotation and a keyboard, and there is no number to go stale.

It lives once, as `ModalScreen` in `src/components/ui/screen.tsx` (sheet + `PaperGrid` + provider + inset; deliberately **no** `px-5`, since a modal's header and its scroll body take the gutter separately).

**The sibling sweep.** Every `Modal` in the app was checked, and **all three chooser modals had the same bug**: this sheet, Home's mode picker (`src/components/home/mode-control.tsx`) and the exercise picker (`src/components/exercise/exercise-picker.tsx`). All three now go through `ModalScreen`. The app lock's `Modal` (`app/_layout.tsx`) is immune **by accident** — `AppLockScreen` centres its content and asks for no inset at all. `app/(tabs)/coach.tsx` uses a bare `SafeAreaView` and is fine: it is a tab screen inside the Stack, so it is a native descendant of the real provider. No pushed screen presents modally (`app/_layout.tsx` sets no `presentation`), so the stack screens were never affected.

**One judgment call beyond the fix, open to veto.** The close control moved from the trailing edge to the **leading** edge, at `-ml-3`, where `StackHeader` puts the back chevron on every pushed screen — because the owner reached for "the back button" and it was in the far corner. The exercise picker already did this. Home's mode picker still keeps its close on the right and was left alone: it was not reported, and the smaller diff is the honest one. If the leading edge is right, that picker should follow.

### 2. Recently logged barcodes (item 9)

> *"Under scan a barcode, lets show a running list of the most recently logged barcodes for quick tapping."*

`listRecentBarcodeFoods(db, limit = 6)` in `repositories/foods.ts` — `listRecentFoods` with `WHERE f.barcode IS NOT NULL`. The decisions, each of which was a real choice:

| Question | Answer | Why |
| --- | --- | --- |
| A new table? | **No, and no migration.** | The scan already caches a `foods` row (`cacheBarcodeFood`) and logging already writes a `meal_items` row. The list is the join those two facts already imply; a second store of scan history is one more thing to fall out of step with the catalog. |
| How many? | **Six.** | A running list is the pantry you are rotating. Longer than a screenful is a search, and the catalog already has one. |
| What does a row show? | **Product name, then brand, then the portion it was last logged at.** Never the digits. | A barcode number means nothing to a human. The portion is a measurement, so it is mono; no portion on record renders as an em-dash, never a stand-in number. |
| A code scanned but never resolved? | **Never appears, by construction.** | It never became a `foods` row. It reaches this list only if the user takes the manual fallback (`/food-new` with the code prefilled), saves the food, and eats it — at which point it is a real catalog entry and belongs. |
| A code cached but never eaten? | **Also absent.** | The join is through `meal_items`. The list exists to re-log a repeat item, and a food nobody ate is not one. Pinned in `db/foods.test.mjs` §10b by an explicit negative. |
| Tap = log, or tap = portion sheet? | **The portion sheet**, prefilled with last time's portion. | The sheet already states what the portion comes to, and it is the same sheet a live scan lands in. One confirmation surface, not two. A repeat item is usually the same amount, so the prefill is the speed — not a skipped confirmation. |

The list is read **once**, in the state initializer, and is a snapshot of the moment the scanner opened: re-reading it after each add would reorder the rows under a finger that is already travelling. It refreshes on the next visit.

It renders only when non-empty — a heading over an authored empty would be a permanent fixture explaining a feature that has not happened yet.

### 3. Two capture buttons under Log on the Eat tab (item 11)

`Photo` → `/meal-estimate?start=camera` (straight into the viewfinder). `Describe` → `/meal-estimate` (the field, which is where that screen already opens).

They are **capture methods, not navigation**, which is what earns them the space the Log-tab grid lost two tiles for. The Log sheet's "Describe or photograph" row opens the same screen on its *field*; getting to a viewfinder from the tab was three taps and is now one. Both are **outlined, never pine** — the accent on `Log` is the screen's one accent in every state and must stay the only thing on the page claiming to be the next action. Same treatment as the Take-a-photo / Choose-a-photo pair inside the estimator, because they are the same two methods one level up.

### 4. Barcode detection inside the photo logger (item 12)

**Feasible, confirmed against the installed `expo-camera` 57.0.3 — not from documentation.** `CameraViewProps` carries `barcodeScannerSettings` and `onBarcodeScanned` on the same component that exposes `takePictureAsync`; `ensureNativeProps` sets `barcodeScannerEnabled = !!props.onBarcodeScanned`; and on iOS the scanner is an `AVCaptureMetadataOutput` added to the session **alongside** the `AVCapturePhotoOutput` (`ios/Current/BarcodeScanner.swift` vs `CameraSessionManager.swift`), with `mode` defaulting to `.picture`, which is what capture needs. One session, both readings, no mode switch and nothing new in the build.

**It sits alongside `app/barcode-scan.tsx`; it does not replace it.** The scanner is the dedicated pantry loop — scan → portion → *Scan another* → repeat, optionally into a named `mealId` from food search — and it is where item 9's running list lives. Folding that into the estimator would have made one screen serve two intentions. So item 9's list is unaffected by the merge.

**The interaction is the whole design.**

- A code in frame is **offered, never taken**. `Capture` stays the one accent, in the same place, doing the same thing, whether or not a packet has wandered into shot behind the plate.
- The offer renders **below** `Capture`, not above it — so nothing the thumb is already travelling towards moves under it. That is why there is no reserved slot: the row appears at the end, where its arrival displaces nothing.
- The offer **says which record it is about to make**: the product name (or the raw code, mono, when the catalog has never seen it) plus `Saved earlier — log a portion` or `Not scanned before`. A photograph becomes an AI estimate; a barcode becomes a catalog food at a chosen portion. Those are different writes and the surface must not blur them.
- The lookup behind the offer is **local only** (`findFoodByBarcode` — offline, synchronous). Reaching Open Food Facts for a code nobody has accepted would spend the network on a packet that merely drifted through frame.
- Taking the offer **pushes `/barcode-scan` with a `code` param** and drops the estimator back to its `input` phase. The push is the point: that screen already owns the resolve ladder (local → OFF → manual fallback) and the portion sheet, so the merge needed no second confirmation surface. Dropping back to `input` unmounts this screen's viewfinder — two live camera sessions stacked in one navigation stack is a battery cost and an iOS session interruption waiting to happen. On arrival the scanner opens directly in `resolving`, never in `scanning`, so it does not start a session it is about to tear down either.

### The camera moved behind a guarded seam

`src/lib/media/camera.ts`, modelled on `src/lib/media/photo-library.ts`. Both `app/meal-estimate.tsx` and `app/barcode-scan.tsx` carried `import { CameraView, useCameraPermissions } from 'expo-camera'` at **route-file module scope** — the pattern that has already caused two app-**launch** crashes (`expo-image-picker`, `expo-keep-awake`), because Expo Router eagerly requires every file under `app/` to build its manifest. `expo-camera` is in the binary currently on the phone, so it had not fired; it was the next one to.

Two consequences beyond the rule:

- **The absent branch is now a sentence, not a spinner.** Without the module `permission` stays `null` forever, and the old `!permission → "Preparing the camera…"` would have sat there for good. Both screens now check availability first and say the shot needs the next app build, naming the path that still works. The scanner additionally says its running list still works, because it does — that half is database-only.
- **Both screens are on the headless render walk for the first time** (`db/screens-render.test.mjs` §7b). A static native import is a *resolve* failure under Node, which is why neither had ever been rendered by the suite.

### Verification

Gate, on this branch: `npm run typecheck` 0 · `npm run lint` 0 errors (2 pre-existing warnings in `src/lib/rag/retrieve.ts`) · `npm run db:validate` 20/20 · `npm run db:test` **3,050 assertions / 50 suites, 0 failed** (`db/foods.test.mjs` 80 → **86**, `db/screens-render.test.mjs` → **345**) · `npx expo export --platform ios` clean.

**No migration.** Head stays `0039`.

**Routes:** none added, none removed. Two existing routes gained an optional param — `/meal-estimate` takes `start=camera`, `/barcode-scan` takes `code` — and both were already registered in `app/_layout.tsx`.

## 12c. What only a device can judge (round 6)

Headless renders prove a component body does not throw and that the strings are right. Effects do not run and taps cannot be simulated, so all of the following are **unverified**:

1. **The safe-area fix itself.** The whole diagnosis is read off the installed native source; nothing on this machine can present a `UIViewController`. Open the Eat tab → `Log` and check the close control clears the Dynamic Island. Then check Home's mode chip and the exercise picker, which had the same defect and the same fix.
2. **Whether the close control belongs on the leading edge.** A judgment call, easily reverted.
3. **The barcode offer.** Reaching it needs a real `onBarcodeScanned` event. Point the estimator's camera at a package: the offer should appear *below* `Capture`, `Capture` should not move, and photographing a plate with a packet in shot should be completely unaffected.
4. **Both cameras at all.** `expo-camera` is in the *current* binary, but every path here is new. In particular: does the metadata output slow `takePictureAsync`, and does the handoff to `/barcode-scan` leave exactly one live session?
5. **The handoff resolve.** `/barcode-scan?code=…` runs in a `useEffect`, which a server render never executes.
6. **The running list's ordering under real use** — the snapshot-on-open decision is a feel judgment, not a correctness one.

---

## 12d. Caffeine, fiber and sodium — the owner's three, made first-class (A8, 2026-09-14)

The owner's note after two weeks on the TestFlight build was three words and a question mark: *"important micros: caffeine, fiber, sodium?"* (backlog `docs/backlog-2026-09.md`, A8). Two of the three were already in the data layer and one was not tracked at all. **No migration** — and that is the point of the column's shape: `foods.micros` / `meal_items.micros` are arbitrary-key JSON guarded by `json_valid`, so a new nutrient is a new key in `src/lib/nutrition/micros.ts` and nothing else. Head stays `0044`; the number reserved for this item (`0045`) was not needed and is released.

**Where each of the three stood, and what changed**

| | Before | Now |
| --- | --- | --- |
| **Sodium** | in the vocabulary since 0017, reference 2,300 mg, framed as a ceiling | unchanged in the data layer; the estimator now returns it, so an AI-logged meal contributes sodium instead of nothing |
| **Fiber** | a fixed column (`foods.fiber_g_100g`, `meal_items.fiber_g`) read against the user's own `nutrition_targets.fiber_g` | unchanged as data; the micros screen's fiber plate **no longer hides itself when no target is set** |
| **Caffeine** | not tracked anywhere | a vocabulary key (`caffeine_mg`), a row on the micros screen, and one of the two micros the model is asked for |

**The reference values, and where they come from.** Written once, in `src/lib/nutrition/micros.ts`, and sourced in its docblock because an unsourced number on a health screen is a number nobody can check. FDA Daily Values (21 CFR 101.9) for the minerals and vitamins, sodium's 2,300 mg included; the IOM's Adequate Intake for omega-3 (ALA, 1.6 g); and for caffeine **400 mg/day**, the FDA's stated figure for healthy adults — guidance about a compound, not a nutrient requirement, and marked `ceiling: true` so the UI frames it *"of 400 limit"* rather than as something to reach. Caffeine sorts last in `MICROS`, on its own, because it is not a nutrient and should not read as one filed among the vitamins.

**The estimator now returns two micros, and only two.** `MEAL_ESTIMATION_SYSTEM_PROMPT` and `MEAL_REVISION_SYSTEM_PROMPT` both carry a `"micros"` object in the schema, asking for **sodium and caffeine in milligrams, for the portion estimated**, on foods that plausibly carry them — and to **omit** a key rather than guess it, because an absent key means "not recorded" and a `0` means "measured none", which are not the same claim. Only two, deliberately: the rest of the shortlist is label data the model would be inventing, and the catalog is the better source for it wherever an item grounds.

The reply goes through the same vocabulary filter as stored JSON (`coerceMicros`, split out of `parseMicros` for exactly this caller), so an invented key or a stringy number is dropped at the seam, and an item that returned nothing usable serialises back to `NULL` rather than `{}`.

**Precedence at grounding** (`groundMealEstimate`) — *superseded 2026-09-23 by a key-by-key merge, §12n; kept here as the A8 record:* a matched catalog food's own snapshot wins whole; a food that records **no** micros leaves the model's sodium/caffeine standing. That is what lets the seeded `Coffee, black` — macros but no micros row — still log its caffeine. It is not merged key by key: a food that records micros at all is the better source for all of them, and half-catalog/half-model is the shape that function exists to avoid.

**A revision no longer strips them.** `buildMealRevisionRequest` prints each item's sodium and caffeine in the row it shows the model (`- Flat white — 240 g, 120 kcal, …, sodium 90 mg, caffeine 145 mg`), and the prompt's restraint rule now says *name, grams, macros and micros* come back unchanged on anything the correction did not touch. Without that, correcting one item would quietly empty the others.

**The seeded catalog was left alone, on purpose.** `db/migrations/0016_food_seed.sql` is a **shipped migration**, and a shipped migration is never edited (CLAUDE.md §9). So `Coffee, black` still carries no caffeine of its own, and neither do the teas or colas; a catalog-logged coffee records caffeine only once its food row is edited in-app or an AI estimate supplies it. Backfilling the seed is a future append-only migration, not this one — it is a data question (which foods, what values, sourced how) rather than a plumbing one.

**The two honesty rules that govern the screen, unchanged and now load-bearing for three nutrients instead of one:**

- **The undercount caveat stays visible.** `dayMicroTotals` sums only items `WHERE mi.micros IS NOT NULL`, so any day holding a free-form or micro-less food runs low. The line inside the plate — *"Only foods with recorded micronutrients contribute, so these totals can run low"* — is what keeps those figures honest, and the owner asked for that honesty by name once already.
- **No denominators until targets exist** (`docs/design-research/implementation/00-design-spec.md` §5). With no fiber target the fiber plate prints the figure alone: no denominator, no rule, and a label that says `no target set`. The old behaviour hid the plate entirely, which meant a profile that had never opened the targets screen could not see a number the day genuinely recorded.

**Verification.** `db/nutrition-v2.test.mjs` §21 walks one caffeinated item end to end — model reply → parser (keys kept, junk dropped, empty → `NULL`) → grounding against a micro-less catalog food → logged meal → `dayMicroTotals` — and asserts both prompts ask for the two micros and that the revision request states them. `db/screens-render.test.mjs` §7c renders `app/nutrition-micros.tsx` over a real day: sodium `1,240`, caffeine `145`, `2 of 12 recorded`, the caveat, and the fiber plate in both of its states.

---

## 12e. `ml` as a second unit (B2, 2026-09-14, migration `0047`)

The owner, opening the September Phase-B list: *"Let's start by implementing ml as a new unit type; the AI should estimate how many ML a drink is, instead of grams, when using ml instead of g."* And the scope fence, in the same breath: *"it could get complex having too many and being too creative with it."*

So: **one** new unit. No density table, no general unit system, no `oz`/`cup`/`slice` in the schema. *(Slices were parked here and built in §12m — as a **count of pieces on a composite**, which is a ratio and needs no conversion. This rule survived intact: there are still exactly two units and nothing converts between them.)*

### The model, and why there is no conversion

Three facts, and nothing else:

1. **A food declares a `basis`** — `'g'` (the default) or `'ml'`. Its per-100 macro columns are per 100 **of that basis**: a 42 kcal/100 ml milk stores `42`.
2. **A meal item's `amount` carries a `unit`** — the food's basis, *snapshotted* at log time exactly as its name and macros are, so editing or deleting the catalog food can never restate what was drunk.
3. **Nothing converts.** A drink is logged in ml and stays in ml, on every screen and in every total, for life.

The third is the load-bearing one. A ml↔g factor needs a **density per food** (milk 1.03, oil 0.92, honey 1.42) — a table of numbers nobody in this app has measured, maintained forever, wrong in the cases that matter most. That is precisely the "too creative" the fence forbids. The two units are two parallel ledgers of the same shape, never two views of one number.

**Refusing it costs nothing, and that is the whole reason the design is this small.** Energy and macros are already the common currency: `meal_items.kcal`, `protein_g`, … are absolute amounts **for the portion**, not per basis, so a 250 ml glass of milk and a 50 g bowl of oats sum into one day's totals by construction. Nothing that rolls up — `todayTotals`, `nutritionHistory`, `dayMicroTotals`, the Coach's snapshot — has to know the unit exists. The unit governs exactly one thing: the portion number and how it prints. That is why `0047` touches **no aggregate, no index and no trigger**.

A food has one basis, and a portion of it is always in that basis. There is deliberately **no "log this ml food in grams" path**: offering one would immediately require the conversion this design refuses.

### The rename, and the one it did not do

`0047` also renames the three portion columns to what they now hold:

| before | after |
| --- | --- |
| `meal_items.grams` | `meal_items.amount` |
| `meal_template_items.grams` | `meal_template_items.amount` |
| `foods.serving_grams` | `foods.serving_amount` |

A column called `grams` holding `250` for a 250 ml drink is the exact class of lie the rest of this schema goes out of its way not to carry (`meal_photos.file_name` is a *name*, never a path; `wearable_data.metric_type` is free text on purpose). SQLite's `ALTER TABLE … RENAME COLUMN` rewrites the references inside indexes, triggers and CHECK constraints — which matters, because `foods` carries a table-level `CHECK ((serving_name IS NULL) = (serving_grams IS NULL))` that would otherwise dangle. `db/migrate.test.mjs` §8 proves the rewritten constraint still *bites*, not merely that it still exists.

**The per-100 macro columns kept their names** (`kcal_100g`, `protein_g_100g`, …), and that is a judgment rather than a half-finished rename. They stay true of every row that exists today and of every solid food forever; "_100g" is read as "per 100 of the basis", and the basis sits one column away. A portion is different in kind — it is the number the user types and the screen prints back, so its unit has to be legible at the point of use.

### Recipe lines stay grams — stated explicitly, because it is a real choice

**`recipe_ingredients.grams` is not renamed and gains no unit.** A recipe line is parsed from prose ("1 cup milk") and *resolved* to a mass by `src/lib/recipes/ingredients.ts` + `src/lib/recipes/estimate.ts`, which is already **mass-only by design** ("a cup of flour and a cup of oil differ by…"); that resolution to one unit is what makes a recipe's nutrition summable at all. So those grams really are grams, and the name stays true.

That also leaves the **0034 invariant** `resolved_by IS NULL ⇔ grams IS NULL` untouched — same two columns, same repository writers, same pairing, not one byte moved.

Three seams between the two worlds, all explicit:

- **`logRecipe`** (recipe → meal): a counted line becomes a meal item at `unit: 'g'`, stated rather than defaulted.
- **`saveMealAsRecipe`** (meal → recipe): a **millilitre item lands UNRESOLVED**, with its number and unit kept in the raw line ("250 ml Milk", `qty` 250, `unit` ml) — which is exactly what a hand-typed volumetric line looks like, and it is priced in grams by the same automatic pass every other volumetric line already goes through. Copying 250 ml into a grams column would be a silent unit swap inside a number the whole rollup then trusts.
- **`resolveIngredient`** refuses a non-`g` food outright, with the reason in the error.

### The estimator

`MEAL_ESTIMATION_SYSTEM_PROMPT` now asks for `"amount"` plus `"unit": "g"|"ml"`, with the rule stated in the terms a model can act on — **"ml" for anything DRUNK** (coffee, tea, juice, soda, beer, wine, milk, a smoothie or shake), `g` for everything eaten — and an explicit *"estimate a drink in millilitres directly; never convert it to grams."* Macro grams stay macro grams whatever the portion unit is, which the prompt also says, because that is the one place the two senses of "g" could collide.

Two coercions in `parseMealEstimate`, both deliberately permissive rather than throwing, because **every estimate lands on an editable review screen** — a wrong unit is visible and one tap from fixed, while a refusal loses the whole meal:

- an unknown `unit` (`"cups"`, absent, nonsense) falls back to `g`;
- a reply that still says `"grams"` is read as a gram `amount`, so an older prompt's shape lands on the row instead of becoming an unportioned item.

**`groundMealEstimate` will not cross the two.** It re-prices only on a confident name match to a food with complete macros **and the same unit**. Two foods with the same name, one per-100-g and one per-100-ml, is the sharpest form of the trap: the name match is perfect and only the unit tells them apart. A mismatch keeps the model's own numbers, which are at least self-consistent — the same reasoning as the existing generic-single-word rule, one axis over.

`MEAL_REVISION_SYSTEM_PROMPT` gains the matching rail (*keep the unit each item arrived with; never restate a millilitre amount as grams*), and `buildMealRevisionRequest` prints each row in its own unit — without that, "leave the untouched items byte-identical" cannot mean anything for a drink.

### What the screens do

| surface | what changed |
| --- | --- |
| `app/food-new.tsx` | a **Solid · g / Drink · ml** toggle above the serving row, because it names what that row's number counts and what the macros are per 100 of. The serving label, the entry-basis chip and the two validation messages all follow it. |
| `app/food-search.tsx`, `app/barcode-scan.tsx` | the portion editor's suffix and spoken label are the food's own unit; the right-edge summary reads `100 ml` for a drink; the recents rail prints last time's portion under the volume preference. |
| `app/meal-detail.tsx` | the amount field is suffixed with the **item's** unit (not the food's — a food re-declared as a drink afterwards does not restate what was eaten), and `portionLabel` prints under the preference. `selectOnFocus` and `KEYPAD_DONE` are untouched. |
| `app/meal-estimate.tsx`, `app/meal-revise.tsx` | each review row carries the model's unit beside its amount and writes it onto the item. |
| `app/meal-templates.tsx` | a saved "morning shake" round-trips with its millilitres intact. |

**The oz/ml preference applies to READINGS, and deliberately not to entry fields.** `fmtAmount` converts a millilitre amount for display when Settings › Units says `oz` — the same factor water uses, exported once from `src/lib/log/metrics.ts` so there is one copy of it — and leaves gram amounts alone, because that toggle is a *volume* preference. An entry box is different: converting one means a 330 ml can reads "11.2 oz" and writes back 331.2 ml on a Save the user never edited, which is the rounding drift `app/meal-detail.tsx` already fights in the other direction. So the field is in the food's own unit, labelled with it, and the reading beside it honours the preference.

### The Coach: a measured **zero**

The finding, recorded because it is the answer rather than an omission: **no Coach tool carries a food portion at all.** `log_meal` writes a free-form meal (name, time, optional macro totals) and `meals` has no amount column for a unit to qualify; `log_recipe`'s `grams` is a cooked *dish* weight against `total_weight_g`, still exactly grams; `save_recipe`'s ingredient `unit` is free text read off the written line, normalisation-only. A `unit` property on any of them would describe a number that does not exist.

So the schema-token delta is **0 / 0** — 9,223 tool tokens and 3,668 prompt tokens, unchanged, with 27 and 32 of headroom. Neither ceiling was raised and nothing had to be trimmed to pay for it (`db/coach-eval.test.mjs` §6 carries the accounting). What *had* to hold is that a millilitre meal is neither invisible nor distorted to a Coach reading the day, and it holds for free because kcal is the common currency: `db/coach-tools.test.mjs` §37 walks a 250 ml drink and a 50 g bowl through `get_today_snapshot` and `get_nutrition_summary` and asserts they sum.

### Backfill, and barcoded drinks

Both new columns are `NOT NULL DEFAULT 'g'`, which backfills every existing row as the column is added — **not a guess about history**: until `0047` there was no other unit to have logged in. No `UPDATE` statement is needed or wanted. The CHECK is single-column and the default satisfies it, so `ADD COLUMN` cannot fail on a populated table — the trap `0034`'s header records (SQLite validates a *cross*-column CHECK against existing rows, so such a constraint passes on a fresh fixture and rejects the whole ALTER on the owner's phone).

A scanned product's basis is **read off the product, not guessed from its name**: Open Food Facts publishes `nutrition_data_per` as `"100g"` or `"100ml"`, and that field is authoritative for the very numbers being cached, so it is consulted first; where it is absent, the `serving_size` string is the fallback (`"330 ml"` is a volume, `"30 g"` is a mass). Both checks look only for a literal `ml` — a `cl` or `l` product falls back to grams rather than being converted, because the user can fix the basis in one tap on the edit screen and that is cheaper than a units table nobody audits.

### Verification

- `db/migrate.test.mjs` §8 — a **populated** database staged at 0046, migrated forward: the renames carry their values, both columns backfill to `g`, the rewritten pair-or-none CHECK still rejects a half-pair, `oz` is refused and `ml` is accepted.
- `db/foods.test.mjs` §14–15 — a per-100-ml food prices 250 ml to 105 kcal with `unit: 'ml'`; the serving stepper works in ml; a gram food is unchanged; a ml item and a g item sum into one day; the unit survives the catalog food being deleted; `fmtAmount` / `portionLabel` suffixes, the oz preference over ml, and grams untouched by it.
- `db/nutrition-v2.test.mjs` §22–22c — the prompt asks for the unit and forbids the conversion; a drink parses as 240 ml beside a 60 g solid; the `grams` and unknown-unit coercions; grounding across the same-name g/ml pair in both directions; the revision request printed in each item's own unit.
- `db/coach-tools.test.mjs` §37 — the Coach round-trip above, plus assertions that `log_meal` still carries no portion and `log_recipe`'s grams is still a dish weight.
- `db/screens-render.test.mjs` §7b — the scanner's recents row rendered twice over a real ml item: `8.5 oz` under the default preference, `250 ml` after flipping it.

### What only a device can judge

- **Whether the model actually reaches for `ml`.** The prompt asks for it and the parser keeps it, but the estimator is tested against the mock harness here — no real call is made on this branch. The first photograph of a coffee is the test: does it come back `240 ml`, or `240 g` with the word "cup" in the name?
- **Whether `Solid · g / Drink · ml` reads as the food's identity** rather than as a formatting choice, sitting where it does in Create a food.
- **Whether the entry-field decision is right in the hand** for an oz-preferring user: the row says `8.5 oz` and the field says `250 ml`. That is defensible on paper (and it is what keeps Save from nudging a portion nobody edited), but it is two units in one glance, and only the phone can say whether that reads as precise or as a mistake.
- **The amount field's width at `ml` values.** A three-digit gram portion and a four-digit millilitre one (`1000`) share a `w-16` box on `app/food-search.tsx` and `app/barcode-scan.tsx`, and a `w-14` one on the two review screens.


## 12f. The readiness verdict, reworked — direction, and a pace curve (C7, 2026-09-14)

The Home screen's Nutrition pillar is the one place in the app that *judges* a day's eating, and the owner's verdict on it was blunt: *"It provides almost no value right now; it only triggers late in the day and doesn't take in account my full goal (currently, exceeding my calorie goal is a good thing)."* (`docs/backlog-2026-09.md`, C7.) Both halves were true of the code. The design round, the three models weighed and the alternatives rejected are in **`docs/spikes/nutrition-verdict.md`**; **Model A** was approved and is what shipped. The pillar itself lives on Home — `src/lib/home/readiness.ts` — and its readiness-side write-up is in `docs/home-screen.md`. **No migration.**

**What this changes on the Eat tab: nothing.** The verdict reads `nutrition_targets` and `meals` and writes neither. The one new control is on the targets screen.

### The goal direction is set where the numbers are set

`app/nutrition-targets.tsx` gains a three-chip row **above** the kcal field — Cutting · Maintaining · Gaining — with a line under it saying what the choice changes. It is stored at `users.preferences.goals.direction` (`getGoalDirection` / `setGoalDirection`, `src/lib/db/repositories/user.ts`), beside the hydration goal and in the same shape, so there is no migration and no new table.

It sits here rather than in Settings because it **qualifies the numbers**: 2,400 kcal means a different day depending on which way you are going. It is written **on tap**, not on Save, and the section label says so (`Saved on tap`) — the direction is a live preference, the targets below it are an immutable version. Those are two different kinds of fact on one screen, and the labels are what keep them apart.

The trade that comes with a live preference is the same one `getWaterTarget` already documents: changing it re-judges past days against today's direction. Taken deliberately — a direction changes far less often than the numbers it qualifies, and when it does change the user is usually also changing the numbers, which writes a new target version anyway. The versioned alternative (a `goal_direction` column on `nutrition_targets`) is better modelling and is recorded in the spike as the thing to do if history ever matters.

### Targets are still never invented

Unchanged and load-bearing: `nutrition_targets` seeds no default row, so a profile that has never opened this screen gets `unknown` and the sentence `no daily targets set yet (Eat › Targets)`. The pillar has no stock 2,000-kcal denominator and must not grow one — the same refusal `src/lib/nutrition/remaining.ts` makes for the tab's own hero.

### Verification

`db/readiness.test.mjs` §10 (the band table in all three directions, the pace curve and its anchors, the projection, the protein rule, the note wording at three times of day, no-targets, the empty day, the D4 seam) and `db/user.test.mjs` §12 (the direction's default, its round-trip, and that it and the hydration goal do not clobber each other inside the shared `goals` section).

**Device-only:** the chip row itself — three 44pt chips across a phone's width with the longest label (`Maintaining`), and whether the selected chip's `border-ink bg-paper-hi` reads as chosen against the outlined pair beside it.

## 12g. Past days' food logs — a day picker and a day view (C1, 2026-09-14)

Owner: *"see past days food logs."* (backlog `docs/backlog-2026-09.md`, C1.) The Eat tab is today-only by design and must stay that way; `app/nutrition-history.tsx` showed **series** — a sparkline and a per-day ledger of totals — which answers *how has my protein been* and not *what did I eat on Tuesday*. Once a day rolled over, its meals were reachable from nowhere.

**No migration** (head stays `0045`) and no new route. Every repository read in the nutrition family has taken a `date` since the day view shipped, so browsing the past costs the same four indexed queries today costs; what was missing was a way to say which day.

### The shared day picker — `src/components/ui/day-picker.tsx`

Built here, but built shared: Today's Mission is the next screen that will want one, and a second copy is how two pickers come to disagree about what "today" means. Nothing in it knows what is being paged.

```ts
<DayPicker
  date={day}                                   // YYYY-MM-DD, the day in view
  bounds={{ latest: today, earliest: recordStart }}
  onChange={(next) => …}                       // always inside bounds
  subject="food log"                           // "Previous food log" (screen reader)
/>
```

`‹  Tue 9 Sep  ›` — two 44pt outlined arrows flanking a centred mono chin (a date is a measured value), with **Back to today** under the row and only while the cursor is behind today. It is not *in* the row on purpose: beside the forward arrow it either shifts the chin off centre when it appears or reserves an empty slot when it does not. It retires the moment it is satisfied, which is the rule the Eat tab's *Set daily targets* already follows. **No accent anywhere** — moving the day in view is navigation, not the screen's next action.

The arithmetic is `src/lib/utils/day-cursor.ts` (`canStepBack` · `canStepForward` · `stepDay` · `dayLabel` · `dayPhrase` · `weekdayName`), which does all of *its* arithmetic through `src/lib/db/date.ts` — `shiftISODate`, plus a new `weekdayIndex` that `localWeekRange` now reads too, so there is one expression to get wrong rather than two. Nothing outside `date.ts` computes a day, which is what `db/day-boundary.test.mjs` §5's source scan enforces.

**The forward bound is the LOGICAL today, not the calendar's.** Under the owner's 04:00 boundary (B3), 01:00 on Wednesday is still Tuesday everywhere else in the app; a picker bounded by the calendar would offer a day the rest of ARC says has not started, and let a meal be logged into it. Both halves are built: the arrow is disabled at the bound **and** `stepDay` clamps, because a live-looking arrow that does nothing is one failure and a caller that can step past from another path is the other. A day that is already out of bounds — a stale `?date=`, a screen left open across midnight — is pulled back inside rather than kept there.

The back bound is the caller's floor. The history passes `firstMealDate(db)` (new, `min(date)` on an indexed text column), so the arrow stops at the first meal ever logged instead of stepping for ever through days that never existed. Same reasoning as `app/water.tsx` clipping its by-day list to `waterRecordStart`.

### The day view — `app/nutrition-history.tsx`

Route unchanged: `/nutrition-history`, now with an optional **`?date=YYYY-MM-DD`** param so a future caller (a Coach answer, a mission row) can open straight onto a day. No new route file — a day is a parameter of the history, not a screen of its own, and `.expo/` is gitignored so a new route would typecheck vacuously.

The screen now reads: picker → **the day** (a grid: the kcal reading, the three macro cells, the day's own target ledger in the corner) → **Meals** (a ruled plate, each row opening the existing `/meal-detail`) → **Over time** (the window chips, the averages and the by-day ledger, unchanged). The by-day rows are now selectable and move the picker, exactly as `app/water.tsx`'s by-day list selects the day its editor works on — which is how a day three weeks back is reached without tapping the arrow twenty-one times.

`readNutritionDay(date)` (in `src/hooks/use-nutrition.ts`) is the read: meals, item counts, the day's targets, the partial-meal map, and the record's start.

**Three rules, each of which is a way this could have quietly lied.**

1. **A closed day never counts down.** New `recordFigure` in `src/lib/nutrition/remaining.ts`. A remainder is a forward-looking claim — *there is this much of the target still to eat* — and last Tuesday cannot be eaten into. Worse, an **empty** day passes `metricIsComplete` *vacuously* (no meals, so no meal is missing a value), so the guard that protects the Eat tab waves it straight through and the screen would have printed **"2,400 kcal left" over a day that is over**. A past day therefore reads as eaten-against-target: the denominator survives, the countdown does not. Today keeps the countdown.
2. **The day is judged by its own targets.** `activeNutritionTargets(db, date)` resolves the versioned target set (0015) that governed *that* day. Applying today's targets to a closed day silently re-judges it — the same mistake the day boundary refuses to make when it re-attributes no existing rows.
3. **An empty day is authored, and it is not a zero.** `meals.length === 0`, never `kcal === 0`, selects it, and the sentence is composed through `dayPhrase`: *"Nothing logged yesterday."* · *"Nothing logged on Tuesday."* inside the week · *"Nothing logged on Tue 1 Sep."* past it, where a bare weekday stops identifying exactly one day. No grid of zeros is drawn at all — a grid of zeros claims the day was measured and empty.

### Verification

- `db/day-boundary.test.mjs` **§8** — the bounds (both halves), the clamp on an already-out-of-bounds day, month ends and leap days, the labels and the sentence forms, and **the 04:00 case asserted against the wrong answer as well as the right one**: `todayISODate(01:00 Tue, '04:00')` is Monday, the picker refuses to step to Tuesday, and the calendar day is pinned as what it must *not* be.
- `db/nutrition-remaining.test.mjs` **§12** — `recordFigure`, including the empty-day trap stated as a control ("an empty day earns a remainder — correct for TODAY, and the trap for yesterday").
- `db/screens-render.test.mjs` **§18** — a past day renders its own meals and `1,180 of 2,000 kcal` (its era's targets, deliberately different from today's 2,400) while **refuting** `kcal left` / `Protein left`; an empty day renders its authored sentence; today hides *Back to today*; a future `?date=` clamps to today.

### What only a device can judge

1. **Whether the chin jitters between labels.** "Today" and "Tue 9 Sep" are different widths; the chin is centred in a flex-1 slot, so it should not move the arrows, but only hardware settles whether the text itself reads as steady while paging.
2. **Whether two 44pt arrows and a 46pt return chip are the right amount of chrome** above a screen that already carries window chips. On the simulator it reads fine; the owner's thumb is the test.
3. **Whether the by-day row's selected state is visible enough** — it is carried by ink weight on the date alone (`text-ink` vs `text-ink-muted`), deliberately, since the row already has a bar and a tally in it.

---

## 12h. Nutrition readability — the bars, and the macros on every meal row (C6, 2026-09-14, no migration)

The owner, on the September list: *"Macro stats more visible (bars / colours against targets) **and** more macro information per individual meal on the overview."* The approved proposal is `docs/spikes/nutrition-readability.md`; this section records what was built from it and the three answers that were taken.

**No migration, no model call, no prompt.** Every number drawn here was already stored, already summed and already on the screen's props. The estimator's token budgets are untouched by this half.

### What was wrong

`TargetRule` (the 3px rule under the kcal hero) was drawn **only when `kcal.mode === 'eaten'`** — and `eaten` is the *fallback* mode, the one a metric drops to when some meal could not be counted. On the ordinary, well-logged day the tab is in `remaining` mode, so **there was no bar anywhere on the screen**. The three macro cells had no bar in either mode. The feature existed and was unreachable on a good day.

On the ledger below it, `const detail = meal.notes ?? [macros, itemCount].join(' · ')` meant a meal with a note showed **no macros at all** — and an AI-estimated meal always carries the model's note (`app/meal-estimate.tsx` writes it onto the meal), so the meals most worth inspecting were exactly the ones whose numbers were hidden.

### What is built

- **`src/lib/nutrition/bar.ts`** — `barFigure(eaten, target) → { fillPct, met }`, pure, beside `dayFigure`. The fill caps at 100% and `met` is what turns the fill pine *and* draws the terminator.
- **`MacroBar`** (`app/nutrition.tsx`) replaces `TargetRule`: 4px, drawn under the kcal hero **and** under each of the three macro cells, in **both** modes, whenever a target governs that metric. A metric with no target still draws no bar — no denominators until targets exist.
- **`macroCells`** (`src/lib/nutrition/format.ts`) — the same three macros `macroLine` joins, kept apart so a meal row can lay them out as **fixed 11px mono columns** down the day. Note and macros are both drawn now, on their own lines.

The objection the old rule was built on — a countdown number over a filling bar is *"two opposite encodings of one quantity"* — is answered rather than overruled. They are two halves of one sentence: the bar draws `eaten`, the number states `left`, the denominator names `target`, and `eaten + left = target` reconciles on the cell. That is the ledger rule stated positively (`00-design-spec.md` §5). The reading that *would* have been two encodings is the one VoiceOver would have given, so the bar takes `accessibilityElementsHidden` and the cell keeps speaking the fact in words.

### The colour, and why the terminator is load-bearing

Progress against a target is **behaviour**, so it takes the accent. The firewall runs both ways (`00-design-spec.md` §2): a `bio-caution` carbs bar would breach it, and it would also be the "red numbers over target" this spec already rejected (§8) — actively wrong for a gaining goal, where over target is a good day.

| part | token | on the rail (`paper-deep` `#C6C1B0`) |
| --- | --- | --- |
| fill, under target | `ink-secondary` `#443F30` | **5.83:1** ✓ |
| fill, at/over target | `pine` `#12454E` | **5.87:1** ✓ |
| terminator, at/over only | `ink` `#1C1911` | **9.74:1** ✓ (and **1.66:1** against the pine beside it) |
| the rail on the sheet | `paper-deep` on `paper` | 1.42:1 — a ground, not a mark |

And the measurement the design rests on: **`pine` against `ink-secondary` is 1.01:1** — the same luminance. A fill that only changes *hue* at target changes nothing anyone can see; it is the identical defect the pillar cells were rewritten to fix (`readiness-strip.tsx`, four swatches at 1.06–1.59:1). So completion carries three cues — **geometry** (a filled 2pt `ink` terminator at the rail's right end), **hue** (pine, which is what pine means everywhere else), and **words** (`PROTEIN LEFT` → `PROTEIN OVER`, and the hero's `kcal over`). Every mark that carries meaning clears WCAG 1.4.11's 3:1; the numbers are asserted, not merely documented, in `db/nutrition-remaining.test.mjs` §13.

**This settles §2's contradiction in favour of the spec.** §2 has said "the fill turns pine" since round 1; the code shipped `bg-ink`. Pine wins, and the `ink` step is kept as the terminator — which is why the shipped code was not simply wrong: `ink` on `ink-secondary` is a real if small 1.66:1 step, more than pine alone gives. The terminator keeps that step *and* gets the meaning.

**Accent budget: still one.** A met bar's pine fill is a *state mark* — the class the budget admits by name (completion stamps) — not a fourth claim to being the next action. Nothing is pine until a target is met, so a normal morning carries none.

### The three answers taken

1. **Over target, the bar stops at the mark** and the number keeps counting. Adherence-neutral, and how far past is "too far" depends on goal direction, which is C7's question. *(Overruled by FB3, below: the excess is now drawn past the mark in its own run, and the rail still means the target.)*
2. **All four readings get a bar** — the kcal hero and the three macro cells. Calories are the reading you look at first; leaving it the only bare number would be odd.
3. **Macros replace the item count on a meal row.** They do not both fit on a narrow phone, and the count told you how the meal was *entered*, not what was in it. It still appears on the meal's own screen, under Items. `useNutrition` no longer computes `itemCounts`; `mealItemCounts` remains in the repository (and in `db/foods.test.mjs`) with no caller on this tab.

Size is **11px**, not the 9.5–10px metadata band: a macro the owner has just asked to see *more* of is the row's second measurement, not metadata. It keeps the tab's existing 11px floor and still drops one step below the 12px line it replaces, which is what buys the column widths. The first two cells are fixed at 52pt so the macros form columns; the third takes what is left, so a narrow phone truncates instead of overflowing into the kcal figure. Absence stays absent — a meal that recorded only protein draws `P 31g` and an empty carbs cell, never a `0`.

**No bar on a meal row**, deliberately: four gauges a row, twenty rows deep, is the data dump CLAUDE.md §5 exists to prevent. The boundary, written down: **per-meal gets numbers, the day gets bars.** Nothing on these rows prints a portion, so the `ml` unit (§12e) does not reach them — macro grams are macro grams whatever the portion was measured in.

### Verification

- `db/nutrition-remaining.test.mjs` §12 — `barFigure`: the empty day, the fraction, the cap at 100% with `met` still true, one gram short, and the non-positive/non-finite backstop drawing an *empty* bar rather than a full one.
- `db/nutrition-remaining.test.mjs` §13 — the contrast table above, computed from `palette` and asserted to 0.005, including the 1.01:1 that makes the terminator load-bearing.
- `db/screens-render.test.mjs` §4, §5, §5b — four bars in `remaining` mode (the regression that shipped as zero) and four in `eaten`; at target, exactly one bar at 100% carrying the terminator; a meal with **both** a note and macros rendering both; and the absence of the joined `P 42g · C 68g` string and of the item count.

### What only a device can judge

- **How much pine four bars plus two accent buttons puts on one screen.** It is the most this tab has ever carried, and it is rare by construction (nothing is pine until a target is met), but the balance is a hardware question.
- **Whether a 4px bar reads as a rule or as a gauge** at @3x, and whether the 2pt terminator reads as a closing mark or as a nick in the fill.
- **Whether three 11px mono cells scan as columns** down a twenty-row day, or as clutter under each meal name.

### OVERRULED on the device — the bars are graded, and colourful (FB2, 2026-09-21, no migration)

The owner, from the phone, on the build that shipped the above: *"colors for nutrition bars are hard to see, should be more colourful."* Both halves of C6's restraint lose — the 4px geometry and the single-accent colour. What replaces them is **not** paint: the bars are filled with the **signal palette, keyed to the grade the day already carries**, so "more colourful" reads as *where you stand*.

**The design record for the firewall departure is `docs/project-status.md` §3**, beside the rule it excepts. In one line: *a macro bar graded against a target is a verdict about the day, which is the same class of thing the Home pillar shows.*

**Where the grade comes from — `macroGrade` (`src/lib/nutrition/bar.ts`), which invents no band.** Every level is produced by the functions `nutritionVerdict` is itself built from (`src/lib/home/readiness.ts`), so a bar is a *component* of the Home pillar rather than a second opinion about it:

| bar | graded by | why that one |
| --- | --- | --- |
| kcal hero | `kcalLevel(ratio, direction)` | the pillar's calorie half, argument for argument |
| protein | `proteinLevel(ratio)` | **one-sided.** Over target is not a fault in any direction — the calorie bands would paint 200 g on a 180 g target amber, the exact opposite of what the pillar says about that number |
| carbs · fat | `kcalLevel(ratio, direction)` | budget components, two-sided like the budget, and the direction applies as it does to calories: cutting, under is the point and over is the fault |

C7's lift is *not* re-drawn here. The kcal and protein bars are the two readings the pillar combines; the combination (`lift` / `worse`) is what Home states in a word. That is why the colours cannot contradict it.

**The ratio is projected; the fill is literal.** Colour grades on `paceRatio` — eaten plus the share still expected today — while the fill inks `eaten ÷ target` flat. It has to: at 10:00 a perfectly-paced day has eaten 15% of its calories, so a colour graded on the raw fraction would read `poor` every morning of every good day. Length answers *how much have I eaten*, colour answers *where is this day going to land*. At the close the two collapse onto the same number.

**`unknown` in exactly the four states the pillar withholds** — timezone-changed day, no target on that metric, nothing logged, and before the pace clock starts (10:00). Cases 3 and 4 still draw the bar at its real length: show the quantity, withhold the judgment, which is the timezone ADR's own rule. A day with no targets keeps four neutral rails rather than losing its bars, so the grid does not change height when a target is first typed in.

#### The cut, and the measurements that chose it

The palette specifies the **swatch** for fills and the **ink cut** for text. On this rail the swatch fails, so the fill takes the ink cut — measured against `paper-deep` `#C6C1B0`, 2026-09-21:

| state | swatch | on the rail | **ink cut (FB2 — superseded by FB3's `bar` cut, below)** | on the rail |
| --- | --- | --- | --- | --- |
| optimal | `#2E8B57` | 2.36:1 ✗ | `#185A36` | **4.56:1** ✓ |
| good | `#2C6C95` | 3.16:1 ✓ | `#24567A` | **4.34:1** ✓ |
| caution | `#A97B22` | 2.10:1 ✗ | `#6E4F15` | **4.17:1** ✓ |
| poor | `#AA402C` | 3.35:1 ✓ | `#8F3524` | **4.31:1** ✓ |
| unknown | — | — | `#5C5340` | **4.21:1** ✓ |
| terminator, on the bare rail | | | `ink` `#1C1911` | **9.74:1** ✓ |
| terminator, on a graded fill | | | `ink` on the four cuts | **2.13–2.33:1** — accepted, see below |
| the rail on the sheet | | | `paper-deep` on `paper` | 1.42:1 — a ground, not a mark |

Two of four swatches are under WCAG 1.4.11's 3:1 on this stock, and a palette where half the states are invisible is C6's defect in new hues. This is the case §3's own guidance names: *reaching for the swatch to colour a value is the most likely way to fail contrast in this system.*

**Geometry: 4px → 6px rail, 2px → 3px terminator.** 18 device pixels tall at @3x, and a terminator of 18×9 — 2.25× C6's nick. The terminator measures 2.13–2.33:1 against the graded fills, under the floor and **accepted**, because it is not what carries the state: `met` is carried by the fill reaching the rail's end and by the label's own word (`PROTEIN LEFT` → `PROTEIN OVER`), while the terminator's real job — marking *where the target is* — happens on the bare rail at 9.74:1. It is better than what shipped besides: C6's terminator sat on `ink-secondary` at 1.66:1.

**What colour does not carry.** The four ink cuts span 4.17–4.56 against one ground, i.e. they are near-isoluminant — to anyone not perceiving hue they are one dark mark, the `readiness-strip.tsx` finding again. Colour here is **reinforcement, never the sole cue**, and nothing was removed to make room for it: the mono figures and their denominators are untouched, the label still flips to OVER, the fill length is still literal, and Home still states the pillar's level in a word.

**Accent budget: the bars now spend none.** Pine leaves this component entirely, which gives the budget back the headroom C6 spent. *(Until FB3, below: the fills still spend none, and the run past the mark on an over-target day is the one pine the bars carry.)*

#### Verification (FB2)

- `db/nutrition-remaining.test.mjs` §12b — `macroGrade` equals `kcalLevel`/`proteinLevel` on the pillar's own ratio (asserted by *identity*, so retuning `KCAL_BANDS` moves the bars with no edit there); protein over target is `optimal` where the calorie bands say `caution`; +20% carbs reads optimal gaining / good maintaining / caution cutting; all five refusals return `unknown`, with a control case proving they are not vacuous; and the 10:00 case — 15% inked, graded `optimal`, not `poor`.
- `db/nutrition-remaining.test.mjs` §13 — the table above to 0.005, **plus** the assertion that chose the cut (the swatch fails on this rail), that every graded fill clears 3:1, that the four cuts are near-isoluminant, and the terminator's 2.13–2.33:1.
- `db/screens-render.test.mjs` §4, §5b, §5c — a fixture in **each band** drawn by a real day (poor/poor/poor/caution at 21:30; caution/optimal/caution/good once the shake lands), the same day ungraded before 10:00, a day with **no targets** drawing four empty neutral rails and no denominators, and the grade → class table asserted from the imported `MACRO_BAR_FILL`. The class cannot be read out of the markup — NativeWind's transform does not run in a server render — so the bar carries its level in a `testID` and the table is asserted beside it; the two together are what "the graded class rendered" means here. Clock frozen by `atClock`, since the grade depends on the hour.

#### What only a device can settle (FB2)

- **Whether four signal-coloured bars answer the complaint** — the whole change is a response to a judgment made at arm's length, and only the same arm can say it worked.
- **Whether a 6px bar is now a gauge.** C6 argued 6–8px crosses from rule into gauge on a sheet whose layering is borders and the paper triad. The owner overruled the 4px; whether 6px is the landing point or a step toward 8px is a hardware question.
- **Whether four hues on one grid reads as information or as a dashboard** — CLAUDE.md §5's line. The bars are the same four colours the Home pillars wear, which is the argument for; four of them in one 3-cell row is the argument against.
- **Whether the terminator still reads at 2.13–2.33:1** against a coloured fill, or whether `met` now rests entirely on the fill's length and the label's word.

### FB3 — more pop, and over drawn past the mark (2026-09-21, no migration)

The owner's note on the device checklist, on the FB2 build, verbatim: *"size of the bars is ok as i stated in a prompt prior, but the colors should pop a little more, the blue could also go over the bar again for overflow"*. Three answers: the height and the terminator stay (6px / 3px); the fill moves to a new **`bar` cut**; and a day past its target draws the excess **past the mark**, in the accent. **Presentation only** — `macroGrade` and its identity with `kcalLevel` / `proteinLevel` are untouched, and so is every grade §12b asserts.

#### The `bar` cut — the most colour each hue has at 4.5:1

FB2's fills were the ink cuts, and the ink cuts are TEXT cuts — darkened for reading, not for colour. On the rail they measured 4.17–4.56:1, three of four under 4.5: legible, near-isoluminant, and drab at arm's length. Each state gets **one** new step, `signal-*-bar` (`tailwind.config.js`, mirrored as `palette.signalBar` in `src/constants/theme.ts`): at the state's own hue — held to within 0.9° of the swatch in OKLCh — the most chromatic sRGB colour that still clears **4.5:1 on the rail**. Derived, not picked; the derivation is written beside the tokens.

| state | swatch, on the rail | FB2 ink cut, on the rail | **`bar` cut (shipped)** | on the rail | on the paper | chroma vs the ink cut |
| --- | --- | --- | --- | --- | --- | --- |
| optimal | `#2E8B57` 2.36 ✗ | `#185A36` 4.56 | `#005B30` | **4.59:1** ✓ | 6.50:1 | +17% |
| good | `#2C6C95` 3.16 | `#24567A` 4.34 | `#00537E` | **4.59:1** ✓ | 6.50:1 | +23% |
| caution | `#A97B22` 2.10 ✗ | `#6E4F15` 4.17 | `#694900` | **4.56:1** ✓ | 6.46:1 | +7% |
| poor | `#AA402C` 3.35 | `#8F3524` 4.31 | `#9D1700` | **4.56:1** ✓ | 6.46:1 | +35% |
| unknown | — | `#5C5340` 4.21 | unchanged: the metadata ink | 4.21:1 | 5.97:1 | — |

"On the paper" is `paper` `#E7E4DA`: the grid device draws no ground, so the sheet is what the room past the mark — and the gutter — sit on.

- **It is the ceiling, not a step toward one.** More chroma at these hues means a lighter colour, and lighter falls under the floor. §13 walks each swatch's hue, finds the most chroma any in-gamut colour reaches at 4.5:1 on the rail, and asserts every cut is within 2% of it (100 / 100 / 99 / 102% — a cut can sit a hair above, since its hue is within a degree of the swatch's rather than on it). Caution gains least: at 4.5:1 on a light warm stock a yellow IS a brown. **Anything more colourful than this needs a different rail, not a different cut.**
- **Neighbours separate.** In OKLab, where one just-noticeable difference is ~0.02, the nearest pair of fills moves from ΔEok **0.091** (caution–poor, the ink cuts) to **0.118** (optimal–caution) — past five JNDs — and all six pairs move apart.
- **Still near-isoluminant** (4.56–4.59). The four sit AT the floor because that is where the chroma is, so colour stays reinforcement, never the sole cue: the label word, the mono figures and the fill's length carry the state without it.
- **`unknown` is not raised.** A withheld verdict stays quieter than every stated one.
- **The terminator on a fill:** 2.12–2.14:1 (FB2: 2.13–2.33) — accepted for FB2's reason; its job is done on the bare rail, at 9.74:1.

#### Over target — the run past the mark

C6 stopped the bar at the mark and FB2 kept that, so a 2,900 on 2,400 day drew exactly what a 2,400 day drew: a full rail. C6's objection to running the *fill* past the mark still stands — rescale the rail and a day exactly on target reads short of full — so the rail is **not** rescaled. The bar keeps room beside it instead:

```
[ fill ··········· rail ··········|▌]   gutter   [ run ·······+ ]
  flex 1 — the target, and only it       2 px     flex OVERFLOW_CAP (0.5) — the room past it
```

- **The rail is the target.** The fill caps at 100% of it, and a met bar reaches the terminator. A day exactly on target is a full rail and nothing past it.
- **The room is half the rail** — the flex ratio *is* `OVERFLOW_CAP` (`src/lib/nutrition/bar.ts`), the constant `barFigure` caps the run at, so the room and the cap cannot disagree. `barFigure` returns two new numbers beside `fillPct` / `met`: `overPct`, the run as a share of the rail's length (0–50), and `capped`.
- **The cap is 150% of the rail's length.** At exactly 150% the run fills the room; past it the run stops and a `+` is knocked out of its end — two 1pt views in `pine-on`, 9.52:1 on pine. Inside the run rather than after it, so a capped run is never *shorter* than one at exactly 150%. The mono figure above says by how much.
- **A 2px gutter of bare sheet** sits between the rail's end and the run, on every day. The run is 1.66:1 against the terminator it follows and 1.28–1.29:1 against every fill, and pine is closest in colour to the `good` cut (ΔEok 0.084 — closer than any two fills come), so butted together they would read as one longer bar. On the sheet both edges are crisp: paper against pine 8.31:1, against the fills 6.46–6.50:1.
- **The run is the accent — "the blue" he asked for.** The fill wears the verdict's palette and the run is behaviour beyond the plan, so the two meanings sit in their two palettes and never share a colour. That is also why the run says *how far* and never *whether*: protein at +67% is an `optimal` fill with a capped pine run; kcal at +21% while maintaining is a `caution` fill with a pine run a fifth of the rail long.

**Accent budget.** The fills spend none (FB2). The run is the only pine the bars add and the only new pine on the tab — Photo and Describe remain its only pine *action*. It is a state mark, the class C6's met-bar pine fill was, and it is absent on every day that stays inside its targets. **At most** — all four bars past 150% on a 393pt phone — the four runs total about **215pt of 6pt ink, ≈ 1,300pt², roughly 7%** of the ~17,900pt² the two capture buttons already spend (the hero's room is ≈ 117pt, each macro cell's ≈ 32–35pt). A plausible heavy day (+21% kcal, +11% protein, +25% carbs, +29% fat) draws about 90pt of it.

**The cost, stated.** The rail is two-thirds of the bar's width on every day, over or not, so a day that is never over draws a shorter rail than FB2 did — the price of drawing over without rescaling. Height is untouched, as asked.

#### Verification (FB3)

- `db/nutrition-remaining.test.mjs` §12 — six run cases: under and on target draw none; 3 g on 180 g is a 1.67% sliver; 2,900 on 2,400 is 20.83%; exactly 150% fills the room without the `+`; past 150% stops at the cap with it. Plus: the fill is the full rail on every over day, and the no-frame guard draws no run.
- `db/nutrition-remaining.test.mjs` §13 — re-derived for the new cuts and **strengthened, not relaxed**: the table above to 0.005 (fills on the rail and on the paper, the run on the sheet, the `+` on the run, the run against the terminator); why FB3 left both older cuts (the swatch under 3:1, the ink cut under 4.5:1 in three of four); **every graded fill ≥ 4.5:1** where FB2 asserted 3:1; `unknown` ≥ 3:1 and below every graded fill; more chroma than the ink cut at every hue, within 1° of the swatch; each cut at its hue's chroma ceiling; the nearest pair of fills ≥ 0.10 ΔEok where the ink cuts' was 0.091, and all six pairs further apart; still near-isoluminant; the terminator at 2.12–2.14 inside FB2's own bounds; the run's separation from the fills; and that `tailwind.config.js` and `palette.signalBar` carry the same four values.
- `db/screens-render.test.mjs` — `readBars` now reads one anchored record per bar (level, fill, terminator, run, `+`) and only matches a room whose flex **is** `OVERFLOW_CAP`, so a drifted room fails every bar count loudly. §5b: the at-target day's protein bar draws its 1.67% sliver and nothing else runs. §5c: the fill table is the `bar` cut, and `MACRO_BAR_OVER` is `bg-pine` in every grade. **§5d, new — the over-target fixture:** 2,900 / 300 / 230 / 70 against 2,400 / 180 / 240 / 70 at 21:30 draws three full rails at their terminators — the in-budget fill capped AT the mark — and carbs short of its own; runs of 20.83% (kcal) and the full room with its `+` (protein), none for carbs (under) and none for fat (exactly on target); grades caution · optimal · optimal · optimal; and the hero, the label and the corner still say `kcal over`, `Protein over`, `2,900 of 2,400 kcal`.

#### What only the phone can settle (FB3)

- **Whether the new cuts pop enough.** They are the ceiling at this floor; if they still read as drab, the next lever is the rail, not the cut.
- **Whether the bare third reads as room or as a bar cut short** on the days nothing is over — which is most days.
- **Whether a 2px gutter reads as a seam or a flicker** at @3x, and whether the knocked-out `+` (5×5pt, 1pt strokes) is legible inside a 6pt run.
- **Whether a sliver reads.** 3 g over 180 g is about 1pt of pine on a macro cell — honest, and possibly invisible.
- **"Go over the bar again" has a second reading**: a second lap in blue drawn ON the bar from the left, which costs no width. This round built the brief's reading — past the mark. If the owner meant the lap, it is a change to `MacroBar` alone; `barFigure`'s `overPct` already carries the length either way.

---

## 12i. AI add food — describe it, and the form fills itself (C2, 2026-09-14, no migration)

The owner, backlog C2: *"Describe a food in words and AI fills the catalog entry's macros — yes."*

Type *"Costco rotisserie chicken thigh, skin on"* into **Describe it**, at the top of `app/food-new.tsx`, and one catalog entry comes back — name, brand, basis, a household serving, per-100 macros, and sodium/caffeine where they are plausible — **rendered into the fields below for review**.

**No migration.** `foods.source` has had `'ai'` in its CHECK since 0014, and `FoodSource` has had it in the type since; C2 is the first writer of it.

### Its own prompt, and why

`FOOD_ENTRY_SYSTEM_PROMPT` (`src/lib/nutrition/estimate.ts`) is a **separate, smaller prompt**, not a branch inside the meal estimator's:

- a MEAL is a list of portions eaten now, priced per portion, carrying per-item confidence; a catalog ENTRY is **one** food priced **per 100 of its basis** and kept for life. The estimator's reply shape has no column in `foods` and vice versa;
- every word one prompt does not need is a word the other pays for on every call — and the meal prompt is the expensive one, because it rides a photograph.

**469 tokens**, measured with the same `length / 3.6` estimator the Coach budgets use, against the meal estimator's 542. Trimmed once before landing (507 → 469) by deleting restatement rather than instruction. It is asserted against a **500-token ceiling** in `db/coach-eval.test.mjs` §6, alongside an assertion that it has not leaked into the Coach's cached prefix — **the two Coach ceilings (9,250 / 3,700) are untouched and must stay untouched by this**, because they guard the payload every chat turn carries, while this one rides a single toolless request with no history and no cache.

Three rules carry the work, stated rather than implied by the schema: **per 100 of the basis, never per serving**; **`ml` only for a drink** (0047 — and nothing converts); and **null rather than a guess**.

### What the parser refuses

`parseFoodEntry` is tolerant in the same places `parseMealEstimate` is and strict in one more:

| reply | result |
| --- | --- |
| ```` ```json ```` fences, stray prose | the outermost object is extracted |
| an unknown `basis` (`"cups"`, absent) | `g` — what every food was before 0047, and visible on the form |
| `kcal_100` over 950, a macro over 100, a negative, a string | **dropped to null, never clamped** |
| `serving_name` without `serving_amount` (or a 0 amount) | both dropped — the column pair is `CHECK`-ed pair-or-none |
| a micro key the vocabulary has never heard of | dropped; a measured `0` survives |
| no usable `name` | **throws** |

Dropping rather than clamping is the honest half: a clamp invents a figure the model never gave and hides that it was wrong, while a blank is this catalog's own word for "not recorded" and is one tap from corrected. The one throw is for the one case review cannot rescue — a nameless row is a blank form with the typing already done wrong.

### Nothing is saved until Save

The reply lands in the same `useState` the keyboard writes to, so every number is editable before it becomes a row — and the row it becomes is stamped **`source: 'ai'`**. `app/food-search.tsx` prints a quiet `est` beside such an entry wherever it appears (label voice, 10px, `ink-muted` — *confidence is typography, not colour*, §2), so an inferred number never wears the face of one the owner typed. That is the 0034 rule, one screen over.

The screen's own note says the same thing in future tense while the estimate is still a proposal: *"Estimated by the model — check the numbers below. Nothing is saved until you tap Save food, and the entry will be marked as an estimate in your catalog."*

**No accent is spent.** Creating a catalog entry is bookkeeping, not the day's directive action, so *Fill from description* wears the same outlined treatment as *Save food* — it fills a form, it does not commit a record.

### Offline is a sentence, never a broken form

Two states, and neither is a spinner that never resolves:

- **no model key** — the field is replaced by a line saying so and what still works (*"everything below works without it"*). The manual form underneath is untouched, because typing the food in by hand is what this screen already was;
- **a call that cannot reach the model** — *"Couldn't reach the model. Check your connection, or fill the fields in below by hand."* Every field keeps exactly what it had.

The call is aborted on unmount, like the estimator's: a live stream left running is billed in full and lands on a screen that is gone.

### Verification

- `db/nutrition-v2.test.mjs` §23 — the prompt states per-100, the `ml` rule and null-over-a-guess; the request is that prompt plus the description with no image block; a fenced reply parses into one entry with its serving; micros keep a measured `0` and drop an invented key; a drink comes back as `ml` and nothing converts; an unknown basis falls back to `g`.
- `db/nutrition-v2.test.mjs` §23b — bounds dropped not clamped, half a serving claim dropped whole, a `0` serving refused, and four unusable replies throwing.
- `db/nutrition-v2.test.mjs` §23c — parsing writes nothing, and the saved row carries `source: 'ai'`.
- `db/screens-render.test.mjs` §7d — the no-key sentence with the whole manual form intact; the field and control with a key set; **no `foods` row written by either render**; and exactly one row in the catalog wearing `est`.
- `db/coach-eval.test.mjs` §6 — 469 tok under a 500 ceiling, and not in the cached prefix.

### What only a device can judge

- **Whether the model's per-100 figures are any good** for the foods the owner actually describes. No real call is made on this branch (the harness is a mock); the first *"Costco rotisserie chicken thigh, skin on"* on hardware is the test, and the failure mode to watch for is a serving priced as a hundred — which shows up as a blank kcal field, because the parser drops it.
- **Whether `est` reads as provenance or as noise** at 10px beside a food's name in a list of twenty.
- **Whether Describe it belongs above the form or below it.** It is above because it is the shortcut *past* everything under it, but that puts a model call first on a screen whose whole job used to be typing.

---

## 12j. Offline food logging (C3, 2026-09-14, migration `0057`)

> **On the number.** Written as `0048` — free then, free on `main` now — and renumbered to `0057` at the moment of commit because `main`’s head had moved 0047 → 0054 and `claude/c12-c13-exercise` holds 0055–0056 unmerged. The runner is forward-only and silently skips anything at or below a device’s `user_version`, so a free-looking number *below the head* is stranded on the phone forever while every test that starts from an empty database still passes. The rule is **the next number above main’s head, re-checked at commit**; the full argument lives in `0057`’s own header, once. C4 was renumbered `0049` → `0058` in the same pass.

Owner, backlog C3: *"Catalog/manual path fully works with no network; AI-dependent estimates **queue until back online**."*

### Half of it was already true, and it is pinned as a source fact

The catalog, template and manual paths never touched the network — `foods.ts`, `nutrition.ts`, `meal-templates.ts`, `servings.ts`, `micros.ts`, the log sheet, Add food, Create a food and Meal templates contain no `fetch` and no import of `openfoodfacts.ts`. That is asserted **over the source** in `db/nutrition-v2.test.mjs` §23, deliberately: a behavioural test passes just as happily on a path that calls the network and swallows the failure, and the swallowed one degrades silently the day someone adds a lookup.

The one nutrition path that *does* use the network already degrades rather than throwing something raw into a screen: `lookupOffProduct` turns a rejecting fetch into an `OffLookupError`, which `app/barcode-scan.tsx` reads as "you're offline" and answers with the manual rung of its resolve ladder. Confirmed in the same section.

### The other half: a request that could not be made is kept

| | |
| --- | --- |
| Schema | `pending_estimates` (`0057`) — one row per meal (`meal_id` UNIQUE, `ON DELETE CASCADE`), `kind` ∈ `photo · text · revise`, the words in `description`, the JPEG as a **base name** in `file_name`, plus `attempts` / `last_error` |
| Files | `pending-estimates/` — **its own directory**, because `meal-photos/` is swept against `meal_photos` rows in both directions on every app open and would delete a queued photo as an orphan on the very launch that needs it |
| Placeholder | a real `meals` row, `source = 'ai_suggested'`, **NULL macros**, named with the user's own typed words (or `Photographed meal`) |
| Drain | `runEstimateQueueDrain` on app open and on every foreground (`app/_layout.tsx`), oldest first, re-entrancy-guarded, never throws |

**NULL, not 0.** A placeholder that read `0 kcal` would be a fabricated measurement and would sum into the day as a fact. NULL is "not recorded" — which the Eat tab already draws as an em-dash, and which already (correctly) drops the day out of countdown mode, because energy that is genuinely unknown cannot be subtracted from a target. The row says **`Estimate pending — offline`** rather than `Nothing recorded — tap to fill it in`, which would be advice the user cannot act on.

### Which failures are worth waiting on

`isQueueableFailure` queues a **transport** failure — the request never reached the API — and nothing else:

| failure | queues? | why |
| --- | --- | --- |
| `expo/fetch` rejecting (`TypeError: Network request failed`) | **yes** | the phone never got out |
| `ModelRequestError` with `status === 0` | **yes** | "no HTTP response" — a stream that died mid-reply is what a dropping connection looks like from inside the client |
| `ModelRequestError` with an HTTP status (400/401/429/5xx) | no | the API **answered**; queueing re-bills the same rejection tomorrow |
| `MealEstimateParseError` | no | the same request produces the same nonsense |
| `MealEstimationUnavailableError` | no | no key, or a binary without `expo/fetch`; waiting adds neither |
| `AbortError` | no | the user left the screen |

`MealEstimateParseError` is new in this round and exists only for that table: the parser's four throws used to be bare `Error`s, indistinguishable from a network failure.

### The drain APPLIES; it does not park a second review

An interactive estimate lands in a review because **nothing has been written yet**. A queued one has already written the placeholder, so holding the result until the user happens to open a review screen would leave that placeholder empty for as long as he does not notice — the exact state this feature exists to end. So the drain grounds the estimate against the catalog (the same `groundMealEstimate`) and writes the items with their per-item `confidence` under `source = 'ai_suggested'` — the labelling the owner already accepts for an estimate. It reads as an estimate everywhere, and `Adjust` and the item editor are one tap away, as they are for a reviewed one. The model's title replaces the provisional name; its caveat becomes the meal's note; a queued photo is moved into `meal-photos/` through the one writer (`attachMealPhoto`), so it inherits the ordinary 7-day retention.

**A queued revision is re-grounded on what is there now.** The queue stores the *correction*, never a snapshot of the items. On drain the meal's current items are read and sent as the "before", so a hand-edit made while offline is what the correction applies to rather than something it silently overwrites with a day-old picture of the meal. A revision still replaces items only — date, time, name and notes are untouched (`replaceMealItems`' own rule).

**Nothing expires.** A row that fails again counts the attempt and records why. The two reasons a drain fails are "still offline" (waiting fixes it) and "no key yet" (Settings fixes it); deleting the user's meal on his behalf fixes neither. The escape hatch is the one he already has — delete the placeholder, and CASCADE takes the request with it.

### Verification

- `db/nutrition-v2.test.mjs` §23–29 — the source scan and a full catalog→meal→day round trip with nothing to connect to; the OFF degrade; the placeholder's NULL macros and the day's `0 kcal / 1 meal` reading; the whole classifier table; **offline → attempt counted → restart → reconnect → items land**, with the placeholder asserted NULL at every step; a queued photo's bytes re-read, sent, and landed in `meal-photos/`; the CASCADE, the orphan sweep, and a photo whose file vanished degrading to its words; a queued revision sent against an item added *after* it was queued.
- `db/screens-render.test.mjs` §5b — the Eat tab rendered over a real placeholder: the user's words as the name, `Estimate pending — offline` on the row, and no number in the row at all.

### What only a device can judge

- **Whether the drain fires soon enough to feel like magic** rather than like a chore. There is no reconnect event without a netinfo dependency, so the trigger is app-open and foreground — which is the moment that matters (a drain nobody is present for helps nobody), but only the phone says whether "it filled itself in while I wasn't looking" reads as trustworthy.
- **Whether the queued screen's two sentences are the right two** at the moment a plane's wifi has just failed.
- **`expo-file-system`'s `File.base64()`** — the one API in this round that has never run on device in this codebase. It is feature-checked (`typeof f.base64 !== 'function'` → null) and its absence degrades a photo request to its typed words, so the failure mode is a worse estimate rather than a lost meal; the first offline photograph is the test.

---

## 12k. Composite foods (C4, 2026-09-14, migration `0058`)

Owner, backlog C4: *"Take a photo of a pepperoni pizza… one composite item (pepperoni pizza) as well as rows below that are pizza crust, cheese, and pepperoni. If I ate the whole pizza but took the pepperoni off half, I could change just one thing. If I ate only half, I could change the entire thing together."* — with the scope fence in the same sentence: **specifically composite foods like pizza, not a general modifier system.** Design: `docs/spikes/composite-foods.md` (**built**).

### The schema: two columns, no new table

`0058` adds `meal_items.parent_item_id` (→ `meal_items`, **`ON DELETE CASCADE`**) and `meal_items.is_composite`, plus one index. A component is a `meal_items` row in every other respect; a second table would duplicate the whole name/amount/unit/macro/micros/confidence set *and* put the parent's numbers somewhere `recomputeMealTotals` does not look.

CASCADE rather than SET NULL because a component has no meaning outside its composite — the rule that prefers SET NULL protects *execution history* from *catalog churn*, and a pizza's cheese is not execution history in its own right.

**Five invariants, repository-maintained and test-pinned:**

| # | | |
| --- | --- | --- |
| 1 | `is_composite = 1` ⟹ `parent_item_id IS NULL` | **One level only.** This is what keeps C4 a composite-foods feature and not the modifier system the owner ruled out — and why no sum needs a recursive CTE and no screen needs a variable indent. |
| 2 | a header's macros, micros, amount and confidence are **NULL** | It is a name over its parts, not a row of numbers. |
| 3 | a component's parent exists, in the same meal, with `is_composite = 1` | A component orphaned into another meal is a corrupt ledger. |
| 4 | a composite always has ≥ 1 component | Removing the last part removes the composite. |
| 5 | a composite's amount sums only when every part has one **and they share a unit** | Never a fabricated total, and **nothing converts** (B2/0047). |

### The roll-up fails safe, deliberately

The header stores NULL **and** every sum additionally filters `is_composite = 0`. Two belts, because the risk is asymmetric: a NULL-macro header means a query that forgets the rule under-counts by **zero** (`sum()` skips NULL), while a sum-carrying header means a forgetful query silently **doubles the pizza** in the day's calories. The storage makes the dangerous mistake impossible; the filter is added anyway so the intent is legible at each call site.

**Three reads, two different filters, and the difference matters:**

| read | filter | the question it answers |
| --- | --- | --- |
| `recomputeMealTotals` | `is_composite = 0` | what carries numbers |
| `partialMealMetrics` | `is_composite = 0` | which items are unpriced — **without it, every meal holding a pizza is marked knowingly short on every metric and the Eat tab's hero stops counting down for a meal that is fully priced.** That regression would have shipped silently; it is asserted as a number. |
| `mealItemCounts` | `parent_item_id IS NULL` | what the collapsed ledger DRAWS — one row per pizza, so a meal with a three-part pizza and a beer reads "2 items" |

The number the reader *sees* on a collapsed composite is derived at read time by `rollUpComponents` (`src/lib/nutrition/composite.ts`) and never stored, so the headline **is** the parts' sum and cannot come to disagree with them.

### Editing: the owner's two sentences, made arithmetic

- **"I took the pepperoni off half"** → the part's own amount, through the existing `updateMealItemPortion` / `rescaleLoggedItem`. **A part edit never moves its siblings and never pushes back onto the parent** — the parent has no numbers to push onto. It changes what the parent *displays*, which is the point.
- **"I only ate half"** → `scaleCompositeItem(db, parentId, factor)`: every part's amount, macros and micros multiplied in one transaction. Proportional is the only honest reading — halving the crust and not the cheese would be a claim about *which* half, which nothing knows. **Nothing is rounded on write**, so ×0.5 then ×2 returns to exactly 300 g. And it scales the parts' **current** values, not a hidden original: the current state is the only state the record has (the owner's own answer), so a hand-correction made first is what gets halved.

### The estimator

The item schema gains `"components": [...]|null`, capped at **4 parts by the parser** rather than by the prompt hoping. When components are present the parent's own macros are **dropped, not reconciled** — one fact gets one number. A single-part array collapses to a plain item (a chevron over nothing is noise). Each part inherits the dish's `confidence`: the model stated one confidence for the pizza, and it is as true of the cheese as of the crust.

**Grounding never prices a header.** The seed catalog holds whole-dish archetypes — `Pizza, cheese slice`, `Cheeseburger, fast food`, `Chicken burrito` — each one leading phrase from what a model actually writes, so a catalog re-price on the header would contradict the parts beneath it. The parts *are* grounded; a single-token name ("cheese", "crust") fails `isConfidentMatch` by design and keeps the model's numbers, which is correct.

The revision path carries it too: `buildMealRevisionRequest` prints a dish with its parts indented beneath it, and `MEAL_REVISION_SYSTEM_PROMPT` gains one rail telling the model to return it as one item with those parts.

### What the screens draw

**The Items block stays one `Block device="plate"`.** A composite is not a nested plate — a block gets exactly one device — so the parts are ruled rows *inside the same plate* at `pl-6`, with no fill, no left rule and no new mark. Collapsed by default.

`app/meal-estimate.tsx` and `app/meal-revise.tsx` now share **one** review table (`src/components/nutrition/estimate-review.tsx`) instead of two copies of the same forty lines. The tree, the disclosure, the proportional scaling and the last-part rule are exactly the kind of logic that must not drift between two screens that promise the same thing — the pipeline already says *"one schema, one parser, one review"*, and this is the review half of it.

**"I ate half" is fraction chips `½ · ⅓ · ¼` plus the whole-dish amount field** (owner's choice). Both are outlined, never accent — in the review phase the accent is `Save meal` and stays there. The amount field is **live and non-compounding**: it scales from a snapshot taken when the field is focused, so typing `3`, `36`, `360` into a 720 g pizza lands on ×0.5 rather than on ×0.5 three times. `app/meal-detail.tsx` gets the same tree over a *logged* composite, with the inline `PortionEditRow` on parts and the chips calling `scaleCompositeItem`.

**Three places flatten a composite, and say so:** a meal template, a recipe captured from a meal, and (for sums) the leaves — the first two because their schemas cannot express a composite, where a header with no numbers would be a lie. Nothing moves when they flatten, because the parts are exactly the rows the meal's totals were summed from. `relogMeal` does **not** flatten: logging a pizza again logs a pizza.

### The estimator prompt has a ceiling now

`ESTIMATOR_PROMPT_CEILING = 1000` (prose tokens, `db/coach-eval.test.mjs` §6's own estimator), asserted in `db/nutrition-v2.test.mjs` §36 against **both** estimator prompts. Until this round the estimator's system prompt was guarded by **nothing**: the two Coach ceilings measure `buildCoachSystemPrompt` and `toWireTools(COACH_TOOLS)`, and the estimator is neither — a different system prompt on a tool-less turn (`tools: []`). It grew 296 → 449 in a day (A8) and 449 → 542 when `ml` landed, unnoticed.

| | prose tok |
| --- | --- |
| `main` at branch point | **542** |
| plus C4 (the composite rule, the `components` clause) | **+149** → 691 |
| plus C5 (the question rules, the `questions` clause) | **+279** → 970 |
| minus three enumerations trimmed in the same round | **−48** → **922** |
| ceiling | **1,000** |

The rule the Coach's budget note states applies verbatim: **the next addition trims rather than raises this**, and the two cheapest trims are named on the constant itself. The test also asserts the prompt is over 60% of the ceiling, so a ceiling nobody approaches cannot pass vacuously.

### Verification

`db/nutrition-v2.test.mjs` §30–36 — the header's NULL columns; the day counting 1,690 and not 11,689; **the countdown-mode guard, asserted through `dayFigure`**; the tally reading 2; the roll-up (510 g / 1,550 kcal) and its refusal to sum across units; an orphaned component emitted top-level; a part edit leaving siblings byte-identical; "ate half" halving the *corrected* pepperoni; the exact ×0.5/×2 round trip; the last-part rule and the FK cascade; the parser's drop/cap/collapse rules; grounding refusing the header against `Cheeseburger, fast food` while pricing the patty; a tree surviving `replaceMealItems`, `relogMeal` and a template flatten; both prompt ceilings. `db/screens-render.test.mjs` §7b2 — `meal-detail` over a real composite: one row, `3 parts`, the derived `1,550` beside the meal's `1,690`, the parts and chips **absent** while collapsed.

### What only a device can judge

- **Whether the model actually returns a `components` array**, and for the right dishes. The rule is a criterion ("parts a person would change separately"), not a dish list, and the estimator is tested here against a mock. The first photographed pizza is the test.
- **Whether a collapsed composite reads as one thing you ate** at 375 pt, with `3 parts` in mono beside a serif name.
- **Whether the chips feel like the sentence.** `½ ⅓ ¼` at 44 pt inside an expanded disclosure is a lot of furniture on a phone; only the hand says whether it is the fast path or clutter.
- **The live scale in the hand** — typing into the whole-dish field and watching three rows halve underneath it is the confirmation, and a server render cannot show whether it reads as responsive or as jumpy.

---

## 12l. Auto-ask clarifying questions (C5, 2026-09-14, no migration)

Owner, backlog C5: fires on anything ambiguous, from **any** logging method; **max 3**; **button-answerable** (an "other / type here" option is allowed but only as a click); only for things that **matter** and that the user would **actually know** — *"we shouldn't ask questions the user likely doesn't know themselves (i.e. cooking methods in a restaurant)."* Archetype: *"how many shots are in this latte?"* Design: `docs/spikes/auto-ask.md` (**built**).

**No migration.** A question is a property of an estimate in flight, not of a logged record; nothing is persisted that `meal_items` cannot already hold.

### One call, and each answer carries its own arithmetic

The estimator's structured output gains `questions`, and each button option carries the **effect** of choosing it, from a closed four-shape vocabulary:

| effect | means |
| --- | --- |
| `{"scale_item": name, "factor": n}` | multiply that item's portion and macros — *"how many shots?"* |
| `{"set_amount": name, "amount": n}` | set the portion outright, **in the item's own unit** |
| `{"add_item": {name, amount, unit, kcal, …}}` | add a whole item — *"was there dressing?"* |
| `{"remove_item": name}` | drop one — *"did you eat the bun?"* |

`set_amount`, not the spike's `set_grams`: `ml` landed (0047) between the design and the build, and a key named for one unit describing a number in another is exactly the lie that migration renamed three columns to avoid. The older spelling is still *read*, the way `grams` is still read as a fallback for `amount`.

Because the effect travels with the estimate, **answering is pure on-device arithmetic** over the review rows (`applyAnswer`, `src/lib/nutrition/review-rows.ts`): no second round trip, instant, and it works with the network gone once the first reply has landed. The alternative — ask first, then estimate — bills the photo twice (`messages` carries no cache breakpoint) and makes the model invent questions about a meal it has not analysed.

**Judgment still lives in the model.** It decides *whether* to ask, *what*, *which answers are plausible*, and *what each implies*. The four effects are a wire format for what it decided, not a decision table — the same relationship the estimate's own JSON already has to the estimate.

### The prompt rules, and why each is shaped that way

- **Materiality as a magnitude** — "~15% of its energy or ~10 g of protein" — not a list of askable topics, which would be wrong the first time he eats something not on it. *(Widened on 2026-09-23 to every figure the reply carries — energy, caffeine or sodium by ~15%, protein by ~10 g — after it ruled out the shots question on a latte. See "Device finding" below.)*
- **Knowability as a place** — *"what the person was there for"* vs *"a kitchen they did not stand in"* — with the owner's restaurant example verbatim.
- **"USUALLY ABSENT" and "an empty list is the norm", twice.** A model handed a `questions` field will fill it; saying zero is normal is the cheapest defence there is, and the existing prompt already uses it for the same class of problem.
- **"the items you return must already assume it."** This is what makes a skipped question safe: the estimate on screen is already the most-likely-answer estimate, so skipping every question leaves a coherent record rather than a half-specified one.

### Three gates, in order

1. **The prompt** — the judgment gate, and the only one that can be smart.
2. **A deterministic confidence gate:** if every item came back `high`, drop all questions. A model certain about every item and still asking has contradicted itself, and a certain estimate is the one case where an extra tap is pure friction.
3. **A hard cap of three**, applied *after* the drops — so three good questions survive a fourth malformed one rather than being crowded out by it.

Plus the parser's ordinary tolerance, extended: an option whose effect names an item not in `items` is dropped (the commonest model error is a renamed item); a question left with fewer than two options is dropped entirely (one button is not a question); an unknown effect key is dropped (the vocabulary is closed on purpose); `factor ≤ 0`, `amount ≤ 0` and `amount > 5000` are dropped, which are the schema's own `CHECK (amount > 0)` and the review screen's own ceiling.

### The UX

A `Block device="plate"` labelled **Questions** (it read *A few things* until 2026-09-23 — see `docs/ai-slop-candidates-2026-09.md` §10: a section label names what is filed under it), **above the item table** — the rows *are* the answer, and on a phone a control below the thing it changes makes the change happen off-screen. The tally is its note: `1 of 2`.

Each question is one ruled row: the ask in serif (it is a sentence, and serif speaks), then outlined option chips in the label voice at ≥ 44 pt. **No accent anywhere in the block** — in the review phase the accent is `Save meal` and stays there; an answered chip fills `bg-ink`, which is a state mark, not a claim to being the next action. **Skip** sits at the row's trailing edge and becomes **Undo** once answered.

**What it says back: nothing, in words.** Tapping a chip re-prices the rows below, and the Items total moves with it because that total is already derived from the live rows. The screen shows the consequence rather than announcing it.

**No accumulation.** The first time a question is answered, the rows as they stand are frozen as that question's base; every later answer is applied to that base. So answering, then changing the answer, produces exactly the state that choosing the second option first would have, and Skip restores the unanswered estimate. The cost, stated because it is real: a hand-edit made *between two answers to the same question* is lost when the answer changes. That is the price of "no accumulation", and it is the right side of the trade — a silently doubled portion is a wrong record; a re-typed gram figure is an annoyance.

**"Other" is the one second call**, and only when the model set `allow_other`. It is reached by a **click** (the owner's constraint), opens a well with a bare input, and fires a `reviseMeal`-shaped, **text-only** turn — the photo is never resent, because `messages` carries no cache breakpoint and a resent image is billed in full every time. The screen says so under the field. The reply's own questions are discarded: asking again in answer to a typed answer is a loop.

**An unanswered question never blocks Save.**

### Which methods ask

| method | asks? |
| --- | --- |
| Describe, Photo (`/meal-estimate`) | **yes** |
| `reviseMeal` (`/meal-revise`) | **yes** — owner decision. A correction can be as ambiguous as a first description, and it is the same one-call shape and the same parser. |
| Barcode (`/barcode-scan`) | **no, and it is a design position** — a barcode is an exact identity against an exact per-100 panel, the portion sheet already asks the one unknown, and the path is offline-first by construction. A path that works with the network unplugged must not grow a question that needs the network. |
| Add food / template / manual | **no** — the user is asserting numbers; asking him to clarify his own assertion is absurd. |

The negatives are pinned **at the source** (`db/nutrition-v2.test.mjs` §40): the scanner and the log sheet must contain no question surface and no call into the estimator, so neither can grow one by accident.

### Verification

`db/nutrition-v2.test.mjs` §37–40 — the owner's latte archetype parsed end to end and its "3 shots" applied on-device (60 ml → 90 ml) with the sibling untouched and the ledger still summing to itself; each of the four effects, including an `add_item` that cannot duplicate itself and an effect naming a row the user already deleted; the no-accumulation property; all three gates; every drop rule; a pre-C5 reply parsing unchanged; both prompts carrying the rules in the owner's own terms; and the two source-level negatives. §36 — the prompt ceiling, at 922 of 1,000.

### What only a device can judge

- **Whether the model asks at all, and asks the right thing.** Every rule here is a criterion, and the estimator is tested against a mock harness — no real call is made on this branch. The first latte is the test: does it come back with "How many shots?", or with three weak questions about a sandwich? **Answered on 2026-09-23: it came back asking about the milk and not the shots.** See "Device finding" below.
- **Whether "Questions" above the table reads as help or as an interrogation** at 375 pt, particularly with three questions and four chips each.
- **Whether watching the rows re-price is enough confirmation**, or whether the change needs saying out loud after all.
- **The "Other" round trip in the hand** — a second or two of `Working…` on a screen the user thought was finished.

### Device finding, 2026-09-23 — it asked about the milk, never the shots

The owner, on the 0061 build (the first on his phone to carry C5): *"asked me what milk was in the latte- this is a good question, but it did not ask about how many shots and therefore doesn't have good caffeination data"*.

**The prompt did what it was told.** The materiality bar read *"~15% of its energy or ~10 g of protein"*, the two figures the spike measured materiality in. One espresso shot is about 2.5 kcal on a ~190 kcal latte (**~1% of its energy**, no protein) and about 63 mg of a two-shot latte's 126 mg (**~50% of its caffeine**). So by the prompt's own rule the shots question was never worth asking. Whole milk against skim moves the same drink's energy by roughly 40%, which is why the milk question cleared the bar easily. The knowability bullet had named *"how many shots"* as its first example since the build, and the materiality bullet one line above ruled that example out. The milk question was a good question under the rules as written. The rules could not see caffeine.

**The fix is to the criterion, not a latte rule.** Nothing says "if coffee, ask shots". Judgment stays in the model. His latte is how the gap was found, not what the rule is about, and `db/nutrition-v2.test.mjs` §53 asserts that neither question block names a drink. Both prompts get three clauses:

| clause | as written in the estimation prompt | what it does |
| --- | --- | --- |
| the bar | *"Ask nothing unless an answer would change a figure, not just a name: the meal's energy, caffeine or sodium by ~15%, or its protein by ~10 g."* | Materiality now counts every figure the reply carries: the two micros ARC tracks, beside energy and protein. It also says outright that making an item's name more exact is not a reason to ask. |
| the ranking | *"At most 3, biggest change first; one good question beats three weak ones."* | When the model holds itself to one question, it keeps the one that moves a figure most. Three slots still hold milk **and** shots. The prompt does not spell that out, because "one good question beats three weak ones" is about weak questions and neither of these is weak. |
| the assumed answer | *"the items you return, micros included, must already assume it."* | Covers the other half, below. |

The revision prompt carries the same three. Its bar has never named protein, and that is unchanged.

### The other half: an answer scales a figure and cannot create one

The question: *when the answer that sets caffeine is unknown, does the estimator return caffeine as a guess, or omit it?*

**The prompts do not settle it.** The estimation prompt gives sodium and caffeine *"for any item that plausibly carries them"* (coffee is a listed example) and says *"OMIT the key when you would be guessing"*. The revision prompt takes both *"on the same terms as an estimate"*: *"only where the item plausibly carries them, omitted where you would be guessing"*. Neither said which rule wins when the unknown is the very thing that sets the caffeine: the shot count. On the prompt alone it is the model's call, and it can go either way.

**The code does settle it.** Every answer is arithmetic over the figure the item already carries. `scale_item` multiplies through `scaleMicros`. `set_amount` re-prices through `rescaleLoggedItem`'s proportional branch. Both **skip an absent key**, and `add_item` carried no micros at all (it carries its own since §15). So if the estimator had omitted the espresso's caffeine, tapping "3" would move the espresso from 5 to 7.5 kcal and record **no caffeine, whatever was tapped** (§54 pins exactly this). In that case the question is not "the only path to a caffeine figure". It is **no path at all**.

That is why the third clause exists. The question block's own rule (the items already assume the most likely answer) now says **micros included**. An item that a question is about carries its caffeine *for the answer the items assume*. That is an estimate with a stated basis, not a guess, and the omit-a-guess rule still governs everything else. The question is then the path from an **assumed** caffeine figure to a **stated** one. Skipping it keeps the assumed figure (two shots, 126 mg). That loses accuracy but never coherence, the same trade C5 already made for portions.

### Paid for inside the ceiling

`ESTIMATOR_PROMPT_CEILING` stays at 1,000:

| | tok |
| --- | --- |
| estimation prompt, where "slices" left it | 967 |
| + the bar: "a figure, not just a name", with caffeine and sodium beside energy and protein | +10 |
| + "biggest change first" | +5 |
| + "micros included" on the assumed answer | +6 |
| − **the cut the constant itself named**: the confidence bullet's three definitions become two plus `else "medium"`. What it cost is the anchor *"typical mixed dishes"*. `high` (the only level gate 2 reads) and `low` are unchanged, word for word | −6 |
| − the per-portion line after the schema, folded into the micros bullet (*"in milligrams for the portion, not per 100"*). This is the revision prompt's own shape, and no rule is lost | −9 |
| **after** | **973**, 27 of headroom |
| revision prompt, with the same three clauses | 834 → **855** |

The constant names what is left to cut. First the micros bullet's closing *"and they are not the same claim"* (~12). Then *"Most meals need no question at all;"* (~10), which goes last because this round leaned on it as the guard when it widened the bar.

### Verification (2026-09-23)

`db/nutrition-v2.test.mjs` §53 pins the criterion at the source:
- the figure-not-name bar and its four figures;
- the old energy-only phrase, pinned as **absent**;
- the ranking;
- "micros included", beside the unchanged omit rule;
- the revision prompt's parity;
- no drink named in either question block;
- both trims.

The suite was run against `main`'s `estimate.ts` to prove that a revert fails it: 9 of 312 fail.

§54 runs the owner's latte through the screen's own path, with the model's reply mocked: parse → ground → review rows → answer → save.
- A `set_amount` "3" takes the espresso from 60 to 90 ml, from 5 to 7.5 kcal, **and from 126 to 189 mg**.
- The milk keeps its 300 ml and its sodium.
- "1" reads 63 mg from the same base.
- A skip keeps 126 mg.
- The `scale_item` spelling of the same answer lands on the same 189 mg.
- The saved day reads **189 mg**.
- The energy share is asserted (1.3%, against caffeine's 50%), so the reason the old bar never asked is checked as arithmetic, not just stated.
- The same reply with the caffeine omitted records none after "3".

§36 reads 973 and 855. No model was called.

### What only the phone can settle (2026-09-23)

- **Whether the next latte asks about the shots.** Every clause above is a criterion, and the model decides. The test is a latte, photographed or described, with no shot count given.
- **Whether it asks both.** Milk *and* shots is the good outcome. Shots *instead of* milk would trade one gap for another. If it only ever asks one, the fix is a sentence in the cap bullet, not a rule.
- **Whether the espresso carries caffeine when the question is asked.** "Micros included" is what lets an answer reach the figure. The failure to look for is a reply that asks the question but has no caffeine on the item the question is about. The micros screen shows it after saving.
- **Whether the wider bar over-asks.** Sodium can now make a question material too, and ~15% of a small figure is a small number. A square of dark chocolate's caffeine is exactly the trivia that the knowability rule and "most meals need no question at all" have to keep out.

### Found on the way, recorded and not fixed in this round

Each of these was reproduced headless. Each bears on the same caffeine and sodium figures. **All three were fixed in §12n (2026-09-23)**, and the second had a twin in fiber.

- **A composite carries no micros.** The parser drops a header's micros (invariant 2), and the `components` clause on the schema line does not ask for any. So a latte (or a pizza's sodium) that comes back as a C4 composite records none, whatever a question does. The fix is `micros` on that clause, about +7 tok.
- **An AI item grounded to a catalog food that records no micros loses the model's sodium and caffeine at review.** Grounding keeps them, which is what §21 asserts. The review rows' `currentPortion` then re-prices through `rescaleLoggedItem` from the food alone. That affects 77 of the 187 seed foods, and `meal-detail`'s portion edit shares the path.
- **Two answered questions do not compose.** `use-estimate-questions` freezes a base per question. So answering milk, then shots, then changing milk re-applies milk to the pre-shots rows. The espresso drops back to two shots while its "3" chip stays lit.

---

## 12m. "Slices" — a count of pieces on a composite (2026-09-19, migration `0059`)

Owner, parked backlog: ***"'Slices' as a food unit"** — convenient for composite foods; back burner.* Design: `docs/spikes/slices-as-a-food-unit.md` (**built**), with all four of its questions answered **(a)**.

> **Re-cut on the device, 2026-09-23 (no migration).** The owner, from the phone: *"this is working poorly. grams are still being used as the unit of measurement, when it should've changed to slices. and the whole interaction when slices comes up is funky."* (The composite itself *"worked more or less."*) The model, the column and the arithmetic below all stand. What changed is how a counted dish **reads** — `3 slices`, leading, wherever its amount is drawn — and the **control**, which is now one sentence, `ATE [3] OF [8] SLICES`, in place of the `THIS IS` / `I ATE` field. Superseded below: that field, the `×` in the label, and the chips beside a count. The account is the last subsection of this section, **The device re-cut**.

### A slice is not a unit. It is a count, and a count is a ratio

`0047` settled the unit vocabulary at two words and no conversion between them, and named `slice` as one of the things it was refusing: *"no `oz`/`cup`/`slice` in the schema."* That holds. Three slices of an eight-slice pizza is **× 3/8** — the arithmetic the composite fraction chips (0058) already do — so this round adds no basis, no piece↔gram factor, and no third value in any CHECK.

What the app lacked was a place to write the count's **noun**. The count itself already had a column: `meal_items.serving_qty` has always meant *"how many of the named thing"*, and the named thing has always been the catalog food's own serving, joined **live** from `foods.serving_name`. A composite header has no `food_id` — *"a header is a dish, not a catalog food"* — so it can never reach that join.

### The schema: one nullable column, one table, no backfill

`0059` adds **`meal_items.piece_name`**, and nothing else. It is non-null only on a composite header, beside a non-null `serving_qty`, and names **one** piece in the singular: `slice`, `wing`, `roll`.

`portionLabel` reads **`piece_name ?? food_serving_name`**, so a catalog row still prints `2 × 1 egg` off the live join and a header prints `3 × slice` off its own column. **The two vocabularies never share a column**, and that is the whole reason for a new one rather than snapshotting the serving name onto every item: `'3 slices'` is a *serving phrase* (one serving is three slices) while `slice` is a *piece noun*, so `2 × 3 slices` is six slices and `3 × slice` is three. One column holding both is the class of lie `0047` renamed three columns to avoid. *(Snapshotting the serving name is a real gap — deleting a food degrades `2 × 1 egg` to `100 g`, and a template never had the join at all — and it is now **its own backlog item** on its own merits, not a prerequisite of this one. Owner decision, question 4.)*

Nothing that exists is a counted composite, so there is **no backfill**: no UPDATE, and therefore 0014's `AFTER UPDATE` trigger never fires on the owner's phone. No CHECK on the pairing either, which is 0034's finding applied rather than repeated: the constraint would pass here, but the invariant belongs where it can say something useful when it breaks — the repository writers and the tests.

### Invariant 2, one clause wider

0058's invariant 2 lists every number that **sums** and says a header carries none of them. It does not name `serving_qty`, and it does not reach it:

> *A header carries no number that sums. It **may** carry a **count** of what it is — `serving_qty` and its `piece_name` — because that is a fact about the whole and not about any part.*

The invariant exists so that *"a query that forgets the rule under-counts by zero"*. No sum anywhere reads `serving_qty`, and the only two non-display readers — the recents rails — **inner join on `food_id`**, which a header never has. `db/nutrition-v2.test.mjs` §42 asserts that as a byte-identity: `recomputeMealTotals`, `partialMealMetrics`, `mealItemCounts`, `listRecentFoods` and `listRecentBarcodeFoods` are identical before and after a header gains a count.

**Parts never carry the pair** — a slice is not a fraction of the cheese. That holds by the writers (`scaleCompositeItem` nulls both on every part; both `priced()` builders send `piece_name: null`), not by a constraint. The last part takes the header, and the count with it (invariant 4).

### The principle, and the one thing the first draft got wrong

> **The unit says what the number is measured in. The count says how many of a named piece the parts, as they stand, add up to. The first count DECLARES that correspondence; every later change PRESERVES it by scaling the parts.**

A composite's parts are the whole dish **as priced** — the model estimates what it sees, not what was eaten. So a number typed into an *uncounted* composite can only mean *"what is priced here is N pieces"*. Read the other way, a photographed whole pizza given a `3` would print `3 × slice` over eight slices of macros and count the whole pizza into the day: the headline disagreeing with the parts, which 0058 built two belts to make impossible.

So the empty field asks one question and its label says which (**owner decision, question 1**):

| state | label | typing `N` |
| --- | --- | --- |
| uncounted | `THIS IS` | declares the parts to be N pieces. **Nothing scales** — every part and `meals.kcal` byte-identical |
| counted | `I ATE` | scales every part by `N / current` and writes the count |

Two entries for the pizza case — `8`, then `3` — and the model's `pieces` performs the first.

*(The two questions stand; since 2026-09-23 they are two fields — OF declares, ATE scales — rather than one field whose label switched between them. See the device re-cut below.)*

Five consequences, each keeping 0047 intact:

1. **Nothing converts.** "Grams per slice" is `amount ÷ serving_qty`, derived every render, never written — a stored copy would disagree the moment a part was hand-edited.
2. **A count is a fact about the whole.** Whatever scales the whole moves it (chips, the grams field, the count field); an edit to one part does not. You still ate three slices; they were lighter. That is 0058's asymmetry, unchanged.
3. **The current state is the record.** 3 → 4 scales from what the parts read *now*.
4. **The correspondence is testable.** Across any run of count edits and chips, `kcal ÷ serving_qty` is constant — the per-piece energy fixed at the declaration. A part hand-edit is the one thing allowed to move it, and §44 asserts exactly that boundary.
5. **A slice is not comparable across days**, and is not meant to be. Nothing sums or trends `serving_qty`.

**A wrong count is re-declared by clearing the field** (**owner decision, question 3**): empty means "no count", so the next number declares afresh and moves nothing. No new furniture. On the review sheet that is one gesture; on `meal-detail`, where the editor stages a draft and writes on Save, the draft carries a `cleared` flag so backspacing-then-typing is still one Save.

*(Superseded 2026-09-23: on the review a wrong count is re-declared by typing into OF, with no clearing; clearing, now resolved when the edit ends rather than on the keystroke, only un-counts. The `cleared` flag is gone from meal-detail — it made backspace-then-type declare while type-over scaled. See the device re-cut below.)*

### The controls

> **Superseded on the device, 2026-09-23.** This is the 2026-09-19 build — the field whose label switched, the `×`, the chips beside a count, and the `3 × slice` sub-lines in the table. What replaced each, and why, is the device re-cut at the end of this section.

**The count sits BESIDE the `½ ⅓ ¼` chips, not instead of them** (**owner decision, question 2**): a chip is the fast handle, a count the precise one — the pairing the whole-dish grams field already has. A chip on a counted dish prints the honest `2.7 × slice`; rounding to `3` would print a count the parts do not add up to.

```
I ATE     ½   ⅓   ¼                     (uncounted)
THIS IS   [   ] × piece

I ATE     ½   ⅓   ¼      [ 8 ] × slice  (counted)
```

The count is the parts' own `AmountField` anatomy — a `w-14` mono field with the same live, snapshot-from-focus, non-compounding semantics — because it **is** the grams field's sibling: one scaling mechanism, two ways to say the same size. A field rather than the catalog stepper, because 8 → 3 is one keypad entry and ten taps at the stepper's 0.5 step. The noun is a label-voice control that swaps to a one-line field on tap; with no count it is a muted readout, because a noun with no count names nothing.

**Device: unchanged.** One `Block device="plate"`, parts indented inside it; no accent (Save keeps it), no signal colour — a count is not biology.

| surface | after |
| --- | --- |
| Eat tab row | **unchanged** — no item portion is drawn there |
| meal-detail, composite sub-line | `3 × slice (270 g) · P 36g …`. The amount guard moved *inside* `portionLabel`, so a counted dish whose parts are in **mixed units** (0058 invariant 5) prints the bare `3 × slice` — the only whole-dish figure such a row has |
| meal-detail, expanded | the two rows above; chips still write immediately, the count stages a draft and writes on Save |
| Review sheet | the two rows above, live |
| meal-detail, plain item | `2 × 1 egg (100 g)` — the identical string, through the same join |
| Templates | **unchanged**; a template flattens a composite, so the pair never reaches `meal_template_items` — the same honest loss the header's own name takes |
| Revision request | `— 8 × slice, 3 parts` |

One formatter does all of it: **`countLabel(qty, noun)`** in `format.ts`, the two tokens `portionLabel` always built, lifted out so the sub-line, the label and the wire cannot drift.

**One convention on the wire:** the revision request prints an item's amount, kcal, macros and micros and never its *serving* count, so the only count the model ever sees is a header's piece count. `2 × 3 slices` never sits beside `8 × slice`.

### The estimator

The item schema gains one optional key, read on a composite header and **ignored anywhere else**: `"pieces": {"name": string, "count": number}|null`. On a plain item a count would land in three places built for a catalog serving count — the recents rail's re-add, a template round-trip, and meal-detail's serving-mode predicate — so the parser drops it there.

The rule is a **criterion with three examples**, not a dish list, because judgment lives in the model and the parser validates shape only: *"If what you priced is a countable number of pieces (slices, wings, rolls), give `pieces`: the singular noun and the count; else null."* **The count is of what was PRICED** — a whole pizza comes back `{slice, 8}`, three slices on a plate `{slice, 3}` — which is the owner's declaration made by the model instead of by him. `parsePieces` takes a trimmed non-empty noun and a finite count `> 0` and `≤ 100`; anything else is `null`. Grounding never prices a header and never touches the count.

**The prompt ceiling was paid, not raised.** `ESTIMATOR_PROMPT_CEILING` stays at 1,000:

| | tok |
| --- | --- |
| estimation prompt, where C4/C5 left it | 922 |
| + the pieces rule | +38 |
| + `"pieces"` on the schema line | +14 |
| − the trim the constant itself named as cheapest: the hidden-fats bullet and *"prefer underestimating an unknown over inventing precision"* folded into one, neither rule lost | −7 |
| **after** | **967**, 33 of headroom |
| revision prompt: 798 + the schema clause + one rail (*keep `pieces` as it arrived*) | **834** |

`§52` asserts the fold at the source, so a quiet revert fails there rather than only nudging the ceiling.

### The Coach: a measured zero

Schema delta **0 / 0**. No Coach tool carries a food portion and nothing under `src/lib/ai` names `meal_items`, so there is no property to add and nothing to trim for — the same zero 0047 measured. Both ceilings stand at 9,250 / 3,700.

### Verification

`db/nutrition-v2.test.mjs` §41–52 — the pair on a header and nothing that sums; **the negative**, as five byte-identity comparisons; a chip moving the count and `×0.5 ×2` returning to exactly 8; the declaration moving nothing, the correspondence holding across 8 → 3 → 4 → 3, the part hand-edit that is allowed to move per-piece, and the refusals (0, `NaN`, a non-header); a part removed leaving the count and the last part taking it; the pure review rows end to end, including a ⅓ chip mid-focus that still cannot compound and an emptied field that declares afresh; a C5 `scale_item 0.375` landing on `3 × slice`; the save, the wholesale replace, the re-log and the template flatten; all three revision builders including the 0057 offline drain; the parser's accept/ignore table; grounding leaving the count alone; and both prompts' rules. `db/migrate.test.mjs` §9 — 0059 on a **populated** database staged at 0058, `piece_name` NULL on every staged row, and the live serving join untouched. `db/foods.test.mjs` §16 — `countLabel`, the `2.7 × slice` decimal, the `piece_name ?? food_serving_name` precedence, and the mixed-unit bare count. `db/screens-render.test.mjs` §20 — meal-detail's counted and mixed-unit sub-lines, and both states of the control through the shared review plate.

### What only a device can judge

> **Answered on the device, 2026-09-23:** the label switch did **not** read, and neither did the grams. Bullets two to five below are what the re-cut replaced; the first and the last still stand, and the new control's own list is at the end of this section.

- **Whether the model returns `pieces` for the right things.** The rule is a criterion tested against a mock; no real call is made on this branch. The first photographed pizza and plate of two eggs are the test. A wrong answer costs one keypad entry, which is the point of building the owner's half first.
- **Whether the label switch reads.** `THIS IS` becomes `I ATE` and the field moves up a row the moment the first count lands. If that reads as the control jumping, the fallback is one row in both states with only the label switching.
- **The `I ATE` row at 375 pt.** Three 44 pt chips, a `w-14` field, a `×`, a noun and the label at `pl-6` is most of a ~343 pt plate interior. Both rows are `flex-wrap`, so it wraps rather than clipping — but whether the wrap reads as one control or two is a hand question.
- **`2.7 × slice`.** Honest, and possibly alarming. If it grates, the remedy is to replace the chips once a composite is counted (question 2's option b), never to round.
- **Clear-then-type versus select-and-type.** `selectAllOnFocus` means typing over a focused `8` scales, while backspacing to empty and then typing declares. Two gestures for "change 8 to 6"; §6 of the spike names this as the thing to watch.
- **Whether `meal-detail`'s own expanded rows read well.** The disclosure's open state is local React state, so the render suite can only draw them collapsed; §20 asserts the control through the shared review plate instead and says so.

### The device re-cut — slices, not grams, and one sentence (2026-09-23, no migration)

The owner, from the phone, on the build that shipped the above: *"this is working poorly. grams are still being used as the unit of measurement, when it should've changed to slices. and the whole interaction when slices comes up is funky."* Of the composite itself: *"this worked more or less."* No migration: `piece_name` and `serving_qty` are as 0059 left them, a review still saves through `rowsToMealItems`, and a logged record's count is still written only by `setCompositeCount` and `clearCompositeCount`, with `scaleCompositeItem` beneath them.

#### Why grams still led — the actual cause

The count was stored, scaled and saved correctly. **The drawing never consulted it where the amount is drawn.** Reproduced with the owner's own two entries — a pizza priced at 720 g, `THIS IS 8`, `I ATE 3`:

1. **The review sheet's header row** hard-wired a composite's amount slot to the whole-dish grams field (`total.amount != null ? <AmountField … />`) — the same boxed field every other row's amount sits in. The count reached the row only as the head of its 10 pt muted sub-line. After `8` then `3` the pizza read **`[270] g`**, with `3 × slice · P 29g` in small print beneath.
2. **The Adjust screen's "As logged" plate** printed a composite's summed grams straight off `fmtAmount` and never asked whether the dish had a count: **`270 g`** for three slices.
3. **The logged row** (meal-detail's sub-line) did lead with the count — `portionLabel` put it first — but as **`3 × slice (270 g)`**: the serving-count form `2 × 1 egg`, right for a catalog serving phrase and read, on a count of pieces, as "three times slice".

The Eat tab's meal row and the day view print no item amount at all (name, macro cells, kcal), and a template flattens a composite, so there was nothing on those to fix.

#### Every surface, after

| surface | before | after |
| --- | --- | --- |
| review sheet, counted header | `[270] g` field; sub-line `3 × slice · P 29g` | **`3 slices`** in the amount column; sub-line `270 g · P 29g` |
| review sheet, uncounted header | `[720] g` | unchanged — a dish with no count still reads in grams |
| meal-detail, composite sub-line | `3 × slice (270 g) · P 29g` | **`3 slices (270 g) · P 29g`** |
| meal-detail, parts in mixed units | `3 × glass` | **`3 glasses`** |
| Adjust, "As logged" | `270 g` | **`3 slices`** — the parts drawn open beneath it keep their grams |
| Adjust, the revised rows | `I ATE [3] × slice` | **`ATE [3] SLICES`** — a record's count, with no OF (below) |
| a catalog serving (any screen) | `2 × 1 egg (100 g)` | unchanged |
| the revision request (the model's to read) | `— 8 × slice, 3 parts` | unchanged — the `×` form is the shape of its own `pieces` JSON, and it sits beside the ceilinged prompts |

**One formatter:** `piecesLabel(count, noun)` in `format.ts` — `3 slices`, `1 slice`, `2.7 slices` — singular exactly when the count *prints* as `1`, plural by `pluralNoun`: four rules and five named words (`half`, `leaf`, `loaf`, `potato`, `tomato`) that reach the pieces people count (slices, wings, rolls, patties, sandwiches, `pieces of sushi`), keeping a capital the noun was given, and leaving a noun that already ends in a single `s` alone, because `3 slicess` is worse than `3 fries`. `portionLabel` reads a header through it and a catalog serving through `countLabel`, so the two vocabularies still never mix.

**`3 slices`, not `3 of 8 slices`.** The eight is the photographed dish, and 0059 deliberately never stored it — the spike's rejected denominator — so a label that needed it would read one way on the review and another after Save, the drift one formatter exists to prevent. The review still says *of 8*: in the control, beside the number it qualifies.

**Grams, where they still earn a place:** the review header's sub-line leads with `270 g` (the check that 90 g is a slice), meal-detail keeps `(270 g)` after the count, and **the parts keep their own grams everywhere** — a slice is not a fraction of the cheese, so a part is never counted in pieces.

#### The interaction: one sentence, two fields

What was funky, walked in code: one field and a noun that asked **two different questions depending on state nobody could see** — labelled `THIS IS` on an uncounted dish (declare; nothing scales) and `I ATE` once counted (scale) — and that **moved from its own row into the chips row the moment it switched**. On the review sheet the switch happened on the *first keystroke* of a declaration, and moving it re-parented it: React unmounted the field, the keyboard dropped, and the `2` of a `12` had nowhere to land. Clearing it to re-declare moved it back. The `×` read as multiplication; the noun had to be tapped, emptied letter by letter, and retyped; on a counted dish the chips sat beside the count printing `2.7 × slice`; and meal-detail's clear-then-type declared while type-over scaled — two gestures for "change 8 to 6" with opposite effects, the trap §6 of the spike named.

```
uncounted:        ATE   —   OF [    ]  PIECES
                        ½    ⅓    ¼
counted:          ATE [ 3 ] OF [ 8 ]  SLICES
a record's count: ATE [ 3 ] SLICES
```

- **ATE** is how many were eaten. Typing it **scales** every part by the new count over the count at focus, live and non-compounding from the focus snapshot, as before. It is an **em-dash** until the dish has an OF: there is nothing to take a share of, and a number there could only mean "this dish is N pieces", which is OF's question. The dash holds the field's slot, so OF is in the same place in every shape — and keyed, so it stays mounted under the thumb while the dish becomes counted.
- **OF** is how many pieces the dish *as priced* is. While all of it is eaten, typing it **declares** — or **re-declares**, with no clearing first: the model said 8, the pizza was 6, and it reads `ate 6 of 6` with nothing scaled. Once part of it is eaten, OF says what the sentence then reads: after `ate 3 of 8`, typing 6 gives `ate 3 of 6`, every part × 8/6. Either way OF re-fixes what one piece weighs — it is a re-declaration, as the clear-and-retype it replaces was — where ATE never does (the principle's consequence 4, unchanged in kind).
- **Text that is not a count shows the dish as it stood at focus**, in either field — empty, `0`, `101`. Only a valid number moves anything. This is what makes an emptied field safe to act on: a `1` typed on the way to `12` is × 8 for that keystroke, and backed out, it never lands. The one exception is shape, not grams: a declaration still being typed keeps its counted shape through an empty keystroke (a declaration never moved a gram), so "8", backspace, "6" does not mount and unmount the ATE field, the header's grams field and the chips around the field being typed into.
- **Clearing still un-counts without scaling — decided when the edit ends.** Emptied and left, the field that says what the dish is (OF; or ATE on a record's count) un-counts it, every part where it stood at focus. It is resolved on blur, on collapsing the dish (a focused field that unmounts is not promised a blur), and at Save if Save comes first — never on the keystroke, so backspacing an 8 to type a 6 is one edit.
- **The noun** agrees with the number it follows (`of 1 slice`, `of 8 slices`, `ate 3 slices`), becomes a one-line field on tap with its word **selected**, and commits as it is typed; left empty, it keeps the noun it opened on.
- **The chips stay on an uncounted dish only** — the fast handle on a burrito, as the owner chose in C4 — drawn under the dash they stand in for. On a counted dish a count says any share exactly (½ of eight is `ate 4`) where a chip could only print `2.7 slices`: the spike's question 2, option (b), which it named as the remedy if the decimal grated. **The whole-dish grams field goes from a counted header too**: the count is edited in one place.

**A record's count has no OF** — `ATE [3] SLICES`. The Adjust screen's rows are built from a logged meal whose count is what was *eaten* (the model is handed it and told to keep it), so `rowsFromEstimate(…, { countIsEaten: true })` gives them no whole. Offering `of [3]` there would invite typing the pizza's eight, which — read as OF must read it — re-declares three logged slices as eight, and a later `ate 3` then takes 3/8 of them. The same holds on the meal screen, below.

**The typed answer keeps the "of".** A clarifying question answered by typing ("Other") sends the model each dish's count *eaten* and asks it to keep it; what comes back is rebuilt by `rowsFromEstimate`, which reads any count as the dish priced whole — so `ate 3 of 8` would have returned as `ate 3 of 3`, the 8 gone. `carryWholes` (`review-rows.ts`), run by the question hook against the rows it sent, gives each dish back its whole when its count came back unchanged, reads a count the answer changed as a count eaten (no whole, `ate [2] slices`), and leaves a dish that was never counted with the model's count as its whole.

The saved count is still the one eaten (`serving_qty`). The review holds the dish's count as view state — `ReviewItem.wholeCount`, never saved, the rejected denominator living exactly as long as the review, and null beside a count for a record's — with `wholeText`; `countText` is now `string | null` (null = untouched, so a field emptied mid-edit shows empty rather than refilling under the thumb), and the focus snapshot `countFrom` is `{ count, whole }`.

**On the meal screen, a counted dish reads `ATE [3] SLICES`, and that is the honest shape.** A record's parts *are* what was eaten, and the whole was never stored. A new number scales every part by new / current; saved empty, the count goes and the parts stay. An **uncounted** dish reads the review's own sentence, `ATE — OF [ ] PIECES` plus the chips: OF declares what the logged parts are, and ATE, in the same Save, then takes a share. The draft is `LoggedCountDraft`; what Save does is `planLoggedCount` (`review-rows.ts`), and the sentence above Save reads the same plan the write runs. An untouched field is `null`, so an editor opened and closed writes nothing — the old draft re-wrote an untouched 2.6667 as the 2.7 its field displayed — and with nothing to write, the button reads **Close** (outlined, never the accent) rather than sitting disabled beside a stuck editor. **The trade, stated:** re-declaring a *counted* record ("it said 8, it was 6, and I ate it all") is now two Saves — clear it, then declare 6 — where the old `cleared` flag made it one. That flag was the trap; a record's count is rare to re-declare (the review is where a count is fixed, in one field); and two Saves each say what they will do before they do it.

**Conformed Set:** one device, the Items plate, unchanged; labels in the label voice (the old ones were mono), every amount mono, no accent (Save keeps it), no signal colour, the chips, the noun and the Close/Save button at 44 pt, and no new border.

#### Verification (2026-09-23)

`db/foods.test.mjs` §16 — `piecesLabel` (`3 slices`, `1 slice`, `2.7 slices`, a 0.95 that prints `1 slice`), `pluralNoun` over thirteen nouns (capitals kept), `portionLabel` at `3 slices (270 g)` / bare `3 slices` in mixed units / `2 × 1 egg (100 g)` unchanged, and `countLabel` unchanged. `db/nutrition-v2.test.mjs` §46 rewritten for the sentence — ATE conjures no count; OF declares and moves not one gram; ATE 3 of 8 is × 3/8, non-compounding; 8-then-3 saves three slices over 3/8 of the parts; OF re-declares (`6 of 6`, nothing scales) and re-reads (`3 of 6`, × 8/6); **backspace-then-type is one edit**; an OF left empty **un-counts without scaling** — on blur, on collapse and at Save, and **after a valid keystroke** (a `1` that made the dish × 8 is backed out to the dish as it stood, not un-counted at 2,160 g); bounds in both fields with the parts checked; a count a hair off its whole still re-declares; a declaration emptied mid-edit keeping its shape without moving a gram; and a record's count (`countIsEaten`) with no whole, ATE scaling it by 4/3 and un-counting it when emptied — §47 (the C5 answer reads `ate 3 of 8`; the typed answer sends the count eaten, a reply rebuilt alone would read `ate 3 of 3`, and `carryWholes` gives the 8 back, reads a changed count as eaten, leaves an uncounted dish its model whole, and is pinned in the question hook), §48 (declares through OF), and a new **§55** (numbered §53 on its branch; the shots fix took §53–§54 first): the logged plan through the repository — ate 3 of the 8 logged, an emptied ATE clearing without scaling, a rename alone at × exactly 1, an untouched draft writing nothing (the 2.6667 case, pinned at the plan *and* at the draft's `eatenText: null`), OF declaring on an uncounted record then ATE taking a share in one Save, the refusals — and a source pin that meal-detail's Save runs exactly that plan. `db/screens-render.test.mjs` §20 rewritten — meal-detail `3 slices (270 g)` and `3 glasses`; the "As logged" plate (drawn from its own export, so the suite needs no key) at `3 slices` with no `270 g`, and an uncounted dish still at `720 g`; the review plate uncounted (the dash, OF empty, `pieces`, the grams field and the chips present, no ATE field, no noun control, no `This is`), counted (`3 slices` in the amount column, `270 g · P 22g` with the grams leading, ATE `3` and OF `8` in that order under the parts, `slices`, no grams field, no chips, no `×`), a record's count (`ate [3] slices`, no OF), and one slice read singular.

#### What only a device can settle (2026-09-23)

- **Whether the sentence reads as one.** `ATE [3] OF [8] SLICES` is ≈250 pt of the ≈281 pt a 375 pt screen leaves inside the plate and its indent; a long noun (`chicken wings`) wraps to a second line, which the row allows rather than clips.
- **Whether the dash reads as "not yet"** rather than as a broken field, and whether the chips drawn under it read as its alternatives.
- **The first keystroke of a declaration.** The OF field stays mounted and keeps the keyboard; the header beside it changes from `[720] g` to `8 pieces` and the chips below vanish on that keystroke. Only the hand says whether that reads as confirmation or as movement. On a partly-eaten dish a two-digit OF passes through one digit (`1` on the way to `12` is × 8 for a keystroke), which the live kcal shows.
- **The fields' height.** Both keep the parts' `AmountField` anatomy, ≈31 pt tall inside a 44 pt row — as the old field did.
- **Whether the chips are missed on a counted dish**; whether `ate [3] slices` on the record (and on Adjust), beside the fresh review's `ate [3] of [8] slices`, reads as honest or as something lost; and whether two Saves to re-declare a counted record is ever felt.
- **A plate photographed after eating** — three slices, priced as three — reads `ate [3] of [3] slices` on the fresh review, which is true; typing the pizza's eight into OF there re-declares those three as eight. The Adjust screen and the meal screen cannot do this (no OF on a record's count); the fresh review can, and only the hand says whether it is ever tried.

## 12n. Micros, round 2 — the three on the Eat tab, a key micro on a row, the shortlist where it counts (2026-09-23, no migration)

Three owner notes from the device, on the 0061 build, verbatim:

1. *"Sodium and caffeine more accessible, other micronutrients should start getting something probably"*
2. *"Fiber should be more visible too"*
3. *"Important micro should show on key items; i.e., displaying caffeine on a latte"*

Plus the three defects the shots round reproduced headless and left for this change (§12l, "Found on the way"). **No migration** — head stays `0061`. Every figure here already had a column or a key; what was missing was where they were read and what dropped them on the way.

### The three, under the macro bars

`app/nutrition.tsx`'s Today grid gains **one more row of the same grid**: Sodium · Caffeine · Fiber, three `GridCell`s under the macro cells, drawn by `src/components/nutrition/day-micros.tsx` from `dayKeyMicros` (`src/lib/nutrition/key-micro.ts`).

```
SODIUM            CAFFEINE          FIBER
1,240 mg          145 mg            21 g
of ~2,300 limit   of ~400 limit     of 34 g
```

- **Sodium and caffeine against their ceilings**, the references `micros.ts` sources (FDA). The tilde says what they are: general guidance, not a target he set.
- **Fiber against his own target** (`nutrition_targets.fiber_g`), the value the micros screen and the Coach read. **Read, never counted down**: fiber is summed from items, so a typed-totals meal contributes none by construction and a remainder would be a lie. With no target the figure stands alone over `no target set` (00-design-spec.md §5).
- **Nothing recorded is an em-dash and `not recorded`, never a 0.** `dayFiberRecorded` (new, `repositories/nutrition.ts`) is NULL when no item today recorded fiber. Every reader that prints or reports the day's fiber takes it: this row, the micronutrients screen's fiber plate, the Coach's `nutritionTargets.fiber` and `keyMicros`, and the `micronutrients` domain (see the review below). `dayFiberTotal`'s 0 is left to nothing that shows it.
- **The caveat, only when it is true.** A meal logged as totals only (typed kcal and macros, no items) adds none of the three, and the grid says so in one line: *"A meal logged as totals only adds no sodium, caffeine or fiber here."* Items with no micros record (most seed foods) are the everyday case, and the micronutrients screen's own caveat covers them. Putting that sentence here would put it on every day.
- **Drawn only once something is logged.** On an empty day all three would read `not recorded`, which the empty grid already says.

**Conformed Set.** One more row of the Today `grid` device, so the rule above it is the grid's own rule between rows, with nothing nested. A step below the macros in every voice: a 10px label against their 11px, a 15px mono figure against their 20px, and **no bar**. A bar would be a gauge beside the macro gauges, and it would ask for the colour the firewall refuses. A daily micro total is not a biological state, and the macro bars' signal fills are an owner override for macros only (docs/project-status.md §3). **No signal colour and no accent**, pinned by source in `db/screens-render.test.mjs` §7c2. The unit sits on the figure line so `of ~2,300 limit` (15 characters of 10px mono, ~90 pt) fits a 375 pt phone's third of the grid (~92 pt). Each cell speaks as one sentence to VoiceOver.

The rest of the shortlist stays on the micronutrients screen, reached from Over time as before.

### One notable micro on an item row

`keyMicro` (`src/lib/nutrition/key-micro.ts`) is the whole rule, one pure function. **One figure per row at most**, in this order:

| | shown when | why the line is there |
| --- | --- | --- |
| **caffeine** | ≥ 20 mg (`KEY_CAFFEINE_MG`, since §15's review) | the owner's own example; a real dose is a question about the next few hours, not only the day's sum |
| **sodium** | ≥ 460 mg, a fifth of the 2,300 mg limit (`KEY_SODIUM_SHARE`) | the FDA's "high in" line (21 CFR 101.54(b), 20% DV). Below it sodium is on every savoury item and saying so would be noise |
| **fiber** | ≥ 5 g (`KEY_FIBER_G`) | roughly a fifth of the 28 g DV, the same share, and a round number |
| **caffeine, under 20 mg** | it rounds to ≥ 1 mg, and neither line above was met | a square of chocolate still says so, but never in place of a dinner's sodium (§15) |

Nothing else on the shortlist competes for the slot. The three are the owner's. It prints as `145 mg caffeine`, a nested Text at the end of the row's own mono sub-line (`src/components/nutrition/key-micro-tail.tsx`), one step up the ink ladder (`ink-secondary` on `ink-muted`). No accent, no signal colour.

Where it is drawn: **meal-detail** (each item, and a composite's header, which reads its parts' sum through `partsAsItem`), the **estimator's review table** (at the live portion, so an amount edit or an answered question moves it), and, since the review, **the Eat tab's meal rows**: the same rule over the meal's items summed (`mealKeyMicroLabels` over `dayMealItemMicros`), on its own 11px mono line under the macro columns, which leave no room beside them on a narrow phone.

### "Other micronutrients should start getting something" — the step taken, and why it is the smallest honest one

Why most of the shortlist reads `not recorded`: only catalog and label foods carry it, and the estimator asked for sodium and caffeine only. The owner logs mostly by Photo and Describe, so his day was sodium and caffeine plus whatever a grounded catalog food brought. Grounding needs a confident name match, and a model writes `Grilled salmon fillet`, not `Salmon, cooked`, so that is rare. The brief offered three options:

| option | cost | reach | verdict |
| --- | --- | --- | --- |
| **(a)** the estimator returns more of the shortlist | prompt tokens, and output tokens per notable item | every AI-logged meal, which is his main path | **taken, bounded** |
| **(b)** a matched catalog food's micros fill an AI item | none | only items that ground, which is rare with model-written names | **taken, key by key** (it half-existed) |
| **(c)** an on-demand "estimate micros for this meal" action | a second model call per meal, a new prompt, and a button on meal-detail (where another branch is working) | only meals he remembers to ask about | **not taken** |

**(b) alone does not reach him**, and (c) is a new surface that asks him to remember something. So both of the cheap ones:

- **(a), bounded by the FDA's own "good source" line.** Both prompts now name the rest of the shortlist, *"only where the portion gives 10%+ of a day's value"* (21 CFR 101.54(c), 10–19% DV). That is the same bar the seed catalog was authored to ("present only where the source is confident"). A salmon fillet records its omega-3, vitamin D and B12. A bowl of rice records none of them. **The data stays sparse on purpose**, and the doc's rule, *honest sparse data over fake completeness*, holds. The omit-a-guess rule is unchanged: absent is `not recorded` and 0 is `measured none`. The key list is read off `MICROS` (`NOTABLE_MICRO_KEYS`), so a vocabulary key and a prompt key cannot drift apart. **The totals it feeds still run low**, and the micros screen still says so. The output cost is a few keys on a notable item and none on the rest.
- **(b), key by key.** `groundMealEstimate` used to take a matched food's micros **whole**: *"a food that records micros at all is the better source for all of them."* The seed breaks that reasoning. 0016 predates the caffeine key, so a food that records its iron is silent on its caffeine, and the whole rule dropped a dark chocolate's caffeine for recording iron. `mergeMicros` (`micros.ts`) now decides per key: every key the food records wins, and the model's fill the rest. Macros stay whole-or-nothing, because kcal and protein carry arithmetic between them and micros do not. Two sources on two keys is two facts, each with one source.
- **A revision no longer strips them.** `buildMealRevisionRequest` prints **every** recorded micro (`omega3_g 3.7`, one decimal finer than the screen, so a 0.44 mcg B12 is not handed back as 0). Before, it printed sodium and caffeine only, and the restraint rule, *an untouched item comes back with the micros it went in with*, can only hold for what the model is shown.

**The foods catalog prompt (Add food, C2) is unchanged.** It still asks for sodium and caffeine per 100. Giving it the shortlist is the natural next step for (b), since an AI-described catalog food would then ground with more. It is a separate decision about catalog entries and was left out of this round.

### Paid for inside the ceiling

`ESTIMATOR_PROMPT_CEILING` stays at **1,000**. The dated note beside it has the full accounting:

| | tok |
| --- | --- |
| where "shots" left it | 973 |
| + the shortlist, only where the portion gives 10%+ of a day's value | +41 |
| + `"micros"` on a composite's parts (defect 5) | +10 |
| − the micros bullet rewritten around its keys, taking the cut the note named first (*"and they are not the same claim"*) and "cured" | −13 |
| − the micros schema is `{<key>: number}`, so the keys are named once, in the bullet | −9 |
| − *"Those are always grams of macronutrient, whatever the portion unit is."* becomes *"Always grams, whatever the portion unit."* | −9 |
| **after** | **995**, 5 of headroom |
| revision prompt, with the same shortlist and components clause | 855 → **895** |
| revision prompt, the review's two fixes (fiber in the restraint rule +2; the 10% bound scoped to added or re-estimated items +28) | 895 → **925** |

The note names what is left to cut. The Coach's ceilings (`db/coach-eval.test.mjs` §6) did not move: the Coach's new figures ride its day **payload**, never a tool schema (below).

### The three defects

Each was fixed with a failing test first, through the screen's own path: model reply → parse → ground → review rows → edit or answer → `rowsToMealItems` → `logMealWithItems` → the day's totals. §21 walked grounding straight to a save and skipped the review rows, which is exactly where the first defect lived.

1. **An AI item grounded to a micro-less catalog food lost the model's sodium/caffeine at review** (and at meal-detail's re-portion, which shares the path). `rescaleLoggedItem` re-derived *every* figure from the food when one was present. It now re-derives what the food records and **scales the item's own snapshot for everything else**. That covers micro keys (through `mergeMicros`) and fiber, the same defect one column over: the seeded Tempeh records no fiber, and the model's 9 g went the same way. `review-rows.ts`' `toRow` merges key by key as grounding does. Pinned by §62 (chicken breast at 480 mg through review, an amount edit, save, and meal-detail's re-portion; tempeh's fiber; dark chocolate's caffeine beside the seed's iron and magnesium).
2. **A composite could carry no sodium or caffeine.** The parser always kept a part's micros, but the `components` clause never asked for any. Both prompts now do (+10 tok). Pinned by §64: three of eight pizza slices, through the review's own ATE field, save three eighths of the parts' sodium.
3. **Two answered questions did not compose.** The hook froze a base per question and re-applied a changed answer to that base alone. The whole of the logic now lives in `answerQuestion` (`review-rows.ts`, pure). Answers are a **trail** in the order first given, each with the rows before it. Changing one rebuilds from its base and **replays every later answer on top**, re-taking their bases as it goes. The invariant: *every lit chip's effect is on the rows, and no other answer's is.* The hook (`use-estimate-questions.ts`) holds the trail and nothing else. Pinned by §63: large milk, then three shots, then small milk keeps 90 ml and 189 mg with the chips reading Small and 3. The other order gives the same record. Undo on the milk keeps the shots. "1" then "3" is three. A hand edit made before a question was answered survives a change to it, and a source pin shows the hook keeps no bases of its own.
   - **A later typed answer is withdrawn, visibly.** It was a model reply over rows that no longer stand. Replaying it would restore the very answer it was computed against, so it is dropped from the trail and the tally shows it. Asking again is one tap.
   - **A chip tapped while a typed answer is in flight is ignored.** The reply was asked over the rows as they stood.
   - **The cost, stated:** a hand edit made *after* a question was first answered is lost when that answer changes. It was true of one question before, and it is now true of several. A silently doubled portion is a wrong record, and a re-typed figure is an annoyance.

### The review (2026-09-23)

An independent review of this round found four things. All four were real and are fixed, each with a failing test first.

1. **A revision re-estimated every item's fiber blind** (major). The reply schema asks for `fiber_g`, and the request never printed it. So correcting the latte put a fresh guess on the lentil soup's 16.4 g, and Save (`replaceMealItems`) wrote it over the only copy. The Eat tab's fiber cell would have moved with nothing on screen to say why. The request now prints `fiber 16.4 g` beside the macros (a recorded 0 prints, an unrecorded one does not), and the restraint rule reads *"macros, fiber and micros it went in with"*. It had three builders: the Adjust screen, the offline drain, and the typed "Other" answer. The review named two. The drain was the third, and it writes with no review at all. The Adjust screen's and the drain's builders were two copies of one function, so they are one now (`loggedToRevisionItems`, `estimate.ts`). Pinned by §68 through each path: reply, ground, review rows, save, and the day's fiber.
2. **Fiber on an unrecorded day read three ways.** The Eat tab said `not recorded`, the micronutrients screen one tap away said `0 g of 34 g` with a rule, and the Coach's `nutritionTargets.fiber.eaten` said 0 beside `keyMicros.fiber_g: null` in the same result. All of them read `dayFiberRecorded` now, and so does the `micronutrients` domain. The screen draws `not recorded` with no rule, and `nutritionTargets.fiber` says in its note that `eaten: null` is not 0 g.
3. **The latte's caffeine was missing from the Eat tab's meal row**, the surface the owner reads most. A one-item latte is a meal row there. The row now carries the same one figure, as described above.
4. **The revision prompt's 10% clause could strip an untouched item.** It bound every item, so a model told to leave an item alone was also invited to drop a key under 10% of a day's value from it, and nothing would restore it (an AI-named item rarely re-grounds). The bound now applies to *"an item you add or re-estimate"*, and *"Any other item keeps every key it was shown, scaled if its portion moved."*

### The Coach

`get_today_snapshot` gains **`keyMicros`**: `sodium_mg` / `sodiumLimit_mg`, `caffeine_mg` / `caffeineLimit_mg`, `fiber_g` / `fiberTarget_g`, and a note that null is not zero, each figure is a floor, and the limits are guidance, not targets. When it is true, the note also carries the totals-only sentence. It uses the same repository reads and references as the screen, and it is omitted on a day with no meals. **Payload only**: the tool's description and `inputSchema` do not move (pinned), so the cached-prefix ceilings are untouched. The full shortlist was already readable through `query_records` → `micronutrients`.

### Verification

- The review round: `db/nutrition-v2.test.mjs` §68 (fiber shown and kept through the Adjust screen, the offline drain and the typed answer; a recorded 0 printed; the scoped 10% clause) and §69 (`mealKeyMicroLabels`, pure and from the day's rows: a latte, a composite's parts, nothing for a typed meal or another day). They failed 8 assertions on the unfixed tree. `db/coach-tools.test.mjs` §47 adds the target-set, nothing-recorded day (`nutritionTargets.fiber.eaten` null); `db/coach-domains.test.mjs` pins the domain's null fiber; `db/screens-render.test.mjs` §7c renders the micros screen's `not recorded` fiber, and §7c2 the Eat tab's `145 mg caffeine` and `1,150 mg sodium` meal rows (4 failures on the old screens).
- `db/nutrition-v2.test.mjs` §62–§67 are new. §62–§64 are the three defects, and each failed before its fix (10 failures on the unfixed tree). §65: the shortlist bullet names every `MICROS` key, the 10% bound in both prompts, the omit rule, the named cut taken, the ceiling unmoved, a salmon's three micros kept with an off-list key dropped and rice recording none, half a fillet saving half its omega-3, and the revision request printing every micro at one decimal finer. §66: `keyMicro`'s order, both thresholds at their edges, one figure only, a parsed object read as its JSON, and a composite's summed parts. §67: `dayKeyMicros` in all three states, `countTotalsOnlyMeals`, the caveat's wording, and `dayFiberRecorded`'s NULL.
- §21 and §53 were updated where the wording they pinned was rewritten, and both are **stronger**: §21 now requires every vocabulary key in both prompts.
- `db/coach-tools.test.mjs` §47: `keyMicros` absent on an empty day; caffeine and sodium against their limits with fiber NULL; fiber against a target and the totals-only note; the `inputSchema` unchanged.
- `db/screens-render.test.mjs` §7c2: the Eat tab shows `1,240` `of ~2,300 limit`, `145` `of ~400 limit`, `21` `of 34 g`, the spoken sentences and the totals-only caveat, all under the macros and above Photo/Describe. Neither new component uses a signal colour or the accent (by source). meal-detail shows `145 mg caffeine` on the flat white, and `1,150 mg sodium` without `21 g fiber` on the soup. The review plate shows `126 mg caffeine` on a latte and `550 mg sodium` on a composite's summed parts.

No model was called.

### What only the phone can settle

- **Whether the row reads as part of Today or as a second dashboard.** It is quieter than the macros in every voice, and only the hand says whether that is quiet enough, or too quiet for "more accessible".
- **`of ~2,300 limit` at 375 pt.** ~90 pt of text in a ~92 pt cell. It is `numberOfLines={1}`, so a font that runs wider truncates rather than wraps.
- **Whether the estimator actually records the shortlist sparsely.** "10%+ of a day's value" is a criterion and the model decides. To look for: a salmon with omega-3 and vitamin D and a rice with nothing (good), or every item carrying ten keys (the bound failed; tighten the sentence, not a rule).
- **Whether the meal row's key micro is noise.** Sodium past 460 mg is common on a whole dinner, so many dinner rows will carry a sodium figure. If that reads as clutter, the meal-row threshold can be raised on its own without touching the item rule.
- **The question plate while a typed answer is in flight.** Chip taps are ignored for the second or two of `Working…`, and the chips do not dim.

---


## 13. Round 7 — two logging papercuts (2026-09-14, backlog A3 + A4)

Both came off two weeks of daily use on the TestFlight build. Neither needed a
migration; head stays `0044`.

### A4 — a scanned product names its own meal

**Owner:** *"Name meals properly from a barcode scan — use the product name, not
a placeholder."*

A scan that created a meal named it `daypartName(now)` — `Breakfast`, `Lunch`,
`Dinner`, `Snack`. That is the clock's answer to a question the barcode had
already answered better, and it is printed twice over: the meal row carries its
own timestamp. `app/barcode-scan.tsx` now titles the meal from the resolved
product via `mealNameForProduct` (`src/lib/nutrition/format.ts`).

- **`name · brand`**, in the order the scanner's own rows and the portion plate
  already draw them, so the meal is titled the way it was chosen. A brand that
  merely repeats the name is dropped (`Oatly · Oatly`).
- **The first product only.** A second scan added to the same meal leaves the
  title alone: a meal named after the thing that started it is a record; one
  that renames itself under the user is not. A meal reached with a `mealId`
  param is someone else's record and is never retitled.
- **The day part survives as the fallback**, because `meals.name` is `NOT NULL`
  and a product with a blank name must still produce one.
- **The rename path is untouched** — `updateMealName` from `app/meal-detail.tsx`
  still overrides it, and that is pinned over an auto-named meal.

`app/food-search.tsx`'s day-part naming is deliberately **left alone**: the
owner's report was about the scanner, and a catalog search has no single product
to name the meal after.

**Tests:** `db/barcode.test.mjs` §8 — the naming table, then the real
`logMealWithItems` write asserting the row carries the product name and no
clock-derived placeholder, then `updateMealName` on top of it.

### A3 — the amount highlights itself

**Owner:** *"Auto highlight the value when changing amount for a food for ease
of use."*

Every amount field in food logging arrives prefilled — `100`, the last portion,
the estimator's guess — so the first act is always to delete what is there.
`selectAllOnFocus(value)` (`src/components/ui/select-on-focus.ts`) is spread onto
all seven of them: the portion sheets on `app/barcode-scan.tsx` and
`app/food-search.tsx`, the meal-item editor on `app/meal-detail.tsx`, the review
rows on `app/meal-estimate.tsx` and `app/meal-revise.tsx`, and both grams fields
on `app/recipe-detail.tsx`.

**`selectTextOnFocus` alone does not do this on iOS**, and that is the whole
reason the helper exists rather than a bare prop at seven call sites. On the New
Architecture (RN 0.86, which Expo SDK 57 ships) the trait is read in exactly one
place — inside `-[RCTTextInputComponentView focus]`, the *imperative* focus
command. A user TAP never goes through it: UIKit makes the field first responder
itself and the component hears about it in `-textInputDidBeginEditing`, which
only emits `onFocus`. The same file says so outright. So the helper also returns
an `onFocus` that calls the input's own `setSelection(0, value.length)` —
`TextInput` mutates its native instance with that method, and that instance is
what React hands back as the event's `currentTarget`, so no `ref` is needed at
any call site. Both halves are kept: the prop is what `react-native-web`, an
imperative `focus()`, and a future RN that fixes the tap path honour.

**Scope:** amount and quantity fields only. Not names, not notes, and
specifically **not** the hour/minute pair on `app/meal-detail.tsx` — selecting a
two-digit hour someone is half-way through correcting would destroy the edit
they came to make.

**Tests:** `db/screens-render.test.mjs` §17 — the handler is driven with a fake
focus event and asked what it selected (filled → `(0, len)`; empty → nothing; a
host without the method → no throw), plus a **source sweep** asserting that
every `decimal-pad` input whose spoken label says "grams" across the six
surfaces carries the helper, with the match count asserted so the pattern cannot
go stale and pass vacuously. It is a source sweep and not a markup assertion
because `react-native-web` consumes `selectTextOnFocus` in its own focus handler
and an `onFocus` prop leaves no trace in HTML — unlike the number-pad rule
above, this one is invisible to a render.

### What only a device can judge (round 7)

1. **Whether the selection survives the caret UIKit places at the tap point.**
   The render suite cannot see a selection at all. Tap any grams field with a
   value in it: the digits should go blue and the first keystroke should replace
   them.
2. **Whether `name · brand` is the right meal title at a glance** on the Eat
   tab's list, where meal names are read in a column. Long product names may
   want truncating.

## 14. Round 8 — undo, combine, and a name for a multi-scan meal (2026-09-23, no migration)

Three notes from the owner's device, verbatim: *"undo for removing a food"*, *"some way to easily combine multiple food logs that are the same meal"*, *"meal name for scanning multiple foods"*. No migration: head stays `0061`. Every write below goes through the repository functions the screens already called; the new ones are in `src/lib/db/repositories/nutrition.ts` under *Taking back, putting back, combining*.

### Undo — every place a food is removed by hand

The grep, and what each site does now:

| where | removal | the Undo |
| --- | --- | --- |
| `app/meal-detail.tsx`, an item's × (plain item, composite header, composite part) | `removeItemWithUndo` → `takeMealItem` → `removeMealItem` | receipt row at the foot of the Items plate, above Add food |
| `app/meal-detail.tsx`, **Delete this meal** | `deleteMealWithUndo` → `takeMealWithPhotos` → `takeMeal` → `deleteMeal` | receipt row at the foot of the list of the day the meal was logged on (the Eat tab for today; that day's view in `app/nutrition-history.tsx` for a past one) |
| `app/nutrition.tsx`, the Log tab | no removal exists on either list (checked) | — |
| the Coach's `delete_record` on `meals` | `deleteMealWithPhotos` = take + settle at once | none — it has its own confirmation card, whose copy says there is no undo |
| the estimate review's × (`meal-estimate`, `meal-revise`) | removes a **draft** row before anything is saved | receipt row at the foot of the review plate — **added in §15** (it was not in this change) |

**An Undo puts back the rows, not a copy of them.** Before removing, the repository reads every row the removal will delete — every column, plus the `rowid` — and the Undo re-inserts those rows verbatim: the same ids, the same snapshot figures (macros, micros, amount, unit, count, `piece_name`), the same `created_at`, and the same `rowid` when nothing has taken it since. The `rowid` matters because item reads order by `created_at, rowid`, and a batch logged in one millisecond ties on the first: the middle of three is put back in the middle, not at the end. A meal's place in the list is `(time IS NULL), time, created_at, id`, all restored.

- **It puts back only into the meal the removal left.** `takeMealItem` records the items it left behind, every column; `restoreMealItems` **refuses, writing nothing**, unless the meal still reads exactly that (bar the `updated_at` stamp). The screen closes the offer on its own writes, but not on one it did not make: a queued revision drained on return to the foreground runs `replaceMealItems` under a meal screen still showing the Undo. Putting the butter back beside the olive oil that replaced it would log a meal nobody ate and count the butter twice; putting a part back under a replaced header would fail its foreign key and do nothing silently. (Found in review, 2026-09-23.)
- **Totals come back to the exact figure.** A meal's totals are restored verbatim, and re-derived only when the totals themselves were written over since (the items unchanged). Re-deriving alone is right in arithmetic and wrong in the last bit: `logMealWithItems` sums in JS and `recomputeMealTotals` in SQLite, and the two can differ by one ulp — found by the test, a 189.4 that was not the 189.4 it had been.
- **What SET NULL would have done, the Undo does.** A catalog food or a recipe deleted while the Undo was open comes back as a cleared `food_id` / `recipe_id` — the state the row would be in had it never been removed. The same deletion clearing a reference on the rows the removal *left* is the database keeping its own rule, not the meal changing, so it does not refuse the Undo.
- **A composite comes back whole.** Removing a header takes its parts (0058 cascade); removing the last part takes its header (invariant 4). Both are read before the delete and put back header first.

**The look, timing and wording are the water receipt's** (`src/components/log/quick-add-grid.tsx`), in one shared component, `src/components/nutrition/undo-row.tsx`: a ruled row of the plate it sits in, the 44 pt floor, a 15 pt glyph, the sentence, **Undo** in the label voice. `Removed Greek yogurt · 150 kcal`, `Deleted Lunch · 640 kcal`, `Combined 3 meals into Breakfast`. One voice change: the water row is all mono because `Logged 16 oz` is a measurement; a food's name is speech, so the sentence is serif and only its kcal is mono. No accent, no motion, **no timer**.

**The window** (`src/lib/nutrition/undo-store.ts` — one offer at a time, held in a module because the meal screen closes on delete and the list it returns to has to draw the offer). The precedent's two rules hold: no timer, and the next removal replaces the offer. One is added — **the offer closes when the screen showing it is left**, and on the meal screen when any other write is made there — for two reasons: an item put back beside a scale, a count or a revision made since would build a meal nobody logged; and a deleted meal's files are held until the window closes, which should not outlive the visit.

**Where an offer is drawn.** An item's offer is keyed by its meal and drawn on that meal's screen only. A deleted meal's, or a combine's, is keyed by **the day** — `{ on: 'list', date }` — and drawn only on a list showing that day: the Eat tab for today, history for the day in view. History keeps one screen across its day picker, so without the day a meal deleted from Tuesday was offered under Wednesday, where its Undo put it back on a list nobody was looking at. Stepping back to Tuesday shows it again (`offerDrawnOn`).

**An Undo that cannot be done says so.** When the repository refuses a put-back, `runUndo` settles the offer (so nothing stays held for it) and keeps it in the slot **refused**: the same row reads the offer's `refusal` sentence — *Could not put Butter back — the meal has changed since.*, *Could not split Brunch back into 2 meals — it has changed since they were combined.* — with no button, until the screen is left or the next removal replaces it. Before, the row vanished and nothing came back, and the tap was unanswered. No signal colour: nothing biological went wrong.

**The pairing lives in one place.** Each removal is made WITH its Undo by `src/lib/nutrition/undo-offers.ts` — `removeItemWithUndo`, `deleteMealWithUndo`, `combineWithUndo` — and the screens call those and nothing lower. So the headless suite drives the path the tap drives (§61): a removal wired to the wrong restore, or to none, fails a test rather than a device.

### Photos: the files wait, and the crash story

`deleteMealWithPhotos` removed the photo files at once, and a removed file is the one thing an Undo cannot bring back. **Decided: the rows go at once, the files when the window closes.** The alternative — soft-holding the meal row — needs a column, a migration and a filter on every read of `meals`, for a state that lasts seconds.

- `takeMealWithPhotos` deletes the rows and **holds** the file names (`src/lib/media/held-files.ts`, in memory). Both reconcile passes — `sweepMealPhotos` and `sweepPendingEstimatePhotos` — skip a held name, so no sweep can take a file an Undo is about to need. Today the sweeps run once per launch, before any Undo can exist; the hold makes that timing irrelevant rather than load-bearing.
- **Undo** (`restoreMealWithPhotos`) puts the rows back onto files that were never removed, and releases the hold.
- **The window closes** (`settleMealRemoval`): the files are removed and released — the queued-estimate photo too, which the pending directory's own sweep used to reclaim a launch later.
- **The app killed inside the window**: the Undo and its hold die with the process. The rows are already gone, so on the next launch the files are orphans no row claims and the sweep reclaims them. Neither failure the brief names can happen: a row never survives without its file (rows go first, and come back only through the Undo while the files are held), and no file outlives the next launch.
- **The Coach's delete is the same removal with the window shut at once** — `deleteMealWithPhotos` is now literally take + settle, so the two paths cannot drift (the parity rule, `docs/coach-domains.md`).

### Combine — several meals that were one

**The entry point** is the day list where the meals sit: `Combine` on the Eaten-today plate's own label line, in the label voice, drawn only on a day with two meals that could combine. It turns the rows into checkboxes (a leading square, in ink, never the accent; a meal waiting on its estimate is drawn disabled, its own line already saying why) and adds a foot to the same plate (`src/components/nutrition/combine-meals.tsx`): the **Name** field, the consequence in future tense, and an outlined **Combine N meals**. The resting screen gains one word; no row changes until asked. A swipe or long-press was refused for the reason the water tile's long-press was deleted — an invisible affordance is one the owner never finds. Combining lives on the Eat tab (today's list); the history day view gets the Undo row but not the entry point.

**What the result keeps** — `planCombine` (`src/lib/nutrition/combine.ts`, pure) decides, and `combineMeals` runs the same plan in one transaction:

- **The earliest meal's row** — its id, date and time — in the list's own order (by clock, untimed last, then by when logged). Keeping a row rather than minting one keeps every reference to it valid.
- **The name** typed at the moment of combining, trimmed; untouched or emptied, the earliest meal's own. The field is prefilled, so a quick combine is two taps and never waits on typing.
- **Every item** moves by `UPDATE … SET meal_id` — the same ids, rowids and `created_at`, headers and parts together (0058 invariant 3). The combined meal lists them in the order they were logged.
- **A free-form meal** (typed totals, no items) becomes one item, `<name> (as logged)`, carrying those totals — `addMealItem`'s rule for the same problem, since `recomputeMealTotals` reads items only. An unpriced one becomes a name-only item: what was eaten is a record even unpriced, and the countdown already refused it and refuses the item the same way (`partialMealMetrics`). It is stamped with its meal's own `created_at`, so it sits where that meal was logged.
- **Every photo** moves to the result; its retention clock is its own `created_at` (0033), so nothing expires sooner or later. **The meal screen draws every photo a meal holds**, newest first, each with its own retention caption (`mealPhotoViews`). Before, it drew only the newest — right when a meal held one photo, which before a combine it always does, but after one the others were stored and unreachable while the consequence line promised they "move into it".
- **Notes**: every one kept, in list order. **`source`**: `ai_suggested` when any was — a meal holding an estimate reads as one, as `relogMeal` keeps it.

**Every reference to an absorbed meal, checked:**

| reference | kind | on combine |
| --- | --- | --- |
| `meal_items.meal_id` | FK, CASCADE | moved to the result |
| `meal_photos.meal_id` | FK, CASCADE | moved to the result |
| `pending_estimates.meal_id` | FK, CASCADE, UNIQUE | **refused** — the drain applies `replaceMealItems` to its meal and would replace every other meal's items; combine it once the numbers land |
| `meals.recipe_id` | FK out, SET NULL | kept; two *different* recipes are **refused** (a meal carries one, and "times cooked" counts `meals.recipe_id` — one would be un-cooked). The same recipe twice combines, and its cook count drops by one, which is the point: it was one meal |
| `meal_items.food_id`, `parent_item_id` | FK out / within | unchanged — rows move whole |
| meal templates, recipes saved from a meal, reports | copies | hold numbers and names, never a meal id |
| `ai_messages.tool_calls` (the Coach's record) | ids in JSON, append-only | kept as history; a later read by an absorbed id is refused with "No meal with id …" and pointed at the list. The result keeps the earliest id, so that one still resolves |
| `memory_chunks`, exports | — | carry no meal id |

Also refused, writing nothing: meals from different days, fewer than two, a meal that is gone. Every refusal is a `CombineRefused` whose message is a sentence; the Eat tab re-reads the day, **stays in combine mode**, and shows that sentence above the button (said once, not twice, when the re-read plan already says it). A change to the choice or the name clears it. Before, the checkboxes simply vanished.

**Undo is exact, and given.** `uncombineMeals` deletes the stand-in items, re-inserts each absorbed meal's row verbatim, moves its items and photos back by id — so each keeps its `rowid`, `created_at` and old place — and restores the kept meal's columns as they stood. Every meal row is what it was, so every day total is what it was, to the bit. One cost, stated: the moved rows' `updated_at` records the two moves (the 0014 trigger stamps every UPDATE); it is a write stamp, not the record.

**It refuses unless the combined meal is exactly as the combine left it.** `combineMeals` records the result — its row and every item, every column — and `uncombineMeals` runs only while the meal still reads that (bar `updated_at`), with no revision queued against it. Checking only which item ids it held was not enough (review, 2026-09-23): a pizza halved or a glass of milk re-portioned keeps its id, and the Undo then wrote the old totals over the edited items — the day read 400 kcal while its items added to 250 — and put the old name back over a rename. Now a halve, a re-portion, a rename, a new time or a queued revision refuses it. What it forgives: the same name written again (a stamp, not a change) and a recipe or food deleted meanwhile (the database's own `SET NULL`).

### A multi-scan meal's name

A4 (§13) named a scan's meal after its first product. Once the scanner has put **two** foods into a meal it created, a **Meal name** field sits above Done (`ScanMealName`, `app/barcode-scan.tsx`), prefilled with the name the meal has — the one it would have kept. It is not focused and has no button; Done works untouched, and an untouched, emptied or unchanged field writes nothing (`mealNameToSave`, `format.ts`). A typed name is written through the meal screen's own `updateMealName` on Done, when the field stops being edited, and when the screen goes (an unmount commit, so the back chevron keeps it too). A meal that arrived by `mealId` is someone else's record and is never offered the field (A4's rule). The screen decides none of this itself: `offersScanMealName` gates the field and `commitScanMealName` writes it (`src/lib/nutrition/scan-meal-name.ts`), comparing with the name the database holds — so Done and the unmount that follows it write once, not twice.

### Verification

`db/nutrition-v2.test.mjs` §56–§61, over real SQLite. §56 — an item taken and put back is every column and rowid it was, the middle of its batch back in the middle, and the meal, the day, its fiber and its micros read exactly what they read; a food deleted inside the window returns cleared; a meal that gained an item since is **refused, writing nothing**, while totals alone written over are re-derived; a meal gone is refused; a composite header takes and returns its parts, and a last part its header; **the drain** (the review's probe: butter taken, a revision replacing it with olive oil) refuses the butter, a part whose dish was replaced is refused before its foreign key can fail, a re-portioned neighbour refuses, and a food deleted that the rest of the meal names is forgiven. §57 — a deleted meal's rows go and its two files stay, held; a sweep inside the window leaves them; Undo returns every row of four tables exactly, the day's totals and order, and a drawable photo; settling removes the files; **the crash** (a sweep that holds nothing) reclaims the file with no row surviving; a queued estimate and its photo come back, then settle; a recipe deleted inside the window returns cleared; the Coach's delete holds nothing. §58 — four meals (two itemized, one with a photo and micros, a typed coffee, an unpriced tea) combine with an unchosen pizza untouched: the earliest id and time, the typed name, day totals, fiber and micros unchanged, the countdown refusing exactly what it did, every item moved once and none doubled, two stand-ins in logged order, the photo drawn on the result, notes and `source` kept, `PRAGMA foreign_key_check` empty — and Undo returning every row of every meal table, and the day. §59 — a composite combined stays one tree; a stale Undo is refused and writes nothing; **edits in place** — the pizza halved, the milk re-portioned, the result renamed, its time moved, a revision queued — each refuse the Undo, write nothing, and leave a meal whose totals still add up; the same name written again and a recipe deleted meanwhile do not; the pending, two-recipe, two-day and too-few refusals write nothing; the same recipe twice keeps it. §60 — the pure plan (order, sums over the priced meals only, the name, the sentence), the slot (replace settles, close by kind, Undo never also settles, a failed Undo settles and stays refused with no second try) and where an offer is drawn (its day, or its meal). §61 — **the screens' own paths**: `removeItemWithUndo`, `deleteMealWithUndo` and `combineWithUndo` over a real database — each offer's scope and words, each Undo exact, the settle removing the file, a past day's deletion offered on that day only, a stale combine and a drained item refused and said, `CombineRefused` as a sentence, a combined meal drawing both its photos newest first — and source pins that meal-detail, the Eat tab and history reach these and nothing lower. `db/barcode.test.mjs` §10 — `mealNameToSave`, `offersScanMealName`, a two-scan session named at Done through `commitScanMealName`, the unmount after Done writing nothing twice, and a pin that the screen gates and commits through them on Done and on unmount. `db/screens-render.test.mjs` §24 (§23 on its branch; the logger took §23 first) — the resting Eat tab shows `Combine` and no checkbox; a list offer draws on the Eat tab and in history; a past day's offer draws on that day's history only; a refused Undo keeps its row with the sentence and no button, on the list and on the meal; an item offer draws above Add food on its own meal only; the combine foot in its three states, plus a refused tap (said once when the plan already says it); the scanner's name field prefilled with no button, and absent before any add.

### What only a device can settle

- **Whether `Combine` on the label line is found** — one 11 pt word beside the kcal tally — and whether a row turning into a checkbox reads as a mode.
- **Whether the receipt on the day list reads as the meal just deleted** after the pop animation, and whether closing it on leaving the tab is ever felt as losing an Undo that was wanted.
- **The scanner's name field** — whether it is noticed after the second scan, and whether the keyboard covers Done while it is open.
- **A combined meal's photos stacked** — whether two full-width photos, each with its own caption, read as one meal's evidence or push Totals too far down.
- **A refused Undo on the device** — the drain path (a revision queued offline, then the app foregrounded under an open item Undo) is proven headless; whether the refusal sentence reads as an answer to the tap is the phone's call.
- **Focus across the tab and the stack.** The window closes on `useFocusEffect` blur, and a tab root blurring when a stack screen is pushed over the tab navigator is React Navigation's behaviour; only the device shows it.

## 15. Round 9 — the two notes round 8 left half-done (2026-09-23, migration `0063`)

An independent check of the owner's round-2 notes found two that held on some paths and not others. *"Undo for removing a food"* had an Undo for every LOGGED food, and none on the estimate review, which is where Photo and Describe land. *"Displaying caffeine on a latte"* held for an AI-estimated latte, and not for the app's own catalog latte. Head moves to `0063`.

### Undo on the estimate review

A mis-tapped × on the review sheet (`app/meal-estimate.tsx`, and the Adjust screen `app/meal-revise.tsx`) dropped the model's item, a composite's parts with it. The only way back was estimating the meal again: a second model call, and a different answer.

**What it looks like.** The meal screen's receipt, drawn again (`UndoRow`, `src/components/nutrition/undo-row.tsx`) as a ruled row at the foot of the review plate: `Removed Almond croissant · 380 kcal`, **Undo** in the label voice, spoken *"Undo removing Almond croissant"*. The words come from one function, `removalWords` (`undo-store.ts`), which the meal screen's item × now uses too, so the two cannot drift. When the last row was removed, the row sits under the plate's empty note. No accent: in the review phase the accent belongs to Save.

**Where the state lives.** In the screen, not in the module slot. Nothing is saved yet, so there is nothing to write back and nothing held on disk. Putting a draft removal in `undo-store.ts`' single slot would let a draft × settle, and so finish, a logged removal it has nothing to do with. `src/hooks/use-review-draft.ts` holds the rows and the one open removal as **one** piece of state, so a × computes its removal from the rows as they stand at that update. The hook also owns every edit handler, so neither screen can wire a × without its Undo. The logic is pure and headless-tested: `src/lib/nutrition/review-undo.ts`.

**Exact, or not offered.** The Undo puts back the very row object that was removed, at the index it left. A dish comes back with its parts, its count and its open or closed disclosure. A part comes back at its place among its siblings. A dish whose last part took it (0058 invariant 4) comes back whole. Only a field's focus baselines are dropped, because a field that unmounted mid-edit has no focus left to snapshot from; no figure moves. The offer stands only while that is still true:

| after the × | the Undo |
| --- | --- |
| an edit to another row | stays: a row's figures are its own |
| a field on the removed part's dish loses focus, no figure moved | stays |
| the removed part's dish is halved, re-counted, or a sibling re-portioned | closes: a full-size part beside half a dish is a meal nobody ate |
| a question is answered (a chip, Undo on a chip, or a typed answer landing) | closes |
| a fresh estimate | closes |
| another × | replaced by the new one |

**Why an answer closes it.** Answers are a trail whose entries hold the rows as they stood before each answer (`answerQuestion`, §12n). An answer given after the × was applied to rows without the removed row. Put the row back then, and it returns without that answer's effect while the chip stays lit, and the next change to the answer, rebuilt from the entry's base, drops the row again. So the question hook is handed the hook's **closing** setter (`replace`), and every answer closes the offer. That includes an answer that moved nothing, which is why the rule could not be "close when the rows change". The other order is exact without help: an answer given *before* the × is on the row that comes back, and its trail entry's base never lost the row.

Pre-existing and unchanged: a × on a row an answer created or scaled leaves that answer's chip lit with its row gone. That was true before this round and is not something the Undo introduced. With the Undo it can now be put right in one tap.

### Caffeine on the catalog foods — `0063_seed_caffeine.sql`

0 of the 187 seed foods recorded caffeine: 0016 predates the key (A8). So a latte logged from search, recents or favorites showed no caffeine on its row, and the day's Caffeine cell undercounted it. 0063 adds `caffeine_mg` per 100 g to the five seed rows that carry it, from USDA FoodData Central SR Legacy (cited by NDB number in the file):

| seed row | per 100 g | source | a serving |
| --- | --- | --- | --- |
| Coffee, black | 40 mg | NDB 14209, brewed coffee | 96 mg a 240 g cup |
| Latte, whole milk | 37.4 mg | derived: two shots of NDB 14210 espresso (212 mg per 100 g) in the row's 340 g | 127 mg a 12 oz |
| Cola | 8 mg | NDB 14400, cola with caffeine | 28 mg a 355 g can |
| Dark chocolate, 70-85% | 80 mg | NDB 19904, the record the row's iron and magnesium came from | 8 mg a 10 g square |
| Milk chocolate | 20 mg | NDB 19120 | 9 mg a 44 g bar |

**The latte is a derivation, and the file says so.** FDC's latte is a survey recipe, not an SR Legacy measurement; the espresso is measured. Two shots is the latte this doc already reasons with (§12l's 126 mg). A one-shot latte is half the figure. No screen and no Coach edit writes a food's micros, so a single-shot latte is his own food (Add food) or a Describe, not an edit to this row.

**Left out on purpose** (absent beats guessed, §3): Kombucha (its caffeine varies with the brew, and SR Legacy has no figure), Chocolate chip cookie (a few milligrams, no figure to cite), Trail mix. The catalog has no tea, espresso, cappuccino or energy drink row. Adding rows is a separate change from recording a figure on the rows that exist.

**Matched by id, never by name.** 'cola' is a substring of 'chocolate', and 'coffee' would be a substring of a user's 'Decaf coffee'. And **a row the user changed is his**. No screen edits a catalog food; the Coach's `edit_record` over `food_catalog` can (name, brand, the four per-100 macros, basis, the star), and it can delete one. So each UPDATE writes only where the row is still, column for column, what 0016 seeded: `source = 'seed'`, its seeded `name_norm`, no brand or barcode, `basis = 'g'` (the figure is per 100 g, and 0047 converts nothing), 0016's serving, and 0016's five per-100 figures exactly. A latte re-priced as his café's single-shot oat latte with the name kept is his food, and two shots would be 1.5–2× what it holds. The check is **not** `updated_at = created_at`: starring a food stamps `updated_at` and changes nothing about it, and an edit that writes back unchanged figures is no edit either (migrate §12 proves both). No `caffeine_mg` may be there yet (0 included). `json_set` adds the one key and keeps the rest. A deleted seed row matches nothing.

**History is not touched; a repeat log fills.** `meal_items` are the record of what was eaten, so a latte logged before 0063 keeps the micros it was logged with. But the review found that the two ways the owner repeats a meal copied that gap forward: **Log again** (`relogMeal`) and **a template** (`logMealFromTemplate`) copied `{"calcium_mg":272}` into every new latte, and each copy handed it on. Both now write `repeatMicros` (`repositories/nutrition.ts`): every key the snapshot records, as it was logged, plus every key the **linked food** records now and the snapshot does not, for the snapshot's own amount. It fills and never re-prices: a 63 mg single stays 63, a decaf's 0 stays 0, and the macros are the snapshot's. It fills only where the arithmetic is the food's own: a linked item, an amount, the food's basis. The meal or template being copied is not written. It is a repository rule, not a backfill, so any key a later catalog update adds reaches a repeat log the same way. `meal_template_items` are therefore not written by 0063. A template is a plan and it would be fair game, but filling at log time already covers it. One more consequence to know: an old catalog latte **re-portioned** on the meal screen gains caffeine, because `rescaleLoggedItem` re-derives every figure the food records. **Grounding changes the same way.** An AI item that grounds to one of these five (a model's `Dark chocolate` matches the seed's leading phrase) now takes the USDA caffeine rather than the model's, key by key under `mergeMicros` (§12n). Drinks do not ground here: the model logs them in ml and these rows are in grams.

### Caffeine from a barcode

`parseOffProduct` (`openfoodfacts.ts`) now maps `caffeine_100g`. Open Food Facts normalises every mass nutrient's `_100g` into **grams** (a label's 32 mg per 100 ml arrives as `0.032`), so it converts to milligrams the way sodium does, per 100 of the product's basis.

It gets its **own ceiling**, 10,000 mg per 100 (a tenth of the product), because the generic 50,000 lets through the one error that matters: a contributor typing an energy drink's milligram figure into the grams field reads 32,000 mg per 100 ml, and one can would put 80,000 mg on the day. Instant coffee powder, the densest food in FDC at about 3,142 mg per 100 g (NDB 14214), stays well inside.

**A known limit, left open for the owner.** A product scanned **before** this change is already in the local cache, and a cache hit never re-fetches, so it keeps no caffeine. Editing it does not help, because no edit writes a food's micros. The only way today is to ask the Coach to delete the food and then scan it again. A background re-fetch on a cache hit was considered and not built. The cache records nothing that separates "cached before the mapping" from "Open Food Facts has no caffeine for this", so it would query Open Food Facts on every scan of every product with no caffeine, for good. That turns the offline, send-nothing cache hit into an egress on each repeat scan. It would also land after the portion sheet had opened. Whether to add a "look it up again" action on a scanned food is the owner's call.

### The two smaller questions the brief raised

**(a) A countable plain item read in grams: assessed, not built.** When the model returns `pieces` on a plain item (toast, eggs, wings), `rowsFromEstimate` drops it, and the item reads `100 g` where a counted dish reads `3 slices`. Building `2 eggs` is not small. 0059 put the piece pair on composite headers only and says so in the schema (*"NULL … on every part and plain item forever"*). `portionLabel` reads `piece_name ?? food_serving_name`, which keeps a piece noun and a catalog serving phrase apart; a plain item with both needs a rule for which one wins. And a plain row would need a count control on the review and on meal-detail, with its own scale-from-count arithmetic. There is a cheaper route that may be enough: a plain item that grounds to a catalog food with a serving (`Egg, whole` is `1 large egg`, 50 g) could save `serving_qty` = amount ÷ serving, which the meal screen already prints as `2 × 1 large egg`. That is an owner call between "a plain item can be counted" (reverses a 0059 line) and "only catalog-grounded items read in servings".

**(b) An added item's micros: built.** An `add_item` answer carried `micros: null`, so *"add a shot"* put 30 ml on the review and no caffeine on the day. An answer scales a figure an item already carries (§12l), and an added item has no figure to scale. The effect now carries `micros` (`QuestionEffect`, `parseEffect` through `coerceMicros`), `applyAnswer` puts them on the new row, and both prompts name `micros` on `add_item`. That costs +3 tokens: the estimation prompt goes 995 → **998** of the unmoved 1,000, and the revision prompt 925 → 928. Nothing was trimmed because it fits. The ceiling note now says the next addition takes one of its named cuts first.

### The review (2026-09-23)

An independent review of this round raised five findings. Four were fixed and one is left to the owner:

| finding | outcome |
| --- | --- |
| **Log again and a template never reached the new caffeine** (major): both copied an old latte's `{"calcium_mg":272}` forward | **fixed**: `repeatMicros` fills keys the linked food now records (above) |
| **A pre-change barcode keeps no caffeine** | **left open**: a background re-fetch would query Open Food Facts on every repeat scan for good (above). The doc now states the limit and the one way round it |
| **A square of seed chocolate took a dinner's sodium off its meal row**: `8 mg caffeine` where `1,800 mg sodium` was | **fixed**: caffeine wins the slot from 20 mg (`KEY_CAFFEINE_MG`, `key-micro.ts`). Under that it yields to sodium or fiber over their lines, and still prints when neither is there (§12n's table) |
| **0063 filled a seed latte the Coach had re-priced with its name kept** | **fixed**: each UPDATE also matches 0016's serving and five per-100 figures, brand and barcode (above) |
| **Nothing tested that the hook's `replace` closes the offer** | **fixed**: the step is `replaceDraft` (`review-undo.ts`), driven in §70 with an answer that keeps every key, and pinned by its body in screens-render §26 |

The 20 mg line sits between the seed's own figures: above a serving of its chocolate (8 mg a dark square, 9 mg a milk bar), below a can of its cola (28 mg), its coffee (96) and its latte (127).

### Verification

- `db/nutrition-v2.test.mjs` **§70** (the draft Undo, through the hook's own pure functions): a plain row back in the middle with the identical save; the words equal `removalWords`; an edit to another row keeps the offer; a part back first among its siblings, the dish still open, `126 mg caffeine` again; the dish halved or a sibling re-portioned closes it, a blur does not; the last part's dish back whole; a header × back with both parts; a second × replaces the first; answered "3", ×, Undo returns 189 mg under the lit chip, and changing to "1" rebuilds onto it (63 mg); ×, then an answer (a no-op on the rows) closes the offer; a fresh estimate closes it; the logged-food slot is never touched or settled; Save with an offer open writes the rows on screen. **§71**: the seeded latte found by search records 37.4 per 100 g; one serving snapshots 127.16 mg; the meal row, the Eat tab's meal row and the Caffeine cell read 127; recents and favorites re-log it with caffeine; coffee 96, cola 28.4, dark chocolate 8, milk chocolate 8.8 at their servings. **§72**: both prompts carry `micros` on `add_item` inside the ceiling; an added shot keeps its 63 mg (an off-list key dropped, none is NULL), reads `63 mg caffeine`, scales to 126 at 60 ml, and the saved day reads 189. §62 was updated: its dark chocolate now records caffeine, so the per-key merge is proven on zinc (the model's) beside the food's caffeine, iron and magnesium. After the review: **§70** also drives `replaceDraft`, the hook's own setter. With the croissant × open, the "3 shots" answer keeps every top-level key, so `editDraft` would keep the offer, and `replaceDraft` closes it, in both the updater and the value form. **§66** is updated for the 20 mg line: 20 or 28 mg beats sodium, 8 or 12 mg yields to sodium and 19.9 mg to fiber, and 8 mg alone still prints. **§73**: a latte logged before 0063, logged again, keeps its calcium and gains 127.16 mg, and its row, meal row and Caffeine cell read 127. The macros and portion are the snapshot's, and the source meal is byte-identical. A copy of the copy passes its text through unchanged. The template saved from it logs with 127 mg and is not written. A 63 mg single stays 63 and a decaf's 0 stays 0. Nothing is filled in ml against a gram food, without an amount, unlinked, or once the food is deleted. A relogged dish fills its linked part and leaves the header and an unlinked part alone. **§74**: ramen plus a seed dark square reads `1,800 mg sodium`, the square alone `8 mg caffeine`, and coffee with a salty roll `96 mg caffeine`. The day counts all of it (112 mg).
- `db/migrate.test.mjs` **§12**: staged at 62 with the seed, 0063 changes exactly the five rows, only `micros` (and `updated_at`), with the table's values; the lookalikes stay empty; a second launch applies nothing. On a hostile catalog: the coffee keeps the sodium he added beside its caffeine; a latte he set to 0 keeps 0; a renamed cola, a millilitre chocolate and his own food called 'Cola' are untouched; a deleted row stays deleted; a latte logged before 0063 keeps its snapshot. §11 (a device at 44) now allows `micros`/`updated_at` on those five ids only and asserts each gained exactly its caffeine. After the review, a third catalog is edited as the Coach would edit it. A latte re-priced with its name kept, a coffee given a brand and a milk chocolate with one macro nudged get nothing. A starred dark chocolate (80) and a cola whose figures were written back unchanged (8) are filled.
- `db/barcode.test.mjs` **§11**: `caffeine_100g` 0.032 → 32 mg per 100 ml beside sodium; a 250 ml can caches, logs and reads 80 mg on the day and on its row; the milligram-in-grams typo is dropped; instant coffee's 3,142 is kept; absent, negative or text records nothing.
- `db/screens-render.test.mjs` **§26**: the review plate draws the receipt under its rows, with the button's spoken label; under the empty note when the last row went; nothing without an offer. By source: both screens hold their rows in `useReviewDraft`, pass the offer to the plate, give the question hook the closing setter, and never call `removeRow`. The hook's `replace` is `replaceDraft` and never `editDraft`.

No model was called.

### What only the phone can settle

- **Whether the receipt is seen.** It sits at the foot of the review plate. On a long review with questions above it, a × near the top can put the receipt below the fold.
- **Whether 127 mg matches his latte.** Two shots is an assumption about his café. If his is a single, the seed row cannot be corrected, because nothing edits a food's micros. His own food (Add food) or a Describe is the way, and a Log again of that copies his figure, never the seed's.
- **Whether 20 mg is the right line.** A cola (28 mg) beside a salty dinner now shows its caffeine rather than the sodium. Only his own meals show whether that is the figure he wants on the row.
- **The keyboard and the receipt.** Tapping × with a grams field focused keeps the keyboard up (`keyboardShouldPersistTaps="handled"`), and the offer survives the keyboard going down, since a blur that moves no figure keeps it. The hand decides whether that reads right.
