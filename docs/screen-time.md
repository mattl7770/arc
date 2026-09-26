# Screen time: what was built, and the Shortcut setup

**Built:** 2026-09-25, on `claude/fb-screentime`. **No migration.** Headless-verified only; nothing here has been on the phone, and it reaches the phone only in the next EAS/TestFlight build (ARC has no OTA).
**The plan it follows:** `docs/spikes/screen-time.md`, read with its checker's corrections.
**The owner's answers (2026-09-25):** the number is a Coach input and a line on the daily record; the daily total only; he types it, and no screenshot goes to the model; no Family Controls. He has not yet run the Shortcuts check ("Get App & Website Data").

ARC never calls a Screen Time API. The number comes from the owner's own reading of Settings › Screen Time, typed or sent by a Shortcut, so the licence limit on Family Controls data (DPLA §3.3.3(P), spike §2.1) does not reach it and the Coach may read it.

---

## 1. Where the number lives

One `wearable_data` row per day, the same store `hrv 48` uses:

| column | value |
|---|---|
| `metric_type` | `screen_time_min` |
| `value` / `unit` | whole minutes, 1–1440 / `min` |
| `source_device` | `manual` (already allowed since 0021, so no rebuild) |
| `source_raw_id` | NULL |
| `metadata` | `{"via":"typed"}` or `{"via":"shortcuts"}`, plus `replaced` when the write took a number off the record |

- **One row per day.** `recordScreenTime` (`src/lib/db/repositories/screen-time.ts`) deletes the day's manual row and inserts the new one in one transaction. A second number for a day replaces the first. `logMetric` routes `screen_time` there too, so no door can append a second row.
- **Provenance in `metadata`, not `source_device`.** That column is a CHECK-constrained vocabulary with no word for a Shortcut, and widening it is a table rebuild. `metadata` is free JSON already.
- **Undo is a restore, one level deep.** `replaced` holds each removed row as its id, value, created_at and door. `undoScreenTime` removes the new row and puts those back, id and timestamp included. It lives in the row, so the Undo outlives the process. A snapshot does **not** carry the snapshot's own `replaced`: the first build stored the previous row's metadata whole, as a string, and every level re-escaped the one below it, so the metadata doubled with each replace (863 bytes after five writes to a day, 3 MB after eighteen, then `JSON.stringify` threw and the day could never be saved again). Every screen offers exactly one Undo, the newest write's, so the chain bought nothing reachable. A row's metadata is now about 150 bytes however often the day is rewritten (`db/log.test.mjs` §19 writes one day forty times).
- **A repeated write is not a write.** The same number from the same door for a day that already holds it writes nothing (`wrote: false`), so a Shortcut that fires twice leaves one row.
- **Zero is refused.** A zero from an automation is more likely a failed read than a day without the phone, and an absent row already means "unknown".
- **Not in the Log feed.** A day's total is not a capture at a moment. Typed at 07:12 on the 25th it is filed under the 24th, and a "Logged today" row (or the Coach's `captures` domain, which reads the same `listEntriesOn`) would say it was logged at 07:12 on the 24th. It has its own reads instead: the receipt, Data, the Coach's snapshot and series.
- **The Shortcuts record** lives in the integration-cursor KV (`health_sync_state`, key `screen_time`; no migration, the same way `workout-ingest.ts` keeps its pairing state): `lastLink`, the last valid link a Shortcut opened, and `receiptSeenThrough`, the newest write the Log receipt has shown. Neither is a fact about one row, so neither can be read from the rows.

## 2. Which day a number belongs to

In the morning the number a person reads off Screen Time is yesterday's (today's is minutes old). So:

- **From the start of the day until noon, a typed number is filed to yesterday; from noon on, to today.** The start of the day is the owner's own boundary (Settings › Profile › Day starts at). Under a 04:00 start, 02:00 is still the previous day's evening, and a number typed then goes to that day.
- **It is always visible.** The keypad has Yesterday / Today chips with the rule's answer selected, and a line naming the chosen day and what it already holds. Every receipt names the day in words and as a date: *Screen time filed to yesterday, Thu 24 Sep · 3h 20m*.
- **It can be overridden.** `screen 3h20 today`, `st yesterday 200`.
- Apple's day runs midnight to midnight. Under a non-midnight boundary the number is still Apple's calendar-day total, filed under the ARC day with the same date. Not corrected for.

`src/lib/screen-time/entry.ts` (`defaultScreenTimeDay`, `screenTimeDate`).

## 3. Typing it

- **Log tab, Quick add.** A **Screen time** door beside Weight, which opens the keypad on its chip. It is plan (a)'s "Screen time tile in Log", and without it the number could only be found by someone who knew the grammar below. Four doors make the grid 2 × 2 again. (`src/components/log/quick-add-grid.tsx`)
- **Log tab, command field.** `screen 3h20`, `screen time 3h 20m`, `screentime 200`, `st 200`, `st: 3:20`, `3h20 screen time`, each with an optional `today`/`yesterday`. A bare number is minutes. The WHOLE line must be the entry: `st` is a word in ordinary notes ("walked down 5th st 20 min"), so the adjacency matcher the other metrics use would mis-file notes. `st` only leads a line, because "20 st" is a weight in stone. Anything else is a note, as before. (`src/lib/log/parse.ts`) What the field does on send is `screenTimeFiling` in `entry.ts`, tested at 09:00 and 13:00, and a screen-time line can never take the generic metric path (which would file it to today).
- **The metric keypad.** A Screen time chip, last in the row; a keypad opened on it scrolls the chip into view. Its `.` key types `h` (`3h20`); the readout's placeholder `0h 0m` shows the format. The button reads **Replace Screen time** when the chosen day already holds a number. (`app/metric-entry.tsx`)
- **The receipt.** A ruled row inside the command field's well: the sentence, the figure (with `was 3h 5m` after a replace), and **Undo**. It is needed because the number usually goes to yesterday, and a day's total is not in "Logged today" at all. (`src/components/log/screen-time-receipt.tsx`)
  - **After an Undo it offers nothing.** It shows *Undone. Thu 24 Sep is back to 3h 5m.* and holds that line until the next write or the next focus. The first build re-read the record straight into a live Undo, so a double tap took back two numbers: the typed correction, then the Shortcut's number it had just restored.
  - **A Shortcuts write is reported once.** It shows until the owner leaves the Log tab; on blur the newest write drawn is stamped as seen (`receiptSeenThrough`), and `pickReceipt` does not draw a Shortcuts write that old again. A nightly automation is one receipt a night, not a standing Undo on the capture surface. The stamp covers typed writes too, so a Shortcuts row an Undo restored (with its original timestamp) is not offered again as if it were new.

## 4. The link — `arc://log/screen-time?minutes=N&date=YYYY-MM-DD`

The route is `app/log/screen-time.tsx`. `arc` is `app.json`'s scheme and `app/+native-intent.ts` passes the path through unchanged.

**Validated before anything is written** (`parseScreenTimeLink`): `minutes` is digits only, 1–1440 (`200.0` is refused); `date` is `YYYY-MM-DD`, a real day, not after today's calendar date, not more than 30 days back; both are required. A refused link writes nothing and the screen says why, which is what the owner sees the first time he runs the Shortcut by hand.

**A write nobody is awake for.** The automation can run with the phone on the nightstand. A confirm card would wait for a tap that does not come, and the number would be lost. The plan of record (spike §4 (e)) said "confirm and write"; the build departs from it only as far as the automation's own case needs (`linkWritesSilently`):

- **Written without a tap:** a date that is calendar today or yesterday (the two days a nightly or morning automation sends), over an empty day or an earlier Shortcuts number.
- **A confirm card instead:** a date older than yesterday, or a day holding a number he **typed**. The card names both numbers (*Thu 24 Sep holds 3h 5m, typed on Log. The Shortcut sent 3h 20m.*) with **Replace with 3h 20m** / **Keep 3h 5m**, or for an older day explains that ARC saves a Shortcut's number without asking only for today and yesterday, with **Save** / **Don't save**. Nothing is written until the tap, and Save re-reads the day first: if it changed while the card was up, the card is redrawn for what it holds now. An automation never sends an older date, so such a link is a wrong Adjust Date or some other caller of `arc://`; and its Undo would never be offered again, because the Log receipt only reports yesterday and today.
- **The same number is not a write,** from either door: the screen says it is already on record, and offers no Undo when the number on record is one he typed.
- The row is marked `via: shortcuts`, and every surface reports it that way. Every valid link is also noted in the Shortcuts record, so Settings can say an automation ran even after a typed correction replaced its row.
- **Where the Undo is.** On the link's own screen while it is open; if iOS keeps ARC in memory overnight, that is what he sees on unlock. If iOS reclaims the app, a cold start opens on **Home**, not Log, and the Undo is on the Log tab's receipt the next time he opens that tab, shown once (§3).
- No network and no model call: the number goes from the URL to SQLite.

If the app lock is on, a cold start is expected to show the lock first, with the link's screen behind it. Not checked on the phone.

## 5. The record and the Coach

- **Data › Trends › Screen time.** The latest day on record (not today, which is usually empty at breakfast), a 14-day sparkline of recorded days only (a day with no number is unknown, not zero), and the day plus `· Shortcuts` when a Shortcut sent it. Tapping opens the keypad on its chip.
- **Settings › Screen time** (`app/settings-screen-time.tsx`): what is on record, what a Shortcut last sent (read from the Shortcuts record, not the rows, so a typed correction does not make it say no Shortcut ever ran), how to type it, and the setup below.
- **The Coach**, payload only; no tool's description or schema moved, and `log_metric` does not take screen time:
  - the per-turn block gains a line for yesterday and today, each when it has a number: `Screen time: 3h 20m on 2026-09-24 (typed) · 45m on 2026-09-25 so far today (from a Shortcut)` (`src/lib/ai/turn-context.ts`). Both days, because a so-far figure for today must not push out yesterday's finished total;
  - `get_today_snapshot` gains `screenTime: { yesterday?, today? }` for the same days, `today` carrying `partial: true`;
  - `get_metric_series` reads it as `screen_time`, with `hm` ("3h 20m"), from a declared spec labelled *self-reported*;
  - `screen_time_min` is on the accumulating list (`src/lib/health/accumulating.ts`): a number filed for today is still climbing, so the series holds it out of the statistics.

## 6. The Shortcut — only if the check returns a total

**First, the check (five minutes on the phone).** In Shortcuts, make a shortcut with one action, **Screen Time › Get App & Website Data**, and run it. Look at what comes out:

- a day's total (as minutes, hours, or a duration): the steps below apply;
- per-app times and no total: the steps might still work if Shortcuts can add them up (a Calculate over the list), but check the sum against Settings › Screen Time before trusting it;
- only app or site names: stop here and keep typing the number.

**The automation (nightly version):**

1. Shortcuts › Automation › New › **Time of Day**, 23:55, Daily, **Run Immediately**.
2. **Get App & Website Data.** If it asks for a day or a range, choose today.
3. Take the day's total from its result. If it is not in minutes, **Calculate** to convert it. Then **Round Number**, so it is whole: ARC refuses `200.0`.
4. **Format Date**: Current Date, Custom format `yyyy-MM-dd`.
5. **URL**: `arc://log/screen-time?minutes=N&date=YYYY-MM-DD`, with the rounded number in place of `N` and the formatted date in place of `YYYY-MM-DD`.
6. **Open URLs.**

**A morning version, if the action can report yesterday.** Trigger on the alarm being stopped (or Sleep Focus turning off), ask the action for yesterday, and in step 4 add **Adjust Date** (subtract 1 day) before formatting. Yesterday's total is final by then, and the phone is in hand, which answers the locked-phone question below.

**Run it by hand once** before trusting it: ARC opens on the link's screen and shows the figure and the day, or says exactly what it refused.

## 7. What only the phone can settle

- What "Get App & Website Data" returns (§6's check).
- Whether iOS runs **Open URLs** from a Time of Day automation while the phone is locked, or holds it until unlock. Not checked; the morning version sidesteps it.
- That `arc://log/screen-time` lands on the link's screen on a cold start and a warm one, with the back chevron working (the `(tabs)` anchor in `app/_layout.tsx` is what should make it work).
- The keypad's `h` key and the Yesterday / Today chips at 375 pt, on a screen that does not scroll; and that a keypad opened on the Screen time chip scrolls it into view.
- The four-door Quick add grid on the phone, and the link's confirm card (its pine Save and the Keep beneath it).
- That the Log receipt's "once" rule reads right in use: shown on the first visit to the Log tab after a Shortcuts write, gone after leaving it.

## 8. Files and tests

- Pure: `src/lib/screen-time/entry.ts` (duration grammar, noon rule, the command field's `screenTimeFiling`, link validation and `linkWritesSilently` / `linkConfirmWords`, keypad helpers, receipt words, `pickReceipt`, `undoneSentence`), `src/lib/screen-time/receipt-store.ts`.
- Data: `src/lib/db/repositories/screen-time.ts` (rows, one-level Undo, the Shortcuts record); `logs.ts` routes `screen_time` there and keeps it out of `listEntriesOn`; `src/lib/log/metrics.ts` declares it (`duration: true`, empty `keywords`).
- Screens: `app/log/screen-time.tsx` (new route), `app/settings-screen-time.tsx` (new route), `app/metric-entry.tsx`, `src/components/log/quick-add-grid.tsx` (the door), `src/components/log/command-field.tsx` + `screen-time-receipt.tsx`, `app/(tabs)/data.tsx` + `src/hooks/use-data-overview.ts`, `app/settings.tsx`.
- Coach: `src/lib/ai/turn-context.ts`, `src/lib/ai/tools/read-tools.ts`, `src/lib/health/accumulating.ts`.
- Tests: `db/log.test.mjs` §13–§21 (§19 bounded metadata, §20 the command field's filing at 09:00 and 13:00, §21 the receipt's once-only rule and the link's silent/confirm rule), `db/turn-context.test.mjs` ST, `db/coach-tools.test.mjs` §48, `db/health-mapping.test.mjs` §13(c), `db/screens-render.test.mjs` §28.
