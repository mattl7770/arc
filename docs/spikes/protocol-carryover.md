# C11 — Protocol carry-over and check-off behaviour

**Status: BUILT** (2026-09-14), migration **`0050_protocol_carry_over.sql`**.
The owner answered §6 and the persistence half shipped with it. This document
stays as the reasoning record; §3 is the design that was implemented and §1 is
still an accurate reading of the code it describes.
**Backlog:** `docs/backlog-2026-09.md` C11 (Phase C, was marked **[spec]**).

## What shipped, and where it departs from this proposal

The owner's answers to §6: **1 → (c)**, **2 → (a)**, **3 → (a)**. So carry-over
persistence shipped whole, the missed day stays a miss, and a debt lives 7 days.
Five deliberate departures, each argued in the code it lives in:

| # | The proposal | What shipped | Why |
| --- | --- | --- | --- |
| 1 | the second column is `early_checkoff` | **`checkoff_mode`** (`strict` / `adjusting`) | it is not only about checking ahead: a LATE completion through a carried row moves the clock under `adjusting` too, which is the only way the toggle is reachable without a future-day surface |
| 2 | future check-off needs a day picker first (§3.3, question 1) | **no future-day surface**, per answer (c) — but `adjusting` ships, redefined as *n days after the item's last completion* | §3.3 found `every_n_days` to be the one cadence the toggle changes, and a carried completion is a completion. The surface is still deferred to the mission day picker (C1) |
| 3 | on day 8 the original is settled `skipped` + `value.carry_expired` | **no write at all** — the cap is the window `outstandingCarries` reads over | an untouched row is already an honest record of a miss and every adherence read counts it as one. Rewriting week-old history on every app open to add an annotation nothing reads is the worse trade, and it would have made `planForDay`'s inputs impure |
| 4 | `missed_yesterday` on a native `daily` row, meaning consecutive missed days | **`missed_days`** on ANY native row that supersedes a debt, meaning outstanding days inside the window | the general rule the spike itself argued for — `daily` stops being a special case — and the field's name no longer contradicts a value of 2 |
| 5 | a debt is any day that ended without a completion | **an untouched (`pending`) row only** | a hand-tapped skip is a DECISION not to do it. Re-levying it would make the skip button meaningless, and it gives the owner an explicit "not this one" gesture that costs no new control |

`NOT_CARRIED_SQL` landed exactly as §3.2 describes it, through
`missionDailySeries`, `missionBySource` and `protocolAdherence`, with
`listMission` deliberately not carrying it. So did the fourth-source placement
inside `planForDay`, the supersede rule, the phase / mode / pause exclusions and
the settle-on-late-completion write — which is also reversible, so un-ticking a
carried row re-opens the debt rather than converting an untouched row into a
permanent skip.

Tests live where §3.5 said they would: `db/mission-generate.test.mjs` §§15–21
and `db/data-trends.test.mjs` §14g.

### C9, which shipped in the same batch — and what replaced it (2026-09-21)

The item **time selector** (C9) went out with this migration, as six anchor
chips (07:00 … 21:00) plus the app's typed `HH:MM` field — *"deliberately not a
native wheel"* (`docs/backlog-2026-09.md` C9). The owner's first round on
hardware overruled that, on his device checklist (2026-09-21):

> *"needs a real wheel like a calendar app"*

So the chips and the field are gone from both editors (`/protocol-edit` and
`/protocol-item`, which share `TimeControl`) and the iOS spinner from
`@react-native-community/datetimepicker` 9.1.0 draws in their place:
`mode="time"`, 5-minute steps, 12- or 24-hour as the phone is set. Nothing this
document designed moves. `scheduled_time` is still `HH:MM` text, the reminder
scheduler still compares two of them as strings, and *Clear* still turns the
reminder off. The `Date` the wheel speaks exists for one render and is converted
on both sides by `src/lib/protocols/clock-time.ts`, whose round trip is pinned in
`db/protocols.test.mjs` §14.

The picker is a native module behind a guarded seam
(`src/lib/ui/date-time-picker.ts`). Where it cannot load — the web logic-check
preview, the headless render suite, a dev client built before it — C9's typed
field draws instead, with a line saying the wheel needs the next build. ARC has
no OTA, so the phone keeps its chips until the next **EAS build**, which is the
only thing that can show the wheel at all. A mission row's *Move to…*
(`MoveControl`) keeps the six chips for now; whether the wheel should follow it
there is a question for hardware.

### Three defects in the mission layer, fixed 2026-09-23

Found while planning the protocol-menus compaction (Phase 0 of that plan). None
needed a migration. Each was reproduced by a failing test before it was fixed.

**1. A row moved by hand snapped back to its planned time.** `moveMissionItem`
wrote `scheduled_time` and nothing else. `rederiveMissionForDay` re-syncs every
pending machine-made row's time from the plan, and a same-day re-derive runs
after any protocol save, a restore, a Settings save, `update_protocol`, or an
experiment starting or ending. So *Move to …* on the item sheet, and the Coach's
`adjust_today` move, lasted until the next unrelated edit that day.

- The move now marks the row: `value.moved = true`, one key beside `removed`,
  `skipped_via`, `done_on` and `ahead`.
- The kept-row re-sync keeps a marked row's `scheduled_time` and writes the mark
  forward. The dose and why-line still follow the item. A row that was not moved
  still follows a time edit to its item.
- A **retitle** rebuilds the row, because the diff matches on the title. A moved
  row's time now goes across to the entry replacing it (same protocol, same item
  id, same carried-ness), so the move survives that too.
- The move says when, not whether. A pause, or an item edited out, still takes
  the row off today.
- The mark is about one row on one day. If a moved day goes untouched, the debt
  is carried to the next day at the **item's own time**, with no mark. A carried
  copy can be moved in its turn and keeps that time.
- A row on a day committed ahead keeps its move through the re-derives every
  save runs on those days, and through the arrival re-derive, which strips
  `ahead` and leaves `moved`.
- Today's reminders are read from the committed rows (`remindableEntries`), so
  the notification fires at the moved time.
- **Two doses under one title.** The re-derive's diff keys on (title, protocol,
  carried), so two items with one title share a queue, and a row used to take
  whichever entry was at its head. A moved evening row could then re-sync onto a
  morning dose added ahead of it, keeping the evening time. A completed evening
  row could also claim the morning slot, so the pending morning row re-synced
  onto the evening dose. That second case was already on main before the mark;
  the mark made it visible. Each row now claims the entry of its own `value.item`
  first. Only a row the plan no longer names by item falls back to the head of
  the queue, as every row did before.
- The mark belongs to the item it was made on. A moved row that can only pair
  with a different item of the same title (its own was deleted) follows that
  item's time, unmarked. If its own item survives under a new title, the moved
  time goes there.

Tests: `db/mission-generate.test.mjs` §29–30 and §32, `db/coach-levers.test.mjs` R5.

**2. A protocol paused through the Coach stayed on today.** `edit_record` on the
`protocols` domain called `reviseProtocol` (and `setActive` on a resume) and never
re-derived today, so a pause, a carry-over change or a check-off-mode change took
effect the next morning. This is the defect the rethink fixed for the Settings
sheet. The domain's `edit` now calls `rederiveMissionFromToday` after the write,
as the sheet does. The tool's schema and description are unchanged, so it costs
no tokens. Tests: `db/coach-levers.test.mjs` R7.

**3. Skipping a carried row settled the debt only from the item sheet.** The
sheet called `skipCarried`. The hero card's *Skip* (`useTodayMission().setStatus`)
and the Coach's `adjust_today` skip called `setMissionStatus(…, 'skipped')`, which
settled the copy and left the original `pending`, so the same debt was carried
again the next morning. The rule now lives in `setMissionStatus` itself:

- `'skipped'` on a carried copy first re-opens whatever that copy had settled,
  then settles the original `skipped` with `value.skipped_via = <copy id>`. A copy
  marked done late and then changed to skipped therefore moves the original from
  `late_on` to `skipped_via` instead of wearing both.
- **Every miss the copy stood for, not only its anchor.** One carried row stands
  for every outstanding miss of its item, and `carried_from` names only the most
  recent. With the item missed Monday and Friday, a Saturday skip used to settle
  Friday alone, and on Sunday the carry re-anchored on Monday: *owed from Mon, 6
  days late*, the skip undone overnight. The skip now settles every row that
  `carryDebtRows` (`src/lib/db/repositories/mission.ts`) counts as a debt of the
  same item on the copy's day, each stamped `skipped_via`. That is the same
  query `outstandingCarries` builds the carry from, moved there so the two
  cannot disagree. An excused day, a miss older than the seven-day window and
  every other item are untouched. The undo re-opens every row stamped with the
  copy's id.
- **Completing** a copy still settles only the anchor (`late_on`). Doing the item
  once pays one debt; declining it declines the debt the row stands for. So with
  two misses outstanding, a completed copy is followed by a carry of the older
  miss the next morning. That was the behaviour before this change, and is left
  for the owner to confirm.
- `skipCarried` is gone. The item sheet calls `setMissionStatus` like every other
  surface.
- Un-skipping re-opens both rows, whether through the row's own tap on Home
  (`toggleMission`) or the sheet's *Put back*.
- Every caller that asks `setMissionStatus` for `'skipped'` was checked, and each
  one is a decision the user made: the hero card's Skip, the item sheet's *Skip
  today*, and `adjust_today`'s skip on a card the user approved. The two skips
  the app makes on its own write SQL directly and still settle nothing:
  `removeMissionItem`'s tombstone (removing a carried copy clears it from today
  only, and the debt comes back tomorrow) and the settle of the original itself.

Tests: `db/mission-generate.test.mjs` §17b, §31 and §33, `db/coach-levers.test.mjs`
R6, and the carried-row case in `db/screens-render.test.mjs`.

---

## 1. Current state

### The day's plan is computed fresh and knows nothing of yesterday

`planForDay` (`src/lib/db/repositories/mission-generate.ts:221-322`) is the single
definition of what a day should contain. It reads active protocols' live versions
(`:223`), picks the live phase from `protocols.started_on` (`:236`, via
`phaseOn`, `src/lib/protocols/phase.ts:46-90`), tests each item's cadence
(`:240`), then appends mode items (`:272-285`) and running experiments'
interventions (`:307-320`). It takes exactly one date and never looks at another.
There is no fourth source and no backward read.

`generateMissionForDay` (`:343-359`) commits that plan once per day and is
idempotent on `countMissionEntries > 0` (`:345`). `rederiveMissionForDay`
(`:429-576`) re-shapes an already-generated day by diffing against the same
`planForDay` — removing untouched machine-made rows the plan no longer calls for,
inserting new ones, preserving anything acted on (`:474-485`).

### A mission row IS a day

`log_entries` (`db/migrations/0001_init.sql:222-251`) carries
`daily_log_id text NOT NULL REFERENCES daily_logs (id) ON DELETE CASCADE` and a
`scheduled_time` that is wall-clock `HH:MM` only — *"the calendar date comes from
the parent daily_log"* (`:237-239`). There is no "originally due" column, no
carry marker, and no link between two rows of the same item on two days. The only
cross-row identity is `value.item`, the `ProtocolItem.id` stamped by the generator
(`mission-generate.ts:88-98`), which exists so the weekly quota can be counted.

So today a pending row at midnight simply stays pending, on its own day's log,
forever. Nothing moves it and nothing mentions it again.

### Adherence already refuses to let two different facts render identically

`missionDailySeries` (`src/lib/db/repositories/mission.ts:369-411`) counts
`planned / completed / skipped / excused` per day; `missionOwed` (`:313-315`)
subtracts the excused ones from the denominator, and the reasoning is written out
at `:270-303`: an excused skip is *"removed from the denominator — it is not
owed, so it is neither a completion nor a miss"*, because *"counting it as met
makes `completed` a lie"* and *"'I rested correctly' and 'I did it' are different
facts and must never render identically."*

`missedOf` is `planned − completed − excused`, so an **untouched** row counts as a
miss exactly like a hand-skip. Only rows with `status = 'skipped'` could be
excused — which meant an untouched row on a Travel day was counted against the
user while the identical row he tapped skip on was not. That asymmetry was
pre-existing; §3 noted where it touched this design without changing it.
**Fixed 2026-09-14, out of band** — an untouched row on an excusing day that has
ENDED is excused too. See the note in §3.

`removeMissionItem` (`:235-254`) is the precedent for row-level markers: a removal
is a **tombstone**, not a delete — `status = 'skipped'` plus `value.removed`, so
the re-derive sees a satisfied plan entry and never resurrects it, and *"the day
keeps an honest record that the item was planned and dropped."*

### The quota already carries, by construction

`quotaCompletionsThisWeek` (`mission-generate.ts:168-189`) counts **completed**
rows in the Monday-start week strictly before the day, keyed on
`(protocol_id, value.item)`. `landsOn` (`:201-212`) then puts a quota item on
**every remaining day of the week until the quota is met**. A flexible quota is
therefore already a carry mechanism with its own accounting.

### Cadence arithmetic, and what anchors it

`cadenceLandsOn` (`src/lib/protocols/cadence.ts:81-98`) answers everything that
can be decided without the database:

- `daily` → always;
- `weekdays` → ISO weekday membership (`:89-92`), Monday = 1 (`:44-48`);
- `every_n_days` → `dayInPhase >= 0 && dayInPhase % n === 0` (`:93-94`);
- `quota` → **null**, deferred to the generator.

`dayInPhase` comes from `phaseOn` and counts from the phase's own first day, which
is derived from `protocols.started_on` (migration `0043`). `0043`'s header
(`db/migrations/0043_protocol_started_on.sql:10-13`) is explicit about why that
column is on the protocol row and not in the version: *"it belongs to the
protocol's IDENTITY and not to any one revision: editing the content writes a new
version and must not restart a titration the user is six weeks into."*

### There is no future-day surface at all

`src/hooks/use-today-mission.ts` reads `todayISODate()` and only that (`readDay`,
`:49-57`); `deriveMissionView` (`src/lib/home/derive-mission.ts:46-76`) is a pure
sort over one day's items. `app/mission-history.tsx` looks **backwards** — and
`missionBySource` is documented "give it settled days only" (`mission.ts:602-606`).

**Nothing in the app can display, let alone check off, a day that has not
happened.** The generator has never been asked to commit a future day either.
That is the binding constraint on the second toggle.

### Where the toggles would be set

`app/protocol-edit.tsx` is the editor. Its contract is stated at `:27-42`:
identity fields (name, type, description, paused state, start date) update the
`protocols` row in place; phases and items are the versioned content. Save writes
a version only when the canonical JSON changed (`:560-563`) and then re-derives
today (`:593`). `ProtocolRevision` (`src/lib/db/repositories/protocols.ts:160-176`)
is the list of everything one Save can change, applied in one transaction
(`:184-221`).

The screen is a **form**, so it carries no block — form (b) of the capture-surface
rule (`src/components/ui/block.tsx:50-58`, and the screen's own note at
`protocol-edit.tsx:59-85`). Its accent budget is exactly one: Save (`:82-84`).
Chips are neutral ink (`Chip`, `:166-197`); the Status pair at `:825-842` is the
shape any new two-state control should copy.

---

## 2. The owner's words

> **C11 | Protocol carry-over + check-off behaviour [spec]** — Two **per-protocol**
> toggles. (1) *Persistence:* *"if you miss something, it stays tomorrow until you
> check it off, versus currently it is just attached to each specific day."*
> (2) *Future check-off:* checking an item off a day ahead marks it and updates —
> **strict** keeps the original calendar; **adjusting** re-bases on when it was
> checked. Both per protocol.

---

## 3. Proposed design

### 3.1 Where the toggles live: the `protocols` row, not the versioned content

**Recommendation: migration `0050`, two columns on `protocols`.**

```sql
ALTER TABLE protocols ADD COLUMN carry_over integer NOT NULL DEFAULT 0
  CHECK (carry_over IN (0, 1));
ALTER TABLE protocols ADD COLUMN early_checkoff text NOT NULL DEFAULT 'strict'
  CHECK (early_checkoff IN ('strict', 'adjusting'));
```

Both defaults reproduce today's behaviour exactly, so no protocol on the device
changes when `0050` runs.

Four arguments, in order of weight:

1. **`started_on` already settled this exact question.** `0043`'s header
   (`:10-13`) puts the phase clock on the row *because editing the content must
   not restart a titration*. A carry-over rule is the same kind of fact: editing
   the plan must not silently change whether yesterday's miss is still owed.
2. **A version restore must restore the plan, not the policy.** `restoreVersion`
   (`protocols.ts:441`) writes an old content document as a new version. If the
   toggles lived in content, restoring v3 would silently flip carry-over — and
   could orphan carried rows generated under v5's rule with nothing to resolve
   them.
3. **Carried rows cross version boundaries by construction.** A row carried from
   Monday into Thursday may span a Tuesday edit. If the policy is versioned, the
   row's origin and its resolution are governed by two different documents. A
   policy that can change mid-carry is precisely what makes a carried row
   ambiguous.
4. **The diff would print the wrong thing.** `src/lib/protocols/diff.ts` renders
   "changed from … to …" for plan content. "Persistence: off → on" beside a dose
   change mixes two vocabularies on one screen.

Cost, accepted: there is no history of *when* a toggle changed. `protocols.updated_at`
moves and that is all. These are two booleans of execution policy, not a plan.

### 3.2 Persistence — the semantics

#### The shape of a carry: a new row, marked, on the later day

A carried item is a **new `log_entries` row on the later day**, not the original
row re-dated. Re-dating would move the row to a different `daily_logs` parent and
destroy the record that Monday planned it and Monday did not do it —
`missionDailySeries` would then show Monday as having planned nothing, which is
the honesty rule broken from a new direction. The tombstone precedent
(`mission.ts:224-254`) is the model: the row stays where it is and gains a
marker.

The carried row is generated by `planForDay` as a **fourth source**, alongside
protocols, mode items and experiments. That placement is the single most
important structural call here: `planForDay` is the one definition of "what this
day should contain", the first generation and the re-derive share it, and a carry
computed anywhere else would drift from it within a release. It needs one extra
query per day — `outstandingCarries(db, date)` — symmetrical with
`quotaCompletionsThisWeek` (`:168-189`): one grouped query, not one per item.

New `value` fields on the two rows involved (`GeneratedExtras`,
`mission-generate.ts:76-103`):

| field | on | meaning |
| --- | --- | --- |
| `carried` | the carried row | `true` — the predicate flag (see the ledger below) |
| `carried_from` | the carried row | `{ date, entry }` — the day and row id it is owed from |
| `carried_days` | the carried row | 1 on the first carry, 2 on the second … |
| `late_on` | the ORIGINAL row | the day a carried copy of it was finally completed |
| `missed_yesterday` | a native daily row | consecutive missed days (see `daily` below) |
| `carry_expired` | the ORIGINAL row | the cap ran out; the debt is closed unmet |

#### Stacking: exactly one live carried row per item

Three missed days produce **one** row, not three. Each day the carry is
re-created and the previous day's carried row is removed — it is `generated` and
`pending`, so the existing re-derive already classifies it as `replaceable`
(`:476-477`) and removes it when the plan no longer names it. What changes across
days is `carried_days`, which is what the row prints.

#### The cap

`CARRY_MAX_DAYS = 7` (the recommendation; see question 3). On day 8 the carry
stops being created and the original row is settled `skipped` with
`value.carry_expired = true`. An unbounded carry is the failure mode of every
task application, and a protocol item you have not done in a week is a fact about
the protocol — `app/mission-history.tsx`'s "Where it's failing" is the surface
that already answers it.

#### The supersede rule, and how each cadence falls out of it

> **A carried item is dropped the moment its own cadence puts the item on that
> day.** A debt and its own recurrence are one obligation, and two rows for one
> obligation is the multiset-collision bug (`mission-generate.ts:486-499`)
> arriving through a new door.

| cadence | behaviour | why |
| --- | --- | --- |
| `daily` | **never a second row.** Today's native row is marked `missed_yesterday` | the cadence lands the item every day, so the carry is always superseded. The rule above produces this; it is not a special case |
| `weekdays` | carries, until the cap or the next listed day, whichever is sooner | Mon/Wed/Fri missed on Monday → carried Tuesday; Wednesday's native occurrence supersedes it |
| `every_n_days` | carries, until the cap or the next occurrence | the only kind where `adjusting` also does something (§3.3) |
| `quota` | **never carries** | the quota *is* the carry (`landsOn`, `:201-212`). A carried row would put two rows of the item on one day and `quotaCompletionsThisWeek` would count one week's completion twice |

#### The phase boundary, and the protocol's own state

A carry dies when its source item is no longer live:

- the live phase on the carry day no longer contains that `value.item` — phase 1
  asked for 2 caps, phase 2 asks for 4; carrying phase 1's row into phase 2 puts
  a dose on the day that the protocol does not ask for;
- `phaseOn` returns `ended` or `not_started` — a protocol that generates nothing
  carries nothing;
- the protocol is paused (`is_active = 0`) — the generator already skips it
  (`:223`) and the carry follows;
- the item was deleted in an edit — this falls out for free: the carried row is
  `generated` and `pending`, so the re-derive removes it.

#### The excused-skip rule

`modeExcusesSkips` (`mission.ts:304-306`) says a skip under Sick / Travel / Social
is the right call. So:

- **No carry is created from a day whose mode excuses skips.** Carrying it would
  re-levy a debt the mode just forgave and would make Travel mode produce a pile
  of work waiting on the day you get home — exactly the nag the mode exists to
  prevent (`src/lib/modes/registry.ts:147`: *"A missed gym session is not a miss
  — do not nag about it"*).
- **The cap clock does not advance across such a day.** Sick days do not consume
  your grace.
- A mode that DROPS a type (Sick drops workouts) drops the carried rows of that
  type too — free, because the carry is computed inside `planForDay`, above the
  `def.dropTypes` filter at `:230`.

~~Note in passing: an **untouched** row on a Travel day is not `skipped`, so
`missionDailySeries` counts it as a miss today. The carry rule above treats
untouched-on-an-excusing-day humanely, which makes the existing asymmetry more
visible rather than less. Worth a separate look; out of scope here.~~

> **FIXED 2026-09-14** (`claude/fixes-sept`), separately from carryover. On a day
> whose mode excuses skips, an untouched row is now excused too **once the day
> has ended** — in `missionDailySeries` (guarded by `date < today`, because a
> pending item at 09:00 is a morning, not a decision) and in `missionBySource`,
> which is only ever given settled days. The denominator rule is unchanged:
> excused leaves the denominator and never counts as met. The by-day ledger and
> "Where it's failing" now agree row for row. Pinned in `db/data-trends.test.mjs`
> §13d and §13d-ii (both states on an excusing day, on a live excusing day, and
> on a normal day).
>
> This removes the asymmetry the carry rule would have had to reason around, so
> the design above inherits a simpler ledger than the one it was written against.

#### The ledger: what a carried item does to adherence

The rule, stated once:

> **The original day keeps the obligation. A carried row is a reminder, not a new
> obligation.**

Concretely, a third shared predicate joins `PLANNED_ROW_SQL` and `NOT_REMOVED_SQL`
(`mission.ts:104`, `:111`):

```ts
export const NOT_CARRIED_SQL = "json_extract(value, '$.carried') IS NULL";
```

Every query that counts what a day **owed** carries it: `missionDailySeries`,
`missionBySource`, and the protocol-detail adherence read. `listMission`
(`:113-123`) does **not** — a carried row renders on Home, it just is not an
obligation of that day.

Why: Tuesday did not owe you Monday's creatine; Monday did. Counting the carry as
a new obligation makes an item asked for once read as *3 planned, 1 completed* —
which would punish the user for using the feature designed to help him.

When a carried row is completed, one extra write in the same transaction settles
the original: `status = 'skipped'`, `value.late_on = <the day it was done>`. Every
existing query then does the right thing with no change at all — a skipped row is
already a miss unless the mode excuses it. The only new surface is an annotation
(§3.4).

**So: the day it was missed stays a miss. The late completion is recorded and
shown, and earns no rate credit.** That is the maximal reading of the house rule.
The gentler alternative is question 2.

#### Worked examples

All against *Evening stack* (`supplement_stack`, `started_on = 2026-09-07`, one
open-ended phase), carry-over **on**, mode `normal` unless stated.

**(a) `daily` — "Magnesium 400 mg".**
Mon 14th: row planned, untouched at midnight. Tue 15th: the cadence lands the item
natively, so the carry is superseded — **one** row, marked
`missed_yesterday: 1`. Completing Tuesday writes nothing back to Monday: you did
not take Monday's magnesium. Monday reads `planned 1 / completed 0` — a miss.

**(b) `weekdays` — "Lower body", Mon/Wed/Fri.**
Mon 14th planned, untouched.
Tue 15th: the cadence does not land it; one carried row appears, same title, same
`scheduled_time`, same dose and `why` verbatim, plus
`carried_from = {date:'2026-09-14', entry:<mon-id>}`, `carried_days: 1`.
The user completes it Tuesday →

- the Tuesday row is `completed`, and is outside every denominator;
- the Monday row becomes `skipped` + `late_on: '2026-09-15'`;
- Monday: `planned 1 · completed 0 · skipped 1` → a miss;
- Tuesday: `planned 0` from this item; its rate is untouched;
- `missionAdherence` over the two days is **0 / 1**, not 1/2 and not 0/2.

Wed 16th: the native Mon/Wed/Fri occurrence lands. Had Tuesday not happened, the
carry would be dropped here anyway — superseded.

**(c) `every_n_days` — "Sauna", n = 3, phase day 0 = Mon 14th → 14th, 17th, 20th.**
Missed the 14th. Carried on the 15th (`carried_days: 1`) and the 16th
(`carried_days: 2`, the 15th's row removed). On the 17th the cadence lands it
natively and the carry is dropped.
Completed on the 16th under **strict**: the every-N counter is untouched, so ARC
asks for sauna again on the 17th, one day after it was done. That is exactly what
"strict keeps the original calendar" means, and it is why `adjusting` exists
(§3.3).

**(d) `quota` — "Zone 2", 3/week.**
Never carries. On Thursday with 1 of 3 done, `landsOn` already puts it on Thu, Fri,
Sat and Sun. A carry would add a second Thursday row and the week's count would
take one completion twice.

**(e) Phase boundary — "Creatine", phase 1 "Loading" 5 days from the 14th
(2 caps), phase 2 open-ended (1 cap).**
The loading dose is missed on the 18th (day 4, the last day of phase 1). On the
19th the live phase is 2 and phase 1's item id is not in it → **no carry**. The
18th stays a miss; the 19th asks for 1 cap, as the protocol says.

**(f) Excused — Travel mode on Mon 14th.**
Nothing carries out of Monday, and the cap clock still reads day 0 for anything
carried later in the week.

### 3.3 Future check-off — strict vs adjusting

#### The prerequisite

There is no surface. Making a future day checkable means one of: a "Tomorrow"
peek on Home, or a day picker on the mission (forward and back — C1 wants the
backward half for food logging anyway). **That is question 1, and it is the
expensive half of this item.**

Two mechanics follow from making one visible, whichever surface wins:

- **Checking a future day commits that whole day's plan.** The row must exist to
  be checked, and the one mechanism for creating rows is
  `generateMissionForDay`. Materialising a single row instead would be a second
  way for mission rows to come into existence, which is how both the multiset bug
  and the seed-deletion bug happened. Committing the day is safe because the
  re-derive exists: a later edit or mode change still reaches it.
- **The check is stamped with the day it happened.** `setMissionStatus`
  (`mission.ts:132-144`) already writes `completed_at` as an instant, but a
  local-day comparison against a UTC instant is the class of bug `0043`'s header
  warns about (`:31-37`). So the check also writes
  `value.checked_ahead_on = 'YYYY-MM-DD'` — the local day the tap happened.

#### Strict (the default)

The check marks the future row `completed` and does nothing else.

- `every_n_days` — the phase clock is untouched; the next occurrence is where it
  always was.
- `quota` — the completion counts in the week containing the **row's** day, which
  is already correct with no change: `quotaCompletionsThisWeek` calls
  `weekStart(date)` on the day being planned (`:182`).
- `weekdays`, `daily` — nothing to move.

Worked: sauna every 3 days lands 14th / 17th / 20th. You do it on the 16th and
check the 17th's row. Next is still the 20th.

#### Adjusting

**Adjusting means the cadence clock follows reality — and it is meaningful for
exactly one cadence kind.**

| cadence | what adjusting does |
| --- | --- |
| `daily` | nothing. n = 1; tomorrow is tomorrow |
| `weekdays` | **nothing.** A weekday list is a calendar statement, not an interval — you cannot re-base "Monday". Doing Friday's lower body on Thursday leaves Monday next |
| `every_n_days` | **the whole feature.** The next occurrence counts from the day it was actually done |
| `quota` | nothing. A quota is already anchored to the calendar week, and a completion checked into a future day counts in that day's week — correctly |

That "one of four" is worth putting to the owner directly (question 2), because it
determines whether the toggle earns a control at all or whether it should simply
be the behaviour for `every_n_days`.

**How `every_n_days` re-bases — with no new storage.**

ARC's cadence clock is per-**protocol** (`started_on` plus phase offsets), so
re-anchoring `started_on` would move every item of a stack because one of them was
taken early, and would shift a titration. That is not acceptable and is stated as
an invariant with a test.

Instead, under `adjusting`, `every_n_days` is redefined as:

> *n days after this item's **last completion**, falling back to the phase clock
> when it has never been completed.*

The last completion is already stored, already indexed, and already joined on
`value.item` by `quotaCompletionsThisWeek`. So this needs **no migration and no
new table**, and it degrades exactly right: an item never completed behaves
precisely as it does today.

The cost is that `every_n_days` stops being pure arithmetic under `adjusting` and
becomes a database question. That has a precedent in the same two files: `quota`
already returns `null` from `cadenceLandsOn` (`cadence.ts:95-96`) and is answered
by `landsOn` in the generator (`:201-212`). Adjusting's `every_n_days` joins it
there. `cadence.ts` stays pure for the editor and the diff.

**Interaction with carry-over.** A carried row's completion *is* the item's last
completion, so under `adjusting` a late completion moves the clock; under `strict`
it does not. Worked example (c) is exactly this: completed on the 16th, next
occurrence on the 19th under adjusting, on the 17th under strict.

**Invariant:** adjusting never writes `protocols.started_on` and never moves phase
day 0. Which phase is live is a fact about the protocol; when one item comes round
is a fact about the item.

### 3.4 Interaction, in Conformed Set vocabulary

**The editor** (`app/protocol-edit.tsx`). Two new sections between Status
(`:825-842`) and "What changed" (`:844-856`) — they are identity and policy, not
content, and putting them there leaves the versioned-content block visually
intact. The screen is a form, so: **no block**, a `SectionLabel`, whitespace
(`block.tsx:50-58`).

```
  SectionLabel   "If you miss it"
  Chip pair      [ Stays tomorrow ]  [ Attached to the day ]

  SectionLabel   "Checking ahead"
  Chip pair      [ Keep the calendar ]  [ Re-base on when I did it ]
  note (serif, text-ink-muted, 12px):
       "Only changes items set to every N days."
```

Both chip pairs are the existing neutral `Chip` (`:166-197`) — the Status pair's
exact shape. **Accent budget unchanged: Save stays the only accent** (`:82-84`).
The one-line note under the second pair is the same device the quota control
already uses to say what a control actually does (`:403-410`), and it exists for
the same reason.

**The mission row** (Home). `MissionItem` (`src/types/home.ts:15-53`) gains
`carriedDays?: number`. It renders as one **label-voice** mark beside the
category: `SUPPLEMENTS · 2 DAYS LATE`. Not a signal colour — adherence is
behaviour, not biology (`app/protocol-detail.tsx:50-53`) — and not an accent. A
carried item can claim the hero on its merits; nothing in `deriveMissionView`
changes.

**Protocol detail** (`app/protocol-detail.tsx:223-228`). The four-term ledger
still reconciles to the denominator; `skipped` gains a parenthetical:

```
  4 done · 2 skipped (1 done late) · 0 partial · 1 untouched
```

Mono, like the rest of that line. Nothing else on that screen moves.

### 3.5 Tests that would pin it

Headless, `node:sqlite`, in `db/mission-generate.test.mjs` and `db/protocols.test.mjs`.

1. **The no-op guarantee.** Carry off (the default): a missed Monday item produces
   no Tuesday row and no marks. `0050` leaves every existing protocol at
   `carry_over = 0, early_checkoff = 'strict'`; `npm run db:validate` passes.
2. `weekdays`: miss Monday → exactly one carried row on Tuesday, with the item's
   own time, dose and `why`. A second `rederiveMissionForDay` on Tuesday adds
   nothing.
3. Wednesday holds ONE carried row with `carried_days: 2`; Tuesday's carried row
   is gone.
4. **Supersede:** Wednesday's native Mon/Wed/Fri occurrence exists and no carry
   does — the day holds exactly one "Lower body".
5. `daily` items never produce a second row; the native row carries
   `missed_yesterday`.
6. `quota` items never carry, and a late completion is counted once by
   `quotaCompletionsThisWeek`.
7. Completing a carried row settles the original `skipped` + `late_on`;
   `missionDailySeries` reads Monday `planned 1 / completed 0`, Tuesday
   `planned 0` from that item.
8. `missionAdherence` over those two days is `0/1`.
9. **Phase boundary:** a miss on the last day of phase 1 does not carry into
   phase 2.
10. **Excused mode:** no carry out of a Travel day, and the cap clock does not
    advance across it. A mode that drops the type drops its carried rows.
11. **Cap:** on day 8 no carry is created and the original carries
    `carry_expired`.
12. A paused protocol carries nothing; a deleted protocol's carried row is removed
    by the next re-derive (`protocol_id` is `ON DELETE SET NULL`).
13. **Strict:** checking a future `every_n_days` row does not move the next
    occurrence.
14. **Adjusting:** it does — and `protocols.started_on` is byte-identical
    afterwards (the invariant).
15. Adjusting is a no-op for `daily`, `weekdays` and `quota`.
16. `planKey` (`:390-391`) is widened to a third component so a carried entry and
    a native entry for the same title under the same protocol cannot claim each
    other's slot in the multiset match.

---

## 4. Alternatives considered

| # | Alternative | Verdict |
| --- | --- | --- |
| A | **Re-date the original row** into the later day | Rejected. `daily_log_id` is the day; moving the row erases the fact that the original day owed it, and `missionDailySeries` would show that day planning nothing |
| B | **Carried rows are full obligations** (naive denominator) | Rejected. One item asked once reads as 3 planned / 1 completed. The feature would make adherence worse for using it |
| C | **Toggles in the versioned content** | Rejected. The `started_on` precedent; a restore should restore the plan, not the policy; a carry spanning an edit would be governed by two documents |
| D | **A dedicated `carried_items` table** | Rejected. The mission row *is* the carry; a second store is a second source of truth, and the tombstone precedent puts row-level provenance in `value` |
| E | **One global setting** instead of per-protocol | Rejected by the owner: *"Both per protocol."* |
| F | **`adjusting` via a per-item anchor table** (the `0037` muscle-anchor precedent) | Viable, and the right answer if adjusting ever needs to be set by hand ("treat this as done on the 12th"). Not needed for the behaviour asked for, and it would cost a migration the last-completion derivation does not |
| G | **Carry the item's whole history forward** (a running streak of debt) | Rejected. One live row per item; the cap closes the rest. Anything else is a task-app inbox |

---

## 5. Effort

| Piece | Size |
| --- | --- |
| `0050` + repo columns + `ProtocolRevision` + editor section | small — half a day |
| `outstandingCarries` + the carry source inside `planForDay` + the supersede / phase / mode rules | **the bulk** — one day |
| `NOT_CARRIED_SQL` through the adherence reads + the settle-on-late-completion write | half a day |
| Home mark + protocol-detail annotation | small |
| Headless tests (16 above) | half a day |
| **Persistence, total** | **≈ 1.5–2 days** |
| Future check-off semantics (strict + adjusting), given a surface | ≈ half a day |
| The future-day surface itself (peek or day picker) | ≈ 1–1.5 days, and it overlaps C1 |

**Recommendation: ship persistence first, on its own.** It is self-contained, it
is what the owner described first, and the second toggle cannot be used until a
screen exists to use it on.

---

## 6. Questions only the owner can answer — ANSWERED 2026-09-14

**(1) → (c)**, **(2) → (a)**, **(3) → (a)**. All three recommendations were
taken. The future-day surface stays deferred to C1's mission day picker; the
missed day stays a miss and reads "done late"; a debt lives 7 days. See the
banner at the top of this file for the five places the build departs from what
is written below.

**1. Future check-off needs a screen showing a future day — none exists.**
Home is today-only (`use-today-mission.ts`) and mission history looks backwards.

- (a) a "Tomorrow" peek on Home — cheapest, and narrow;
- (b) a day picker on the mission, forward and back — the same control C1 wants
  for food history;
- (c) **← recommended** — defer future check-off until (b) lands for C1, and ship
  persistence now.

**2. When a carried item is finally done, does the day it was missed stay a miss?**

- (a) **← recommended** — yes. The missed day stays a miss; the late completion is
  recorded, shown ("1 done late") and earns no rate credit. This is the maximal
  reading of "did it late and did it on time must not render identically";
- (b) the missed day leaves the denominator like an excused skip, and the
  completion counts on the day it happened. Kinder, and a carried protocol would
  read better — but "late" and "on time" then produce the same number.

**3. How long does a debt live?** The supersede rule already caps most cadences at
the next occurrence; this is about items whose next occurrence is far away (every
14 days, or Mon-only).

- (a) **← recommended** — 7 days;
- (b) no cap beyond the next occurrence — a fortnightly item could carry 13 days;
- (c) 3 days — tightest; past that it is a fact about the protocol, not a task.
