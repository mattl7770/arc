# Spike — recipe import from a caption-less video (backlog D1)

**Date:** 2026-09-14 · **Branch:** `claude/d1-video-spike` · **Status:** feasibility answer, no code written. **The build plan that answers it is `docs/spikes/video-recipe-import-build.md`** (2026-09-15, still unbuilt) — this file stays as the feasibility reasoning.
**Question (owner, `docs/backlog-2026-09.md` D1):** *"Some recipe import apps are able to figure out a recipe just from the video, with no captions. I want to see if that is feasible to implement and implement if so."*

---

## Verdict

**GO WITH CONDITIONS — and not buildable today.** ARC *can* derive a recipe from a video's **pictures**, at ~$0.016/import, but only from a video **already saved on the phone** (never from a shared URL), and only behind **one new native dependency + an EAS build**. This spike therefore stops at the spec, per its own gate.

The condition that actually matters is not the build. It is this: **the apps the owner has seen are almost certainly transcribing the audio, and ARC cannot.** The Anthropic Messages API takes images only — no video, no audio — and there is no on-device speech-to-text anywhere in this tree or in Expo's first-party surface. A frame-only derivation recovers what is **written on the screen**. In a genuinely caption-less reel where the cook *says* "a tablespoon of miso", that quantity is unrecoverable and, under ARC's anti-fabrication doctrine, must be left NULL. So the feature is real, but it is a **weaker feature than the one the owner watched a competitor perform**, and the gap is structural, not an implementation-quality issue.

---

## 1. What input ARC can actually get

### 1a. From a shared URL: nothing. Settled, and not a limitation to engineer around.

`fetchRecipeSource` (`src/lib/recipes/import.ts:241`) reads caption/metadata **text** only. The governing ADR is explicit — `docs/decisions.md:379`:

> Never media downloads — no video, no audio, no images fetched for storage.

and the recipes plan already records video download/transcription as a deliberate non-goal (`docs/recipes-grocery.md:366`): *"unreachable via the share sheet, ToS-hostile, the canonical 5.2.3 rejection, and a server product in disguise."*

Nothing in this spike disturbs that. Downloading the reel would need a server — the platforms do not hand the mp4 to a client — and a server is forbidden by CLAUDE.md §2. **A URL is not a path to the pixels.** Rule it out permanently.

### 1b. From the share extension: a video file is *admissible*, but two things are in the way, and both are ours.

The activation rule in `app.json:62-68` is Text · 1 WebURL · 1 Image:

```json
"activationRule": {
  "supportsText": true,
  "supportsWebUrlWithMaxCount": 1,
  "supportsImageWithMaxCount": 1
}
```

The expo-sharing config plugin **does** support a movie rule — `node_modules/expo-sharing/plugin/src/ios/createInfoPlistFile.ts` maps `supportsMovieWithMaxCount` → `NSExtensionActivationSupportsMovieWithMaxCount`. So admitting video is a **one-line `app.json` change with no new npm dependency** (it still needs a rebuild: the extension's Info.plist is generated at prebuild).

A second, quieter blocker sat in our own code. `recipeImportShareFromPayloads` (`src/lib/recipes/share-payload.ts`) routed `url` → `text` → `image` and **had no `video` branch**, while expo-sharing's `ShareType` union already includes `'video'` (`node_modules/expo-sharing/build/Sharing.types.d.ts`). A shared video matched none of the three filters and returned `null` — the screen said *nothing usable was shared*. Silent, and exactly the class of bug that file's own `shareType`-vs-`type` docstring was written about.

> **FIXED 2026-09-14** (`claude/fixes-sept`). The router now has a `video` branch, placed **last** so a reel shared with its caption or link still takes a rung that works. It carries no work — it carries a sentence, `VIDEO_SHARE_MESSAGE`, which says ARC cannot pull frames from a movie in this build and names the two paths that do work (paste the caption, share a screenshot). `app/recipe-import.tsx` renders it on the normal failure surface with `suggestPaste`. Pinned in `db/recipe-import.test.mjs` §8.
>
> **`app.json` was NOT widened, and that is deliberate.** Checked at the same time: the activation rule is still Text · 1 WebURL · 1 Image with **no** `supportsMovieWithMaxCount`, so iOS does not offer ARC as a destination for a movie at all today — the branch is dormant. The plugin supports the key, but the extension's Info.plist is generated at prebuild, which makes widening it a rebuild-scoped change and not part of a fix batch. A test asserts the rule's current shape so the day it changes, it changes on purpose.

**The real constraint is upstream of both.** Instagram's and TikTok's share sheets offer a **link**, not the movie file; TikTok's "Save video" writes to Photos instead. So even with the rule widened, the share sheet realistically delivers a video only when the user shares **from Photos** — i.e. a file they already saved. Which makes 1c the actual path. *(Confidence high, but device-unverified — nothing about a share extension is testable in the web preview or headless, per `docs/recipes-grocery.md:357`.)*

### 1c. From the photo library: yes. This is the obtainable input.

`expo-image-picker` is installed (`package.json`), is in `app.json`'s plugin list with a photos purpose string, and — per `src/lib/media/photo-library.ts:10-14` — is in the owner's current binary. Its installed types declare `MediaType = 'images' | 'videos' | 'livePhotos'` (`node_modules/expo-image-picker/build/ImagePicker.types.d.ts:48`), and a picked asset carries a local `uri`.

So `launchImageLibraryAsync({ mediaTypes: 'videos' })` returns a local video URI **with no new dependency and no rebuild**. The user saves the reel (TikTok's Save, or a screen recording) and picks it.

**Conclusion for §1:** the realistically obtainable input is **a local video file the user saved themselves**, reached through the photo-library picker. That is also the honest App Store framing — ARC never downloads anything; it reads a file the user already has, exactly as it reads a screenshot today.

---

## 2. Frame extraction: this is the gate, and it needs a native module

Neither candidate is installed. `package.json` has no `expo-av`, no `expo-video`, no `expo-video-thumbnails`, and `ls node_modules | grep -i "video\|thumbnail\|expo-av\|ffmpeg\|speech"` returns **nothing**. `expo-image-manipulator` is present but is an image module — it cannot open an mp4.

| Option | Shape | Verdict |
|---|---|---|
| `expo-video-thumbnails` | `getThumbnailAsync(uri, {time, quality})` → `{uri, width, height}`; one call per frame; SDK 57 | Best-shaped seam for ARC — returns a plain **URI**, which feeds `downscaleJpeg(uri)` (`src/lib/media/photo-library.ts:129`) unchanged. **But Expo documents it as deprecated** in favour of the row below. |
| `expo-video` → `VideoPlayer.generateThumbnailsAsync(times[], {maxWidth,maxHeight})` | One call for N frames (times in **seconds**) → `VideoThumbnail[]` of `{width, height, requestedTime, actualTime, nativeRefType}` | The supported path, better ergonomics. **Risk:** the result is a *native ref*, not a documented file URI — whether `expo-image-manipulator` can consume it to produce base64 is **unverified**, and is the first thing a build must check. |
| Pure JS (mp4box / WASM decode) | — | **Not viable.** RN has no canvas, no WebCodecs, no `ImageBitmap`; Hermes would decode at seconds per frame, and there is no route from decoded pixels to a JPEG. Listed so the "no new native module" option is visibly closed rather than unexamined. |

`expo-file-system` can already read the mp4's *bytes*. It cannot decode them. The gap is a decoder, and a decoder is native.

**Cost of the native module — stated plainly, as required.** One npm dependency, a `npx expo prebuild` regeneration, and **one EAS build**, which only the owner can run and which gates every other pending native change. Neither module needs a config-plugin entry and neither adds a permission (the photo permission is already granted), so this is the *cheapest possible* native addition: no new entitlement, no App Group, no provisioning regeneration — none of the share-extension signing pain recorded at `docs/recipes-grocery.md:360`. The owner's *"it's not that hard"* is fair for the build itself. What is not free is the **latency**: the rung is device-inert until that binary is installed, and would ship dormant behind the standard guarded-require degradation (the `healthkit.ts` / `photo-library.ts` pattern), exactly as the screenshot rung did.

---

## 3. The model side

### 3a. The path is fixed by the API

The Messages API accepts **JPEG, PNG, GIF, WebP** and nothing else; the vision docs add *"Animations are unsupported, and only the first frame is used"*. There is no video content block and no audio content block. So the only possible shape is **N sampled frames → one multi-image vision request**, reusing `buildRecipeExtractionRequest` (`src/lib/recipes/import.ts:414`), whose `VisionBlock[]` content array already takes multiple blocks — it is built for a list and currently pushes one.

Request limits are not a concern at this scale: 100 images/request on a 200k-context model, and staying at **≤20 image blocks** avoids the stricter per-image dimension rule the docs impose above that threshold.

### 3b. Token arithmetic — and a 3× trap in the existing downscale

Claude bills images in 28×28 patches: **visual tokens = ⌈w/28⌉ × ⌈h/28⌉**. Opus 5 and Sonnet 5 are high-resolution tier (long edge 2576 px, cap 4784 tokens), so a downscaled frame is **not** resized further server-side — we pay for every pixel we send.

**The trap:** `downscaleJpeg`'s default was `RESIZE_WIDTH = 1024` (`src/lib/media/photo-library.ts`). On a 9:16 reel frame, 1024 is the **short** edge — the frame goes out at 1024×1820 and costs **2,405 tokens**. Resizing by *long* edge instead sends 576×1024 for **777 tokens**. Same legibility class, **one third the bill.** A video rung that naively called `downscaleToJpegBase64(uri)` would silently pay 3× per frame, ten times per import.

> **FIXED 2026-09-14** (`claude/fixes-sept`), independently of the video rung, because the trap was already shipped on three live paths. The seam now bounds the **long edge** by default: `longEdgeResize(width, height, edge)` is the one definition (`workingCopyResize` became an alias of it), `DownscaleOptions` gained `maxEdge` and `source`, and explicit `width`/`height` still win so the two callers written against that contract are untouched. Callers that genuinely cannot know their source's shape — a screenshot off the share sheet, a stored progress photo — get a width-bounded pass that the seam then *corrects* from the manipulator's own report (`overLongEdge`), which costs a second native pass only when the guess was wrong. Per caller:
>
> | Caller | Before | After |
> | --- | --- | --- |
> | Meal estimator, camera (`app/meal-estimate.tsx`) | 1024×1365 ≈ **1,813** (4:3 portrait) | 768×1024 ≈ **1,036** |
> | Meal estimator / recipe screenshot / recipe photo, library (`pickPhotoBase64`) | 1024×1820 ≈ **2,405** (9:16 screenshot) | 576×1024 ≈ **777** |
> | Share-sheet screenshot (`readSharedImageBase64`) | 1024×2220 ≈ **2,960** (19.5:9) | 472×1024 ≈ **629** |
> | Progress photo compare / detail | 1024×1365 ≈ **1,813** | 768×1024 ≈ **1,036** |
> | Workout import | 1280×2773 ≈ **4,554** | **unchanged, deliberately** — it reads a grid of small numbers, and on a portrait set table the *width* is what carries them. A misread weight corrupts a workout record, which is worth more than the tokens. |
> | Progress photo **working copy** (`progress-photo-add.tsx`) | long edge 1600 | **unchanged** — this is the photo the owner keeps, it was already correct, and nothing here shrinks it. |
>
> Pinned in `db/progress-photos.test.mjs` (the patch arithmetic itself, both shapes, the landscape non-regression, and the second-pass predicate).

Per-import cost (in = frames × per-frame + 383-token extraction prompt; out ≈ 600 tokens of recipe JSON):

| Frame long edge | per frame | 6 frames | 10 frames | 12 frames |
|---|---|---|---|---|
| 640 (360×640) | 299 | $0.010 / $0.026 | $0.013 / $0.032 | $0.014 / $0.035 |
| **768 (432×768)** | **448** | $0.012 / $0.030 | **$0.016 / $0.039** | $0.018 / $0.044 |
| 1024 (576×1024) | 777 | $0.016 / $0.040 | $0.022 / $0.056 | $0.025 / $0.064 |
| *width-1024 (1024×1820) — the trap* | *2,405* | *$0.036 / $0.089* | *$0.055 / $0.137* | *$0.064 / $0.161* |

*(Sonnet 5 $2/$10 — the app's `DEFAULT_MODEL`, `src/lib/ai/model-client.ts:54` — / Opus 5 $5/$25. Prices from `src/lib/ai/cost.ts:23`, which carries its own REVISIT 2026-09-01 note: Sonnet's introductory rate has expired and the constant still says $2/$10, so every Sonnet figure here is a **floor**, not a quote.)*

For scale, the rungs that exist today: the **caption** rung ≈ $0.007, the **screenshot** rung ≈ $0.013 (its 1024×2220 screenshot was 2,960 visual tokens — the same width-vs-long-edge trap, already shipped, and worth fixing independently of this spike; **fixed 2026-09-14**, now 472×1024 ≈ 629 tokens, so that rung is ≈ $0.008).

**Recommendation: 10 frames at long edge 768 ⇒ ~4.9k input tokens, ~$0.016/import on Sonnet 5** — about 1.2× the screenshot rung the owner already pays, and roughly two Coach turns. Comfortably inside the house cost discipline (`db/coach-eval.test.mjs:376`, §6 "the prompt budget"). Note also that this turn does **not** pay the 9,250-token Coach prefix: `runExtractionTurn` passes its own `system` and `tools: []` (`import.ts:582-594`). Conversely, its ~383-token system block sits **below the minimum cacheable prefix**, so the `cache_control` breakpoint `runCoachTurn` stamps on it is inert here — no cache benefit, and none assumed above.

### 3c. Audio narration is NOT reachable. Plainly.

Two independent walls, either sufficient on its own:

1. **The API takes no audio.** There is no audio content block on the Messages API. Even holding a perfect `.m4a` track, there is nowhere to send it.
2. **There is no on-device STT in reach.** Nothing in `node_modules` matches `speech`. Expo's first-party `expo-speech` is **text-to-speech (synthesis), not recognition** — and is not installed either. Expo ships **no** speech-to-text module. iOS *does* have an on-device-capable `SFSpeechRecognizer`, but reaching it from Expo means **authoring a local native Expo module in Swift**; and before that module could even start, it would need `AVAssetReader` to demux the audio track out of the mp4 — a second native surface. So: **not reachable without a new module, and not by adding a package — by writing one.**

This is the whole answer to *"some apps do this"*. Those apps almost certainly download the video server-side and run ASR + vision over it (**inference, not verified** — but it is the only architecture that recovers spoken quantities). Both halves are forbidden here: the download by the ADR, the server by CLAUDE.md §2.

---

## 4. What frames can and cannot recover, and how the result must be labelled

**Recoverable from frames** — genuinely, and often well:

- The **dish** and its **title**, from the plated shot.
- The **ingredient list**, when the reel shows an overlay card or a mise-en-place board — which a large fraction of recipe reels do, because creators know captions get truncated.
- **On-screen text of any kind**: burned-in captions, sticker text, the quantities creators overlay on each pour (`"2 tbsp"` stamped on the shot). The model reads these off the image; no OCR dependency needed.
- **Step order and technique**, coarsely — sear, then deglaze, then bake — from the visual sequence.

**Not recoverable:**

- **Anything only spoken.** Quantities are the casualty, and quantities are the part that makes a recipe cookable.
- **Times and temperatures** said aloud and never shown.
- **Anything between sampled frames.** Ten frames across a 45-second reel is one every 4.5 s; an overlay that flashes for 2 s can fall in a gap. A real failure mode that tuning does not close — denser sampling costs linearly and never eliminates it.

### Labelling — and a correction to the framing in the D1 brief

The brief asks that a video-derived line be marked `resolved_by = 'ai'`. **That column means something else**, and conflating the two would put a number of the wrong provenance into the day's totals. Per `db/migrations/0034_recipe_photo_autoresolve.sql:21-33`, `resolved_by` records **who priced the line** — who attached grams and therefore macros (`'user'` | `'catalog'` | `'ai'` | NULL). It is not a record of where the line's *text* came from. Correct handling:

- **Provenance of the recipe** is already carried by `source_platform` / `source_url` / `source='import'` on `recipes` (`db/migrations/0031_recipes.sql:46-49`). A video picked from the library with no URL sets `source_platform = NULL`, exactly as the screenshot rung does today. **The existing `CHECK (source_platform IN ('instagram','tiktok','youtube','website'))` needs no change, so this rung needs no migration.**
- **Quantities the video never stated stay NULL.** `qty` / `unit` are already nullable and `parseRecipeExtraction` (`import.ts:498`) already preserves nulls. The extraction prompt's existing rail — *"use null where the source gives no amount — never invent quantities"* (`import.ts:399`) — is exactly right and needs no softening for video. If anything it needs **hardening**: a prompt line stating that these are stills from a video whose audio was not heard, so unstated amounts are expected, and `found:false` is the correct answer to a reel that shows only a finished plate.
- **`resolved_by` behaves normally.** A line the catalog prices exactly gets `'catalog'`; a line the model prices gets `'ai'`, and every surface that draws it already says so. Nothing about the video origin changes that ladder.
- **The review screen is the safety net and stays mandatory.** Nothing is auto-committed (`import.ts:606-613`). A video-derived draft arriving with half its quantities blank is *correct behaviour*, and the review screen should say so in words — not present a sparse draft as though the import underperformed.

---

## 5. Recommendation

**Go with conditions.** Build it **only** as part of a build train that is happening anyway, and **only** with the expectations in §6 put to the owner first. Do not open an EAS build for this alone.

### Where it goes

A new **rung 8**, strictly *below* the screenshot rung, reached from `app/recipe-import.tsx` as a third source chip ("Video") beside the existing `url` / `text` modes (`recipe-import.tsx:69`). Never automatic, and never a rung the ladder *falls* into — the frames path is the most expensive rung in the app and must be a deliberate act.

### Files touched

| File | Change |
|---|---|
| `package.json` | **+1 native dep** — `expo-video` (or `expo-video-thumbnails`; see §2) |
| `src/lib/media/video-frames.ts` | **new.** Guarded-require seam (the `photo-library.ts` pattern): pick a video, sample N timestamps, return `string[]` of base64 JPEGs. **Resize by long edge, not width** — now the seam's default (§3b), so this is `downscaleToJpegBase64(uri, { maxEdge: 768, source })` rather than a new rule. Every failure a variant, never a throw. |
| `src/lib/recipes/import.ts` | `ExtractionInput` gains `{kind:'frames', framesBase64: string[]}`; `buildRecipeExtractionRequest` pushes `Image 1:`…`Image N:` label + image pairs (the documented multi-image shape, images before text); `ImportInput` gains the matching variant; prompt gains the stills-from-video rail |
| `app/recipe-import.tsx` | Third source chip + its unavailable / canceled / failed prose |
| ~~`src/lib/recipes/share-payload.ts`~~ | ~~`video` branch~~ — **done 2026-09-14** (§1b). The branch exists and says why; a frames rung would replace its message with work. |
| `app.json` | `supportsMovieWithMaxCount: 1` on the activation rule — **still pending**, rebuild-scoped |
| `db/recipe-import.test.mjs` | New numbered section against the mock harness: request shape for N frames (N image blocks + N labels + 1 text block, images first), the frames variant through `parseRecipeExtraction`, a `found:false` reply from a plate-only reel, NULL-quantity preservation, the video share-payload route |
| **Migrations** | **none** |

**Effort:** ~1 day of code and tests. The build and the on-device pass are the schedule, not the code.

### What must be verified on device before it is called done

1. Does `generateThumbnailsAsync`'s `VideoThumbnail` reach `expo-image-manipulator`? (§2 risk — if not, fall back to the deprecated `expo-video-thumbnails`, whose URI does.)
2. Does the picker return a video URI the decoder can open — for both a saved TikTok and a screen recording?
3. Real end-to-end quality on five reels the owner actually wants: two with overlay cards, two narrated-only, one plate-only.
4. Wall-clock: ten thumbnail calls + ten manipulator passes + one multi-image request. Estimate 8–15 s. If it exceeds ~20 s, the frame count comes down before anything else does.

### The better feature, recorded rather than built

If the owner wants what he actually saw, the high-yield path is **on-device speech-to-text**, not frames. A transcript is ~300 tokens of *text* — cheaper than a single frame — and it carries the spoken quantities that frames structurally cannot. It would ride the **existing** text rung with no change to the model path at all. The cost is a hand-written Swift Expo module (`AVAssetReader` + `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`, plus `NSSpeechRecognitionUsageDescription`) — a real step up from adding a package, but entirely inside the local-first architecture, since on-device recognition sends nothing anywhere. **Recommend recording this as a D-phase item in its own right.** If it is ever built, the frames rung becomes a supplement to it — the overlay text the narration skips — rather than the feature.

---

## 6. What the owner will actually experience

You save a reel to your camera roll, open Recipes → Import, tap **Video**, pick it. Ten seconds of *"Reading the video…"*, then the same review screen you already know.

**On a good reel** — one with an ingredient card on screen, which is most of the ones worth saving — you get a genuinely complete draft: title, the ingredient list with its overlaid amounts, steps in order. It will feel like the thing you saw the other app do.

**On a narrated reel** — the cook talking over their hands, nothing written — you get the title, a plausible ingredient list read off the counter, rough steps, and **blank quantities**, because those were spoken and ARC did not hear them. It will not guess. That is the same rule that keeps fabricated numbers out of your labs and your day's totals, and here it is doing its job rather than failing. You will finish those recipes by hand.

**On a plate-only reel** — a finished dish, a trending sound, no list — it will tell you it found no recipe. Correctly.

So: better than today, where a caption-less reel gives you nothing at all. Roughly $0.016 an import against $0.007 for a caption. And **not** the thing you watched the other app do, because that app listened to the audio on a server, and ARC has no server and cannot listen. The honest summary is that this buys you the *visible* half of the recipe reliably, and leaves the *spoken* half blank rather than inventing it.

---

## Appendix — how the numbers here were produced

- **Visual tokens:** `⌈w/28⌉ × ⌈h/28⌉`, per the Claude vision docs (fetched 2026-09-14). Opus 5 / Sonnet 5 sit in the high-resolution tier (long edge 2576 px, 4784-token cap), so none of the frame sizes above are downscaled server-side — every figure is what would actually bill.
- **Prompt:** `RECIPE_EXTRACTION_SYSTEM_PROMPT` measured at 1,378 chars ⇒ ~383 tok under the house prose estimator (`/3.6`, `db/coach-eval.test.mjs:383`).
- **Prices:** `src/lib/ai/cost.ts:23`. The Sonnet 5 row is **stale** — its own comment says REVISIT 2026-09-01 to $3/$15 — so every Sonnet figure above is a floor.
- **Module inventory:** `package.json` plus `ls node_modules` on the shared install; the activation-rule capability read from `node_modules/expo-sharing/plugin/src/ios/createInfoPlistFile.ts`; picker media types from `node_modules/expo-image-picker/build/ImagePicker.types.d.ts:48`.
- **No API key was used and no model was called.** Every cost figure is arithmetic over the documented billing formula, not a measurement — and, like the rest of this file, should be re-baselined with `count_tokens` on real frames once a build exists.
