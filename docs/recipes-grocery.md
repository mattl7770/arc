# Recipes, grocery & import — design & build plan

**Status:** **BUILT, MERGED AND CONFORMED — 2026-08-11.** Migrations **0031** (recipes) + **0032** (grocery), renumbered up from 0030/0031 at the merge because `main` had taken 0030 for coach memory and the runner **silently skips** a migration at or below a device’s `user_version`. Repositories `recipes.ts` + `grocery.ts`; pure libs `ingredients` / `extract` / `import` / `categories` / `quantities`; the eight Coach tools (registry now **39 — 17 read + 22 write**, `docs/ai-coach.md` §2f). All five screens — `recipes` · `recipe-detail` · `recipe-edit` · `recipe-import` · `grocery` — were **restyled from Porcelain Ledger to the Conformed Set** and put through a conformance gate; its 20 findings are fixed (six tap targets under 44pt, a plate surviving its own empty branch, four built class strings, and three idioms drawn three different ways by five parallel restyles). Entry points are the Eat tab’s **Kitchen** rows and its **Log → Cook a recipe** row; import is the recipe book’s own primary action, not a hub row. **Headless:** recipes **88** · grocery **57** · recipe-import **56** · nutrition-remaining **35** · **screens-render 93** (every screen, plus the Eat tab in four states — first run, guarded remainder, guarded fallback, and the tab-root header branch — rendered via react-native-web SSR over the real migrated schema). `npm run db:test` **46 suites / 1,988 assertions / 0 failures**; `db:validate` 20/20; `expo export --platform ios` clean. ⚠️ **Still device-unverified:** look/feel, keyboard, touch, the live share-sheet flow and the app’s own network fetches. The EAS build that activates the share extension and `expo-image-picker` is an owner action (the last attempt failed on provisioning, and a new extension target means credentials must be regenerated — §8’s known gotcha). §10 is the on-device checklist.
**Last updated:** 2026-08-11
**Mission:** close the loop from *"I saw a recipe"* → *"it's in my book"* → *"ingredients are on my list"* → *"I cooked it and it's logged with real macros"* — with the Coach able to read and write every step — while staying local-first, offline-except-AI, adherence-neutral, and Porcelain-Ledger calm.

> **Research base (2026-08-08):** a seven-agent recon pass — four over this repo's conventions (IA, Coach tool contract, nutrition code, DB conventions) and three web sweeps (Osta + the reel-import competitor field; serverless share-extension + caption-fetch feasibility, **empirically tested**; grocery/recipe mechanics across AnyList/Paprika/Mela/Crouton/Grocery/Reminders/MacroFactor) — followed by a three-lens adversarial review of this document itself, whose surviving findings are folded in below (the migration renumbering, the `get_recipe` tool, the partial-sum disclosure rule, the resolved-predicate CHECK, and the first-party share-extension spike all came out of that pass).

---

## 0. The shape, in ten lines

1. **Recipes are first-class tables** (`recipes` + `recipe_ingredients`, migration **0030**), not protocol content and not an extension of `meal_templates` — a template is *what I ate*; a recipe is *how to cook one batch, with instructions and servings*.
2. **Ingredients keep the raw imported line as source of truth**, with a parsed qty/unit/name overlay and an **optional, explicit** link to a catalog food — never fuzzy-matched (the labs rule). Nutrition per serving is computed **only** from resolved ingredients; otherwise the screen says so honestly.
3. **Cooking a recipe logs a meal through the existing stamp path** (`logMealWithItems`) — per-ingredient `meal_items` scaled from the recipe's own snapshots, by servings eaten. Editing or deleting a recipe never touches eating history (0018 discipline). Logging an incompletely-resolved recipe is allowed but **disclosed** — never silently undercounted.
4. **One standing grocery list** (`grocery_items` + a `grocery_name_prefs` memory table, migration **0032**): category sections from a static on-device keyword table, per-item learned re-filing, autocomplete + staples from the user's own history. Check-off is soft — history feeds resurfacing, never deleted.
5. **Import is a ladder, not a scraper**: share/paste URL → platform-aware caption/JSON-LD fetch → one no-tools model turn structures it → **editable review, never auto-commit**. Every rung degrades to the next; paste-the-caption and screenshot-vision are first-class paths, not error states.
6. **Empirically confirmed (2026-08-08):** Instagram serves the full caption in `og:description` to anonymous non-desktop-UA fetches; TikTok's oEmbed is auth-free (`title` = caption); YouTube's watch page carries the full description; recipe sites carry schema.org Recipe JSON-LD (parsed deterministically, no AI). All snapshots-in-time; the ladder assumes any rung can rot.
7. **Anti-fabrication is doctrine:** if the source doesn't contain the recipe, the import says so — it never generates a plausible recipe from a dish name (the documented Flavorish anti-pattern; ARC's "never fuzzy-match a biomarker" rule applied to food).
8. **The share sheet lands via a spike-then-decide:** the already-installed **`expo-sharing` 57.0.8 ships an experimental first-party share-INTO-app extension** (receive API + config plugin, in `package.json` and `app.json` today, riding the next EAS build) — spike it first; adopt **`expo-share-intent` v8** (SDK 57 support confirmed) only if the first-party path fails the requirement. Either way it's behind the guarded-require seam, and the paste-URL path works before it and remains the fallback forever.
9. **The Coach gets batch-input tools** — read: `get_recipes`, `get_recipe`, `get_grocery_list`; write (all confirmation-gated): `add_grocery_items`, `complete_grocery_items`, `add_recipe_to_grocery_list`, `log_recipe`, `save_recipe`. "We need more milk" is the model calling `add_grocery_items`, not a phrase detector — judgment stays in the model.
10. **One new network surface, one ADR:** user-initiated, single-shot recipe-source fetches (the shared URL + its oEmbed/embed variants) join Open Food Facts and air quality as the third sanctioned non-AI exception. Never background, never media downloads.

---

## 1. What the research found (digest)

### The competitor field (Osta and friends)

- **Osta** (iOS id6739286231, 4.8★/~6.6k) imports from Instagram posts/Reels/Stories, TikTok, and websites via **share sheet or pasted link**; it parses **caption/description/comments text only** — "parsing text and captions, not watching the video" (pluckrecipes.com teardown). Its distinctive strength: it also reads **the first comment**, where creators often post the recipe. Its documented failure: ingredients shown only on screen are missed. Free tier forces a ~30s ad per import (the #1 review complaint across this whole category is import quotas/paywalls, ahead of accuracy).
- **The extraction ladder across the field:** caption → first comment → audio transcription (ReciMe) → on-screen-text OCR + frame analysis (Deglaze, the only full-multimodal player) → follow a website link found in the post → give up editable. Every app lands the result in an **editable review screen** — manual correction is an assumed part of the UX everywhere.
- **The anti-pattern, named:** Flavorish, when the caption is incomplete, "will generate one based on available information such as dish name and hashtags" — fabrication presented as the creator's recipe, and the root of its accuracy complaints. ARC explicitly forbids this in the extraction prompt.
- **Websites:** schema.org/Recipe JSON-LD is near-universal on food blogs (WordPress recipe plugins emit it for Google rich results); Mela is metadata-first with ML fallback. Parse deterministically first; AI only when markup is absent.
- **Nutrition:** most recipe apps only display nutrition the source published. Apps that *compute* it from free text (Samsung Food) hit silent wrong-match failures. **MacroFactor sidesteps matching entirely**: a recipe is built from already-resolved food references, becomes a loggable food, and can be "exploded" back to individual editable ingredients — the model ARC adopts.

### Serverless feasibility (empirical, 2026-08-08)

- **Instagram:** `GET instagram.com/reel/<id>/` with **no cookies, no login, residential IP** returns full `og:title`/`og:description` — including a complete ~900-char recipe caption (ingredients, 7 steps, hashtags) — **for every tested non-desktop-browser User-Agent** (iPhone Safari, WhatsApp, facebookexternalhit, Twitterbot, Googlebot, curl, and a CFNetwork/RN-default shape). Desktop-Chrome UA gets a 603KB JS shell with zero og tags. Secondary: `/p/<code>/embed/captioned/` returns the full caption server-rendered (same UA condition). Instagram **oEmbed is dead** for this purpose (requires an approved Facebook app token; legacy endpoints removed April 2025). Private API endpoints 429 instantly — not the path.
- **TikTok:** `tiktok.com/oembed?url=…` is **auth-free JSON** and its `title` field **is the caption**. Share-sheet may deliver `vm.tiktok.com` short links — resolve redirects first.
- **YouTube:** oEmbed is auth-free but title-only; the anonymous watch page HTML contains the **full description** in `ytInitialPlayerResponse.shortDescription` (regex-extractable).
- **The share sheet only ever delivers the permalink URL** — never the video file. This is how every shipped competitor works ("share the link, we process it"). Full video/audio analysis is out of reach serverless — and downloading media is the canonical App Store 5.2.3 rejection. Caption-text import for personal use is the shipped-many-times category (ReciMe, Osta, Recipe Notes are all live).
- **Share-into-app options:** the installed **`expo-sharing` 57.0.8** carries Expo's experimental first-party receive path — `getSharedPayloads` / `getResolvedSharedPayloadsAsync` / `useIncomingShare` plus a complete iOS share-extension config plugin (App Group, entitlements, extension target) — already in this tree at `node_modules/expo-sharing/plugin`. Third-party: **`expo-share-intent` v8.0.1** (published 2026-07-10) explicitly supports SDK 57 (text/webUrl + optional images, cold+warm start, App Group; needs the dev client). react-native-share-menu is dead (2023); MaxAst/expo-share-extension is capped at SDK 54. §8 turns this into a spike-then-decide.

### Grocery & recipe mechanics worth stealing

- **Check-off speed is three stacked mechanisms:** a shipped item→category table that auto-assigns as you type (Paprika/AnyList/Reminders), a per-item learned override that remembers where the user re-filed it, and resurfacing via autocomplete-from-history + favorites/staples (AnyList). The Grocery app (Conrad Stoll) proves a fully on-device, self-improving variant (learned check-off order) with zero taxonomy.
- **Consolidation is a view, never a destructive merge:** Paprika sums same-unit duplicates ("2 eggs" + "3 eggs" = "5 eggs"); **nobody cross-converts** "2 cups flour" + "100 g flour" — AnyList shows one merged line with the individual source lines (and recipe backlinks) inspectable beneath. That's the honest pattern.
- **Apple Reminders' grocery auto-categorization is a private API** — EventKit can't read or write sections, so "sync into Reminders with categories" is impossible; every third-party app ships its own static keyword table. So does ARC.
- **Recipe records converge on ~12 fields** (title, source URL/author, photo, servings, prep/cook time, ingredient lines, steps, tags, notes, optional nutrition). Scaling is naive multiplication with vulgar-fraction formatting; nobody solves "1 egg × 1.5" — they display 1½ and the human copes. Cook-mode essentials: screen-awake, step focus, tap-to-cross ingredients.
- **Reject list** (retention theater / wrong for single-user ARC): sharing/household sync, meal-planning calendar slots (ARC's protocols own the day), discovery feeds, ratings, badges, wink-navigation gimmicks, per-store category sets, nutrition auto-compute over unresolved free text.

---

## 2. Feature design

### 2a. Recipe book

A pushed screen family in the Nutrition domain (IA doc line 39 already pre-slots "grocery, pantry, recipes" as Nutrition growth; the locked five-tab shell and the locked 3×2 Log-tile grid are untouched — entry is from within `app/nutrition.tsx`).

**A recipe is:** title · source (`user` | `import` | `ai`) · source URL + author + platform (when imported) · servings (the batch yield) · prep/cook minutes · ordered steps · ingredient lines · optional total cooked weight (grams — MacroFactor's trick enabling gram-accurate logging of the cooked dish) · tags · notes · favorite flag.

**Ingredient lines are honest about three layers:**
1. `raw_text` — the line as imported/typed. Source of truth, never destroyed.
2. A parsed overlay: `qty` (real), `unit` (free text), `name` — best-effort from `parseIngredientLine`, editable, used for scaling and grocery consolidation. When unparseable, the overlay stays NULL and the raw line still works everywhere.
3. An **explicit** resolution: `food_id` → the catalog + `grams` for this recipe's batch, set only by the user picking a food (suggestions offered only via the sanctioned `isConfidentMatch`-grade exact/leading-phrase logic — never auto-applied fuzzy matching). Resolution snapshots per-batch macros + micros onto the row (the 0018 snapshot discipline), so recipe nutrition survives catalog churn and food deletion (`ON DELETE SET NULL`).

**"Resolved" is a defined predicate, not a vibe:** a line is resolved ⇔ `grams IS NOT NULL AND kcal IS NOT NULL` — snapshot-based, so it survives the food's later deletion (SET NULL leaves the snapshots intact and the line stays resolved). `resolveIngredient` therefore **refuses** a food whose `kcal_100g` is NULL (a food that can't price energy can't resolve a line — same refusal posture as the labs unit converter), and a coupling CHECK in the DDL (§3) makes grams-without-snapshot and snapshot-without-grams unrepresentable.

**Nutrition per serving** = Σ(resolved ingredient snapshots) ÷ servings, displayed under two honesty rules:
- **The gate:** shown only when every ingredient is resolved or explicitly marked `negligible` (water, "salt to taste") — *and* at least one non-negligible line is resolved (a recipe of nothing-but-negligible lines is not "complete" by vacuous truth). Otherwise: *"Nutrition not computed — N ingredients unresolved"*, with the resolve affordance right there.
- **Per-macro honesty:** kcal is guaranteed by the resolved predicate; the other macros are shown per-macro — if any counted line's snapshot lacks protein (an OFF-sourced food without a protein value), the protein cell shows "—", never a partial sum presented as the total. (This is the labs stance: refuse to guess, let the user see what's unmatched.)

**Log it:** a servings stepper (default 1.0; 0.25 steps) → stamps a real meal via `logMealWithItems`: each resolved ingredient becomes a `meal_item` whose macros + micros are the line's **per-batch snapshots scaled by pure multiplication** (`eaten/servings`, micros via `scaleMicros`) — **no live catalog lookup**, exactly like `logMealFromTemplate` copies template snapshots (a deleted or since-edited food must not change what the card promised). Unresolved lines become name-only items with NULL macros. Two disclosure rules keep this honest:
- A **fully unresolved** recipe logs a meal whose totals are NULL (`sumOrNull` semantics) — genuinely honest.
- A **partially resolved** recipe logs a *known undercount* — so the Log-it sheet must disclose it before stamping (*"2 ingredients aren't counted — this logs below the real intake"*), and `meal-detail` shows an "N items not counted" line (derivable from all-NULL-macro items; no schema needed). The Coach's `log_recipe` card carries the same disclosure (§6). Nothing about this is called "honest by construction" — it's honest by being said out loud.

The meal carries `meals.recipe_id` (new nullable FK, SET NULL) so "times cooked / last cooked" are derived facts, not counters. When `total_weight_g` is set, a second mode logs by grams of cooked dish (scale factor `grams/total_weight_g`). Logging from a recipe is the **explode**: per-ingredient items, individually editable afterward in `meal-detail` like any meal. Meals logged from recipes keep `source='manual'` (a cooked-and-confirmed meal is a manual assertion, exactly like template logging — no `meals.source` CHECK rebuild).

**Create paths:** manual editor · **"Save as recipe" from a logged meal** (meal-detail action — the MacroFactor assemble-from-timeline pattern; food-linked items with grams arrive resolved, and items *without* usable grams/kcal land unresolved rather than pretending) · import (§2c) · the Coach's `save_recipe` (§2d). Templates stay what they are (one-tap re-log of an eaten meal); a recipe is not a template and neither replaces the other.

### 2b. Grocery list

**One standing list.** No `grocery_lists` parent table (single user, one household; a second list is a later migration if life ever demands it — deliberately simpler than `data-model.md`'s old `grocery_lists` sketch, recorded in the ADR).

- **Add fast:** an always-focused add field with autocomplete from `grocery_name_prefs` (the user's own history — the highest-leverage speed lever), quantity as free display text ("2", "1 bag", "500 g"). A quiet **Staples** row (starred items, one-tap re-add) and **Recent** chips (recently checked-off — read from `grocery_items.checked_at`, tap to re-add).
- **Sections, not chaos:** category assigned at insert from a static on-device keyword→category table (`src/lib/grocery/categories.ts`, ~12 ARC categories: Produce · Meat & Seafood · Dairy & Eggs · Bakery · Pantry · Frozen · Beverages · Snacks · Spices & Sauces · Supplements · Household · Other). The user re-filing an item **teaches** it (`grocery_name_prefs.category` wins over the static table forever after). Unrecognized → Other, exactly like Reminders does. No AI call required; no network in the loop. (Option, later: a one-time Coach categorize-and-cache pass over stubborn items, in chat.)
- **Check-off is soft-delete into history:** `checked_at` stamps; checked items collapse to a muted "N in cart" section, clearable. Nothing is ever hard-deleted by check-off.
- **Prefs have one owner per column** (so `times_added` can't double-count): **add** upserts the `name_norm` row and owns `times_added`, `last_added_at`, `last_qty_text`, `display_name`; **re-filing** owns `category`; the user owns `is_staple`; **check-off writes nothing to prefs** — recency of purchase is read from `grocery_items.checked_at` directly.
- **From a recipe:** "Add to grocery list" opens a **pre-checked ingredient picker** (uncheck what you have — Mela/Pestle pattern; a real pantry model is deliberately deferred, §9). Added items carry `recipe_id` (SET NULL) so the list can show *"for Chicken Adobo"* and consolidation stays inspectable.
- **Consolidation is a view:** open items grouped by `name_norm`; same-unit quantities summed, different units listed side by side ("2 cups + 100 g") — never converted, never destructively merged (the AnyList pattern; cross-unit conversion needs density data nobody has).

### 2c. Import (the Osta feature, done the ARC way)

**Entry points:** share sheet (Instagram/TikTok/YouTube/Safari → ARC, §8) · paste a URL · paste caption/recipe text · pick/share a screenshot (vision) · manual editor. All land in `app/recipe-import.tsx`.

**URL normalization before the ladder:** `youtu.be/<id>` and `youtube.com/shorts/<id>` → `youtube.com/watch?v=<id>` (deterministic transforms; a Shorts share is the likely form of a recipe video share); `vm.tiktok.com` / `vt.tiktok.com` → follow the redirect and read `response.url`; `instagram.com/stories/…` is **detected and skipped straight to the paste/screenshot rungs** — stories are login-walled with no permalink caption, so this Osta-parity gap is a documented decision, not a crash path.

**The ladder** (each rung falls through to the next, visibly — a failed fetch is a state, not an error):

| # | Rung | Mechanism | Status |
| --- | --- | --- | --- |
| 1 | Website URL | fetch HTML → extract `<script type="application/ld+json">` → walk `@graph` for `@type: Recipe` → deterministic map (name, recipeIngredient[], recipeInstructions[] incl. HowToStep/HowToSection, recipeYield, ISO-8601 durations, nutrition passthrough). **No AI call at all** when markup is present. | Standard; verified prevalence |
| 2 | Website URL, no JSON-LD | strip page text → model turn (rung 6) | Standard |
| 3 | Instagram post/reel URL | fetch with default device UA → parse `og:description` (HTML-entity decode); if absent/truncated → `/p|reel/<code>/embed/captioned/` parse → model turn | **Empirically confirmed 2026-08-08** |
| 4 | TikTok URL | resolve short link → `tiktok.com/oembed` → `title` (the caption) → model turn | **Empirically confirmed 2026-08-08** |
| 5 | YouTube URL (normalized) | watch-page HTML → `ytInitialPlayerResponse.shortDescription` → model turn | **Empirically confirmed 2026-08-08** (watch page; Shorts arrive normalized to it) |
| 6 | Any text (fetched or pasted) | one **no-tools** model turn through `runCoachTurn` (the `estimate.ts` twin): JSON-only contract → `parseRecipeExtraction` (defensive, never trusts shape) | The one AI-online step |
| 7 | Screenshot / photo | same turn with an image block (downscaled ~1024px JPEG via `expo-image-manipulator`); input via **photo-library pick (`expo-image-picker`, added in §8)** or camera | Native deps ride the EAS build train — see §8 |
| 8 | Nothing worked | paste-caption screen with instructions ("tap the caption → copy") · manual editor | Always available, styled as intentional |

**The extraction prompt's hard rules** (mirrors `MEAL_ESTIMATION_SYSTEM_PROMPT` discipline):
- Output ONLY the JSON contract: `{ found: boolean, title, servings, prep_min, cook_min, ingredients: [{raw, qty, unit, name}], steps: [], source_notes }`.
- **`found: false` when the input does not actually contain the recipe** ("recipe on my blog", "link in bio", bare dish-name captions — and a screenshot that doesn't show the recipe gets the same refusal). Never synthesize a recipe from a dish name or hashtags. The UI then surfaces the ladder's remaining rungs — including "this reel's caption doesn't contain the recipe; the video probably shows it — paste it or screenshot the ingredient list".
- Preserve the creator's wording in `raw` lines; parse qty/unit into the overlay, don't rewrite.
- Never invent quantities for ingredients mentioned without amounts — emit them with `qty: null`.

**Review before save, always:** the parsed recipe lands in an editable review (title, servings, per-line ingredient editing, steps reorderable, source shown) — the same never-auto-commit contract as `meal-estimate.tsx` and the labs pipeline. Saving writes `recipes` + `recipe_ingredients` with `source='import'`. Food resolution is **not** part of import review (two cognitive tasks; resolution happens in recipe-detail at the user's pace).

**What's deliberately NOT attempted:** downloading the video or audio (unreachable via share sheet, ToS-hostile, the exact App Store 5.2.3 rejection case, and useless without a transcription pipeline). Deglaze-tier multimodal is a server product; ARC's screenshot-vision rung covers the "silent reel, on-screen text" case honestly.

### 2d. Coach integration

The Coach reads and writes the same repositories the screens use, through the established tool contract (registered `CoachTool`s, every write confirmation-gated with a resolved-names card, one clock read per call, batch inputs — see §6). "Tell it we need more milk" = the model choosing `add_grocery_items` in conversation; "what should I cook tonight?" = the model reading `get_recipes` (+ `get_recipe` for the candidates) + `get_today_snapshot` + targets and reasoning; "what do I need for Chicken Adobo?" = `get_recipe` + `get_grocery_list` diffed by the model — **no hardcoded suggestion rules, no phrase detectors** (the coach-judgment-not-rules memory).

**"Auto suggesting recipes" ships in two stages, deliberately.** V1 is *ask-and-it-reasons* (the tools above make the reasoning real). The *proactive* half — a recipe clause in the daily brief / a `computeInsights` detector ("protein has run 10% under target this week; the book has three high-protein dinners") — is **deferred until usage data exists**, because the insights engine is deterministic-by-doctrine and a noisy nudge teaches the user to ignore the Coach. This deferral is surfaced as open question 6 (§11), not slipped through: if v1 proactivity is wanted, the protein-gap→recipe clause is the candidate with a real detector behind it.

---

## 3. Data model

Two migrations, numbered **0030** and **0031**. ⚠️ **Numbering was corrected once already and must be re-measured at branch-cut:** `main` merged `0029_purge_seed_mission.sql` on 2026-08-08 (this plan's own write date — an earlier draft said "head is 0028" and was wrong within hours). The runner is forward-only (silently skips any number ≤ a device's `user_version`) and **throws on duplicates at boot**; 0005/0006/0010/0019/0022/0023 are permanently dead gaps. **Rule: `git ls-tree main db/migrations` immediately before authoring the SQL files; these numbers are correct as of 2026-08-08 and must be re-verified, never trusted from this doc.**

All house conventions apply: `text` PK `NOT NULL` with app v4 UUIDs via `newId` (randomblob — Hermes has no `crypto`), ISO-8601 text timestamps + per-table `AFTER UPDATE` trigger on mutable tables, enum-as-text + CHECK, `json_valid` CHECKs, GLOB date shapes, `PRAGMA foreign_keys = ON` per connection, `npm run db:bundle` + commit of `migrations.generated.ts`, `db:validate` before shipping.

### `0031_recipes.sql` — `recipes`, `recipe_ingredients`, `meals.recipe_id`

**`recipes`**

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | `newId` |
| `title` | text NOT NULL | |
| `title_norm` | text NOT NULL | lowercased search key, written by the repo (the `foods.name_norm` pattern, LIKE-escape discipline included); indexed |
| `source` | text NOT NULL DEFAULT 'user' | CHECK IN (`'user','import','ai'`) — authored · imported from a URL/text/photo · Coach-designed |
| `source_url` | text | the shared/pasted URL, when imported |
| `source_platform` | text | NULL or CHECK IN (`'instagram','tiktok','youtube','website'`) |
| `source_author` | text | creator/site attribution |
| `source_image_url` | text | og:image / oEmbed thumbnail URL, stored now, **rendered later** (media handling is Phase 4; no silent network fetch to display it before the ADR covers it) |
| `servings` | real NOT NULL | > 0 — the batch yield; the scaling denominator |
| `total_weight_g` | real | NULL or > 0 — final cooked weight; enables log-by-grams |
| `prep_min` / `cook_min` | integer | NULL or ≥ 0 |
| `steps` | text NOT NULL DEFAULT '[]' | JSON array of strings, `json_valid` CHECK |
| `tags` | text | NULL or `json_valid` JSON array |
| `notes` | text | |
| `is_favorite` | integer NOT NULL DEFAULT 0 | CHECK IN (0,1) |
| `created_at` / `updated_at` | text | defaults + trigger (mutable — a recipe is a living document, unlike a logged meal) |

**`recipe_ingredients`** — the three-layer line (§2a):

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | |
| `recipe_id` | text NOT NULL → `recipes(id)` **ON DELETE CASCADE** | a line has no meaning outside its recipe (the `meal_items`/`workout_sets` reasoning) |
| `position` | integer NOT NULL | display order; CHECK ≥ 0 |
| `raw_text` | text NOT NULL | the imported/typed line — source of truth, survives everything |
| `qty` / `unit` / `name` | real / text / text | the parsed overlay; each nullable; `qty` NULL or > 0 |
| `food_id` | text → `foods(id)` **ON DELETE SET NULL** | **explicit** resolution only |
| `grams` | real | NULL or > 0 — resolved grams **per batch** |
| `kcal` `protein_g` `carbs_g` `fat_g` `fiber_g` | real | NULL or ≥ 0 — per-batch snapshot at resolution time (0018 discipline: survives catalog churn) |
| `micros` | text | NULL or `json_valid` — per-batch snapshot |
| `negligible` | integer NOT NULL DEFAULT 0 | CHECK IN (0,1) — "counts as zero for nutrition, on purpose" (water, salt to taste); what makes the all-or-nothing nutrition gate usable |
| `created_at` / `updated_at` | text | defaults + trigger (lines are editable) |

**Coupling CHECK** (makes the resolved predicate structural, the 0014 pair-or-none spirit): `CHECK ((grams IS NULL) = (kcal IS NULL))` — grams-without-energy-snapshot and kcal-without-grams are unrepresentable; the other macros stay individually nullable (a resolving food may genuinely lack fiber — per-macro honesty is §2a's display rule, not a CHECK). `resolveIngredient` writes grams + kcal (+ whatever macros the food knows) atomically; `unresolveIngredient` clears all of them atomically.

Indexes: `recipe_ingredients_recipe_idx`, `recipe_ingredients_food_idx`; `recipes_title_norm_idx`.

**`meals.recipe_id`** — `ALTER TABLE meals ADD COLUMN recipe_id text REFERENCES recipes(id) ON DELETE SET NULL` — the **0013 precedent** (`workouts.routine_id` / `workout_sets.exercise_id` are the repo's FK-carrying ADD COLUMNs; 0017/0028 are the general forward-only ALTER shape). NULL for every existing row. Provenance only: powers "times cooked / last cooked" as derived counts and meal-detail's "from Chicken Adobo" line.

### `0032_grocery.sql` — `grocery_items`, `grocery_name_prefs`

**`grocery_items`** — the standing list, including its history:

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | |
| `name` | text NOT NULL | display name |
| `name_norm` | text NOT NULL | search/consolidation key (repo-written); indexed |
| `qty_text` | text | free display text ("2", "1 bag", "500 g") — the surveyed apps' verdict: light parse for merging, never forced structure |
| `category` | text NOT NULL DEFAULT 'other' | ARC's own vocabulary — free text on purpose (the `metric_type` precedent): the static table + learned prefs own the vocabulary, not a CHECK, so a new category is not a migration |
| `source` | text NOT NULL DEFAULT 'user' | CHECK IN (`'user','coach','recipe'`) |
| `recipe_id` | text → `recipes(id)` ON DELETE SET NULL | backlink for "for <recipe>" + inspectable consolidation |
| `food_id` | text → `foods(id)` ON DELETE SET NULL | optional; set when the item came from a resolved ingredient |
| `checked_at` | text | NULL = open; ISO timestamp = in cart. **Soft state, not deletion** |
| `created_at` / `updated_at` | text | defaults + trigger |

**`grocery_name_prefs`** — the on-device memory that makes the list fast (autocomplete · staples · learned categories · Paprika-style aisle learning), one row per distinct item name. **Column ownership is explicit** (§2b): add-time upsert owns `times_added`/`last_added_at`/`last_qty_text`/`display_name`; user re-filing owns `category`; the user owns `is_staple`; check-off writes nothing here.

| column | type | notes |
| --- | --- | --- |
| `id` | text PK NOT NULL | |
| `name_norm` | text NOT NULL UNIQUE | upsert key |
| `display_name` | text NOT NULL | last-used casing |
| `category` | text | NULL = defer to the static table; set = the user's re-filing, wins forever |
| `is_staple` | integer NOT NULL DEFAULT 0 | CHECK IN (0,1) |
| `last_qty_text` | text | prefill on re-add |
| `times_added` | integer NOT NULL DEFAULT 0 | resurfacing rank |
| `last_added_at` | text | recency rank |
| `created_at` / `updated_at` | text | defaults + trigger |

Maintained by the repository in the same transaction as the add it records (the recompute-in-transaction discipline from `logMealWithItems`).

---

## 4. Code surface

**New repositories** (depend only on the `Database` interface; headless-tested):

- `src/lib/db/repositories/recipes.ts` — `createRecipe`, `updateRecipe` (meta + steps), `deleteRecipe` (ingredients CASCADE; logged meals keep `recipe_id → NULL`), `getRecipe`, `listRecipes` (search over `title_norm`, favorites boosted, newest-cooked surfaced), `setRecipeFavorite`, `addIngredient` / `updateIngredient` / `removeIngredient` / `reorderIngredients`, `resolveIngredient(db, id, foodId, grams)` (refuses a food with NULL `kcal_100g`; snapshots macros+micros via `servings.ts` at resolution time; `unresolveIngredient` clears atomically), `setIngredientNegligible`, `recipeNutrition(db, id)` → `{ perServing: {kcal, protein_g|null, …}, unresolvedCount, complete: boolean }` (per-macro nulls per §2a), `logRecipe(db, id, portion, date, time)` — portion is `{servings} XOR {grams}` (neither → servings 1; both → error; grams without `total_weight_g` → corrective error) — **pure snapshot scaling, no `foods` lookup**, stamps via `logMealWithItems` + `meals.recipe_id`, `saveMealAsRecipe(db, mealId, title, servings)` (retroactive assembly; gramless/kcal-less items land unresolved), `recipeCookStats` (derived from `meals.recipe_id`).
- `src/lib/db/repositories/grocery.ts` — `addGroceryItems(db, items[])` (batch; consults static categories + prefs; upserts prefs in-transaction per the §3 ownership rules), `listGroceryItems({open|checked})` grouped by category, `checkGroceryItem` / `uncheckGroceryItem` (stamps/clears `checked_at`), `clearCheckedItems`, `updateGroceryItem` (name/qty/category — a category change writes the pref), `removeGroceryItem`, `addRecipeToGroceryList(db, recipeId, includeIngredientIds[])`, `searchGroceryHistory(prefix)` (autocomplete), `listStaples`, `setStaple`, `consolidatedOpenList` (the view-merge: grouped by `name_norm`, same-unit sums, cross-unit side-by-side, source backlinks).

**New pure libs** (fetch-injected where network is involved; every parser headless-tested against pinned fixtures, the `health-mapping` discipline):

- `src/lib/recipes/ingredients.ts` — `parseIngredientLine` (qty/unit/name overlay; vulgar fractions, ranges, unicode ½), `scaleQty` + `formatQty` (fraction display; raw-text fallback when unparseable — the Paprika constraint), `normalizeUnit` (display only — **no cross-unit conversion**).
- `src/lib/recipes/extract.ts` — pure parsers: `extractJsonLdRecipe(html)` (walks `@graph`, handles `@type` string|array, HowToStep/HowToSection, ISO-8601 durations, free-text `recipeYield`), `extractInstagramCaption(html)` (og:description + entity decode; `/embed/captioned/` variant), `extractTikTokCaption(oembedJson)`, `extractYouTubeDescription(html)`.
- `src/lib/recipes/import.ts` — `normalizeSourceUrl(url)` (youtu.be + `/shorts/` → watch; TikTok short-link redirect note; Stories detection → ladder skip), `detectPlatform(url)`, `fetchRecipeSource(url, fetchImpl)` (the ladder §2c; UA = the device default — confirmed sufficient; 10s abort; distinguishes offline / login-wall / not-found like `OffLookupError`), `buildRecipeExtractionRequest` + `parseRecipeExtraction` (the `estimate.ts` twins: no-tools `runCoachTurn`, JSON-only contract, `found:false` honesty), `importRecipe(input)` orchestrator returning a review-ready draft — **throws `RecipeImportUnavailableError` without a key, exactly like `estimateMeal`**.
- `src/lib/grocery/categories.ts` — the static keyword→category table + `categorizeGroceryItem(name, prefs)`.

**Hooks:** `useRecipes`, `useGrocery` — the sanctioned shape (synchronous `useState` initializer read + `useFocusEffect` reload).

**Tests:** `db/recipes.test.mjs` (CRUD, CHECKs incl. the grams/kcal coupling, resolution snapshots + the NULL-kcal refusal, SET-NULL survival keeping lines resolved, logRecipe portion XOR + snapshot-only scaling + the partial-undercount stamp, nutrition gate incl. `negligible`, vacuous-complete, per-macro nulls, saveMealAsRecipe, cook stats), `db/grocery.test.mjs` (batch add, prefs ownership rules — one add + one check-off increments `times_added` exactly once, check-off soft state, consolidation view, recipe backlinks), `db/recipe-import.test.mjs` (fixture HTML/JSON per platform: og-tag page, captioned-embed page, TikTok oEmbed, YouTube watch page **and a Shorts URL normalizing to it**, three JSON-LD shapes incl. @graph and HowToSection, malformed JSON-LD, a `found:false` caption, a Stories URL skipping the fetch rungs; `parseIngredientLine` table), plus new numbered sections in `db/coach-tools.test.mjs`. Each suite appended to the `db:test` chain.

---

## 5. Screens & IA

Five new flat kebab-case routes, registered as siblings in the nutrition family block of `app/_layout.tsx` (the locked convention — no nested groups):

| Route | Screen |
| --- | --- |
| `app/recipes.tsx` | The book: search field, favorites row, list rows (title · serif; per-serving kcal when complete · mono; source badge · muted; last cooked). One pine action: **Import a recipe**. |
| `app/recipe-detail.tsx` | Title + source attribution line · servings/time row (mono) · ingredients (raw line; resolved lines show mono macros; unresolved show a quiet "link" affordance; `negligible` renders struck-muted) · steps (numbered, generous line-height — this is where Porcelain Ledger shines) · nutrition block (complete → per-serving mono table with per-macro "—" honesty; else the honest unresolved line) · actions: **Log it** (the one pine action; servings stepper sheet **with the undercount disclosure when partially resolved**), Add to grocery list (ghost), Edit, Save as favorite. Cook mode v1 = `useKeepAwake` while the screen is open + tap-to-mark-step (kept deliberately modest; a full-screen step mode is a later slice). |
| `app/recipe-edit.tsx` | Manual create/edit: meta fields, ingredient line editor (add/reorder/remove; per-line parsed-overlay fields), steps editor. |
| `app/recipe-import.tsx` | The ladder UI: URL field (prefilled by share intent) · paste-text mode · photo mode → fetching → **editable review** (never auto-commit) → Save. Failure states are typeset instructions, not alerts ("This caption doesn't contain the recipe. Paste it, or share a screenshot of the ingredient list."). |
| `app/grocery.tsx` | Add field (autocomplete dropdown from history) · Staples chips · category sections with check-off rows (tap row = check; mono qty right-aligned) · collapsed "N in cart" section with Clear. No pine on this screen except nothing — check-off marks use the standard completion stamp semantics. |

**Entry points (as built, 2026-08-11):** the Eat tab carries a **Kitchen** section — a plate of two rows, **Recipe book** and **Grocery list**, each with its live state in the row BODY (`24 recipes · 3 cooked this month`, `12 to buy · 3 in the cart`), never in the chevron slot. The grocery figure is `openGroceryLineCount` — the LINES `/grocery` draws — not `openGroceryCount`'s raw rows, which double the moment two recipes both want milk. **Import is NOT a hub row** (owner call, 2026-08-11): it is the recipe book's own primary action, and the share sheet reaches `/recipe-import` without passing through the hub. **Cook a recipe** is also a row in the Eat tab's Log sheet, so logging from the book no longer requires opening the recipe first. `app/meal-detail.tsx` gains "Save as recipe". No Log-tab tile changes (locked 3×2 grid), no Home changes (sacred; a "cook X tonight" can reach Home only as a protocol/mode mission item or via the Coach's brief channel — both already exist and need nothing from this plan).

**Design notes:** adherence-neutral throughout (no red states, no streaks); numbers mono; serif headings; one pine action per screen; `≈` + muted `est` for AI-derived values; two-tap arm/confirm deletes; every Pressable carries accessibility props. Recipe hero images are **not rendered in v1** (`source_image_url` is stored; display waits for the Phase 4 media decision — no quiet network image fetches).

---

## 6. Coach tools

Eight new tools, shipped **as one batch** (each tool-list change invalidates the cached prompt prefix — batch, don't dribble). Registry goes 24 → 32 (**14 read + 18 write**). All follow the house contract: JSON-Schema inputs with `additionalProperties:false`, validation helpers, `execute` returns compact JSON (caps + omitted-count pattern — never dump a whole recipe book into a turn), every write's `confirmSummary` resolves names (never bare ids) and takes the required `CoachToolContext {now}`. **Every id a write tool consumes is an id a read tool returned** — the `list_reminders → complete_reminder` contract.

**Read:**
- `get_recipes` — `{query?, favorite_only?, limit? (def 10, max 25)}` → `[{id, title, servings, perServingKcal|null, nutritionComplete, lastCooked|null, timesCooked, tags}]` + `omitted` count. The browse/suggest surface.
- `get_recipe` — `{recipe_id}` → full detail: steps, per-line ingredients `{id, raw, qty, unit, name, resolved, negligible}`, per-serving nutrition + `unresolvedCount`. One recipe is bounded, so it fits the compact contract. This is what makes *"what do I need for Chicken Adobo tonight?"* and the grocery-diff real, and it feeds `add_recipe_to_grocery_list.exclude`.
- `get_grocery_list` — `{include_checked?}` → open items grouped by category, each `{id, name, qty, forRecipe|null}` + counts. Ids are load-bearing for `complete_grocery_items`.

**Write (all confirmation-gated):**
- `add_grocery_items` — `{items: [{name, qty?, note?}]}` (**batch** — one card, one approval; N single-item calls would mean N cards and burn the 8-call turn budget). Card: `Add 3 items to the grocery list: milk · eggs (12) · spinach`. Items land `source='coach'`. Doctrine: read the list first when unsure — never re-add an open duplicate.
- `complete_grocery_items` — `{ids: []}` batch check-off; card resolves every name: `Check off 2 items: milk · eggs`.
- `add_recipe_to_grocery_list` — `{recipe_id, exclude?: [ingredient ids from get_recipe]}`; card: `Add 8 ingredients from "Chicken Adobo" to the grocery list`. (This subsumes the `generate_grocery_list` idea reserved in `docs/ai-coach.md` §2e — composing a list across several recipes is the model calling this per recipe, not a bespoke generator.)
- `log_recipe` — `{recipe_id, servings?, grams?, date?, time?}`; validation mirrors the repository: servings XOR grams, neither → 1 serving, grams without `total_weight_g` → corrective error. Card: `Log 1.5 servings of Chicken Adobo (~820 kcal) · today` (backdates named per the `dateSuffix` pattern); when resolution is incomplete the card says so — `Log 1.5 servings of Chicken Adobo (nutrition incomplete — 2 ingredients uncounted) · today`.
- `save_recipe` — `{title, servings, ingredients: [{raw, qty?, unit?, name?}], steps: [], notes?}` → `source='ai'`, **unresolved lines only** (the Coach never asserts food resolutions — those are the user's explicit act in the UI, same as import). Card: `Save recipe "High-protein chili" — 6 ingredients, 4 servings`. This is the "Coach designs a recipe in chat" path.

**Doctrine additions** (sync trio: `system-prompt.ts` TOOL_DOCTRINE + `docs/ai-coach.md` §2 tables/counts + `db/coach-tools.test.mjs` sections):
- Grocery: "add items when the user says they need something — including implicitly (`we're out of milk`). Batch every add into ONE call."
- Recipes: "suggest from `get_recipes`/`get_recipe` + today's context; never invent a recipe the book doesn't have when asked what's *available* — offer `save_recipe` to create one instead. Never present computed nutrition as measured, and say when a recipe's nutrition is incomplete."
- **URLs pasted in chat:** the Coach has no fetch capability and no import tool — doctrine tells it to hand the user to the import screen ("share it to ARC or open Nutrition → Recipes → Import and paste it there"), never to pretend it read the link. (A future `import_recipe_from_url` tool is a recorded non-goal for now — §9 — since it would put a network fetch inside a Coach turn; the ADR's user-initiated framing would need explicit extension.)
- Import honesty carries over: the Coach never fabricates a recipe from a dish name and presents it as imported/the creator's.

**Withheld for now** (the `stubs.ts` rule — a tool that always fails teaches the model not to call it): nothing in this set needs withholding; all eight are fully buildable on the new repos.

---

## 7. Network posture & the ADR

This plan adds **one** new network surface: at import time, the app fetches the **user-shared/pasted URL** (and its derived oEmbed/`/embed/captioned` variants). Everything else is either offline (recipes, grocery, logging, categories) or the existing AI exception (the extraction model turn, the screenshot vision turn).

**Proposed ADR for `docs/decisions.md`** (owner sign-off required before Slice 2 ships):

> *2026-08-XX — Recipe import adds a third sanctioned non-AI network exception.* User-initiated, single-shot fetches of a recipe source the user explicitly shared or pasted (the URL itself; its oEmbed endpoint; its embed-captioned variant), at import time only. Never in the background, never polling, never media downloads — caption/metadata text only. Failure degrades to paste-the-caption / screenshot-vision, which must remain first-class UI. Rationale: the alternative is a proxy server, which the architecture forbids. Companion rule: App Store metadata and UI never use "download from Instagram" phrasing — this is "save recipes you were sent" (the shipped-and-approved category; media downloading is the 5.2.3 rejection case).

Implementation notes: default device User-Agent (empirically sufficient — no crawler-UA spoofing), 10s abort, honest tri-state errors (offline vs login-wall vs no-recipe), and **every fetch result is treated as untrusted input** — parsed defensively, never executed, capped in size before it reaches a model prompt.

---

## 8. Native dependency plan (share sheet + photo pick)

- **Spike outcome (2026-08-08): the first-party path is IMPLEMENTED.** `expo-sharing` 57.0.8's experimental share-INTO-app extension is configured in `app.json` (`ios.enabled` + an activation rule of Text · 1 WebURL · 1 Image — the image admits screenshot shares straight into the vision rung) with the plugin's defaults for the App Group (`group.com.arcresilience.app`) and extension bundle id; `npx expo config --type prebuild` evaluates the chain cleanly and registers the `expo-sharing-extension` target in `appExtensions` (what EAS reads to provision it). Delivery is wired end to end in JS: `app/+native-intent.ts` redirects expo-sharing deep links to `/recipe-import`; the screen consumes payloads once via the guarded seam (`src/lib/recipes/incoming-share.ts`) and the pure router (`share-payload.ts`: explicit URL > URL-inside-text > text→paste-prefill > image→vision, pinned in `db/recipe-import.test.mjs` §8); a shared screenshot reads to base64 through `expo-file-system`'s File API (already in the build). Everything no-ops gracefully on a binary without the extension. **`expo-share-intent` v8** (third-party, SDK-57 confirmed) remains the recorded fallback ONLY if the experimental path's cold/warm delivery fails on-device verification.
- What remains is strictly the build + device pass: cold-start share (app killed), warm-start share, from Instagram/TikTok/Safari, and a screenshot share — none of it verifiable in Expo Go, the web preview, or headless.
- **`expo-image-picker` is added in this tranche** (new native dep, EAS ledger + `NSPhotoLibraryUsageDescription` purpose string): rung 7's *"share a screenshot of the ingredient list"* needs photo-library access, and nothing installed provides it (`meal-estimate.tsx` is live-camera capture only). Until its build ships, the screenshot rung is built-but-dormant behind the standard guarded degradation — the paste-caption rung covers the gap.
- **Guarded seam** (the `healthkit.ts` pattern) for whichever share module lands: try/catch require, shape-check, degrade to null; without the module the app runs identically minus the share target, and the paste-URL path covers everything. Headless tests never touch it.
- **EAS build ledger:** these join the *next* build's additions (alongside HealthKit + nitro-modules per the project-status caveat). ⚠️ Two known gotchas from the wearables merge apply verbatim: (1) a share extension is a **new target + App Group entitlement** → the provisioning profile must be regenerated or the build fails on a cryptic signing error — clear cached credentials and let EAS re-issue before debugging anything else (note: the last EAS build attempt **already failed on provisioning** before any of this); (2) nothing about the extension or photo pick is testable until that binary is installed — Slice 4 is deliberately last, and every vision rung is device-inert until the build train succeeds.

---

## 9. Deliberately out (and why)

- **Video/audio download or transcription** — unreachable via the share sheet, ToS-hostile, the canonical 5.2.3 rejection, and a server product in disguise. The screenshot-vision rung covers the honest remainder.
- **A Coach `import_recipe_from_url` tool** — it would put an arbitrary-URL fetch inside a Coach turn; the ADR sanctions *user-initiated* import-screen fetches, and stretching it to chat is a separate decision. Doctrine (§6) makes the Coach hand the user to the import screen instead. Revisit only with an explicit ADR extension.
- **Pantry / inventory tracking** — the brief names it, but a maintained-by-hand inventory is the most-abandoned feature in this category. The grocery history (`grocery_name_prefs` + checked history) is the substrate a lightweight "probably have it" heuristic can grow on later; the recipe→list pre-checked picker is the 80% today. Revisit with real usage.
- **Meal-planning calendar** — ARC's protocols/mission system owns the day; a recipe can become a protocol item by name today. No second planner.
- **Cross-unit ingredient consolidation** — needs density data; every shipped app punts. Group, don't merge.
- **Nutrition auto-compute over unresolved free text** — Samsung Food's silent-wrong-numbers failure mode. Resolution is explicit or nutrition is absent (labs stance).
- **Multiple grocery lists / sharing / household sync** — single user, one device.
- **Reminders sync** — EventKit can't touch grocery sections (private API); flat-item sync adds a second source of truth for nothing.
- **Recipe discovery / social / ratings / import quotas** — retention theater; ARC has no monetization pressure (the user brings their own key).
- **Auto-categorization via AI per item** — the static table + learned prefs cover it offline with zero latency; an AI tidy-pass can be a chat action later.
- **Weekly macro charts** — named alongside the recipe builder in `docs/nutrition-subapp.md`'s status line; **consciously deferred out of this tranche, not forgotten**: it's a Data-tab/nutrition-history visualization with no coupling to recipes or grocery. It must keep a tracking home when that status line is rewritten (§12 item 7).

---

## 10. Build slices & sequencing

Each slice is a vertical, shippable, independently-verifiable unit. Headless gates for every slice: `npm run typecheck` · `lint` · `format:check` · `db:validate` (bundle regenerated + committed) · `db:test` (new suites green) · `npx expo export --platform ios`. **Each slice also carries explicit on-device obligations** (the project memory: verify on device, not web — the web bundle is a logic check, never a look/feel or native-behavior verdict).

**Slice 1 — the offline core (no network, no native deps, no model).**
Migrations 0030 + 0031 (re-verify head against `main` first) · both repositories + `ingredients.ts` + `categories.ts` · `db/recipes.test.mjs` + `db/grocery.test.mjs` · screens: `recipes`, `recipe-detail` (incl. Log-it stamping + disclosure, nutrition gate, resolution flow), `recipe-edit`, `grocery` · nutrition-hub entry rows · meal-detail "Save as recipe" · `expo-keep-awake` declared as a direct dependency (already in every binary via `expo` — no rebuild needed).
*Device obligations:* all five screens rendered on the installed build; the grocery add field + autocomplete dropdown exercised above the live keyboard (the Coach-screen keyboard-offset caveat is this exact class of bug); keep-awake observed in recipe-detail. *Everything here works with the network unplugged, forever.*

**Slice 2 — import (the one new AI path + the ADR).**
ADR into `docs/decisions.md` (owner sign-off) · `extract.ts` + `import.ts` + fixtures + `db/recipe-import.test.mjs` · `recipe-import.tsx` (URL/paste/photo → review → save; the photo mode ships built-but-dormant until the §8 build).
*Device obligations:* the three platform rungs exercised **from the app's own fetch on a real device, on Wi-Fi and cellular** (the 2026-08-08 empirics were desktop-curl snapshots; Instagram's UA/IP behavior is the fragile rung and must be re-proven from RN's fetch stack at build time) · the offline / login-wall / no-recipe tri-states each seen once. *Vision rungs are explicitly untestable until the EAS build train succeeds — state it in the slice's status line, project-status style.*

**Slice 3 — Coach tools (one batched registry change).**
The 8 tools + doctrine + `docs/ai-coach.md` §2/§10 updates + `coach-tools.test.mjs` sections. Registry 24 → 32; one prompt-cache invalidation.
*Device obligations:* one real confirmation-card round trip per write tool in the Coach thread (approve at least one; decline at least one and watch the model move on).

**Slice 4 — the share sheet (rides the next EAS build).**
The §8 spike (first-party `expo-sharing` receive vs `expo-share-intent`), App Group, routing → `/recipe-import` · guarded seam · `expo-image-picker` lands in the same build.
*Device obligations:* cold-start share (app killed) and warm-start share, from Instagram, TikTok, and Safari; a screenshot share/pick through rung 7. The provisioning-profile regeneration caveat applies — the last build attempt already died on it. Until this build ships, paste-URL is the import entry — fully functional.

Suggested order: 1 → 2 → 3 → 4. Slices 2 and 3 are independent of each other (either can go first after 1); 4 is gated on the EAS build train regardless.

---

## 11. Open questions for the owner

1. **The ADR (§7)** — sign off on the third network exception before Slice 2? (Without it, import still ships in paste-text/screenshot-only form — genuinely useful, zero new network surface.)
2. **`save_recipe` for the Coach** — comfortable with the Coach authoring recipes into the book (always via the confirmation card, `source='ai'`), or hold it back initially?
3. **Servings stepper default** — 1.0 serving with 0.25 steps assumed; and is log-by-cooked-grams (via `total_weight_g`) worth the second input mode in v1, or a later polish?
4. **Grocery categories** — happy with the proposed ~12, or trim/rename before the static table is authored? (Cheap to change later — it's a TS constant + free-text column, not a schema vocabulary.)
5. **Share-extension path** — the plan spikes the already-installed first-party `expo-sharing` receive path before considering `expo-share-intent` (§8). Any preference? And: batch it with the next EAS build attempt, or land Slices 1–3 first? (Plan assumes the latter.)
6. **"Auto suggesting recipes" scope** — v1 ships *ask-and-it-reasons* (the tools make it real); **proactive** suggestions (a brief clause / insights detector, e.g. protein-gap → high-protein recipes from the book) are deferred until usage data exists, per the deterministic-insights doctrine. Approve the deferral, or name the one proactive trigger you want in v1.

---

## 12. Integrator-merge points & doc-sync obligations

| # | Item | Kind |
| --- | --- | --- |
| 1 | Migrations 0030/0031 (**re-measure head against `main` at branch-cut** — 0029 is taken by `purge_seed_mission`) → `npm run db:bundle`, commit `migrations.generated.ts` | required with Slice 1 |
| 2 | `package.json` `db:test` chain += 3 suites; `expo-keep-awake` declared (Slice 1); `expo-image-picker` added (Slice 4 build) | Slice 1 / 2 / 4 |
| 3 | `app/_layout.tsx` += 5 routes in the nutrition family block (comment cites this doc) | Slice 1 / 2 |
| 4 | `docs/ai-coach.md` §2 tables + both tool-count lines (24 → 32: 14 read + 18 write); `system-prompt.ts` TOOL_DOCTRINE (sync trio) | Slice 3 |
| 5 | `docs/decisions.md` — the §7 ADR + a note that recipes shipped as first-class tables (superseding `data-model.md:175`'s "can start as protocol content" sketch) | Slice 2 (ADR) / Slice 1 (note) |
| 6 | `docs/project-status.md` — To-Do rows + the schema inventory of record (tables +4 → 40, head → `0031`, repositories +2 → 27 — **re-measure, don't copy**) **in the same change that ships them** | each slice |
| 7 | `docs/nutrition-subapp.md` status line — point its "next slice" at this doc **and re-home the still-open "weekly macro charts" promise** (a named row in project-status §1) so the doc-sync doesn't erase it | Slice 1 |
| 8 | `app.json` — share-extension config (whichever module the §8 spike picks) + App Group + `NSPhotoLibraryUsageDescription`; EAS credentials refresh for the new target | Slice 4 |
| 9 | `docs/information-architecture.md` — tick "grocery, recipes" from line 39's growth list as they land | Slice 1 |
