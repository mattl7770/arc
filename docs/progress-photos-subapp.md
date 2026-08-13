# Progress Photos — the body-progress gallery, import, and on-demand AI reading

**Status:** Spec — designed 2026-08-12 in a docs-only round. **Nothing here is built**; no migration has shipped and no route exists. The Data tab's "Progress photos" row (`app/(tabs)/data.tsx`, the `photos` entry) stays a disabled "Later" chip until this spec's v1 lands.
**Owner decisions already taken (2026-08-12):** on-demand AI analysis is **in** (user-triggered, never automatic); the build itself is a later round.
**Read first:** `CLAUDE.md` (§2 principles, §9 DB conventions) · `docs/architecture-migration.md` §Phase 4 (the 2026-07-24 media policy this spec amends) · `docs/labs-subapp.md` (the import-review-commit discipline this spec copies) · `src/lib/media/photo-library.ts` (the guarded picker seam this spec widens) · **`db/migrations/0033_meal_photos.sql` + `src/lib/media/photo-file-store.ts`** (the durable-photo substrate that landed hours after this spec's first draft — this feature is that substrate's third consumer, not a new invention; see §1a).

---

## 1. The storage reality — what changed between the policy and this spec

The 2026-07-24 owner call (`docs/architecture-migration.md` §Phase 4) was: **progress pics → PhotoKit reference + thumbnail.** iCloud Photos owns the original at full quality and backs it up; ARC stores only a reference, keeping its own footprint and backup blob tiny; a thumbnail guards against the referenced photo being deleted; an "important" flag forces a full in-app copy.

Two facts landed after that policy was written, and both bear on it:

1. **The reference cannot be honored in v1 at all.** Re-fetching an original by its PhotoKit id needs `expo-media-library` (`getAssetInfoAsync`) — a native module that is **not installed and not in any planned build**. Without it, ARC's only access to the pixels is *at pick time*, through the picker's returned URI (a cache copy iOS may reclaim). A stored reference would be a reference nothing can follow.
2. **Even with MediaLibrary, the reference dies at restore.** The audit finding already recorded in `architecture-migration.md` holds: PhotoKit `localIdentifier`s are device-local and do not survive restore-to-a-new-phone. The stable id is `PHCloudIdentifier` — and **no Expo module exposes it** (verified 2026-08-12: expo-media-library's API is localIdentifier-based throughout). On a fresh phone, every reference dangles at once, degrading the entire progress history to whatever ARC stored itself.

**The amendment this spec proposes (⚑ MATT #1):** the always-stored artifact is not a thumbnail but a **working copy** — longest edge 1600 px, JPEG q0.7, ≈180–350 KB per photo, made at pick time via `expo-image-manipulator`. One file serves four jobs: the gallery cell (RN's `Image` downscales at render), the full-screen view, the dangling-reference fallback, and the AI-analysis payload source (downscaled again to 1024 px on send, the exact size `photo-library.ts` already feeds vision models).

Footprint, stated so the trade is a number and not a vibe: 3 poses/week ≈ **40–55 MB/year, ≈0.5 GB/decade** — against the ~3 GB/decade food-photo budget the 2026-07-24 ADR already accepted. The *spirit* of the policy survives intact: iCloud Photos still owns the original at full quality; ARC's copy is a working record, not a keepsake; and `is_important` still forces a **full-resolution in-app copy** (possible only at pick time in v1 — retro-flagging keeps only the working copy, and the UI says so; retro-fetch is a MediaLibrary-era feature).

`asset_id` (the picker's localIdentifier) is stored anyway, as **dormant provenance**: never read in v1, it powers duplicate detection today and is the hook a future MediaLibrary / PHCloudIdentifier upgrade re-links through.

### 1a. The substrate landed the same day — build on it, don't reinvent it

Hours after this spec's first draft, migrations **0033** (meal photos) and **0034** (recipe photos) merged and settled the storage mechanics this section had proposed from scratch — converging on the same reasoning independently:

- **The DB stores a bare file NAME, never a path** — 0033's header calls this "the load-bearing decision", for the exact reason this spec had given: iOS re-issues the app container's UUID on every install, so a stored absolute path is a dangling pointer after the next build. 0033 enforces it with a CHECK (must end `.jpg`, must contain no separator) so no caller can quietly store a path again. This spec adopts that CHECK verbatim.
- **The file half is a store module** that resolves the directory at read time: `src/lib/media/photo-file-store.ts` is the **generic store** (extracted in 0034 when recipe photos became its second consumer — `nativeStoreIn(directory)`, `photoFileName()`), with `meal-photo-store.ts` and `recipe-photo-store.ts` over it. **Progress photos are the third consumer**: a thin `progress-photo-store.ts` over `nativeStoreIn('progress-photos')`, inheriting the reconciliation passes (dangling names, orphan files) the other stores run on app open.
- **Retention:** none — the recipe-photo precedent, stated in 0034's notes: a meal photo is evidence for one day's estimate and expires; "a recipe is a document the owner keeps for years." A progress photo is the strongest case of the keeps-for-years kind. (The meal store's 7-day sweep must NOT be inherited.)

*(This spec's first draft placed files under `Library/` beside `arc.db`; the shipped substrate roots its stores under the app's Documents directory, which stays private — the 2026-08-07 decision kept `UIFileSharingEnabled` out of app.json, so Documents is not user-visible. Follow the substrate: consistency with two shipped stores outranks the draft's directory preference.)*

---

## 2. Data model — two tables, next free migration number

> ⚠️ **The migration number is assigned at build time, not here.** Measured 2026-08-12 the head is `0032`, so this lands at **0033 or above — re-measure against `main` at the moment of branching**. The runner **silently skips** any migration numbered at or below a device's `PRAGMA user_version` (the 0030/0031 renumbering collision is the standing lesson; `docs/project-status.md` Known caveats). After adding the file, run `npm run db:bundle` to regenerate `src/lib/db/migrations.generated.ts`.

```sql
-- progress_photos — one row per imported photo. The image itself is a FILE
-- in the progress-photos store (photo-file-store.ts, the 0033/0034 substrate);
-- this table stores a bare NAME and nothing else — the 0033 CHECK convention,
-- because the app container's absolute prefix changes on reinstall, and the
-- exporter's assertScalar fails loud on BLOBs, deliberately.
CREATE TABLE progress_photos (
  id text PRIMARY KEY NOT NULL,
  -- The LOCAL day the photo was taken (EXIF/asset date, user-editable at
  -- import). Named taken_on, not date: an import may be years after the
  -- shutter, and import-day-vs-shutter-day is this feature's central hazard.
  taken_on text NOT NULL CHECK (taken_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- The instant, when EXIF supplied one. Nullable: no data, no number.
  taken_at text,
  pose text NOT NULL DEFAULT 'front' CHECK (pose IN ('front', 'side', 'back', 'other')),
  source text NOT NULL DEFAULT 'library' CHECK (source IN ('library', 'camera')),
  -- PhotoKit localIdentifier from the picker. Dormant provenance in v1 (no
  -- installed module can re-fetch by it); powers dedupe now, re-linking later.
  asset_id text,
  -- Bare file names in the progress-photos store (the 0033 CHECK convention:
  -- ends .jpg, no separator — no caller can quietly store a path).
  working_file_name text NOT NULL CHECK (
    working_file_name LIKE '%.jpg' AND working_file_name NOT LIKE '%/%'
  ),
  -- Full-resolution in-app copy; set when is_important = 1 at pick time.
  original_file_name text CHECK (
    original_file_name IS NULL
    OR (original_file_name LIKE '%.jpg' AND original_file_name NOT LIKE '%/%')
  ),
  is_important integer NOT NULL DEFAULT 0 CHECK (is_important IN (0, 1)),
  notes text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX progress_photos_taken_idx ON progress_photos (taken_on DESC);
CREATE INDEX progress_photos_pose_taken_idx ON progress_photos (pose, taken_on DESC);
CREATE UNIQUE INDEX progress_photos_asset_key ON progress_photos (asset_id)
  WHERE asset_id IS NOT NULL;

-- progress_photo_analyses — saved AI readings. A separate table, not a column:
-- a pair analysis references TWO photos, and one photo may be read many times.
CREATE TABLE progress_photo_analyses (
  id text PRIMARY KEY NOT NULL,
  photo_id text NOT NULL REFERENCES progress_photos (id) ON DELETE CASCADE,
  -- NULL for a single-photo reading; set for an A/B comparison. photo_id is
  -- the EARLIER photo, compare_photo_id the later — the prompt states order.
  compare_photo_id text REFERENCES progress_photos (id) ON DELETE CASCADE,
  model text NOT NULL,
  summary text NOT NULL,
  observations text CHECK (observations IS NULL OR json_valid(observations)),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX progress_photo_analyses_photo_idx ON progress_photo_analyses (photo_id);
-- + the two standard updated_at AFTER UPDATE triggers.
```

### Decisions recorded, so they are not re-litigated blind

- **`taken_on` over `date`.** `meals.date` and `wearable_data.date` set a precedent for `date`, but here the name must carry the semantics: the row's day is the *shutter's* day, never the import's. `body_metrics`' UTC-instant-only design (and the JS local-day gymnastics it forces on every consumer — `repositories/body.ts` documents the lesson) is why the local day is first-class here and the instant is the optional extra.
- **Pose is a 4-value CHECK, and the rebuild cost is accepted.** `side_left`/`side_right` was considered and rejected as over-taxonomy for v1 (`other` + notes covers it). Widening a CHECK later is a parent-table rebuild, and `progress_photo_analyses` is a child that must be shuttled — the labs 0024 rebuild (`docs/labs-subapp.md` §2) is the worked example of why the two obvious approaches fail. The alternative (free-text pose, repository-validated — the `metric_type` philosophy) loses the CHECK convention for a set that is genuinely closed. Chosen: CHECK.
- **No `body_metric_id` FK.** Weight context is correlated **by date at read time** (nearest weigh-in; §4). A hard link goes stale the moment a weigh-in is edited, adds delete-ordering complexity, and buys zero query power over a date join.
- **No thumbnail file.** One working copy; grid cells downscale at render. A second pre-rendered thumbnail is an optimization to add only if grid scroll performance demands it on hardware.
- **Mirror 0033's exact CHECK spelling at build time** — the sketch above states the intent; the shipped `meal_photos` DDL is the authority on the idiom (and note its `GLOB`-vs-`LIKE` choice), since the two tables should be grep-twins.
- **Delete order:** repository deletes the DB row first (CASCADE takes analyses), then best-effort deletes the files. A file-delete failure never orphans a row — an orphaned *file* is harmless; an orphaned *row* renders the authored "file missing" state. Deleting in ARC **never touches the Photos-library original.**

---

## 3. Capture & import

**v1 is library-pick only — there is no in-app camera.** Three reasons, in order: (1) the policy wants originals in the camera roll where iCloud Photos backs them up, and without MediaLibrary ARC cannot *write* a capture to the roll — an in-app camera would make ARC's copy the only original, the exact inversion of the policy; (2) the iOS Camera app is simply better at this (timer, mirror, grid, volume-button shutter); (3) the `source` CHECK already carries `'camera'`, so the v2 guided-capture screen (ghost-overlay of the last same-pose photo, MediaLibrary write-back) needs no rebuild.

**Flow — `app/progress-photo-add.tsx`** (the four-beat house contract, minus the model — every beat here is offline):

```
/progress-photos ── "Add photos" (the one accent) ──▶ /progress-photo-add
                                                        │
  pick   (offline) ─────────────────────────────────────┤ launchImageLibraryAsync,
                                                        │ multi-select (~30/batch)
  process (offline) ────────────────────────────────────┤ per asset: EXIF date, working
                                                        │ copy via manipulator, dedupe
  REVIEW (offline) ─────────────────────────────────────┤ per-photo: date · pose · flag
  save   (offline) ─────────────────────────────────────┘ one transaction, files first
```

- **Multi-select is on** (`allowsMultipleSelection: true`, ordered selection, generous limit ~30 per batch). Backfilling years of existing photos is the *first-run* flow, not an afterthought.
- **Date honesty (the labs draw-date discipline, verbatim):** EXIF `DateTimeOriginal` → `taken_on` (local day) + `taken_at`; fall back to the asset's file date if the picker exposes one; the final fallback is **an empty date field the user must fill** — never a silently-stamped "today" on a photo taken last year. Every date is editable in review.
- **Pose tagging:** per-photo chip row (Front · Side · Back · Other), defaulting to the previous photo's pose in the batch (a batch is usually one session, three poses). **No AI pose guess in v1** — a wrong silent guess corrupts the same-pose compare filter, which is the feature's core query.
- **Duplicates:** the partial UNIQUE on `asset_id` is the guard; review marks an already-imported asset "Already in the gallery" and excludes it by default (the labs `duplicate`-status pattern). A photo re-picked after arriving without an assetId cannot be caught — accepted limit, named here.
- **Important at import:** toggling it stores `original_path` (full-res copy), and the review row prices it plainly ("keeps the full-size original inside ARC"). The flag can be flipped later on the detail screen, but v1 cannot retro-fetch the original — flipping later keeps only the working copy, and the UI says so.
- **Save:** files are written first, then one DB transaction for the batch; a throw rolls back the rows and deletes the just-written files. Nothing is stored until Save.

> ⚠ **Verify on the next build:** the `assetId` and `exif` fields of `ImagePickerAsset` have never been exercised in this codebase — the current seam types only `uri`/`base64`. Their real shapes are a device question (the wearables Quantity-object lesson: parse wire shapes in exported pure functions with fixtures pinned to the installed package's payloads).

---

## 4. The gallery, detail, and compare surfaces

Flat kebab-case routes, each registered as a `Stack.Screen` in `app/_layout.tsx`; the Data-tab `photos` row gains an `onPress` (which auto-flips the derived "N of 8 built" tally) and its chip retires.

| Route | Screen |
| --- | --- |
| `/progress-photos` | The gallery hub. `StackHeader` back to Data. Pose filter (neutral chip row — interface state, no signal colour), month-grouped plates newest-first, a 3-across grid of working-copy cells per month; each cell carries day-number + a pose letter in mono. The month plate's section note is a true tally (`4 photos · 2 poses`). **The one accent** is the "Add photos" stamp heading the screen (the labs import-stamp pattern, hatched cap and all). A "Compare" control enters selection mode. |
| `/progress-photo-add` | The import flow (§3). Pick = well-tokened surfaces, review = plate — the `workout-import.tsx` phase mapping. |
| `/progress-photo-detail?id=` | One photo full-screen: date, pose, notes, the important toggle (with the honest retro-flag caveat), saved analyses, **"Read this photo"** (§5), delete (arm/confirm). |
| `/progress-photo-compare?a=&b=` | Side-by-side A/B (§ below) + **"Compare these two"** (§5). |

**Compare.** Selection defaults to A's pose for the B candidates (toggleable to all); when a pose has ≥2 photos the screen offers earliest-vs-latest as the default suggestion. The two working copies render split-vertically, each captioned:

```
12 Jan 2026            ·            9 Aug 2026
84.2 kg · weighed same day    81.0 kg · weighed 2 days later
```

**The weight caption is honest by construction:** it takes the *nearest* `body_metrics.weight_kg` within ±3 days of `taken_on` and **always states its own distance** ("weighed 2 days later"), or prints "no weigh-in near this date". Stating the distance sidesteps the open UTC-vs-local bucketing caveat entirely — no bucketing claim is made, the actual instant's own date is what's printed. Units honor `UnitPreferences` like every other surface.

**Empty and degraded states are authored:**
- Gallery, no rows: the stamp plus a margin note — *"No photos yet. Photograph yourself in the iOS Camera app — front, side, back — then bring them in here. ARC keeps a working copy; your originals stay in Photos."*
- Binary without the picker: the stamp's button disables with the honest "rides the next app build" sentence (the seam's `unavailable` variant already speaks it).
- Row whose file is missing (a restore that carried rows but not files): an authored "Image not on this phone" cell — never a broken image.

---

## 5. On-demand AI analysis

**Never automatic.** Two entry points: "Read this photo" (detail) and "Compare these two" (compare). The mechanics are the meal-estimate / labs contract exactly — one online step, review before anything persists:

```
tap ▶ privacy line + Send (accent) ──▶ runCoachTurn   (ONLINE — the only step;
      one turn, NO tools, streaming, abort on unmount; key-gated via
      useSessionKeySet — same key, same model picker, no second model stack)
   ──▶ REVIEW (offline): summary + observation rows, tagged "est · AI"
   ──▶ Save → progress_photo_analyses row  ·  Discard → nothing written
```

- **Payload:** the working copies downscaled to 1024 px JPEG (the existing `downscaleToJpegBase64` pass) as image content blocks; for a pair, image 1 = earlier, image 2 = later, and the prompt states the order. Alongside the pixels ride the dates, poses, and the same nearest-weigh-in figures the compare screen prints — **with their distance labels** — and the instruction that the model must **not invent numbers of its own**: ARC's numeric truth is supplied; the model's job is eyes.
- **Output contract** (structured, parsed defensively like `estimate.ts`): `{ summary, observations: [{area, note}], changes?: [{area, direction: 'leaner'|'fuller'|'unchanged'|'unclear', note}], caveats, confidence }`. `caveats` is **mandatory** in the prompt — lighting, pose and angle differences are the failure mode of photo comparison, and the model must name them or the reading is refused.
- **No numeric body-composition estimates.** The model is instructed to output qualitative observations only — no body-fat percentages. Visual BF% estimation is ±5 points on a good day; a plausible wrong number filed near a trend surface is the exact hazard the labs mapper exists to prevent. (⚑ MATT #2 — meal-estimate does ship ≈-labelled numbers, so this is a deliberate asymmetry the owner may overrule.)
- **The privacy line, shown above the Send control every time** (labs §4 wording discipline — specific, not boilerplate): *"These photos leave your phone for this one reading — sent to your model provider under your key. Nothing is stored anywhere but here."* What leaves: the downscaled copies, the dates, the weights. Where: the configured provider. What rests in a cloud: nothing.
- **Persistence:** analyses persist **on Save** — unlike a meal estimate, a reading has no other landing table, and discarding means paying tokens to re-read. The review gate stays regardless: nothing auto-commits. Saved analyses render on detail/compare with model + date + the `est · AI` tag. `max_tokens` chat-sized (~4,000): this is prose, not a panel.
- Pure lib: `src/lib/photos/analyze.ts` (prompt build + response parse, headless-testable with fixtures); the screen owns only phases.

---

## 6. Degradation ledger

| Stage | What works |
| --- | --- |
| **Today's binary** (picker/camera/manipulator not installed; the last EAS build failed on provisioning) | The route renders; the gallery draws any existing rows; the Add-photos stamp is disabled with the authored "rides the next app build" line. Every native require stays guarded (the `photo-library.ts` seam; `db/screens-render.test.mjs` walks the import graph for real). Nothing crashes. |
| **After the next successful EAS build** (picker + manipulator + camera already ride it — in package.json/app.json today) | Full v1: multi-select import, EXIF dates, working/original copies, gallery, compare, AI analysis. The `assetId`/`exif` wire shapes get verified on device at this point (§3 ⚠). |
| **If `expo-media-library` is adopted later** (a NEW native dep — joins a *future* build; the Known-caveats two-build ledger grows a line) | Retro-fetch full-res for late `is_important` flips; guided in-app capture written back to the camera roll (`source='camera'` goes live); "open original in Photos". **It does not fix restore** — no PHCloudIdentifier access exists in any Expo module. |
| **Restore to a new phone** | Every `asset_id` dangles silently — and nothing breaks, because v1 never reads them. Rows ride the encrypted snapshot; images ride only if Phase 4 includes the media directory (§8). Rows without files render the authored missing state. |

---

## 7. Coach integration — a declared blind spot, no tool in v1

`UNCOVERED_DOMAINS` (`src/lib/ai/tools/index.ts`) gains: **"progress photos and their AI readings (Data › Progress photos)"** — so the model routes the user to the screen instead of hallucinating a capability or asserting the feature doesn't exist (the blindness-as-absence failure the manifest was built for; `coverageProblems()` stays green because no tool is registered).

Why no tool: the catalog is ~66–72% of the cached prompt prefix and every addition invalidates the cache; photo *metadata* (counts, dates, poses) gives the model almost nothing actionable — the pixels are the value, and those flow through the user-triggered analysis. A future `get_progress_photo_log` read tool is gated on demonstrated conversational need ("when did I last take photos?" asked more than once), and would be batched with whatever registry change comes next.

---

## 8. Backup & export

- **DB rows** are all scalars (paths are text) — they ride the whole-DB JSON export and the future encrypted snapshot untouched; `assertScalar` stays satisfied by design.
- **The JSON export cannot carry the images**, and it should say so where it already says such things: the `ArcExport` envelope gains a note naming `progress-photos/` as a sibling directory not present in the file (the `omittedTables` philosophy applied to files).
- **Phase 4 encrypted iCloud snapshot: recommend the media directory rides it** (⚑ MATT #4). Working copies are ~0.5 GB/decade, and the full-res `is_important` originals are deliberate, individually-priced purchases; excluding them re-creates the everything-dangles restore hole the audit flagged. Camera-roll originals never ride — iCloud Photos owns them — which is the split that keeps ARC's blob small.

---

## 9. Tests — `db/progress-photos.test.mjs` (headless, node:sqlite)

- Migration applies over the current head; CHECKs reject bad pose / malformed `taken_on` / non-boolean flag; NOT-NULL id enforced.
- CASCADE: deleting a photo removes its analyses (both FK paths); the compare row dies when *either* photo dies.
- Dedupe: the partial UNIQUE rejects a duplicate `asset_id`, admits many NULLs.
- Repository reads: month grouping, pose filter, newest-first ordering; the nearest-weigh-in join (±3-day window, distance reported, "no weigh-in" beyond it).
- Pure functions: name→path resolution rides `photo-file-store.ts`'s already-tested surface (assert the progress store rejects a name carrying a separator, per the CHECK's twin rule); `analyze.ts` prompt build (order, dates, no-invented-numbers instruction present) and response parse (well-formed, missing-caveats refusal, malformed JSON). Assert the meal store's retention sweep does NOT reach the progress directory.
- Render walk: the new screens join `db/screens-render.test.mjs` so a missing native module can never crash them at import.

---

## 10. Deliberate limits, integrator merge points, and ⚑ MATT

**Deliberate limits (named, not hidden):** no in-app camera (v2, MediaLibrary-era); no AI pose tagging; no retro-fetch of originals; no thumbnail sidecar files; re-picked assets without ids can duplicate; `asset_id` is written and never read.

**Integrator merge points:** `app/_layout.tsx` (four `Stack.Screen` entries) · `app/(tabs)/data.tsx` (the `photos` row gains `onPress`, chip retires, tally self-updates) · the migration + `npm run db:bundle` · `src/lib/db/types.ts` row types · `UNCOVERED_DOMAINS` in `src/lib/ai/tools/index.ts` · `package.json` `db:test` chain · `docs/project-status.md` schema inventory re-measured in the same change.

**Decided — owner calls, 2026-08-12** (all six answered in one round at the top of the build session; every one landed on the spec's recommendation, so the body above stands unamended):

1. **The working-copy amendment (§1) is ACCEPTED.** 1600 px JPEG q0.7 working copies (~0.5 GB/decade) are the always-stored artifact, superseding the 2026-07-24 "PhotoKit reference + thumbnail" letter. `docs/architecture-migration.md` §Phase 4 is amended by this decision, not contradicted by it: iCloud Photos still owns the original, ARC's copy is a working record.
2. **Qualitative only — no numeric body-composition estimates.** No body-fat percentages, ≈-labelled or otherwise. The asymmetry with meal-estimate's ≈-numbers is deliberate and owner-confirmed: a visual BF% is ±5 points on a good day and a plausible wrong number filed near a trend surface is the exact hazard the labs mapper exists to prevent.
3. **Library-pick-only v1 confirmed.** No in-app camera until a MediaLibrary-era build can write captures back to the camera roll. `source` keeps its `'camera'` CHECK value so v2 needs no rebuild.
4. **The photo files ride the Phase 4 encrypted snapshot.** Working copies and the `is_important` full-res originals both. Camera-roll originals never ride — iCloud Photos owns those.
5. **Coach stays blind in v1.** `UNCOVERED_DOMAINS` entry only, no tool registered. A `get_progress_photo_log` read tool stays gated on demonstrated conversational need.
6. **Cadence nudge is out of scope.** "Photo day" composes with the protocol model rework whenever that lands; ARC will not grow a second scheduling mechanism for it now.

---

## Related documents

- `docs/architecture-migration.md` — §Phase 4, the 2026-07-24 media policy and the restore audit finding this spec amends
- `docs/labs-subapp.md` — the import → editable review → transactional commit discipline; the 0024 parent-rebuild lesson
- `docs/wearables-subapp.md` — the guarded-seam and wire-shape-fixture patterns
- `src/lib/media/photo-library.ts` — the picker seam this feature widens (assetId/EXIF/multi-select)
- `docs/project-status.md` — Known caveats: the two-build native-deps ledger, the migration-numbering hazard, the Documents-privacy decision
