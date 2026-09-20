# C11b — The mission day picker, and checking a protocol item off ahead

**Status: BUILT** (2026-09-19), branch `claude/daypicker`, **no migration** —
two value keys on `log_entries.value` (`done_on`, `ahead`), guarded by the
existing `json_valid` CHECK. Head stayed `0059`. The owner answered all four
questions in §8 and **took option (a) every time**, so §3 shipped whole: a
pushed **Plan** screen from Home, six days ahead, a past tick for the seven
settled days behind today, and a carried copy that is read-only there.
**Backlog:** `docs/backlog-2026-09.md:47`, `:67`. **Parent spike:**
`docs/spikes/protocol-carryover.md` §3.3 (`:389-473`) is the sketch this
replaces; its five shipped departures (`:9-33`) are the ground. This build also
supersedes **Phase 5 of `docs/spikes/protocol-interface-rethink.md`**, which
deliberately stopped short and left the flag, the projection helpers and the
view-model fields in the shape this plan expected.

## What the build departs from what is written below

| # | The plan | What shipped | Why |
| --- | --- | --- | --- |
| 1 | `planForDay(db, date, { today })` | **`{ committing?, today? }`**, and `today` *implies* non-committing when `date > today` | the rethink's Phase 1 had already landed `{ committing }`; a second flag that silently contradicted the first would be the drift the one-definition rule exists to stop. Passing `today` about TODAY is still a committing read, which is exactly what the arrival re-derive needs |
| 2 | `value.checked_ahead_on` (the parent spike's name) | **`done_on`**, as §3.6 proposed | it is written by EVERY completion, not only by one made ahead, and it reads in both directions — earlier than the row is a tick ahead, later is a backfill |
| 3 | three guards on the past tick | **the `late_on` guard also covers `skipped_via`** | both marks mean "a carried copy has already spoken for this row", both are undone from the copy, and `skipped_via` would otherwise leave a hand-skipped debt re-openable from the wrong end. A widening of guard 3, not a fourth guard |
| 4 | the quota predicate fixes a reachable bug | the predicate shipped; **the state it guards is not reachable in v1** | a future day never places a quota item (`committing: false`), so a Friday quota row cannot be ticked on Monday today. The arithmetic is still the honest one — a week's allowance is counted over the whole week — and the test builds the state directly and says so. If a later build ever places a quota ahead, the count is already right |
| 5 | `LabelLink({ icon, label, hint, href })` drawn twice in one wrapper outside the `planned` branch | **`MissionLinks`**, drawn in BOTH branches | `MissionEmpty` occupies the hero slot, five sections above where the mission plate draws, so one wrapper "outside the branch" would have put the links under the readiness strip on an empty day. Two call sites, one component, and the links sit under whichever block actually drew |
| 6 | the Plan screen's rows keep the sheet | **no `onOpen` at all** | a computed row has no stored row to open. `MissionItemRow.onOpen` became optional, and where it is absent the chevron is not drawn and the named VoiceOver action is not offered — rather than offered and doing nothing |
| 7 | `uncommitDayAhead` is called by the un-tick | it is, **and `commitDayAhead` asks the DATE whether it is committed** rather than creating a `daily_logs` row first | "nothing is written by looking" has to survive a REFUSED tap too, and `getOrCreateDailyLog` before the guards would have left an empty day behind for every stale `expect` |

Everything else is as written, including every "Considered and rejected" note
and every alternative in §4.

## What only a device can settle

§7 below is unchanged and still open: none of it has been seen on hardware.

---

## 1. Current state

### The day is computable ahead, but only one thing ever asks

`planForDay` (`src/lib/db/repositories/mission-generate.ts:447-585`) is a pure
read over `(db, date)`: phase from `started_on` (`:470`), cadence (`:473-482`),
mode items (`:535-548`), running experiments (`:570-583`), no writes; its one
consumer is the reminder scheduler, tomorrow through today+6
(`src/lib/notifications/protocol-reminders.ts:155-163`; `PlannedEntry`,
`:158-172`). Committing a day is `generateMissionForDay` (`:606-622`):
idempotent on `countMissionEntries > 0` (`:608`), and **before** planning it
anchors every active protocol whose `started_on` is NULL to the date being
generated (`ensureStartedOn`, `:614`; `src/lib/db/repositories/protocols.ts:441-446`;
`:611-612`). Right for today, wrong for a day ahead: were Friday the first day
ever committed for a new protocol, today would read `not_started`
(`src/lib/protocols/phase.ts:54`).

### A committed day is frozen until something re-derives it

`rederiveMissionForDay` (`:697-852`) is a diff: untouched `pending`
machine-made rows the plan no longer names are deleted (`:796-801`, `:826-831`),
new entries inserted (`:812-813`), acted-on rows preserved by status
(`:750-751`), pending kept rows re-synced (`:805-808`, `:836-840`); it calls
`ensureStartedOn(db, date)` unconditionally (`:702`). Every caller passes
`todayISODate()`: `app/protocol-edit.tsx:750`, `app/protocol-versions.tsx:165`,
`src/lib/modes/store.ts:52`, `src/lib/ai/tools/write-tools.ts:1033`, `:1463`
(`set_mode`, today only, `:1460-1463`, `:1472`). Three writes that change what
a day should hold re-derive nothing: `deleteProtocol` (`protocol-edit.tsx:781`;
`protocols.ts:490-492`), `create_experiment` (`write-tools.ts:1543-1551`),
`complete_experiment` (`:1671-1674`). Home calls `ensureTodaySeeded` on every
focus (`src/hooks/use-today-mission.ts:51-58`, `:130`; `src/lib/db/seed.ts:113`),
a no-op once the day has rows. **A day is shaped once, on its own morning.**

### The carry and the clock both read "before this day"

`outstandingCarries` (`:281-326`) reads untouched `pending` originals in
`[date − 7, date)` (`:282`, `:300-301`; `CARRY_MAX_DAYS`, `:240`); asked about
a future day it would read **today's** pending rows as debts — the *"pending
at 09:00 is a morning, not a decision"* error `missionDailySeries` guards with
`date < today` (`mission.ts:648-652`). `lastCompletions` (`:343-362`) takes
`max(d.date)` of completed rows `< date` (`:350`); `quotaCompletionsThisWeek`
counts completed rows in `[weekStart, date)` (`:207`, `:213`).
`setMissionStatus` (`mission.ts:232-246`) stamps a UTC instant (`:241-244`)
and nothing about the *day*; `settleCarriedOriginal` (`:284-308`) writes
`late_on` from the carried row's own day (`:245`, `:301-307`).

### The shared picker cannot step onto tomorrow, by contract

`DayPicker` (`src/components/ui/day-picker.tsx:18-20`) was shaped for the
mission to reuse. `DayBounds.latest` is *"always the LOGICAL today"*
(`src/lib/utils/day-cursor.ts:73`), `canStepForward` is `date < bounds.latest`
(`:86-88`), the chin is `dayLabel(date, bounds.latest)` (`day-picker.tsx:129`;
`day-cursor.ts:129-133`), the pill shows when `date !== bounds.latest` (`:115`)
and **sends the cursor to `bounds.latest`** (`:145`) — three places conflating
the forward bound with today. `db/day-boundary.test.mjs` §8 (`:19-21`,
`:610-649`) pins the clamp (`day-cursor.ts:4` calls it §9; it is §8).

### Home is today, in every hook

`app/(tabs)/index.tsx:140-149` reads six today-bound hooks. The mission's day
is a ref clamped forward by `forwardCursor` (`use-today-mission.ts:103-117`),
*"the implicit write target that must not move"* (`:101-102`). The row tap is
`toggleMission(getDb(), id)` (`:154`) → `setMissionStatus` (`mission.ts:311-317`)
with no day argument. Under the list is one label-voice link, *"NOT an accent
and not a button"* (`index.tsx:117-120`, `:122-137`), `self-start` (`:129`),
`accessibilityLabel="Protocols"` (`:127`) — rendered **inside** `{planned ? …
: null}` (`:217-236`), so on a day the protocols put nothing on (`:146`) Home
draws `MissionEmpty` (`:201`) and no link. The folio date is printed from a raw
`Date` (`src/components/home/date-eyebrow.tsx:126-129`) — the **calendar** day.

### Adherence judges a row on its own day, once the day is over

`missionDailySeries` groups by `d.date` and holds carried rows out
(`mission.ts:612-635`); `missionBySource` and `protocolAdherence` are *"given
settled days only"* (`:871-873`; `src/lib/db/repositories/protocol-adherence.ts:91-95`,
`:220`); `missionAdherence` skips days owing nothing (`:676-686`) — **a day the
app was never opened on has no rows and is in no rate.** `missionRecordStart`
is `min(d.date)` over all planned rows (`:709-717`); `app/mission-history.tsx:179-183`
clips at it. *"A late completion never earns rate credit"* is recorded four
times (`db/migrations/0050_protocol_carry_over.sql:52-55`; `backlog:47`;
`project-status.md:57`; `db/data-trends.test.mjs:863-866`). The Coach is
today-only on both sides (`read-tools.ts:562`, `:678-685`;
`write-tools.ts:1205`, `:1260`); the schema ledger reads **9,241 of 9,250**
(`db/coach-eval.test.mjs:807`, `:814`), payload fields outside it (`:708`).

---

## 2. The owner's words

> **C11 (2)** *Future check-off:* checking an item off a day ahead marks it and
> updates — **strict** keeps the original calendar; **adjusting** re-bases on
> when it was checked. Both per protocol. (`docs/backlog-2026-09.md:47`)

---

## 3. Proposed design

### 3.1 Where the picker lives: a pushed screen, not Home

**`app/mission-day.tsx`, title "Plan", parent "Home", reached from a second
label-voice link under the mission block.** Home stays what CLAUDE.md §5 says
it is — every section answers *now* — and the forward-only write target
(`use-today-mission.ts:93-102`) is the same rule from the data side.
`ProtocolsLink` (`index.tsx:122-137`) becomes `LabelLink({ icon, label, hint,
href })`, drawn twice in one `flex-row gap-4` wrapper — `PROTOCOLS ›` and
`PLAN ›`, neutral ink, 44pt, no accent, role `button`, the new one with
`accessibilityLabel="Plan"` and `accessibilityHint="The mission on other days"`.
**The wrapper moves out of the `planned` branch** and renders under whichever
of `Mission` or `MissionEmpty` drew: an every-3-days-only stack has empty days
by design, and those are the days worth checking tomorrow on. The screen takes
`?date=` like its sibling (`nutrition-history.tsx:251`, `:260-268`), clamped
with `stepDay(requested, 0, bounds)` (`day-boundary.test.mjs:636-640`), and
ships with a caller: the day rows of `mission-history.tsx` (`:491-510`, plain
`View`s today) become `Pressable`s that open the Plan screen on that day. The
Coach is not a caller (§3.10); the folio date and `mission-history` are §4 A–B.

### 3.2 Bounds

`DayBounds` gains `today?: string` — the logical today, defaulting to `latest`,
so the nutrition history is byte-identical. Three lines in `DayPicker` read
`bounds.today ?? bounds.latest`: the pill's condition (`:115`), the chin
(`:129`) and **the pill's destination** (`:145`) — miss the third and "Back to
today" lands on the horizon. `dayLabel` gains *Tomorrow* (`day-cursor.ts:129-133`);
`dayPhrase` (`:147-152`) is **not** touched — its one caller
(`nutrition-history.tsx:386`) never passes a future day, no authored line here
uses it, and its weekday form (`:150`) is ambiguous forward. The no-future
header comments (`day-picker.tsx:22-31`, `day-cursor.ts:19-27`) become a fact
about the bounds a caller passes; the source scan (`day-cursor.ts:11-12`) keeps
passing because the screen reads `todayISODate()` once and threads it.
**Forward: `MISSION_HORIZON_DAYS = 6`**, beside `CARRY_MAX_DAYS` — every
weekday once. It neither is defined by nor redefines
`PROTOCOL_REMINDER_HORIZON_DAYS` (`protocol-reminders.ts:57`) — a UI answer
must not retune the notification layer — but `db/reminders.test.mjs` asserts
`MISSION_HORIZON_DAYS < PROTOCOL_REMINDER_HORIZON_DAYS`, so every day the
picker can commit is one the scheduler reads; under question 2(b) or (c) the
scheduler's constant is raised by hand, at the price of more reads per sync.
**Back: `missionRecordStart(db, today)`** (`mission.ts:709-717`, clamped per
§3.9). `today` is read once per render pass and the reload rolls forward only
if the user was on today (`nutrition-history.tsx:252-255`, `:278-292`).

### 3.3 A future day: computed on view, committed on the first tick

A future day is rendered from `planForDay(db, date, { today })` and **nothing
is written by looking** — no `daily_logs` row, no entry. `PlannedEntry` has no
id, and every seam the screen reuses needs one (`derive-mission.ts:53`;
`mission-item.tsx:111`), so the screen adapts the plan with **synthetic ordinal
ids** — entry `i` becomes a `MissionItem` with `id = 'plan:' + i`, captured
*before* `deriveMissionView` sorts. The committed test is `listMission(db,
date).length > 0` (`mission.ts:164-174` writes nothing when no log row exists,
`:165-166`). Each arrow tap is one `planForDay` — the read the scheduler
already runs six times on every status write (`:456-459`).

**The first tick commits the whole day and ticks the row in one transaction.**
`insertGenerated` returns `void` (`:130-141`) and discards the id it mints
(`:147`); it is given a `: string` return by hoisting `newId(db)` to a local.
The insert loop (`:618-620`) becomes `commitPlan(db, logId, plan): string[]`,
returning ids **in plan order**; `generateMissionForDay` becomes
`commitPlan(...).length`. `commitDayAhead(db, date, today, { ordinal, expect })`
asserts `today < date <= today + MISSION_HORIZON_DAYS`; calls
`ensureStartedOn(db, today)` — **the logical today, never the viewed day**, so
the anchoring trap in §1 cannot fire; recomputes the plan; writes nothing if
the day is already committed or `plan[ordinal]` no longer matches `expect`
(title, protocol, item — a protocol saved between render and tap; the screen
re-reads); otherwise one `db.transaction` runs `commitPlan` and
`setMissionStatus(db, ids[ordinal], 'completed', today)`. `Database.transaction`
is a plain BEGIN that does not nest (`mission.ts:274-278`) and
`setMissionStatus` opens none — the closure `adjust_today` makes
(`write-tools.ts:1276`): the day cannot exist with nothing ticked. **Position,
not key:** `planKey` is a multiset key by design (`:763-775`); ordinal over the
same `planForDay` order is exact.

> **Considered and rejected — resolving the ordinal by re-reading `ORDER BY
> created_at, id`** (`mission.ts:170`). `commitPlan` inserts inside one
> transaction and `created_at` is a millisecond default (`0001_init.sql:249`),
> so a stack commits with tied timestamps and a random `id` as the tiebreak.

**A future day has no carry source at all.** When `date > today` the fourth
source is not consulted — `carries` is the empty map (`:456-458`) — so no
entry is `carried` and none wears `missed_days` (`:486-490`); a tick against a
debt drawn on Thursday would settle Monday's original with a `late_on` naming
a day that has not happened (`:245`, `:301-307`). **Only the Plan screen's
future view, `commitDayAhead` and the committed-ahead re-derive (§3.5) pass
`{ today }`**; every other caller, the scheduler included, passes nothing, so
§§15–21 of `db/mission-generate.test.mjs` (`:686-1007`) do not move and the
scheduler's carry reads (§3.7) are untouched; the fallback anchor follows the
same rule, `protocol.startedOn ?? today ?? date` (`:470`). **A future day is
tick-only** (`mission-item.tsx:7-12`; §3.10): a skip ahead would be a
permanent suppression (a hand-tapped skip is never carried, `:262-265`) and a
remove ahead a tombstone on a plan that may change before its day.

**Un-ticking the last tick un-commits the day.** `uncommitDayAhead(db, date,
today)` asserts `date > today`, refuses if any planned row is not (`pending`
and `generated`), else **deletes** the day's rows with the guards of
`:826-831`. The tombstone precedent (`mission.ts:383-393`) exists because a
*user's* removal was resurrected by the next re-derive; an un-commit removes
nothing the user chose, and the day is meant to return to being computed.

**The quota count is corrected, because a tick ahead breaks it.** A Friday
quota row ticked on Monday, then Monday, Tuesday and Wednesday done, records
**four against `per_week: 3`**: `quotaCompletionsThisWeek` never sees the
Friday row (`d.date < date`, `:207`), so Wednesday still lands (`:401-402`) and
Friday's row is preserved by status (`:750-751`). The fix: `d.date >=
weekStart(date) AND d.date <= weekStart(date) + 6 AND d.date <> date` — every
completion in the row's week except the row's own day, keeping the header's
reason for that exclusion (`:191-194`); nothing today completes a row after
`date`, so §§10, 11, 21 are unchanged, and Wednesday now counts 3 and does not
land. Phases, pauses, modes and experiments need no forward rule of their own
(`phase.ts:46-89`; `:449`; `getActiveMode`, `day-modes.ts:43-45`, read at
`:448`; `experiments.ts:130-132`); the backward direction is §3.5.

### 3.4 The `ahead` mark, and the day's arrival

A committed-ahead day is a record of a morning the user has not had; judged
like any day, Friday committed on Wednesday and never opened reads `planned 9
· completed 1` while an untouched Tuesday reads nothing (§1) — `0050`'s
invariant, *"using the feature can never make a rate look worse"* (`:52-53`),
broken by the feature's gesture. So `planForDay(db, date, { today })` with
`date > today` stamps `ahead: true` in every entry's extras, and one predicate
reads it:

```
NOT_UNSEEN_SQL = "(json_extract(value, '$.ahead') IS NULL OR status <> 'pending')"
```

Written as an `IS NULL` test like its three siblings (`mission.ts:121`, `:128`,
`:153`), never as `NOT (… = 1 AND …)`: on a row with no `ahead` key
`json_extract` is NULL, `NULL = 1` is NULL, and `WHERE NOT NULL` drops every
ordinary pending row — disabling carry-over outright and inflating every rate.
The `= 1` form belongs only to a positive test where NULL-excludes is wanted
(`remindableEntries`, `:217`; `hasUnseenRows` below). An **unseen** row —
written before its day, never acted on — is not owed: `missionDailySeries`
(`:628-633`), `missionBySource`, `protocolAdherence`, `missionRecordStart` and
`outstandingCarries` (`:305-307`) carry it beside the three shared predicates,
so a passed day that never arrived counts and carries only what he asserted.
The pair, not the mark alone: a bare mark would hold the completed sauna out
of the rate for ever. A NULL `value` passes (`removeMissionItem`, `:408-409`).

**Arrival.** `arriveDay(db, day)` = `ensureTodaySeeded(db, day)` then `if
(hasUnseenRows(db, day)) rederiveMissionForDay(db, day)`, `hasUnseenRows` being
`SELECT 1 … WHERE d.date = ? AND json_extract(value, '$.ahead') = 1 AND status
= 'pending' LIMIT 1`. The re-derive computes today's plan *without* `ahead`, so
the value re-sync (`:805-808`) strips the mark from every pending row and the
carry source, held out of the future view, is added now (`:812-813`). It
replaces `ensureTodaySeeded` in `readDay` (`use-today-mission.ts:51-58`),
follows `adjust_today`'s seed (`:1270`), and **the Plan screen calls it whenever
it reads today** — the picker is itself a way to open a day. One cheap query
per focus, one diff per arrival, none on an ordinary day (alternative J).

### 3.5 Re-derivation reaches every committed day

Two helpers. `rederiveDaysAhead(db, today)` runs `rederiveMissionForDay(db,
day, { today })` for each committed day in `(today, today +
MISSION_HORIZON_DAYS]` — the bound is in the query, so a day committed under a
larger horizon is left to its own arrival — and is a no-op when
`hasCommittedDaysAhead(db, today)` (one indexed `LIMIT 1`) finds none.
`rederiveMissionFromToday(db, today): RederiveResult` calls `ensureStartedOn(db,
today)` **first** — `rederiveMissionForDay` anchors to the day it is handed
(`:702`), and handing it Friday for a NULL-anchored protocol would start the
clock on Friday and empty today (the generator skips its anchor on a day with
rows, `:608` before `:614`) — then re-derives today, then `rederiveDaysAhead`.

**Where each is called.** `rederiveMissionFromToday` replaces the today-only
call at the five seams (§1) and is added at the three that re-derive nothing
today: after `deleteProtocol` (`protocol-edit.tsx:781`), `createExperiment`
(`write-tools.ts:1543-1551`) and `completeExperiment` (`:1671-1674`). At the
delete seam it also changes **today**: a deleted protocol's pending rows
(`protocol_id` SET NULL, `0001_init.sql:231-232`) match no plan entry and are
removed, where today they stay on Home until the next unrelated re-derive; its
reminders are already safe (`remindableEntries` requires `protocol_id IS NOT
NULL`, `mission.ts:215`). `rederiveDaysAhead` alone runs **after every status
write** — `setStatus` and `toggle` (`use-today-mission.ts:142-160`, before the
reminder sync at `:147`/`:157`), the Plan screen's ticks, `adjust_today` after
its batch — because a completion moves what lands on later days under
`adjusting` (`:392-398`) and under a quota (§3.3), and a committed-ahead day
would otherwise go stale on the most common gesture in the app (§3.7). A
database with nothing committed ahead pays one `LIMIT 1` per tick. Today is not
re-derived on a tick: a row on `date` completed on `date` cannot change
`date`'s own plan (`:338-341`; the quota predicate excludes `d.date = date`).
The invariant, stated exactly: **a day committed ahead never holds a plan that
the protocols, modes, experiments and completions no longer make, from the
moment the app itself changed one of them.** Only the carry source is outside
it; arrival adds that.

### 3.6 The check-off: one stamp, two readings

**Every completion records the logical day the tick landed**:
`setMissionStatus(db, id, status, today = todayISODate())` writes
`value.done_on = today`; any other status removes it (`json_remove`, the
`late_on` undo shape at `:291-299`). `toggleMission(db, id, today)` threads it,
and the hook passes `dayRef.current` from `:154` as `:144` must — after a
westbound flight the clock lags that ref (`:93-102`). The Plan screen passes
its `today`; the Coach passes `todayISODate(context.now)` (`:1314`). `done_on`
earlier than `daily_logs.date` is a tick ahead, later a tick after the fact
(§3.8) — the parent spike's `checked_ahead_on` (`protocol-carryover.md:410`)
renamed for both signs. A value key beside the carry marks
(`mission-generate.ts:113-127`, `mission.ts:30-49`). **No migration.**

**Strict** — the default (`0050…sql:37-42`). The row is `completed`;
`lastCompletions` is not read (`:459`); `daily`, `weekdays`
(`src/lib/protocols/cadence.ts:89-92`) and `every_n_days` (`:93-94`) move
nothing; a `quota` completion counts in the **row's** week (§3.3). Worked:
sauna every 3 days, phase days 14 / 17 / 20; today the 15th; the user ticks
the 17th's row. It is `completed`, `done_on = 15`; the 20th is still next.

**Adjusting** — *"re-bases on when it was checked"* (`backlog:47`). The clock
reads the day the item was **done**, which a tick proves was no later than the
earlier of the row's day and the tap day. So `lastCompletions` reads
`min(COALESCE(json_extract(value,'$.done_on'), d.date), d.date)` as the done
day in both the filter and the aggregate, behind a prunable prefilter:
`d.date < ? /* date + MISSION_HORIZON_DAYS + 1 */ AND <done day> < ?`. The
prefilter is exact because `commitDayAhead` asserts a tap day is never more
than `MISSION_HORIZON_DAYS` before its row, and it keeps the query indexable
on a read the scheduler runs six times per sync — the first of three
mechanisms that need the horizon small and fixed (question 2). `landsOn`
(`:392-398`) is untouched; a tick on its own day and a carried row completed
late compute what they compute now.

Same example under adjusting: the 17th is completed with `done_on = 15`, so
**the 18th is next** (`since = 3`), and **the 17th stops being a native
occurrence of its own plan** (`lastCompletions(db, 17)` sees its own row,
`since = 2`); the completed row stands because the re-derive preserves acted-on
rows (`:750-751`), not because it lands. Un-ticking removes `done_on` and the
17th lands natively again; `rederiveDaysAhead` reshapes a committed 18th the
moment the 17th is ticked. The concern `:338-341` states cannot recur: a row on
`date` completed on `date` has done day `date`, not `< date`. `daily`,
`weekdays` and `quota` move nothing (`:376-381`; §21, `:968`); a `quota` row
ticked in **next** week's calendar banks a session there under both modes
(alternative H). **The `0050` invariant holds:** adjusting never writes
`started_on` (`0050…sql:63-64`; §20, `:963-965`); the only writes to it here
are the `ensureStartedOn(db, today)` guards.

### 3.7 Carry-over and reminders

`outstandingCarries` reads `status = 'pending'` (`:301`) and, now, seen rows
only; a future row that was ticked is `completed` and never a debt. `missed_days`
(`:514`) and `carried_days` (`:519`) are computed on the arrival re-derive.

**Reminders — the scheduler's reads do not change; its subtraction does.**
`protocolRemindersDue` walks tomorrow through today+6 with `planForDay(db,
day)` and no option (`:155-163`), and that stays: those reads consult the
carry source, which is what nudges a debt whose time has already passed today
— an item at 07:00 missed on Monday, carry-over on; at 20:00 Monday `add()`
drops today's row as past (`:147`) and only Tuesday's plan entry can supply
the nudge (`db/reminders.test.mjs:468-473` is the spent-today form). Passing
`{ today }` there would lose that notification outright, and Tuesday's arrival
can be after 07:00. What changes is one subtraction: on a **committed** day,
entries whose committed row is no longer `pending` — one query over the day's
settled planned rows — are skipped, so a row ticked ahead does not buzz on its
day, while a carried debt onto a committed-ahead tomorrow still does (the
carry is in the plan; its row does not exist yet). An unseen pending row keeps
its reminder. Dedupe is unchanged (`:143`).

### 3.8 The past half: a backfill reverses one owner call, in one case

The picker reaches back to the record start. A past day renders its committed
rows as they stand; an unarrived past day renders only its acted-on rows above
one serif line, *"This day was never opened."* Ticking a past row is the
question. Yesterday's untouched magnesium, remembered this morning: with
carry-over on, ticking today's carried copy settles the original `skipped +
late_on` — *done late, no credit* (`mission.ts:257-267`); ticking the original
on yesterday instead makes it `completed` on its own day with full credit.
**That reverses the owner's 2026-09-14 call in exactly this case — the tick
made on the original rather than on the carried copy.** The two gestures make
different claims (*I did it today, late* versus *I did it yesterday and did not
tick*), and the second is the most common reason to look back; for a `daily`
item it is the *only* correction, since `daily` never grows a carried row
(`:439-440`; §18, `:810`) and today's `missed_days` row *"settles nothing
earlier"* (`:512-513`). But the rate cannot tell a true backfill from a
flattering one, and the rule exists to keep *did it late* and *did it on time*
from producing the same number. Question 3 puts it to him in those terms.

**Three guards, and they ship with the gesture, not after it.** A past tick
is refused, with an authored line, on a row carrying `late_on`: it would flip
a `skipped + late_on` original to `completed` with the stamp still in `value`,
`doneLate` (`:618`) would silently drop, and the item would count done twice.
A past tick is refused on a **carried** row (question 4): the debt is live on
today's copy, where the gesture belongs; allowing it would stamp the original
with `late_on = dayOfEntry` (`:245`, `:249-255`) — a day on which nothing was
asserted — and put `carriedDays` and `tickedDays` on one row. A backfill on a
pending **original** (Monday's row, its debt carried to today) is the allowed
case, and it triggers `rederiveMissionFromToday`, so today's carried copy — a
debt that no longer exists — is removed by the diff (`:796-801`).
**Recommendation: backfill for the seven settled days behind today (the carry
window), older days read-only** — a miss older than a week is a fact about the
protocol (`:224-231`) — the read-only day saying so in one serif line, never a
disabled checkbox with no explanation (`00-design-spec.md:170`).

### 3.9 Adherence, the record start, and the day boundary

Two things change in the reads. `NOT_UNSEEN_SQL` (§3.4) in the five reads, so a
committed-ahead day that passes unopened enters no rate and carries no debt.
And `missionRecordStart(db, today = todayISODate())` clamps at `d.date <=
today`: on a young install whose first-ever row is a committed Friday, the
record would otherwise begin in the future and `mission-history.tsx:182` would
clip its window to nothing. A Friday tick made on Wednesday still sits under
Friday (`:612-635`) and is judged on Saturday; `doneLate` is untouched. The
only new figure any surface states is provenance — *done 2 days early*,
*ticked 1 day later* — label voice, never a signal colour
(`mission-item.tsx:75-77`).

**A boundary change needs no rule of its own.** `dayStartsAt` is written in
Settings and installed live (`app/settings-profile.tsx:94-95`); existing rows
are never rewritten (`src/lib/db/date.ts:163`). Moved so that today advances
(04:00 → 00:00 at 01:00): a committed-ahead day that is now today is arrived by
`arriveDay` on the next Home focus. Moved so that today retreats: Home's
`dayRef` does not rewind (`forwardCursor`, `:103-117`) until a relaunch, after
which the former today is a committed day ahead holding ordinary rows — no
`ahead` mark, not a debt (`< date`, `:300`), not in the series (`<= today`,
`:621`), ticked like any committed day. Both directions are a test.

### 3.10 What the Coach sees

**No schema change.** Nine tokens of headroom do not pay for a `date` on
`adjust_today` plus the rewrite of *"Today only"* (`:1205`); `adjust_today`
stays today-only, and acting on a day ahead rides the parked whole-app-access
item (`backlog:66`) with the `update_protocol` sweep nobody has done
(`coach-eval.test.mjs:807-811`). What the Coach needs is **visibility**, which
is payload: `mission[]` (`read-tools.ts:678-685`) gains `doneOn` on a row whose
`done_on` differs from today (omitted otherwise), and an `ahead` array —
`{day, title, protocol}` for every completed row on a day after today, omitted
when empty. No description sentence, and no rule about whether early is good —
that is judgment. **Token delta: 0 schema / 0 prompt by construction** — no
description or `inputSchema` changes; re-measured against
`db/coach-eval.test.mjs` §6 (`:814`, `:820`) before merge.

### 3.11 Interaction, in Conformed Set vocabulary

**The Plan screen.** `StackHeader` "Plan", parent "Home"
(`src/components/ui/stack-header.tsx:63-72`). The `DayPicker` bare — a control
row carries no device (`day-picker.tsx:50-56`) — with `subject="mission"`. Then
**one `plate`** holding the day's rows (Home's mission device, `mission.tsx:247`),
the same `MissionItemRow` Home draws, sorted by `deriveMissionView`
(`derive-mission.ts:46-76`) with **`snoozedIds` always the empty set** — snooze
yields the hero slot for a Home session (`use-today-mission.ts:85`;
`derive-mission.ts:12-13`), and this screen has no hero. No fold. One mono line
names the day's mode when one is set (the register of `index.tsx:174-176`). No
section note naming the record's state — it would flip under his finger on the
first tick; what is authored is the empties (`00-design-spec.md:170`), five:
*Your protocols put nothing on this day* (future; `MissionEmpty`'s `IDLE`
phrasing, `mission-empty.tsx:119-121`); *No plan was generated on this day*
(past); *This day was never opened* under a past day's acted-on rows; *This
day is settled* (beyond the backfill window); and `MissionEmpty` with no active
protocols. The accent is the completion stamps (`index.tsx:86-90`), nothing else.

**The row's mark, and what it says aloud.** `MissionItem` gains `tickedDays?:
number` (signed; negative is early), set by `toMissionItem(row, date)` from
`value.done_on` when it differs from the row's day — `listMission(db, date)`
passes the date through, since `LogEntryRow` knows its log id and not its day
(`src/lib/db/types.ts:232-246`). `carryMark` (`mission-item.tsx:79-85`) grows
a third branch, `DONE 2 DAYS EARLY` / `TICKED 1 DAY LATER`, label voice. It
takes precedence over `missed_days` on a backfilled row (informational about
*other* days, `mission-generate.ts:122-127`) and never meets `carried_days`,
because §3.8 refuses that tick. `MissionItemRow` gains `ahead?: boolean`: the
row is a `checkbox` whose label ends in its status (`:96-104`, `:108-109`), and
on a day that has not happened *"not done"* (`STATUS_SPOKEN.pending`,
`:232-237`) is a different claim — a second total map, `STATUS_SPOKEN_AHEAD`,
says *"planned"* for `pending`. **Home** gets the `LabelLink` row of §3.1 and
nothing else; **the editor** is unchanged (`protocol-edit.tsx:1044-1064`,
`:1061-1063`).

### 3.12 Tests that would pin it

Headless, `node:sqlite`. `db/mission-generate.test.mjs` (after §21, `:968`):

1. **No-op guarantee.** `planForDay(db, date)` with no `today` is
   byte-identical; §§15–21 unchanged; the quota predicate leaves §§10, 11, 21
   unchanged.
2. `planForDay(db, future, { today })`: no carried entry, no `missed_days`,
   every entry `ahead: true`; a NULL-anchored protocol at today+3 shows today's
   anchor; **viewing creates no `daily_logs` row.**
3. `commitDayAhead`: refuses `date <= today` and `date > today + 6`; leaves
   `started_on` = **today** for a NULL-anchored protocol; a title listed twice,
   ticked on the second row, completes the second; a plan changed between
   render and tick writes nothing; `done_on` lands with the commit; un-ticking
   removes it and, if it was the only tick, empties the day;
   `uncommitDayAhead` refuses a day holding any acted-on row.
4. **Strict:** the 17th ticked on the 15th leaves the 20th native.
   **Adjusting:** the 18th is native, the 17th is not, its completed row stands
   through arrival, `started_on` byte-identical (§20); §20's fixtures compute
   the same done day; `daily`, `weekdays`, `quota` move nothing; **a Friday
   quota row ticked on Monday, then Monday and Tuesday done: Wednesday does not
   land, the week records three.**
5. `rederiveMissionFromToday`: a pause, a delete, a concluded experiment and a
   mode over Friday each reshape a committed Friday, completed rows standing; a
   NULL-anchored protocol keeps `started_on` = today. **After a tick:**
   adjusting, Friday committed, Thursday completed → `rederiveDaysAhead`
   removes Friday's pending row; with nothing committed ahead, one query.
6. **Arrival:** `hasUnseenRows` flips; the diff strips `ahead` and adds exactly
   the carried rows; `outstandingCarries` never reads an unseen row as a debt;
   **an ordinary pending row — no `ahead` key, and one with a NULL `value` —
   survives all five reads** (the three-valued-logic pin); a boundary change
   each way.

`db/data-trends.test.mjs` (§14h, after `:813`): a Friday tick on Wednesday
moves Wednesday's point not at all and Friday's `completed` by one; `doneLate`
stays 0; **a committed-ahead day that passes unopened enters no rate** and
reads `planned 1 · completed 1`; `missionRecordStart(db, today)` never returns
a day after `today`; a past tick on a `late_on` row and on a `carried` row is
refused; a backfill on yesterday's pending original counts there and removes
today's carried copy. `db/day-boundary.test.mjs` (§8): `{ latest: today+6,
today }` steps six and no further; *Tomorrow*; the pill targets `today`; with
no `today`, `:624-649` hold. `db/reminders.test.mjs` (§7c, after `:500`):
`MISSION_HORIZON_DAYS < PROTOCOL_REMINDER_HORIZON_DAYS`; a row ticked ahead on
a committed day is not scheduled, the same item on an uncommitted day is; **a
carried debt whose time passed today is nudged tomorrow, committed-ahead or
not**; today+6 reached, today+7 not. `db/screens-render.test.mjs` — **header
(`:1-4`) and scope rewritten to cover `app/mission-day.tsx`**: today, an
uncommitted future day and a past day with no plan, the DB reads in `useState`
initializers that suite executes for real (`:6-8`) — the only headless gate on
Phase 2. `db/coach-tools.test.mjs`: `ahead` and `doneOn` only when they apply.
`db/coach-eval.test.mjs` §6: ceilings unmoved.

---

## 4. Alternatives considered

| # | Alternative | Verdict |
| --- | --- | --- |
| A | The picker on Home's folio line | Rejected. Six today-bound hooks; the forward-only write target (`use-today-mission.ts:101-102`); the folio prints the calendar day |
| B | Extend `mission-history` forward | Rejected. Settled days, counts not rows, pushed from Data |
| C | A "Tomorrow" peek on Home (parent spike's (a)) | Rejected. Narrow, and the owner asked for the picker |
| D | Commit a day when it is **viewed** | Rejected. Safe for the rates under the `ahead` mark but not cheap: six days of rows per browse, six diffs per tick |
| E | Materialise the one ticked row without the day | Rejected. A second way for rows to exist — the multiset and seed-deletion bugs came through that door (parent spike §3.3) |
| F | Carry debts into future views | Rejected. Today's pending rows are a morning, not a decision (`mission.ts:648-652`); a tick against one would stamp a future `late_on` |
| G | Under adjusting, re-date the vehicle row to the tap day | Rejected. `daily_log_id` is the day (carry spike alternative A, `:559`) |
| H | Adjusting reads `done_on` for quota too | Rejected for v1. It would change the meaning of every past quota row |
| I | A `log_entries.done_on` column (0059) | Not now. Value keys are the row-mark precedent; §5 records the column form |
| J | Re-derive every committed day on every Home focus | Rejected. `hasUnseenRows` is one cheap query per focus and one diff per arrival |
| K | `adjust_today` takes a `date` | Deferred to the parked whole-app-access item (§3.10) |
| L | Past days read-only | Viable (question 3b). Keeps the owner's rule whole; loses the forgot-to-tick correction, the only one a `daily` item has |
| M | Leave a committed-ahead day alone until its morning | Rejected. Under adjusting or a quota it goes stale on every tick and its dead row keeps its reminder; the gate costs one `LIMIT 1` |
| N | **A deferred intent, not a committed day** | Rejected — priced below |

**N, priced.** Store the tick as an intent — `(date, protocol, item,
done_on)` — applied by `generateMissionForDay` on the day's own morning. It
keeps *"a day is shaped once"* literally and deletes five mechanisms. Its
price: a **`0059` table** (`daily_logs` has no JSON column,
`0001_init.sql:209-220`); **four readers of a second store** — the future view,
`lastCompletions`, `quotaCompletionsThisWeek` and `protocolRemindersDue` must
each read intents or lie until the day generates; an **orphan policy** for an
intent the plan no longer puts on that day; and a tick **lost outright** if the
day is never opened. Commit-ahead keeps one store and every existing reader —
the carry spike's own reason for rejecting a side table (`:562`).

---

## 5. Data model, migration, and the way back

**Migration: none.** Two new value keys on `log_entries.value`: `done_on`
(`YYYY-MM-DD`, the logical day a completion was recorded; absent on every row
before this ships and read as the row's own day through `COALESCE`) and
`ahead` (`true` on a row written before its day, stripped from pending rows on
arrival, left on a completed row as provenance). Both declared in
`GeneratedExtras` and `MissionExtras`; `json_valid` guards them
(`0001_init.sql:241`). One new shared predicate, `NOT_UNSEEN_SQL`, beside the
three in `mission.ts:121-153`. If a rollup ever needs `done_on` indexed, the
column form is one additive ALTER at the then-free number with a
`json_extract` backfill. Head is `0058`; the next free number is `0059` and
this plan does not take it (`backlog:72`; the forward-only rule at `:89`). **No
native module**, no EAS rebuild, nothing leaves the device. **Rollback:**
`done_on` is written from Phase 1 on the one database ARC has, but the keys
are inert once unread — `parseExtras` ignores unknown keys (`mission.ts:63-70`)
and the re-derive re-syncs pending rows only (`:796-808`) — and one
`json_remove` strips them; an abandoned committed-ahead day is that plus
`uncommitDayAhead`'s delete. Nothing in this plan is one-way.

---

## 6. Effort and phases

| Phase | Piece | Size |
| --- | --- | --- |
| **1 — the data half** | `DayBounds.today` + *Tomorrow*; `done_on` in `setMissionStatus`/`toggleMission` and the hook's `dayRef`; `planForDay({ today })` — no carry source, `ahead`, the anchor fallback; `lastCompletions` on the done day with the prefilter; the quota predicate; `insertGenerated`'s return, `commitPlan` / `commitDayAhead` / `uncommitDayAhead`; `NOT_UNSEEN_SQL` in five reads and the record-start clamp; `arriveDay` in `readDay` and `adjust_today`; `rederiveDaysAhead` after every status write, `rederiveMissionFromToday` at eight seams; the scheduler's settled subtraction and the horizon invariant; `MISSION_HORIZON_DAYS` | one day |
| | headless tests, §3.12 | half a day |
| **2 — the screen** | `app/mission-day.tsx`, `_layout.tsx`, `LabelLink` and the Home row outside the branch, `?date=` and the mission-history caller, `tickedDays`, the row mark and `STATUS_SPOKEN_AHEAD`, `listMission(db, date)`, `arriveDay` on a today read; **past days read-only**; the render suite widened | one day |
| **3 — the past tick, per question 3** | the past-day tick **together with its three guards** and the window (seven days, any, or none); the Coach payload (`doneOn`, `ahead`); the ledger entry | half a day |
| | device pass, §7 | one evening |
| **Total** | | **≈ 3 days** |

The past-day tick is whole in Phase 3, because a tick without its guards
corrupts the done-late ledger (§3.8) and a Phase 2 that ships it before
question 3 is answered may ship a gesture he refuses. **Phase 1 adds no pixels
but is not invisible**: it changes what Home does on the first focus of a
committed-ahead day, what every tick writes and does, and what a deleted
protocol leaves on today; it most needs the device evening. **Phase 2 adds a
route**, and `.expo/` is gitignored (`.gitignore:7`), so a worktree `tsc`
cannot catch a bad `router.push('/mission-day')` — only `expo start`
regenerates `router.d.ts`; this repo carries the scar (commit `3fd46fa`, *"the
reminder tap lands on '/' — '/(tabs)/' is not a typed route"*). The route is
verified by running `expo start` before the merge.

---

## 7. What only a device can settle

- `PLAN ›` beside `PROTOCOLS ›` at 10px label on a 375pt screen — one control
  row or clutter under the plate; **and the same two links under
  `MissionEmpty`**, a different composition from two under a full plate.
- The chin printing *Tomorrow* and *Fri 19 Sep* with the pill showing in both
  directions under a `StackHeader` band; the plate for a future day, every
  `StatusBox` open, no fold, no hero — a plan or a to-do list; `DONE 2 DAYS
  EARLY` beside a long protocol name (`numberOfLines={1}`, `:133-135`);
  VoiceOver reading *planned* on a future row.
- Under a 04:00 boundary at 01:00: *Tomorrow* is the logical tomorrow, a tick
  made then stamps the logical day, and *Today* is not the folio's day.
- A row ticked ahead genuinely not buzzing on its day, and a carried debt's
  nudge still arriving the next morning — needs the notifications module in
  the binary (`use-today-mission.ts:140-141`).
- Stepping the picker across six days on the real stack; the arrival diff at
  the first Home focus of a committed-ahead day; `rederiveDaysAhead` on a Home
  tick while a day is committed ahead under adjusting — each felt or not.

---

## 8. Questions for the owner

**1. Where does the picker live?**

- (a) **(Recommended)** — a pushed **Plan** screen from Home, reached by a
  `PLAN ›` link beside `PROTOCOLS ›` under the mission, shown on empty days too;
- (b) the same screen, reached by tapping the date in Home's folio line — no
  new element, less discoverable, and the folio must first learn the logical day;
- (c) on Home itself, replacing the date with the picker (§3.1, §4A).

**2. How far ahead can the picker go?** *"To the end of the current phase" is
not offered: a phase can be open-ended, and the adjusting prefilter (§3.6),
the re-derive after every tick (§3.5) and the scheduler's loop against iOS's
64-notification ceiling (`protocol-reminders.ts:59-68`) need a small, fixed
horizon.*

- (a) **(Recommended)** — six days: every weekday once, inside the days the
  reminder scheduler already reads, so nothing else moves;
- (b) seven days — the same weekday next week; the scheduler's horizon is
  raised to 8 by hand, one more `planForDay` per sync;
- (c) fourteen days — the scheduler's horizon raised to 15, eight more reads.

**3. Can a past day be ticked from the picker?** *The one place the plan
touches your 2026-09-14 call that a late completion never earns credit: a tick
on the original row, rather than on the carried copy, would count on its day.*

- (a) **(Recommended)** — yes, for the seven settled days behind today,
  stamped with the day of the tap and shown as *ticked N days later*; a row
  already settled late through a carried copy is refused; older days are
  read-only and say so;
- (b) no — past days are the record, view only; a forgotten tick is corrected
  through today's carried row, as now, and a `daily` miss has no correction;
- (c) any day on record.

**4. A carried copy on a past day — Monday's magnesium, carried to Tuesday,
still untouched there; today is Thursday and you open Tuesday.** *If 3(b), this
does not arise.*

- (a) **(Recommended)** — the carried row is read-only there, with a line
  saying the debt is live on today's mission; a tick on Monday's own row is the
  backfill of question 3;
- (b) it can be ticked, settling Monday as done late on Thursday — the carried
  row then wears both marks, and `late_on` names a day nothing was asserted on.
