# Faster water logging — a design spike

**Backlog item:** D2, *"Faster water logging"* (`docs/backlog-2026-09.md:55`)
**Status:** **BUILT — Rank 1 and Rank 2, 2026-09-14. Rank 1's long-press REVERSED on device, 2026-09-21. Rank 2 made TWO-WAY, 2026-09-21.** Ranks 3–6 remain refused or deferred exactly as argued below. Where the build departed from this document it is noted inline; the shipped behaviour is recorded in `docs/information-architecture.md` (the Log tab's water row) and `docs/wearables-subapp.md` §15 (the Apple Health read) and §20 (the write, and why the echo argument below no longer holds).

> **What the phone said (owner, 2026-09-21 build):**
>
> > *"the water no longer really works, because the button just adds 8? need to do something different here, idk what tbh."*
>
> Rank 1 fused two bullets — a one-tap remembered vessel, and long-press to reveal the rest — and argued they were only worth building together (§2 › Rank 1). **The fusion was the error, and it is the half of it this document argued hardest for.** He had logged glasses most often, so `usualWaterAmount` settled on 8 oz; the long-press had no affordance, so he never found it; and the tile therefore *was* an 8 oz button, exactly as he describes.
>
> The miss is not in the arithmetic. This spike measured **taps** — four paths, counted act by act — and never measured **discoverability**, which is the only axis on which a long-press differs from a visible control. §3.1's own downside 3 worried that a derived amount "moves", and answered it by printing the number on the tile's face. That answer is sound for the amount shown and useless for the three amounts *not* shown: a face cannot advertise what is behind a gesture.
>
> **The shipped shape since 2026-09-21:** Glass / Bottle / Large / Other… are a full-width ruled row of the Quick add plate, all four on the sheet at all times, one tap each; the long-press handler is deleted, not kept as an alias; the remembered amount survives as a *note* (`usually 8 oz`) that nothing taps. The tap count is unchanged at two (tab bar → an amount) and it is now two for **every** amount, not just for whichever one the derivation picked. Rank 2 is untouched. Layout arithmetic and the "marked, not reordered" decision: `docs/information-architecture.md`, and the docblock on `src/components/log/quick-add-grid.tsx`.
>
> **The lesson worth keeping, for the next spike that ranks options by taps:** a gesture with no affordance is not a cheaper path, it is an *absent* path for anyone who has not been told about it — so a tap count that includes one is measuring a route the user may never take. Count only what the sheet shows.

> **What the phone said about Rank 2 (owner, device checklist 2026-09-21; confirmed 2026-09-23):**
>
> > *"water should get 2 way health sync"* — and, on the Garmin item, *"works, units are heavily rounded"*.
>
> **The gate this document called the only thing that could kill Rank 2 has passed.** Hydration logged in Garmin Connect arrives in ARC through Apple Health, so `coverage.ts` now records `garmin: 'yes'`, citing the owner's phone.
>
> **And Rank 2 is now two-way.** The argument below that ARC must never write water ("a `cumulativeSum` query **cannot** filter out ARC's own samples") was wrong about the library. A statistics query takes the same sample predicate every reader builds, so ARC's own glasses can be kept out of the day's total. They are kept out by the metadata rung alone, fail-closed, because the source rung can fail open on a sum. Manual captures publish as one `DietaryWater` sample each, and an Undo takes a published glass back out of Health by its own id. The full account, including what only the phone can settle, is `docs/wearables-subapp.md` §20. **What survives unchanged:** no dedupe, and *pick one door*. ARC's own glasses are never counted twice now, but the same glass typed here *and* tapped on the watch is still two entries.
**Date:** 2026-09-14

---

## The question, corrected

The first ask was *"add 1, 2, 4 oz quick-add buttons for water."* The owner withdrew it himself:

> *"I actually want to find a way to make this logging faster and not necessarily just adding more quick buttons."*

That correction is the whole spike. More buttons on the water screen make the **last** tap cheaper, and the last tap was never the expensive one — the four taps before it are. The question this document answers is:

> **How does a glass of water get into ARC in the fewest, fastest actions from wherever he is?**

Which means the unit of measurement is not "taps on the water screen". It is **taps from wherever the phone actually is when he drinks**, including the case where the phone is in another room.

---

## 1. What it costs today, measured

Counting a tap, a keystroke burst, and a scroll as separate acts; counting a screen push/pop as a transition. Starting state: the app is open, somewhere.

### Path A — Log tab tile → keypad

`src/components/log/quick-add-grid.tsx:113–117` → `app/metric-entry.tsx`

| # | Act | Transition |
| --- | --- | --- |
| 1 | Tap **Log** in the tab bar | → Log tab |
| 2 | Tap the **Water** tile | → push `/metric-entry?metric=water` |
| 3 | Tap **Glass** (`+8 oz`) | — |
| 4 | Tap **Log Water** | → `router.back()` |

**4 taps, 3 transitions.**

The detail that makes this path worse than it looks: the keypad's water tiles are **additive onto the readout, not commits** (`app/metric-entry.tsx:171–176`, and the docblock is explicit — *"The `+` is load-bearing: these ADD to whatever is on the readout rather than replacing it"*). So even after tapping an amount you must still tap Log. Every other quick-add tile on the Log tab lands on a screen where the first tap finishes the job; this one needs two.

Add step 0 — tapping Log when you are not already there — and a glass costs a full third of the tab bar plus a pushed screen you immediately dismiss.

### Path B — Data tab → Water screen → Add

`app/(tabs)/data.tsx:248–253` → `app/water.tsx:444–461`

| # | Act | Transition |
| --- | --- | --- |
| 1 | Tap **Data** in the tab bar | → Data tab |
| 2 | Scroll to the Water trend row | — |
| 3 | Tap the **Water** row | → push `/water` |
| 4 | Tap **Bottle** (`+16 oz`) | — (writes immediately) |

**3 taps + 1 scroll, 2 transitions.**

Here the quick amount **is** the commit (`app/water.tsx:451` → `add(q.amount)` → `logWater`). Once you are on `/water`, one glass is genuinely one tap. The entire cost of this path is getting there — and the route is through a trend row on the Data tab, which is a reasonable place to *read* the water record and a strange place to reach for when you are holding a glass.

### Path C — the Log tab command field

`src/components/log/command-field.tsx` → `src/lib/log/parse.ts:69`

| # | Act |
| --- | --- |
| 1 | Tap **Log** |
| 2 | Tap the field (keyboard rises) |
| 3 | Type `water 16` — 8 keystrokes |
| 4 | Tap send |

**3 taps + 8 keystrokes, 1 transition.**

Already fully wired and fully offline: `parseCommand` recognises `water`/`h2o` and both the `"water 16"` and `"16 oz water"` orders (`src/lib/log/metrics.ts:86–100`). Fewer transitions than A or B, but the keystrokes cost more than the taps they save, and a soft keyboard is the slowest input on the device. Its real strength is **arbitrary amounts**, not speed.

### Path D — the Coach

`app/(tabs)/coach.tsx:74–94` → `src/lib/ai/coach-service.ts:60,94–100` → `src/lib/ai/tools/write-tools.ts:207–238`

| # | Act |
| --- | --- |
| 1 | Tap **Coach** |
| 2 | Tap the composer |
| 3 | Type `16 oz water` — 11 keystrokes |
| 4 | Tap send |
| 5 | **Wait for a network round trip to a frontier model** |
| 6 | Tap **Approve** on the pending-write card |

**4 taps + 11 keystrokes + a network wait + a confirmation tap.**

Three things make this permanently the slowest path, and only the first is fixable:

1. It requires typing an amount. A button does not.
2. It requires the network. Every other water path in ARC works with the network unplugged, which is the whole point of the local-first principle (`CLAUDE.md` §2).
3. **It ends in a mandatory Approve.** That gate is a design rule, not a rough edge — *"A pending write is a live decision"* (`docs/design-research/implementation/00-design-spec.md:172`), enforced by `confirmWrite` in `coach-service.ts:60`. It cannot be shortened for water without weakening it for every write the Coach makes.

**Is the Coach ever the fastest? For a glass of water, no — not once, not ever.** It is the fastest path for exactly one shape of input: an amount, a time and a correction in one breath (*"I drank about a litre at lunch yesterday"*). That is a genuinely good use and it already works. Leave it alone; do not bolt a "log water" chip onto `suggested-prompts.tsx`, which would still cost the round trip and the Approve.

### The honest summary

| Path | Taps | Keystrokes | Transitions | Works offline | Works when the phone is elsewhere |
| --- | --- | --- | --- | --- | --- |
| A — tile → keypad | 4 | 0 | 3 | yes | no |
| B — Data → Water | 3 + scroll | 0 | 2 | yes | no |
| C — command field | 3 | 8 | 1 | yes | no |
| D — Coach | 4 | 11 | 0 | **no** | no |

**The last column is the finding.** Four paths, four different costs, and every one of them is zero-for-four on the case that matters most for hydration: the glass you drink in the kitchen while your phone is charging in the bedroom. Water is the one metric that is logged *many times a day at unpredictable moments*, which is precisely the pattern that punishes any path beginning with "pick up the phone and open the app".

---

## 2. The options, ranked

Ranked by **speed gained per unit of effort**, with the constraint that nothing here may require a native rebuild unless it says so out loud.

---

### Rank 1 — Make the Water tile the vessel; move the amounts to long-press

**BUILD NOW.** 4 taps → **2 taps** (tab bar → tile), 3 transitions → **1**.

> ⚠️ **Half-reversed on device, 2026-09-21** — see the status block at the top. The *first* half (water logs in place, from the Log tab, in two taps) stands and is the win. The *second* half — "move the amounts to long-press" — is deleted: the amounts are a visible row now. Read what follows as the argument that was made, including the downside at 138 that turned out to be the wrong downside to worry about.

The two bullets in the brief — "a one-tap default vessel" and "long-press to reveal the amounts inline" — are one proposal, and fusing them is what makes either worth doing. Separately, each is worse:

- *A one-tap vessel as a **new** control* needs a home, and every home is spoken for (see Rank 3).
- *Long-press alone*, leaving tap = navigate, puts the fast path behind a gesture iOS gives no affordance for, and leaves the common case at four taps. It optimises the exception and ignores the rule.

Fused, the tile stops being a door and becomes the thing itself:

- **Tap** — logs the remembered amount to today, in place. No push, no pop.
- **Long-press** — reveals the remembered amounts inline, inside the same plate, under the grid. Glass / Bottle / Large / **Other…**, where *Other…* is the existing `/metric-entry` route, unchanged.

**Why the quick-add grid can take this.** The grid was cut from six tiles to four and the docblock says exactly why (`src/components/log/quick-add-grid.tsx:15–30`): the two that went were *"a different kind of thing wearing the same tile: not a capture, a DOOR"*, and the reason they could go is that *"the doors moved"* to the tab bar. The constraint is **not** "four is the maximum" — it is (a) a regular arrangement, which `TILE`'s layout note pins as 2 × 2 for four (`:80–100`), and (b) *"Every tile lands somewhere that writes."*

This proposal adds no fifth tile, so the 2 × 2 is untouched. And it makes the strongest possible version of the block's own stated contract true: the Water tile stops *landing somewhere that writes* and simply **writes**.

**Effort: small.** One component, one new repository read, two test files extended. No migration, no preference key, no new dependency — `Pressable` carries `onLongPress` natively, so `react-native-gesture-handler` is not touched. Pure JS; ships into the current binary. Call it half a day.

**Honest downsides, all three of them:**

1. **It breaks the grid's uniformity, which the docblock treats as load-bearing** — *"What is left is one kind of tile with one behaviour, which is why the chevron went with them."* Three tiles navigate, one commits, and the block will no longer have a single behaviour. The resolution is not to hide that but to state it: the tile prints its amount (`+16 oz`, mono) under its label, exactly as the water screen's and the keypad's quick tiles already do. A tile that says what it will do is allowed to do something different from its neighbours; a tile that looks identical and behaves differently is not.
2. **A committing tap can be made by accident, and there is no undo on the Log tab.** Mitigated, not solved: the "Logged today" feed sits on the same screen and already renders manual water rows (`src/lib/db/repositories/logs.ts:243–259`), so the mistake is visible without navigating, and `/water` corrects it. Accept this — a confirm step would hand back the taps the proposal exists to save.
3. **The remembered amount is derived, so it moves.** See the rule in §3.1. A button whose meaning changes silently is a bad button, which is why printing the number on the face is not decoration; it is the thing that makes the derivation safe.

**And the downside that is the real reason this is Rank 1 rather than the only recommendation:** it does nothing when he is not holding the phone. That case needs Rank 2.

---

### Rank 2 — Read `dietaryWater` from Apple Health

**BUILD NOW, gated on one on-device check.** Zero taps in ARC.

A hydration tap on the wrist, or in the Health app, or in any hydration app already installed, becomes an ARC row on the next sync. This is the only option on the list that wins the last column of the table in §1, and the only one that gets there without native work.

**It is pure JS, and that is verifiable rather than assumed:**

- `readDailyCumulative` is generic over the identifier and takes the HKUnit as a parameter (`src/lib/health/healthkit.ts:654–657`, `:665`). Nothing about hydration is special to it.
- `HEALTH_READ_IDENTIFIERS` is a derived JS array (`src/lib/health/mapping.ts:889–895`) fed straight into `requestAuthorization({ toRead })` (`healthkit.ts:176–178`).
- **A read scope needs no new Info.plist key.** `NSHealthShareUsageDescription` is already supplied by the `@kingstinct/react-native-healthkit` plugin entry in `app.json`. The key that would force a rebuild is `NSHealthUpdateUsageDescription`, and that one is only required for `toShare` (`healthkit.ts:160–171`). This is a read.
- `sync.ts:240–242` already loops `STATISTIC_METRICS` through `statisticDailyRows`. A new entry rides the existing pass.

> ⚠️ *Superseded 2026-09-21 — the next five bullets argue water can never be written, and the fourth is the premise that failed: a statistics query DOES accept a sample predicate (`docs/wearables-subapp.md` §20.1). Kept as the record of what was believed.*

**The echo-loop claim, verified.** The brief says ARC does not publish water outward, with the documented reason that HealthKit sums re-published totals. Both halves check out, and the second is stated in the code more sharply than the brief put it:

- `mapping.ts` contains **no water channel in either direction** — no `water`, no `dietary`, anywhere in the file. The water repository's own docblock already asserts this (`src/lib/db/repositories/water.ts:26–30`).
- The publish walk reads `publishableBodyAfter` from **`body_metrics` only** (`src/lib/health/publish.ts:217`), and `HEALTH_WRITE_IDENTIFIERS` is *derived* from `BODY_PUBLISH_METRICS` (`mapping.ts:898–900`), which is keyed to the three body columns. Water lives in `wearable_data`. **Water cannot accidentally become a write scope**; it would take editing the body channel to do it.
- And the reason it must stay that way is at `healthkit.ts:687–688`: *"Statistics carry no own-write exclusion by design (Apple merges before the predicate)."* A `cumulativeSum` query **cannot** filter out ARC's own samples. So if ARC ever published water, reading it back would double it with no suppression available — exactly the trap the brief named, now pinned to a line.
- The CI tripwire that keeps this true is `unsuppressedEchoIdentifiers()` (`mapping.ts:947–949`), asserted empty by `db/health-mapping.test.mjs`. With `dietaryWater` in READ and absent from WRITE, it stays empty. **There is no echo-loop risk here.**

**Effort: small.** Three literals, one audit row, three test extensions — plus one evening's empirical check. Pure JS, ships into the current binary, noting that HealthKit reads only function on a build carrying the native module, which landed in the 2026-08-25 EAS build (`healthkit.ts:5–13`).

**Honest downsides, and there are four:**

1. **Nothing in this repository establishes that Garmin writes hydration to Apple Health.** `src/lib/health/coverage.ts` is the project's evidence base for exactly this question, and it has **no row for `dietaryWater`** — because it is not currently a read scope, so there is nothing to audit. The brief's premise is plausible and unverified. The file's own convention is explicit that *"an honest 'unknown' is worth more here than a confident guess"* (`coverage.ts:28–32`), so this ships with `garmin: 'unverified'` until someone logs a hydration entry on the watch, runs a sync, and watches a row land. **That check is the gate. Do it first; it is one evening and it decides whether the rest is worth building.**
2. **A cumulative statistic is a day bucket, not a capture.** It arrives as one row per day, `source_device='apple_health'`, `source_raw_id='hk:water_ml:<date>'` (`mapping.ts:327–343`). `waterDaySeries` sums by `metric_type` regardless of source, so the Water screen's total stays correct and the ledger reconciles (§5). `listWaterEntries` will draw it as a single non-editable row reading *"From apple_health — edit it there"* — a state `app/water.tsx:550–557` already authors, which is a rare case of the seam being built before the feature. But its `created_at` is the **sync** time, so it sorts into the day at sync o'clock rather than drink o'clock. Accept it; a merged day total has no drink time to report.
3. **It will not appear on the Log tab.** The feed filters `source_device = 'manual'` (`logs.ts:245`). **Recommendation: leave the filter alone, and say so in the docblock so the next reader does not "fix" it.** The Log tab is a record of what you *captured*; a merged Apple Health total is a *reading*. `/water` is where the whole record lives, and it is honest there.
4. **Two doors, one total.** Log the same glass in ARC and on the watch and the day double-counts. This is not an echo loop — ARC publishes nothing — it is two independent records of one event, and the fix is behavioural: once this lands, pick one door. Settings › Apple Health should say it in a sentence.
   *(2026-09-21: ARC now publishes, and still this is not an echo, because ARC's own glasses are excluded from what it reads back. The double here is two hand-entered records of one drink, and it still needs the behavioural fix.)*

Also worth stating plainly: the sync is a throttled boot/foreground pass (`shouldAutoSync`, `sync.ts:155–161`), so the number is not live. For *"am I on track today"* that is fine. For *"I just drank it, confirm it landed"* it is not — which is the other reason Rank 1 ships alongside it rather than instead of it.

---

### Rank 3 — A one-tap vessel on Home

**No.** Not "later" — no.

Home answers one question (`CLAUDE.md` §5): *"What should I do right now, and what are the non-negotiables for today?"* A permanent water button is a capture control, and capture controls on Home have already been tried and cut once: *"Section 6 (the quick actions dock) was cut entirely — it duplicated the tab bar"* (`app/(tabs)/index.tsx:29–30`). The tab bar still reaches Log in one tap, so the duplication argument is unchanged.

It also collides with the accent budget, which Home states as a ceiling of exactly three things — the hero, completion stamps, the active tab (`index.tsx:82–87`). A water button either takes a fourth accent, or renders neutral and competes with the hero it must not compete with.

**The legitimate Home route already exists and needs no new control.** If hydration matters enough to belong on Home on a given day, it belongs there as a **mission item from an active protocol** — the mechanism Home is built on, *derived* from the mission rather than authored beside it (`index.tsx:82–84`). That is a protocol change, not a UI change.

**Effort if built anyway: small. Cost: a principle.** The §5 rule survives by being refused in the cases where it would be convenient to bend it, and "it's only one small button" is what bending it always sounds like.

---

### Rank 4 — A notification action

**Not now.** Two problems, and the second is disqualifying.

The mechanics are better than expected: `expo-notifications` (~57.0.9) is installed and already in the `app.json` plugins array, `setNotificationCategoryAsync` is a runtime API in the compiled module, and `addNotificationResponseReceivedListener` is already wired for routing (`src/lib/notifications/reminders.ts:144`, `:227–234`). Defining a category with a **"Log 16 oz"** action is pure JS.

1. **A background action needs a rebuild.** An action with `opensAppToForeground: false` is delivered through `Notifications.registerTaskAsync`, which requires **`expo-task-manager` — not installed**; nothing in the codebase calls `registerTaskAsync` or `setNotificationCategoryAsync` today. With the current binary the action must open the app, which is a cold launch, not a shortcut.
2. **A notification only exists when a reminder fires, and a reminder fires on a schedule. Thirst does not.** This surface can only ever cover the moments ARC chose to interrupt him — and buying speed with a scheduled nag is a poor trade in a product built to *"stay completely out of the way"* (`CLAUDE.md` §2).

**Effort: small for the foreground variant; native + rebuild for the useful one. Downside: it buys a fast path at the price of an interruption, for the moments ARC picked rather than the ones he did.**

---

### Rank 5 — The Coach one-liner

**Keep exactly as it is.** Measured in §1, Path D. Never the fastest for a glass; genuinely the fastest for a backdated, unusual or narrated amount. `log_metric` already handles water with an optional `date` for backdating (`src/lib/ai/tools/write-tools.ts:207–238`, `:152–158`), converts the display unit to canonical ml at card time, and is covered by `db/coach-tools.test.mjs:736–740`.

**Effort to make it faster: wasted.** The three costs (typing, the network, the Approve gate) are one accident and two deliberate design decisions.

---

### Rank 6 — Widget / App Intent / Siri Shortcut / Quick Action

**Wait.** All four are real native work behind an EAS rebuild, and none is checked in. Stating it plainly, per package:

| Surface | Module installed? | What it actually needs |
| --- | --- | --- |
| Home / Lock-screen widget | **No.** There is no first-party `expo-widgets`; the real path is a WidgetKit extension target via a community plugin such as `@bacons/apple-targets` — not in `package.json`. | A new extension target, an **App Group**, an EAS rebuild — *and* a data-architecture change. A widget runs in a different process and cannot open the app's `op-sqlite` database; it would need a shared container and a write queue the app drains. That is not a button. |
| App Intent / Siri | **No.** No Expo SDK 57 path exists. | iOS 16+ App Intents are Swift structs compiled into the binary. Custom native code + rebuild. Same cross-process data problem unless the intent is `openAppWhenRun`, which defeats the point. |
| Quick Action (long-press the app icon) | **No.** `expo-quick-actions` is a community module, not installed. | Native dep + rebuild. The cheapest of the four — and it only gets you to "the app opens on the Log tab", which the tab bar already does in one tap once the app is open. |
| Live Activity | **No.** `expo-live-activity` not installed. | Native dep + rebuild, and the wrong shape for a discrete capture. |

The binding constraint is documented all over this repo: every native module is queued behind a rebuild treated as the scarce resource to batch against (`docs/architecture-migration.md:33`; `docs/decisions.md:32–35`; `docs/nutrition-subapp.md:313`; `docs/progress-photos-subapp.md:28`). The last EAS build was 2026-08-25. `app.json` declares **no entitlements, no app groups, no extension targets**, and `expo-haptics` is not installed either — so even a haptic tick on the new tile is a rebuild, and the tile ships without one.

**And the reason this rank is "wait" rather than "never": the outcome they promise is already available for free.** A wrist tap genuinely is the fastest possible way to log a glass — but the fastest surface is the one **Apple already built**, and ARC's job is to *read* it, not to rebuild it. That is Rank 2, and it costs no native code at all.

---

## 3. Recommendation — build these two

> **Build the one-tap Water tile and the Apple Health `dietaryWater` read.** The tile collapses the common in-app case from four taps and three screen transitions to two taps and one; the HealthKit read makes a wrist tap the fastest path of all, at zero taps inside ARC. Everything else waits: a Home button breaks §5 for a case the Log tab already covers, a notification action needs an interruption to exist and a rebuild to be useful, the Coach is already good at the thing it is good at, and every native surface costs an EAS build to reach an outcome HealthKit reaches for free.

They are recommended **together** because they cover the two genuinely different cases and neither covers both: the tile is for when the phone is in his hand, the HealthKit read is for when it is not. Shipping only the tile leaves the kitchen-glass case untouched; shipping only the read leaves the in-app path at four taps and rests on an unverified Garmin behaviour.

---

### 3.1 Interaction spec — the Water tile

> ⚠️ **Superseded in part, 2026-09-21.** Everything below about the *tap* — the repository
> call, the ledger as receipt, the units invariant, the Conformed Set treatment — still
> describes what ships. Everything about **the long-press, the tile's derived face, and the
> 2 × 2 of hidden amounts** does not: the four amounts are a full-width row of the plate,
> visible at all times, and the remembered amount is a note (`usually 8 oz`) that nothing
> taps. The accessibility paragraph at 297 is inverted — there is no gesture left to expose,
> and each cell's own label carries its own amount. See the status block at the top of this
> file for the owner's words and the reasoning.
>
> **As built (2026-09-14), four departures from the spec below.**
>
> 1. **There IS an undo.** This section argued the ledger alone is the receipt and that a
>    confirm step would hand back the taps the proposal exists to save. The second half still
>    holds — nothing confirms — but "mitigated, not solved" was not good enough for a tap that
>    writes: the block now reports the write on a ruled row and offers **Undo**, which deletes
>    by the id `logWater` returned, so it can only ever remove the glass it just wrote. It
>    carries no timer (the design system has no timing vocabulary, and an affordance you have
>    to race is worse than one that waits) and is replaced by the next write. The ledger is
>    still the durable receipt: `QuickAddGrid` takes an `onLogged` callback and the Log tab
>    passes it `reload`, exactly as it already did for the command field.
> 2. **The inline amounts are a 2 × 2, not a row of four.** Four cells across leaves each about
>    80pt at phone width. Same `w-[48.5%]` arithmetic and the same reasoning as the tile grid's
>    own layout note.
> 3. **The literals moved to one table.** `src/lib/log/water-amounts.ts`, read by this screen,
>    the keypad and the tile. This section said "the same table both other screens use"; there
>    was no such table, there were two copies that agreed by luck, and a third would not have.
> 4. **`usualWaterAmount` returns canonical ml and the tile resolves the display amount**, so
>    the invariant below is true by construction rather than by care: the tile prints
>    `round(fromCanonical(usual))` and logs `toCanonical(that)`. A 500 ml record read under an
>    ounce preference therefore offers 17 oz and logs 17 oz — the honest rendering, and it says
>    which unit it is in.

**Device.** Unchanged. The tile remains a closed hairline box on `paper-hi` inside the Quick Add **plate** (`quick-add-grid.tsx:102–103`). No new device, no new enclosure, no accent — the Log tab's single pine is the command field's send action, and that budget does not move (`app/(tabs)/log.tsx:24–29`).

**Voice.** `Water` stays in the **label** voice (`font-label text-[10px] font-bold`). The amount is a measured value and therefore **mono**: `font-mono text-[10px] text-ink-muted`, reading `+16 oz`. This is the pairing §3 of the design spec explicitly licenses — *"a measured value inside a label stays mono"* — and it is the identical treatment the `/water` Add block and the keypad's quick tiles already ship (`app/water.tsx:455–458`; `app/metric-entry.tsx:309–312`).

**Layout.** The tile becomes icon + a two-line column (label over amount), keeping `w-[48.5%]`, `min-h-[52px]` and the 2 × 2. That two-line stack is not new — it is what both existing quick-amount tiles already are. The label keeps `grow` so the caption starts hard against its icon (`quick-add-grid.tsx:96–100`). Class strings stay whole literals.

**The tap.** Calls `logWater(getDb(), todayISODate(), spec.toCanonical(amount))` — the same repository function the Water screen uses, so the row is indistinguishable from one made there (`src/lib/db/repositories/water.ts:86–92` is explicit that this is the point). One row per capture, never a running total.

**What it says back — and it is not a toast.** Nothing modal, nothing animated. The Log tab's **"Logged today"** plate is on the same screen, below the grid, and already renders manual water rows as `16 oz` under the category `Water` (`logs.ts:243–259`). The feed reloads and the row appears. **The ledger is the receipt**, which is the §5 answer (*ledgers must sum to their own totals*) and avoids inventing a notification vocabulary the Conformed Set does not have. No motion: the design system has no motion language, and inventing one here is precisely the slop the anti-slop gate exists to catch.

**The long-press.** `onLongPress` on the same `Pressable` — RN built-in, no new dependency. It expands the amounts **inline inside the same plate, beneath the grid**: `Glass` / `Bottle` / `Large` / `Other…`, each a 44pt bordered button in the existing quick-amount treatment, per-unit literals from the same table both other screens use (a metric bottle is 500 ml, not 473). Selecting an amount logs it and collapses the row. `Other…` pushes `/metric-entry?metric=water`, the path that exists today, unchanged. No modal, no sheet, no push.

**The remembered amount — the rule.** `usualWaterAmount(db, today)`: the **most frequent display amount across manual water rows in the last 14 days**, ties broken by the most recent, returning `null` on an empty record; `null` renders the Glass literal (8 oz / 240 ml).

- **Manual rows only.** An `apple_health` day bucket must never become "his usual" — a day total is not a vessel.
- **14 days**, to agree with `WINDOW_DAYS` on the water screen (`app/water.tsx:142`). Two windows disagreeing about "recently" is how a number starts lying.
- **Not "last logged".** One 4 oz pill-swallow would retrain the button.
- **Derived, not configured**, because the ask was speed, not another setting. The alternative — a user-set default beside the daily goal in the preferences blob (`goals.waterMl`, `app/water.tsx:82–86`) — is simpler and never moves, and is the right fallback if the derived rule proves surprising on device. Printing the number on the tile is what makes the derived version safe: the button cannot mislead about an amount it is displaying.

**Accessibility.** The label must state the amount **and** that the tap commits — `"Log water, 16 ounces"`, not `"Water"`. A long-press is undiscoverable to VoiceOver, so it needs an `accessibilityHint` and a matching `accessibilityActions` entry exposing "Other amounts" as a real action, not only as a gesture.

**Tests that pin it**

- `db/water.test.mjs` (extend) — `usualWaterAmount`: empty record → `null`; five 16 oz and two 8 oz → the 16 oz canonical value; a tie → the more recent; rows outside the 14-day window ignored; an `apple_health` row ignored even when it is the largest.
- `db/screens-render.test.mjs` (extend) — the Log tab's Water tile caption contains the resolved amount and its unit; with an empty record it reads the Glass literal; under `units.volume = 'ml'` it reads the ml literal and never a converted oz figure.
- **The invariant that makes the tile honest**: the amount printed on the face equals the amount handed to `logWater`, asserted in both units. If those can diverge, the tile is a lie and nothing else matters.
- The accessibility label contains the number — `screens-render` already asserts on the words a screen actually shows, which is the habit that caught `"2 entrys"` (`app/water.tsx:191–198`).

---

### 3.2 Interaction spec — Apple Health `dietaryWater`

**Device: none.** This is data, not a surface. Its only two visible homes already exist and already draw the state it produces:

- `/water` → **Entries**, which renders a device-sourced row without the edit affordance and prints *"From apple_health — edit it there"* (`app/water.tsx:550–557`).
- Settings › Apple Health, whose per-metric run log and coverage list are already built, and which **structurally require** an audit row: `uncoveredReadIdentifiers()` fails if a read scope has none (`coverage.ts:233–240`).

**The change, concretely — three literals and one audit row:**

1. `STATISTIC_METRICS` gains `{ metricType: 'water_ml', hkIdentifier: 'HKQuantityTypeIdentifierDietaryWater', hkUnit: <verified>, unit: 'ml', decimals: 0 }`.
   ⚠️ **The HKUnit string is the load-bearing detail and must be checked against the library's generated `QuantityUnitByIdentifierMap` before shipping**, exactly as every other unit in this file was (`mapping.ts:616–620`). Litres where millilitres were meant is a factor of a thousand into a health record, silently — the same class of bug as the body-fat percent trap documented at `mapping.ts:635–643`, which is why that note exists.
2. `METRIC_COVERAGE` gains a `dietaryWater` row: `use: "The Water record's day total"`, `garmin: 'unverified'` with a note saying what was and was not checked, `verdictDays: null`.
3. One sentence in Settings › Apple Health: ARC **reads** hydration and does not write it. *(Rewritten 2026-09-21: "Water goes both ways." — `app/settings-health.tsx`.)*

**Voice.** Nothing new anywhere. The Entries row reads in mono (`16 oz`) with a serif provenance line — both already authored.

**What it says back.** The `/water` Today field, the day's percent-of-goal and the By-day bars simply include it, because `waterDaySeries` sums by `metric_type` across sources (`water.ts:199–214`). Nothing to build; the totals reconcile because the row is in the same table the totals read.

**The decision this forces, made rather than deferred.** The Log tab feed will **not** show it, and that is the right answer (Rank 2, downside 3). Record it in the docblock.

**Tests that pin it**

- `db/health-mapping.test.mjs` (extend) — `statisticDailyRows` on the water spec yields `metric_type='water_ml'`, `unit='ml'`, `source_device='apple_health'`, `source_raw_id='hk:water_ml:<date>'`; a zero day yields **no row** (a row saying "0 ml" would be a claim, not an absence — `mapping.ts:321–326`); and **`unsuppressedEchoIdentifiers()` still returns `[]` with the new read scope present.** That last assertion is the echo-loop tripwire, and it is the test this proposal most needs to keep passing.
- `db/health-coverage.test.mjs` — already asserts `uncoveredReadIdentifiers()` is empty in both directions. Nothing to write; adding the scope without the audit row fails it, which is the intended behaviour.
- `db/water.test.mjs` (extend) — a manual 500 ml row plus an `apple_health` 1200 ml day bucket on one day: `waterDaySeries` reports **1700 with `entries: 2`** (the ledger reconciles); `listWaterEntries` marks the HK row `editable: false`; **`updateWaterEntry` and `deleteWaterEntry` both return `false`** against it. That last pair proves the screen cannot offer an edit the next sync would silently revert — the guard the water repository already carries (`water.ts:118`, `:141`) but which nothing has yet exercised against a real device row.
- Re-sync idempotency — the same day synced twice UPDATEs the one row rather than inserting a second. Likely already covered by the existing `upsertWearableRows` conflict tests; check before duplicating.

**The gate, restated because it is the only thing that can kill this proposal:** log a hydration entry on the watch, run a sync, confirm a row lands. Until that happens the coverage verdict stays `unverified` and Settings says so. **Passed on the owner's phone (2026-09-21, confirmed 2026-09-23); the verdict is `yes`.**

---

## 4. What this does not change

- **No migration.** `water_ml` already exists in `wearable_data`, manual rows already coexist with device rows by the partial unique index, and neither proposal adds a column. Nothing needs a number from the reserved block at `docs/backlog-2026-09.md:68–70`.
- **No new dependency, no EAS rebuild.** Both ship as JS into the existing binary — noting that the HealthKit half only functions on a build carrying the native module (2026-08-25 or later).
- **`/water` is untouched.** It remains where the record is read, corrected and back-dated, and its Add block stays exactly as it is. The tile is a shortcut to the common case, never a replacement for the record.
- **The Coach is untouched.**
- **`B2` (`ml` as a unit type, `docs/backlog-2026-09.md:28`) is independent of both**, but lands in the same neighbourhood: both proposals here read the volume unit through `resolveDisplay` and use per-unit literal amounts, so whichever ships second inherits the other's table rather than duplicating it.
