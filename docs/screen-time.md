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
- **Undo is a restore.** `replaced` holds each removed row whole (id, value, created_at, metadata). `undoScreenTime` removes the new row and puts those back exactly, id and timestamp included. It lives in the row, so the Undo outlives the process.
- **A repeated write is not a write.** The same number from the same door for a day that already holds it writes nothing (`wrote: false`), so a Shortcut that fires twice leaves one row.
- **Zero is refused.** A zero from an automation is more likely a failed read than a day without the phone, and an absent row already means "unknown".

## 2. Which day a number belongs to

In the morning the number a person reads off Screen Time is yesterday's (today's is minutes old). So:

- **From the start of the day until noon, a typed number is filed to yesterday; from noon on, to today.** The start of the day is the owner's own boundary (Settings › Profile › Day starts at). Under a 04:00 start, 02:00 is still the previous day's evening, and a number typed then goes to that day.
- **It is always visible.** The keypad has Yesterday / Today chips with the rule's answer selected, and a line naming the chosen day and what it already holds. Every receipt names the day in words and as a date: *Screen time filed to yesterday, Thu 24 Sep · 3h 20m*.
- **It can be overridden.** `screen 3h20 today`, `st yesterday 200`.
- Apple's day runs midnight to midnight. Under a non-midnight boundary the number is still Apple's calendar-day total, filed under the ARC day with the same date. Not corrected for.

`src/lib/screen-time/entry.ts` (`defaultScreenTimeDay`, `screenTimeDate`).

## 3. Typing it

- **Log tab, command field.** `screen 3h20`, `screen time 3h 20m`, `screentime 200`, `st 200`, `st: 3:20`, `3h20 screen time`, each with an optional `today`/`yesterday`. A bare number is minutes. The WHOLE line must be the entry: `st` is a word in ordinary notes ("walked down 5th st 20 min"), so the adjacency matcher the other metrics use would mis-file notes. `st` only leads a line, because "20 st" is a weight in stone. Anything else is a note, as before. (`src/lib/log/parse.ts`)
- **The metric keypad.** A Screen time chip, last in the row. Its `.` key types `h` (`3h20`); the readout's placeholder `0h 0m` shows the format. The button reads **Replace Screen time** when the chosen day already holds a number. (`app/metric-entry.tsx`)
- **The receipt.** A ruled row inside the command field's well: the sentence, the figure (with `was 3h 5m` after a replace), and **Undo**. It is needed because the number usually goes to yesterday, which "Logged today" does not list. (`src/components/log/screen-time-receipt.tsx`)

## 4. The link — `arc://log/screen-time?minutes=N&date=YYYY-MM-DD`

The route is `app/log/screen-time.tsx`. `arc` is `app.json`'s scheme and `app/+native-intent.ts` passes the path through unchanged.

**Validated before anything is written** (`parseScreenTimeLink`): `minutes` is digits only, 1–1440 (`200.0` is refused); `date` is `YYYY-MM-DD`, a real day, not after today's calendar date, not more than 30 days back; both are required. A refused link writes nothing and the screen says why, which is what the owner sees the first time he runs the Shortcut by hand.

**A write nobody is awake for.** The automation can run with the phone on the nightstand. A confirm card would wait for a tap that does not come, and the number would be lost, so the link writes at once and the honesty moves to afterwards:

- the row is marked `via: shortcuts`, and every surface reports it that way;
- **Undo on the next open, whichever screen that is.** If iOS keeps ARC in memory overnight, the next open is the link's own screen, with its Undo. If iOS reclaims it, the Log tab's receipt finds the write from the record (the newest Shortcuts write for yesterday or today);
- no network and no model call: the number goes from the URL to SQLite.

If the app lock is on, a cold start shows the lock first and the write happens after unlocking.

## 5. The record and the Coach

- **Data › Trends › Screen time.** The latest day on record (not today, which is usually empty at breakfast), a 14-day sparkline of recorded days only (a day with no number is unknown, not zero), and the day plus `· Shortcuts` when a Shortcut sent it. Tapping opens the keypad on its chip.
- **Settings › Screen time** (`app/settings-screen-time.tsx`): what is on record, whether a Shortcut has ever sent a number, how to type it, and the setup below.
- **The Coach**, payload only; no tool's description or schema moved, and `log_metric` does not take screen time:
  - the per-turn block gains `Screen time (typed): 3h 20m on 2026-09-24` when yesterday or today has a number (`src/lib/ai/turn-context.ts`);
  - `get_today_snapshot` gains a `screenTime` field for the same days, with `partial: true` on a today figure;
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
- The keypad's `h` key and the Yesterday / Today chips at 375 pt, on a screen that does not scroll.

## 8. Files and tests

- Pure: `src/lib/screen-time/entry.ts` (duration grammar, noon rule, link validation, keypad helpers, receipt words), `src/lib/screen-time/receipt-store.ts`.
- Data: `src/lib/db/repositories/screen-time.ts`; `logs.ts` routes `screen_time` there; `src/lib/log/metrics.ts` declares it (`duration: true`, empty `keywords`).
- Screens: `app/log/screen-time.tsx` (new route), `app/settings-screen-time.tsx` (new route), `app/metric-entry.tsx`, `src/components/log/command-field.tsx` + `screen-time-receipt.tsx`, `app/(tabs)/data.tsx` + `src/hooks/use-data-overview.ts`, `app/settings.tsx`.
- Coach: `src/lib/ai/turn-context.ts`, `src/lib/ai/tools/read-tools.ts`, `src/lib/health/accumulating.ts`.
- Tests: `db/log.test.mjs` §13–§18, `db/turn-context.test.mjs` ST, `db/coach-tools.test.mjs` §48, `db/health-mapping.test.mjs` §13(c), `db/screens-render.test.mjs` §28.
