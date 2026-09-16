# D1 — Video recipe import: the build plan

**Status: PLAN, third draft** (2026-09-15). Not built. The second draft went to an independent critic
and came back *needs-revision*; every finding is answered in place, and where this draft keeps its
ground it says so in a *Considered and rejected* note. The feasibility answer is
`docs/spikes/video-recipe-import.md` (2026-09-14, *go with conditions*). The owner's condition —
*"build later, after this batch ships"* (`docs/backlog-2026-09.md:68`) — is met: the backlog is
closed, `main` is at head `0058`, and *"the next build applies 0045 → 0058 in one go"*
(`docs/project-status.md:13`). That build, owed for `react-native-svg` (`:362`), is the train. **When
built, this file lands as `docs/spikes/video-recipe-import-build.md`**, its Status flipped as
`gym-away-note.md:3` was.

**Migrations: none.** **Native dependency: one SDK-bundled package, `expo-video-thumbnails`, which
forces an EAS rebuild** — its `package.json` line lands in Phase 0 on the current binary, dormant
behind the guard. Nothing reaches the owner's phone before Phase 1's build: ARC has no OTA channel
(`package.json:19-56` carries no `expo-updates`; CLAUDE.md §3). **Coach impact: none on the two
ceilings** — the rung runs on the tool-less extraction turn (`src/lib/recipes/import.ts:650`,
`tools: []`), outside the 9,250 / 3,700 budget; it adds a ceiling the recipe prompt has never had
(§3.4). The feature is the spike's §4 made concrete: it recovers what is **written on the screen** of
a video, not what is said — weaker than the apps the owner watched, and every surface below says so.

---

## 1. Current state

### The ladder, and where the new rung sits

`importRecipe` (`src/lib/recipes/import.ts:685-736`) takes one of three inputs — `url`, `text`,
`photo` (`ImportInput`, `:665-675`) — and every non-JSON-LD path funnels into `runExtractionTurn`
(`:639-663`), one `runCoachTurn` call with the recipe system prompt and `tools: []` (`:650`).
`buildRecipeExtractionRequest` (`:478-496`) takes an `ExtractionInput` of text or one photo
(`:440-442`); the photo case pushes **one** image block then one text block (`:483-488`) into a
`VisionBlock[]` (`:473-475`) already typed as a list. `parseRecipeExtraction` (`:562-623`) throws
`NoRecipeFoundError` on `found:false` (`:582`) and on an empty "found" reply (`:610-612`); a
`refusal` stop is a thrown error (`:659-661`). The turn's `usage` — returned by `runCoachTurn`
(`src/lib/ai/model-client.ts:709`, summed at `:693` from `message_start` / `message_delta`,
`:487-495`) — is **discarded** by `runExtractionTurn`, which keeps only `stopReason` and `text`.

**What the parser does with a null quantity.** It does *not* preserve a model null as such. Each
object line is parsed from its own `raw` text (`parseIngredientLine`, `:597`), the model's fields
first and the parse second: `qty: num(e.qty) ?? parsed.qty` (`:600-602`). `parseLeadingQty`
(`src/lib/recipes/ingredients.ts:128-155`) matches any leading integer, decimal, fraction, mixed
number or vulgar glyph, so `{"raw":"2 tbsp miso","qty":null}` comes back with `qty: 2`. A line is
`qty === null` only when the model gave no number **and** the raw carries none. The §6 fixture
(`db/recipe-import.test.mjs:296-306`) holds at `:305` for `"parmesan to taste"` because that raw has
no leading number. §3.6 is written against this.

### The share-in half already knows what a movie is

`recipeImportShareFromPayloads` (`src/lib/recipes/share-payload.ts:86-118`) routes `url → text →
image → video`, the video branch **last** (`:109-115`) so a reel shared with its link keeps the rung
that works. The variant is `{ kind: 'video'; uri: string }` and nothing more (`:57`); the payload it
is built from is `{ value, shareType? }` (`:38-45`), so a shared movie arrives with **no duration
and no dimensions**. The branch carries a sentence, `VIDEO_SHARE_MESSAGE` (`:73-74`), rendered by
`app/recipe-import.tsx:159-161` with `suggestPaste`, pinned at `db/recipe-import.test.mjs:570-592`
and `:606-614`. It is **dormant on the device**: `app.json:63-67` carries no
`supportsMovieWithMaxCount` (the plugin maps that key at
`node_modules/expo-sharing/plugin/src/ios/createInfoPlistFile.ts:33-35`), the Info.plist is
generated at prebuild, and `:619-627` asserts the current rule.

### The photo rung is the pattern to copy — including how it shipped

`pickScreenshot` (`app/recipe-import.tsx:200-224`) calls `pickPhotoBase64`
(`src/lib/media/photo-library.ts:409-443`) and answers every variant of `PickedPhoto` (`:396-402`)
in words: cancel says nothing (`:202`), `unavailable` and `failed` become prose routing to paste
(`:203-219`). It sets **no phase while the picker is open** — `run()` (`:123-139`) sets `working`
only once it holds an `ImportInput` (`:127`) — which is what makes the silent cancel safe. `run()`
also owns supersession: it aborts the previous controller (`:124-126`) and discards a stale resolve
(`:130-134`), its comment naming *"superseded by a screenshot pick"* as the case. The seam declares
only the shape ARC reads (`PickerModule`, `:30-55`) and resolves the module **inside a function** in
a try/catch (`:148-157`); `camera.ts:82-91` and `backup-file-store.ts:110-121` are the same pattern.
(`api-key-store.ts:53-59` is *not* — it resolves at module scope, which `photo-library.ts:130-135`
forbids for anything the render walk imports.) A route file never statically imports a native
module (`docs/project-status.md:355`).

How that rung *shipped* matters for §5: `expo-image-picker` entered `package.json` on 2026-08-08
(`docs/recipes-grocery.md:534`, *"built-but-dormant"* until its build) and was absent only from the
**binary** until 2026-08-25 (`docs/project-status.md:361`). `metro.config.js:1-6` installs no custom
resolver, so a `require` of a package not in `node_modules` fails at bundle time under the `expo
export` gate (`project-status.md:11`). The precedent is "installed, binary behind", never "absent".

The one downscale, `downscaleJpeg` (`photo-library.ts:180-229`), takes a **file URI** through the
legacy `manipulateAsync` (`:57-66`), bounds the long edge (`longEdgeResize`, `:94-101`; `COMPRESS =
0.6`, `:78`), needs no correction pass when the caller passes `source` dimensions (`:198-199`,
`:272`; `:211-220` is for callers that cannot know their shape), and returns the JPEG's own
`width`/`height` (`:221-225`).

### What is installed, what is not, and what the types say

`package.json` has `expo-image-picker ~57.0.8`, `expo-image-manipulator ~57.0.8`, `expo-file-system
~57.0.1`, `expo-sharing ~57.0.10`; it has **no** `expo-video` or `expo-video-thumbnails`, and `npm
run doctor` is `expo-doctor` (`:14`). Both candidates are in the SDK 57 bundle
(`node_modules/expo/bundledNativeModules.json:95-96`: `expo-video-thumbnails ~57.0.1`, `expo-video
~57.0.2`); **`expo-av` is not in that file at all.** The picker's installed types declare `MediaType
= 'images' | 'videos' | 'livePhotos'` (`node_modules/expo-image-picker/build/ImagePicker.types.d.ts:
48`), `duration` in **milliseconds** (`:297-299`), `fileName` (`:269`), and
`preferredAssetRepresentationMode` with `Current = "current"`, *"to avoid transcoding, if possible"*
(`:208-210`, `:515`).

### The review screen, what it writes, and a cost line that already exists

`ReviewDraft` (`app/recipe-import.tsx:455-764`) is the editable review every rung lands on: a
provenance eyebrow, `no AI · site data` or `≈ extracted`, in the `SectionLabel` accessory
(`:529-536`); an optional serif author · platform line (`:537-541`); the model's `notes` in the
margin voice (`:733-739`); Save writing the four `source_*` columns (`:501-504`). `SectionLabel`
(`src/components/ui/section-label.tsx:56-61`) is one row — label at `flex-1`, accessory
unconstrained, then the mono `note`, *"a tally, a count, a date"* (`:8-11`); the widest accessory
today is seventeen characters (`:533`). `source_image_url` must be https
(`src/lib/recipes/source.ts:110`) and is drawn by `app/recipe-detail.tsx:561-587` only when the
recipe has no photo of its own, labelled *"From the source"* (`:583-585`); the recipe's own picture
is `photo_file_name`, drawn at `:539-560` and written by `setRecipePhoto(db, id, base64Jpeg)`
(`src/lib/media/recipe-photo-store.ts:53-58`) — a string, not a file.

Every Coach reply already wears a mono `usageCaption` (`src/components/coach/message-bubble.tsx:
354-366`, built at `src/hooks/use-coach-chat.ts:309-313`) on the stated principle that *"the only
recurring cost in ARC is model tokens, so it should be visible"*. `usageCaption(usage, model,
toolCount)` (`src/lib/ai/cost.ts:73-105`) renders `… in · … out · ~$0.02`.

### The prompt has no ceiling

`RECIPE_EXTRACTION_SYSTEM_PROMPT` (`import.ts:449-471`) is 1,378 characters, 383 tokens under the
house estimator (`db/coach-eval.test.mjs:387`, `/3.6`), and nothing asserts it. Its load-bearing rule
is *"Extract ONLY what the source actually states. NEVER invent"* (`:455-456`), doctrine by the ADR
(`docs/decisions.md:381`). The three one-off ceilings run 6–8 % of air: food-entry 500 over 469
(`coach-eval.test.mjs:851-857`), estimator 1000 over 922 (`src/lib/nutrition/estimate.ts:343`;
`db/nutrition-v2.test.mjs:2193-2206`, vacuity guard `:2204`), add-exercise 600 over ~560
(`db/exercise-ai.test.mjs:864-867`). **Nothing here touches the day:** recipes carry no date, and
nothing in this rung reads `logicalDate` or `todayISODate` (`src/lib/db/date.ts:168`, `:232`).

---

## 2. The owner's words

> **D1 | Recipe import from a caption-less video [spike]** — *"Some recipe import apps are able to
> figure out a recipe just from the video, with no captions. I want to see if that is feasible to
> implement and implement if so."* (`docs/backlog-2026-09.md:56`) — and on the spike's answer:
> **build later, after this batch ships** (`:68`). On rebuilding, 2026-08-25: *"we have rebuilt
> already, its not that hard"* (`docs/project-status.md:361`).

---

## 3. Proposed design

### 3.1 Input: a video the user already has, from the library

**The library pick is the door.** A new `pickVideoAsset()` beside `pickPhotoLibraryAssets`
(`photo-library.ts:335-368`) calls `launchImageLibraryAsync({ mediaTypes: ['videos'], allowsEditing:
false, preferredAssetRepresentationMode: 'current' })` through the existing seam and returns `{
kind: 'video', uri, durationMs } | canceled | unavailable | failed`. `PickerModule`'s asset shape
(`:43-53`) gains `duration?: number | null`, typed as loosely as `creationTime` (`:48-50`); nothing
depends on the asset's `width`/`height`, since the thumbnails report their own (§3.2). `'current'`
hands over the stored file instead of an H.264 transcode (`ImagePicker.types.d.ts:208-210`); HEVC,
ProRes and slow-motion files are AVFoundation-decodable on every supported iPhone, and a file the
decoder cannot open is a thrown thumbnail call → `failed` (§3.5), not a stall. Live Photos are a
separate `MediaType` (`:48`) and are not requested.

**The share sheet stays closed to movies in this build** (question 2). The recommended decoder
exposes no duration read, and without a duration nothing can be sampled — opening
`supportsMovieWithMaxCount` would require the second package for a metadata call alone. Instagram
and TikTok share a link, not a file (spike §1b, `:48`); the only movie the sheet could deliver is one
already in Photos, one picker tap away. `VIDEO_SHARE_MESSAGE` and its tests stand. Nothing is
downloaded: the ADR's *"Never media downloads"* (`docs/decisions.md:379`) is about the network, and
this rung makes no request except the model call.

### 3.2 Frame extraction: `src/lib/media/video-frames.ts`

One new seam in the `photo-library.ts` shape: a `require` inside a function in try/catch, the
surface ARC uses declared locally, absence a variant, nothing native resolved at import time —
`db/screens-render.test.mjs` walks the screen's import graph under Node (`:80`, `:315-320`).

**Which module: `expo-video-thumbnails`, alone.** Its `getThumbnailAsync(uri, { time, quality })`
(time in **milliseconds** — one `frameTimesMs` helper converts at one call site) returns `{ uri,
width, height }` (spike §2, `:66`): a plain file URI with its own dimensions, which feeds
`downscaleJpeg(uri, { maxEdge: FRAME_EDGE, source: { width, height } })` unchanged — the shipped
manipulator path, the bound chosen from a known shape (`:198-199`), no guess, no correction pass.
The second draft put `expo-video` first on a deprecation claim with no in-tree evidence, built a
`SharedRef → manipulate → renderAsync → saveAsync` chain nobody has run, and kept both packages to
hedge it; the critic was right that this inverted the risk. **The honest cost of the flip:** Expo's
docs mark `expo-video-thumbnails` deprecated in favour of `expo-video`; it is still pinned in the
SDK 57 bundle (`bundledNativeModules.json:95`), so it ships in this build, and the risk is a future
SDK dropping it — a rebuild ARC will be doing anyway. Two JPEG encodes per frame (the thumbnail at
`quality: 0.9`, then the downscale at `COMPRESS`) are accepted: the module writes a file.

**`expo-video`, as the opt-in** (question 4b). If the device pass finds the per-frame decodes too
slow, `expo-video`'s `generateThumbnailsAsync(times, { maxWidth, maxHeight })` bounds at decode time
in one native call, and `createVideoPlayer(uri)` reports a duration — also what a share-sheet movie
would need (§3.1). Its output is a `SharedRef<'image'>`, which the installed manipulator's
`manipulate()` accepts on the types (`node_modules/expo-image-manipulator/build/
ImageManipulator.types.d.ts:118`) and which nobody has run. Whether `maxWidth` / `maxHeight` are
bounds or targets is settled by reading the package's own typings the moment it is installed — if
bounds, both are passed at `FRAME_EDGE` and no dimension choice exists; if targets, `longEdgeResize`
chooses one. That branch is not built unless question 4 asks for it.

**Cache hygiene under partial failure.** Every thumbnail path is pushed to a list the moment the
call returns; a `finally` deletes whatever is on it — a throw on frame seven cleans one to six. The
delete is `backup-file-store.ts:352-355`'s (`new File(Paths.cache, name)`, `.exists`, `.delete()`).
The base64 strings are extracted *before* the files go, so nothing downstream holds a cache path:
the review and Phase 3 hold strings.

**A payload cap that binds.** Each base64 is checked against `FRAME_BASE64_CAP = 200_000` (~150 KB
of JPEG); a frame over it is re-encoded once at `compress: 0.45`, and if still over it is
**dropped** and `stillCount` falls — a cap that never binds guards nothing
(`coach-eval.test.mjs:852`). Ten frames at the cap is 2 MB of ASCII string in Hermes plus one
serialisation into the request body, inside any budget the app has; the intermediates live on disk.

**Abortability, progress, shape.** The seam takes the screen's `AbortSignal` and checks it between
native calls; a set signal returns `canceled` and the `finally` cleans up (one decode in flight
finishes unused). It takes `onPhase?: (label: string) => void`, called *"Reading N stills…"* once
the count is known; the screen's guard is in §3.8. It returns `{ kind: 'frames', framesBase64:
string[], stillCount: number, durationS: number, everySeconds: number } | canceled | unavailable |
failed | { kind: 'no-frames' } | { kind: 'too-long'; durationS: number }` and never throws.

**Where the numbers live.** `FRAME_EDGE = 768`, `FRAME_COUNT_MIN = 4`, `FRAME_COUNT_CAP = 10`,
`FRAME_SURVIVOR_MIN = 2`, `SECONDS_PER_FRAME = 4.5`, `MIN_DURATION_S = 2`, `MAX_DURATION_S = 300`,
`FRAME_BASE64_CAP` — all exported from `video-frames.ts`. The edge is this caller's dial, as the
workout importer's 1280 is its own (`photo-library.ts:236-242`); `COMPRESS` stays the seam's one
copy (`:78`). Question 1's tiers change two constants.

### 3.3 Which frames, and how many

**Uniform, the ends trimmed by half a second.** `frameTimesSeconds(durationS, n)` returns `n` times
from `0.5` to `durationS − 0.5`, evenly spaced, and `[]` under `MIN_DURATION_S`; the seam returns
`failed` below two seconds — a clip too short to sample is the screenshot rung's job. **Count is
adaptive under a cap:** `frameCountFor(durationS) = clamp(⌈D / 4.5⌉, FRAME_COUNT_MIN,
FRAME_COUNT_CAP)` — 4.5 is the spike's gap arithmetic (`:142`). A 15-second clip gets 4; a 45-second
reel 10; a three-minute video 10, one every 20 s.

**The interval is computed from what survived, not what was asked.** A thumbnail call that throws
skips that frame; a frame over the cap is dropped; the decoder may snap two requested times to one
keyframe, which this module cannot report (no `actualTime` on its result — that dedupe returns only
with `expo-video`) and is accepted as a token cost, not a correctness one. So
`intervalSeconds(survivingTimes) = (last − first) / (n − 1)` — the sampler's own gap when nothing
dropped, the true mean gap otherwise — is the one figure the rail and the review print, through
`formatInterval` (one decimal under ten seconds, whole seconds above). Ten of ten from 45 s is
**4.9 s**; eight survivors from the same reel print *"8 stills · about 1 per 6.3 s"*, never "every
4.9 s". Fewer than `FRAME_SURVIVOR_MIN` is `no-frames`.

**A duration ceiling, and why 300 s.** Past five minutes at ten frames the gap exceeds 33 s — a
ten-second overlay is more likely missed than caught, and a video that long has a description the
URL rung reads. The seam returns `too-long` (§3.5); an unknown duration (picker `null`) is `failed`.

**Burned-in text versus the platform's captions.** A reel saved from TikTok carries what the
creator burned in — stickers, overlay cards, the `2 tbsp` stamped on a pour; a **screen recording**
carries everything on the screen, including the platform's auto-captions, which is the stronger
input for a narrated reel, and the review cannot tell which it was given. An overlay card that sits
in place for the whole reel is the *good* case — every sample catches it — and the repetition costs
tokens, not accuracy. **Why not scene change or text density:** both need pixels or OCR in
JavaScript, which RN lacks, or a second native seam, to make a deterministic judgement about what a
frame contains — the model *is* the OCR (spike §4). The gap between samples is real and stays (spike
`:142`); the review's sentence exists for it, and the fix when it bites is the screenshot rung.

### 3.4 The model request

`ExtractionInput` gains `{ kind: 'frames', framesBase64: string[], caption: string | null,
stillCount: number, durationS: number, everySeconds: number }`; `buildRecipeExtractionRequest`
pushes `Image 1:` text, image, `Image 2:` text, image, … then the rail as one text block, then the
caption block when present — 2N + 1 blocks without a caption, 2N + 2 with (spike §3a; ≤ 20 images).

**The rail rides in the user turn, not the system prompt.** With `10`, `45`, `4.9` substituted:

> These are 10 stills from a 45-second cooking video, about one every 4.9 seconds. The audio was
> not heard: amounts, times and temperatures that were only spoken are not available — leave them
> null. Read on-screen text exactly. Name an ingredient only when on-screen text names it or it is
> unmistakable on sight; never infer one from a container, a colour or a technique. If the stills
> show more than one recipe, extract the first and list the others in notes. If they show only a
> finished dish and no recipe, answer found:false.

527 characters, **146 tokens** under `/3.6`, paid only by video imports. The second draft
constrained amounts and nothing else, and the spike's own §6 predicted the result — *"a plausible
ingredient list read off the counter"* (`:197`), inference, not extraction. The name clause is the
labs rule (*never fuzzy-match*, CLAUDE.md §7) applied to a jar; the compilation clause answers a
multi-recipe reel. A rail sentence is a prompt, not a rule in code: the model still judges what
"unmistakable" means. The system prompt gains one clause at `:451`, *", or stills from a cooking
video"* — 32 characters, 1,378 → 1,410, **392 tokens**.

**The caption rides along when present.** If the paste field holds text at the moment the video is
picked (the A6 sequence, `import.ts:667-673`), it is appended as `Caption from the post:\n…` — prose
already paid for on the text rung, outside the rail's ceiling.

**Two ceilings, and the turn's own cost kept.** `RECIPE_EXTRACTION_PROMPT_CEILING = 420` and
`VIDEO_RAIL_CEILING = 155`, exported beside the prompt and asserted in `db/recipe-import.test.mjs`
with the `/3.6` estimator and the `> ceiling × 0.6` vacuity guard (`nutrition-v2.test.mjs:2204`):
392 and 146 measured, ~7 % and ~6 % of air — the house band. The same test asserts the prompt is
not a substring of the Coach's system prompt, as `coach-eval.test.mjs:858-861` does.
`runExtractionTurn` returns `usage` alongside the parse (two lines at `import.ts:648-662`); the
frames branch puts it on the draft's `sampling` field (§3.6).

**Token and cost per import.** Visual tokens are `⌈w/28⌉ × ⌈h/28⌉` (`db/progress-photos.test.mjs:
943`); a 9:16 frame at 432×768 is **448**. Input is frames + 392 prompt + 146 rail + ten `Image i:`
labels (~32); output ~600 tokens of JSON. One arithmetic, used everywhere in this file:

| Tier | Frames | Input | Sonnet 5 @ $2/$10 | Sonnet 5 @ $3/$15 | Opus 5 @ $5/$25 |
| --- | --- | --- | --- | --- | --- |
| cheap: 6 × 640 (299 each) | 6 | 2.4k | $0.011 | $0.016 | $0.027 |
| **default: ≤ 10 × 768 (448 each)** | 10 | **5.0k** | **$0.016** | **$0.024** | **$0.040** |
| thorough: 10 × 1024 (777 each) | 10 | 8.3k | $0.023 | $0.034 | $0.057 |

`$2/$10` is what `src/lib/ai/cost.ts:23-31` charges today, with a REVISIT note that the rate reverted
to `$3/$15` on 2026-09-01 (`:25-29`) — the middle column is the honest Sonnet figure until that
one-line fix. `DEFAULT_MODEL` is Sonnet 5 (`model-client.ts:54`); the screenshot rung is ≈ $0.008
and a caption ≈ $0.007 (spike §3b). This turn does not pay the Coach's cached prefix; its ~400-token
system block is below every cacheable minimum, so the breakpoint at `model-client.ts:268-269` is
inert; `DEFAULT_MAX_TOKENS = 8192` (`:84`) is ample. The seam knows each frame's real dimensions, so
the *predicted* figure is computable before the call; the review shows the *billed* one.

### 3.5 Degrade paths, each a state

| Seam outcome | What the screen does |
| --- | --- |
| `unavailable` (no decoder in this binary) | `failed`: *"Video import needs the next app build. Share a screenshot of the ingredient list, or paste the caption."*, `suggestPaste: true` — the screenshot rung's own shape (`recipe-import.tsx:203-211`) |
| `canceled` | No state change: the screen stays in `input` (§3.8) |
| `failed` / `no-frames` | `failed`: *"Couldn't read that video — share a screenshot of the ingredient list, or paste the caption."*, `suggestPaste: true` |
| `too-long` | `failed`: *"That video is 12:30 long — ARC reads up to five minutes. Share a screenshot of the ingredient list, or paste the caption."* (`m:ss`, never rounded minutes), `suggestPaste: true` |
| `frames` | `run()` with the frames `ImportInput`; the ladder's existing handling applies |
| Model `found:false` (plate-only, or nothing legible) | `NoRecipeFoundError` → the failure prose with the model's reason (`:103-104`). The feature working |
| A draft with blank amounts (a narrated reel) | The review, with the sentence in §3.6 |
| No model key · model `refusal` | The control is not rendered (§3.8) · the existing thrown error (`import.ts:659-661`) |

The mapping from a non-`frames` outcome to prose is a pure function, `videoOutcomeMessage(outcome):
{ message: string; suggestPaste: boolean } | null`, in a new `src/lib/recipes/video-outcome.ts`
beside `share-payload.ts` — the same DB-free, prose-for-an-outcome role. The second draft put it in
`share-payload.ts` returning the screen's `Phase`; `Phase` is route-local and unexported
(`recipe-import.tsx:76-80`), no file under `src/` imports from `app/`, and the inputs come from the
picker seam, not the share sheet. The screen maps the result to a `Phase` at the call site.

### 3.6 The review: reuse it, and say what it is

`ReviewDraft` is reused whole. `RecipeDraft` gains one **optional** field, `sampling?: { stills:
number; everySeconds: number; usage: CoachUsage | null }`, so the three other construction sites
(`import.ts:309`, `:696`, `:709`) and the `baseDraft` fixture (`screens-render.test.mjs:2730-2744`)
need no edit. Three authored changes, none a new device:

- The provenance accessory (`:529-536`) reads `≈ from video` — twelve characters, inside the
  seventeen the slot holds today (`:533`).
- Under the eyebrow, where the serif author · platform line sits (`:537-541`), a **mono** line,
  because these are measurements: `10 stills · about 1 per 4.9 s · 5.0k in · 0.6k out · ~$0.02` —
  the tail is `usageCaption(usage, model, 0)` verbatim (`cost.ts:73-105`), the string every Coach
  reply already wears (`message-bubble.tsx:354-366`). Question 5.
- Under the ingredient plate, only when `sampling` is set **and** at least one line has `qty ===
  null`, one margin block:

  > These lines carry no amount: the video's audio was not read, and nothing on screen gave one.
  > Fill them in or leave them blank.

  Computed from the review's own lines, so typing an amount into the last blank line removes it; by
  §1's mechanism a raw line saying `2 tbsp miso` is never counted. The sentence no longer asserts
  the ingredients *"were shown"* — for an unlabelled jar that would be the app claiming what the
  model guessed — and the second draft's middle sentence (*"ARC read the video; it could not hear
  it"*) is cut: it restated the first in the personified register the A9 pass removed
  (`docs/ai-slop-candidates-2026-09.md:21`, `:23`); the caveat itself is the kind that doc exempts
  (`:29`).

`draft.notes` renders as it does (`:733-739`) — which is where the model names a second recipe it
declined to extract (§3.4).

**Considered and rejected: removing the cost line once the device pass has measured it.** The
critic reads it as a one-time diagnostic shipped forever. The Coach shows the same caption under
every reply on a stated principle (`message-bubble.tsx:355-356`), and this is the most expensive
turn in the app; a disclosure the cheaper turns make is not one the dearest should skip. It is a
count in the mono voice, which is what the slot is for (`section-label.tsx:8-11`). The owner is
asked in question 5 because he has never been.

**Considered and rejected: suppressing the `?? parsed.*` backfill on the frames rung so a model
null stays null.** The raw line *is* the model's reading of the screen, and a number in it is a
number the model claims it saw; a null under a raw that says `2 tbsp` would put the sentence over a
line that visibly carries one. The bare-string case (`recipe-import.test.mjs:308-313`) relies on it.

### 3.7 What is written, and what is not

Save writes what the screenshot rung writes (`:496-522`): `source = 'import'`; `source_url` /
`source_platform` from `startedFrom()` (`:190-193`) through `recipeSourceFromUrl`
(`import.ts:191-204`), `NULL` with no link; `source_author` and `source_image_url` `NULL`, as the
photo rung's own comment requires (`:713-715`) — nothing was fetched and a local frame is not https
(`source.ts:110`). No frame is stored: `photo_file_name` is the cook's photograph
(`recipe-detail.tsx:539-560`), and a provenance bit beside it is a migration for a picture the owner
has not asked to keep — question 3. `sampling` is review-time only; provenance stays in the 0031
columns, honouring 0034's rule by not inventing a JSON side-channel.

**`resolved_by` is untouched, and the two AI claims do not collapse.** That column records *who
priced* a line (`db/migrations/0034_recipe_photo_autoresolve.sql:21-33`); nothing in this rung
writes it. A line whose *name* the model read off a still and a line the model later *prices* are
two facts: the first is the recipe's provenance (`source='import'`, the `≈ from video` eyebrow), the
second is `resolved_by='ai'` on the line, set by the existing ladder in its own time.

**Migrations: none.** If question 3 keeps the frame, `0059_recipe_photo_source.sql` adds a nullable
`photo_source text CHECK (… IN ('user','video_still'))` on `recipes` — above head, never in a gap
(`src/lib/db/migrate.ts:70`).

### 3.8 The screen, in Conformed Set vocabulary

**The entry is a bare pressable, not a chip.** The `url` / `text` chips (`recipe-import.tsx:247-275`)
select a field to type into; a video has none. The screenshot rung's bare ink pressable with an
outline icon (`:404-414`) is the precedent, and *"Import from a video"* joins it as a second row of
the same shape (`videocam-outline`), inside the `keySet` arm; the accent budget is unchanged
(`:69-74`). **With no key it is not rendered**, like the screenshot control, and the no-key margin
sentence (`:398-399`) gains the word: *"captions, screenshots and videos need the model"* — that
block is the explanation, so nothing is greyed. That arm is not reachable headless —
`isRecipeImportAvailable()` is `apiKeyStore.has()` (`import.ts:117-119`), false under Node, so
`screens-render.test.mjs:319` renders the no-key arm — so the pressable's render opens the device pass.

**No pending state.** `Mode` (`:82`) stays `'url' | 'text'` and `ready` (`:226`) is untouched: the
video pressable runs the seam straight through to `run()`, as the screenshot pressable does
(`:220-223`). The second draft's `pendingVideo` — typed with a duration and dimensions a share-sheet
movie never carries (`share-payload.ts:57`), populated by no path — is gone with the share door
(§3.1). Should question 2 reopen that door, the state is `{ uri, name }` only, `name` the basename
of the share URI, shown as a mono line (`reel.mov`, no length claimed) with the ingredient row's
remove control (`:688-695`), `ready` flipping on it, and the duration read by `expo-video` on the
Import tap — which is why 2(a)/(b) require 4(b).

**Working, cancel, and the re-entrancy window.** The video path creates the `AbortController`
*before* the picker opens and stores it in `abortRef` (`:97`); `run()` gains an optional
`controller` parameter so it adopts that one instead of minting a second. A `busyRef` is set at the
tap and cleared in a `finally`; a second video tap while it is set is ignored. The phase goes to
`working` (*"Reading the video…"*) the moment the picker resolves with an asset — never before, so a
cancel leaves `input` — and `onPhase` relabels it *"Reading 10 stills…"*. A screenshot pick during
the decode calls `run()`, which aborts the shared controller (`:124-126`); the video path checks its
own signal after the seam returns and exits silently if set, the same guard `run()` has
(`:130-134`) — the later pick wins, the house supersession rule. An unmount aborts through the
existing effect (`:100`). The working row (`:324-328`) narrates the 8–15 s the spike estimates and
cannot strand.

**Wall-clock and memory, estimated.** Ten full-size decodes at 100–300 ms (AVFoundation seeking from
the prior keyframe), ten manipulator passes at ~100 ms, then a 5–10 s model turn: the spike's 8–15 s
stands. Memory is ten strings under 200 KB and ten cache files deleted before the seam returns; the
draft holds no frames (Phase 3 would carry one string). Failures stay on the bare sheet (`:359-392`).

### 3.9 Tests that pin it — mock harness only

Headless, no model, no key. `db/recipe-import.test.mjs` gains a numbered section per rule;
`db/progress-photos.test.mjs` gains the seam's arithmetic; `db/screens-render.test.mjs` re-walks the
screen. Expected: ~60 assertions over the 4,805 on `main` (`project-status.md:11`).

1. **Sampling.** `frameCountFor`: 15 → 4, 45 → 10, 180 → 10 (the zero case is unreachable behind
   `MIN_DURATION_S` and is not asserted). `frameTimesSeconds(45, 10)` runs 0.5 … 44.5, every time
   in `[0, D]`; `frameTimesSeconds(0.4, 4)` is `[]`. `intervalSeconds` over the full ten equals the
   gap between consecutive times; over a **fixture with two dropped** it equals `(last − first) / 7`
   and `formatInterval` prints `6.3 s` — the case the second draft's test could not fail on. One
   survivor is `no-frames`; a frame still over `FRAME_BASE64_CAP` is dropped and `stillCount` falls.
2. **Request shape.** N frames with no caption yield exactly 2N + 1 blocks, `Image i:` then image,
   images before the rail, which names N, the formatted interval and the duration; with a caption,
   2N + 2 and the caption block last; the system prompt is byte-identical across text, photo and
   frames.
3. **The rail's wording** says the audio was not heard, forbids naming an ingredient from a
   container, names the multi-recipe rule, and instructs `found:false` for a plate-only video.
4. **Ceilings.** Prompt < 420 and > 252; the substituted rail < 155 and > 93; the prompt is not a
   substring of `buildCoachSystemPrompt(...)`.
5. **Parsing on the frames branch.** `found:false` throws `NoRecipeFoundError`. Raw lines with no
   leading numerals (`"miso paste"`, `"soy sauce, to taste"`) and `qty: null` parse with every
   `qty` null; `{"raw":"2 tbsp miso","qty":null}` parses with `qty: 2`, and a pure
   `unheardAmountCount(lines)` counts the first fixture's two lines, not this one. The branch nulls
   `source_author` / `source_image_url`, carries `sourceUrl`, sets `sampling.usage`, never fetches.
6. **Share routing.** `:570-592` and `:619-627` stand unchanged.
7. **The seam under Node.** `isVideoImportAvailable()` is false and `pickVideoFrames()` returns
   `unavailable` — as `:631-633` pins for the share seam.
8. **Arithmetic on the edge.** `longEdgeResize(1080, 1920, 768)` is `{ height: 768 }` and 432×768
   is 448 patches; 16:9 → 448; 4:3 → 588. The constant identity the second draft asserted is gone —
   it could not fail.
9. **Render walk.** The screen's four pinned strings (`:315-320`) stand and the no-key sentence
   names videos; `ReviewDraft` with `sampling` set and two null-`qty` lines renders `≈ from video`,
   the mono line and the sentence; with `sampling` absent, none.
10. **Degrade routing.** `videoOutcomeMessage` maps `unavailable`, `failed`, `no-frames` and
    `too-long` (`12:30` in the message, `5:30` for 330 s) to `suggestPaste: true`, and `canceled` to
    `null` — every row of §3.5.

---

## 4. Alternatives considered

| # | Alternative | Verdict |
| --- | --- | --- |
| A | **Audio transcription** — what the competitor apps do | Out of reach without authoring a Swift Expo module; the API takes no audio (spike §3c). A D-phase item of its own |
| B | Fetch the video from the shared URL | Forbidden twice (`decisions.md:379`; CLAUDE.md §2). Closed |
| C | `expo-video` first, thumbnails as the hedge, both shipped | The second draft's choice — it inverted the risk (§3.2). `expo-video` is now the opt-in, question 4b. `expo-av` is not in the SDK 57 bundle at all (`bundledNativeModules.json`, no entry): closed outright |
| D | The spike's placement — below the screenshot rung, never fallen into | Kept. The ladder's rung 8 is "Nothing worked" (`recipes-grocery.md:164`); video becomes rung 8 and the last row 9 — the one collision, fixed in §5 |
| E | Pure-JS decode | No canvas, no route from pixels to JPEG on Hermes (spike §2). Closed |
| F | Scene-change / text-density selection, or a two-pass "which stills matter" turn | A second seam or request, and a deterministic judgement about content (§3.3). Rejected |
| G | The rail in the system prompt | Every caption import would pay 146 tokens for a rule about videos (§3.4) |
| H | Open the share sheet to movies now | Needs a duration read the recommended decoder lacks; the file is one picker tap away (§3.1). Question 2 |
| I | Store the plated frame as the recipe's photo | A creator's still behind the cook's label; needs `0059`. Question 3 |
| J | A video source chip (the spike's sketch) | A chip selects a field; a video has none (§3.8) |
| K | Several screenshots in one pick, as a Phase 0 slice "on the current binary" | **Dropped.** The second draft sold it as provable on hardware before any package lands; with no OTA channel it reaches the phone in the same binary as the video rung and buys no sequencing. A half-day change to a shipped control (`recipe-import.tsx:200-224`, `:404-414`; `pickPhotoLibraryAssets` already takes a `limit`, `photo-library.ts:346-348`) that belongs in the backlog as its own line |
| L | The user deselects stills before the model call | A contact sheet of ten 768-px JPEGs so the user can judge "does this frame carry writing?" from a thumbnail too small to show it. The user's arbitration point is the *output* (`import.ts:4-5`, the mandatory review), not the input. Rejected |

---

## 5. Effort and phases

| Piece | Size |
| --- | --- |
| `video-frames.ts` seam (thumbnails branch, cleanup list, binding cap, abort, `onPhase`, variants, constants) + `pickVideoAsset` | half a day |
| `frames` variant through `ExtractionInput` / `ImportInput` / `buildRecipeExtractionRequest` / `importRecipe`, `usage` kept, the rail, the two ceilings, `video-outcome.ts` | half a day |
| The screen: the pressable, `run(controller)`, `busyRef`, the working narration, the no-key word, the review's three changes | half a day |
| Tests (§3.9, ten groups) | half a day |
| Docs of record (below) · `package.json` + `expo-doctor` (Phase 0) · EAS (Phase 1) | hours; the build is the owner's |
| **Total** | **≈ 2 days of code**; the build and device pass are the schedule |

The spike said one day (`:176`). This is two: the binding cap, abort and cache hygiene, the
survivor-based interval, the re-entrancy guard, the review changes and the ten test groups are each
small and none was in the spike's table; the second draft's three days included the `expo-video`
chain and a multi-screenshot slice, both now out.

**Phase 0 — everything that needs no binary, including the `package.json` line.**
`expo-video-thumbnails ~57.0.1` is installed and `npm run doctor` (`package.json:14`) confirms it
against the SDK bundle; Metro resolves it and `expo export --platform ios` stays green; on the
current binary the guarded require returns null and the rung is dormant exactly as the screenshot
rung was (`recipes-grocery.md:534`). Phase 0 carries the seam, the pipeline, the screen, the tests,
this file moved to `docs/spikes/`, and **the doc edits, narrowed:** `docs/recipes-grocery.md`'s
ladder (`:155-164` — video as rung 8, "Nothing worked" as 9), the *trailing clause* of `:174`
(*"the screenshot and video-stills rungs cover …"*), and §8's native ledger (`:530-536`). The second
draft also listed the *"deliberately NOT attempted"* sentence itself (`:174`, *"downloading the
video or audio"*) and §9's first bullet (`:542`, *"Video/audio download or transcription"*): both
remain **true** — this rung downloads and transcribes nothing — and loosening a download prohibition
for a feature that does not download is the drift the ADR exists to stop. They are left alone.

**Phase 1 — the build.** EAS, owner-run, carrying 0045 → 0058 and `react-native-svg` too. There is
no `ios/` directory (managed workflow), so EAS prebuilds; a local `npx expo prebuild` is an optional
check, not a deliverable. `app.json` changes only if question 2 reopens the share door, with
`:619-627` flipped in the same commit. Docs: the rebuild ledger (`docs/project-status.md:361-362`)
gains the package and closes; the D1 row and parked line (`backlog-2026-09.md:56`, `:68`) flip.

**Phase 2 — the device pass** (§6). Read the cost line off the review; run five real reels; decide
question 4's opt-in from the wall-clock.

**Phase 3 — only if question 3 says keep the frame.** `0059`, one column; the draft's `sampling`
carries the last still's base64; the review offers *"use this as the picture"*; Save calls
`setRecipePhoto(db, id, base64Jpeg)` (`recipe-photo-store.ts:53-58`), which takes the string — the
seam's cache files are already gone (§3.2), so nothing is left to delete or reconcile.

**Rollback, stated plainly.** After Phase 1 the package and the control are in a TestFlight build the
owner uses, and a rail rewrite is a JS change — with no OTA channel, another build. There is no kill
switch, deliberately: a settings toggle for one rung is a feature flag in a single-user app. The net
that needs no build is the review — nothing auto-commits (`import.ts:4-5`), so a wrong name is a
line the owner deletes before Save — and the owner has said a rebuild *"is not that hard"*.

---

## 6. What only a device can settle

1. **Does the picker open a saved TikTok and a screen recording, and does `duration` arrive?** The
   asset shape is loose because nobody has seen it.
2. **Does `getThumbnailAsync` open a `'current'`-representation HEVC file without a stall,** and
   what does one call cost in wall-clock?
3. **Wall-clock, end to end,** and whether `onPhase` relabels when §3.8 says; past ~20 s,
   `FRAME_COUNT_CAP` comes down first, and past that `expo-video` (question 4b) is the answer.
4. **Real quality on five reels**: two with an ingredient card, two narrated-only with unlabelled
   jars, one plate-only. The card pair should read the card; the narrated pair should return blank
   amounts **and no ingredient named from a container**, with the sentence; the plate-only one
   `found:false`. An invented amount or an inferred name means the rail is rewritten next build (§5).
5. **Cache hygiene after a success *and* a failure** (airplane mode during the model call):
   `Paths.cache` holds no thumbnail either way. The pressable renders in the `keySet` arm.
6. **The share sheet, only if question 2 reopens it**: cold- and warm-start share from Photos; a
   reel shared *with* its link takes the link (`share-payload.ts:109-115`,
   `recipe-import.test.mjs:579-585`).

---

## 7. Questions for the owner

**1. How much should one video import cost?** Two constants in `video-frames.ts` (§3.2).

- (a) **Default — up to 10 stills at 768 px, ≈ $0.016–0.024 on Sonnet 5, ≈ $0.040 on Opus 5
  (Recommended).** Legible on-screen text at about two screenshots' cost.
- (b) Cheap — up to 6 stills at 640 px, ≈ $0.011–0.016. Wider gaps; briefly flashed overlays are
  missed more often.
- (c) Thorough — up to 10 stills at 1024 px, ≈ $0.023–0.034. Sharper small text, a third more.

**2. Open the share sheet to movies in this build?** The same saved file is one picker tap away;
the door needs a duration read only `expo-video` provides, so (a) or (b) forces question 4 to (b).

- (a) Open it; a shared movie waits for the Import tap.
- (b) Open it, and run at once, as a shared screenshot does.
- (c) **Library pick only; leave the rule and its test as they are (Recommended).**

**3. Keep a frame as the recipe's picture?**

- (a) **No picture, as the screenshot rung does today (Recommended).** No migration; the "cook's
  photo" label stays true.
- (b) Offer the last still on the review as "use this as the picture", with a provenance column so
  the detail screen can say *"from the video"* — `0059`, Phase 3.
- (c) Always store the last still. Rejected in the text: a creator's still behind the cook's label
  with no way to say so.

**4. One decoder or two?** `expo-video-thumbnails` is the simple, already-compatible one;
`expo-video` is the supported successor nobody has run here, and a shared movie's only duration source.

- (a) **`expo-video-thumbnails` alone (Recommended).** One package, no new loader, the shipped
  manipulator path; the risk is a future SDK dropping a deprecated module, which is a rebuild ARC
  will be doing anyway.
- (b) Both, with `expo-video` built as an opt-in branch the device pass may promote — roughly a
  third more seam code in Phase 0, most of it unverifiable until the build.
- (c) `expo-video` alone, and accept one more build if its output cannot reach the manipulator.

**5. Show what each video import cost, on the review?** `RecipeDraft` gains an optional `sampling`
field either way; this is about the second mono line under the eyebrow (§3.6).

- (a) **Yes — stills, interval and the Coach's own cost caption, e.g. `10 stills · about 1 per
  4.9 s · 5.0k in · 0.6k out · ~$0.02` (Recommended).** The disclosure every Coach reply already
  makes, on the dearest turn.
- (b) Stills and interval only — `10 stills · about 1 per 4.9 s`; no cost figure on a recipe screen.
- (c) Neither; the `≈ from video` eyebrow and the blank-amounts sentence are enough.
