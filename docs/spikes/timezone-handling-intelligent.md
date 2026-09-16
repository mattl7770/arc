# Spike — timezone handling, second pass: what "intelligently" should mean (D4 follow-on)

**Status: PROPOSAL, 2026-09-15 (rev. 3, after two reviews) — nothing built.** Read against `main` at
`0ae73ea`. The first pass is `docs/spikes/timezone-days.md` (**BUILT 2026-09-14**, migration
`0053`); this file is the "more thinking" the owner asked for on the day he approved it. It changes
nothing D4 shipped; it proposes what sits on top.
**Owner's ask:** *"Yeah this should work automatically, we will need to do more thinking on the
subject to make sure it works intelligently."* (`docs/backlog-2026-09.md:59`)
**Migration: one — `0059`, two nullable integer columns on `timezone_changes`** (§4). Head is
`0058`, next free `0059` (`docs/backlog-2026-09.md:72`); after the next TestFlight build the
forward-only rule is absolute again (`:89`). Everything else here is derivable from `0053`'s rows.
**Native modules: none new** — `expo-notifications` and `@kingstinct/react-native-healthkit` are
both in the binary (`package.json:36`, `:21`). A rebuild is already owed — backups and `0045`–`0058`
are not in the installed build (`backlog-2026-09.md:89`); §7 says which build carries what.
**Touches:** the parked **Modes revamp** (`backlog-2026-09.md:64`) — §3a uses the declared Traveling
window as a correction; §3b hands the revamp one open question.

**Recommendation in one line:** keep D4's rule — *annotate the seam, never re-attribute* — and add
the one thing D4 could not see: **the run of days between two seams.** Derive a *trip* from the rows
(closed by a return, by the user's own Traveling window, or by three weeks of stillness; with one
fact per row `0053` did not keep, the arrival zone's seasonal pair), let readiness baselines stand
on home days while the body is elsewhere, re-anchor reminders at the foreground that sees the
change, give the Coach the trip as a fact and one unattended turn, and stop the wearable history
from re-dating itself after a flight. No rule table; the one constant this plan adds is §9's.

---

## 1. What shipped, and what a trip does to it

### 1a. The record: one row per observed change, one or two marked days

`timezone_changes` (`db/migrations/0053_timezone_changes.sql:85-107`) holds one row per
**observed** change — `changed_at`, the two offsets in minutes east of UTC, and the logical day at
that instant under each; *"not per day and not per trip"* (`:16-19`). A DST shift writes no row
(`:41-59`); the cursor `lastOffsetMin` lives in `users.preferences`
(`src/lib/db/repositories/user.ts:308-324`) and moves for DST too (`day-meta.ts:98-102`). The
observer runs on the first database open and on every foreground (`day-meta.ts:71-76`;
`src/lib/db/client.ts:125`; `app/_layout.tsx:182`), compares the cursor to the **current** offset
only (`:91-96`), and classifies through `classifyOffsetChange` (`src/lib/timezone/classify.ts:142-159`)
using `zoneProbe` — **the device's current zone's** January/July offsets (`:54-67`), spread in at
write time (`day-meta.ts:104-110`). Two consequences this plan carries. **`changed_at` is when ARC
looked, not when the plane landed** (`0053:87-89`). And **an out-and-back trip with no foreground
abroad writes no row at all** — Los Angeles → London → Los Angeles with ARC unopened in London is
invisible to everything below. This plan does not fix that (§3a, §3e); e5 is the one source that could.

### 1b. The four consumers of a marked day

| Consumer | Evidence | What a marked day gets |
| --- | --- | --- |
| Readiness baselines | `src/lib/home/readiness.ts:713-729`, `:800-810`; wired `:855-859`, `:869`, `:938-941` | no vote in the HRV / RHR / energy means; the day's own reading still renders |
| Nutrition verdict | `readiness.ts:545-554` | `unknown` — *"timezone changed today — not graded"*, figures shown |
| Adherence | `src/lib/db/repositories/mission.ts:506-513` | excused, **without a mode** (`:498-504`) |
| The record and Home | `app/mission-history.tsx:232`, `app/nutrition-history.tsx:39`, `app/water.tsx:251`; Home `app/(tabs)/index.tsx:145`, `:174-176` | one mono `text-ink-muted` line; Home only on the day |

The Coach gets one uncached line for five days (`src/lib/ai/turn-context.ts:95-125`;
`TIMEZONE_COACH_HORIZON_DAYS = 5`, `day-meta.ts:52-57`), **measured at ~36 tokens** (the test
asserts under 40, `db/timezone.test.mjs:656-662`; `docs/project-status.md:43`). Its docblock names
the clause it must carry: *"without it the model reads a flat HRV trend across a trip and explains
it with something that is not true"* (`:96-101`) — a sentence about baseline behaviour that exists,
which is why §7 never ships a line ahead of the behaviour it describes. A marked day's **own
verdicts**: Sleep grades against absolute bands (`readiness.ts:913`), Recovery against the home
baseline (`:901-911`); only nutrition withholds (`:545-554`).

### 1c. What is not modelled: the days between

Every effect above is keyed to a **seam day**. On a nine-day trip, out on the 12th and back on the
21st, the 13th–20th are ordinary London days and nothing treats them differently from a Tuesday at
home. Correct for the mission and the nutrition verdict. Not for readiness: *during* the trip
today's HRV grades against home days (`readiness.ts:851-859`) and reads `caution` — true, and what
readiness is for. *After* the trip the 30-day window (`BASELINE_WINDOW_DAYS`, `:37`) holds eight
jet-lagged days with no marker, so for a month the home baseline is dragged down and post-trip
mornings read `optimal` against a depressed mean. That is the silent one. The Coach line has the
same blind spot: `recentTimezoneChange` (`day-meta.ts:236-250`) answers "a change in the last five
days", so on day six of a three-week stay the model reads a flat, low fortnight as a fact about the user.

### 1d. The day boundary under a changed zone — settled, with one case in two halves

The boundary is a local wall-clock time and moves with the zone (`src/lib/db/date.ts:44-57`;
`logicalDate` reads `getHours()`, `:168-177`); the write cursor is clamped monotonic (`forwardCursor`,
`:374-376`; `use-today-mission.ts:103-117`; `pass-schedule.ts:100-113`). The westbound Pacific case,
Sydney → Los Angeles, has two shapes. When the change does **not** cross the boundary there is
**one** marked day, the mission — generated once (`mission-generate.ts:606`) — runs 41 hours
(`dayLengthHours`, `classify.ts:200-202`), and Home says *"Today is 41 hours long"*
(`day-meta.ts:227-228`). When it **does** cross, the date is lived twice (`classify.ts:135-136`),
**two** days are marked (`:152-156`), and the length clause is deliberately suppressed
(`day-meta.ts:226`; *"no single number is true of either"*, `:211-215`). `scheduled_time` is the wall
clock by design (`0001_init.sql:237-239`), so afternoon items come round twice in both shapes.

### 1e. Reminders: two trigger kinds, a nine-hour hole, and two edge behaviours

Protocol-item nudges and one-off reminders are **absolute instants**: `{ type: 'date', date }`
(`src/lib/notifications/reminders.ts:356`, `:114-120`), the `Date` built componentwise in the zone
the phone is in at scheduling time (`protocol-reminders.ts:102-113`), and on iOS a countdown
(`node_modules/expo-notifications/ios/ExpoNotifications/Notifications/TriggerRecords.swift:96-111`).
A 07:00 magnesium nudge scheduled in Los Angeles fires at 16:00 London. Daily and weekly reminders
**float** (`DateComponents(hour:minute:)`, `TriggerRecords.swift:113-129`; `reminders.ts:99-107`).
The divergence lasts until the next reconciliation, which cancels everything and rebuilds
(`reminders.ts:303-366`, the cancel at `:319`) — at boot (`_layout.tsx:154`), on a rollover
(`use-today-mission.ts:116`), after a status write (`:147`, `:157`) and after a Coach turn or a
reminder tick (`app/(tabs)/coach.tsx:134`, `:141`, `:148`). **Not** on the foreground that observes
the change: that listener runs the backup throttle (`_layout.tsx:173`), the observer (`:182`) and the drain (`:192`).

Three things §3c must live with. `syncReminderNotifications` has **no in-flight guard** and opens by
cancelling the whole OS schedule — two interleaved calls either double every nudge or drop them, a
race that already exists between `use-today-mission.ts:147` and `coach.tsx:134-148` (the drain is
guarded, `estimate-queue.ts:291-303`; so is the health walk, `src/lib/health/publish.ts:164-184`).
A **westbound** seam day can nudge **twice** for one pending item — the day is 32 hours and the item
is still owed. An **eastbound** re-anchor **drops** today's already-passed items rather than moving
them: both schedulers refuse a moment in the past (`reminders.ts:119`; `protocol-reminders.ts:145-147`),
so a 09:00 London landing removes the 07:00 nudge the old schedule would still have delivered at
15:00 London. The item stays on the mission; only the buzz goes.

### 1f. HealthKit: the re-window, the prune, and a night across a flight

The sync recomputes a trailing window — 14 days, stretched over any gap (`src/lib/health/sync.ts:73`,
`:127-138`) — as local-midnight days in the **current** zone (`syncDayWindows`, `:94-102`) with a
sample span from noon of the day before (`:108-111`). Sampled metrics and sleep bucket by
`localDayOf`, the current-zone calendar day (`src/lib/health/mapping.ts:143-145`), deliberately: the
upsert key `hk:<metric>:<date>` must mean one thing (`:119-126`) and ARC's day must match the Health
app's (`:127-130`); *"the fix is a re-bucket MIGRATION over the stored samples, not a read-time
change here"* (`:139-141`). Since 2026-09-14 the pass **deletes** buckets in its window it did not
reproduce (`docs/wearables-subapp.md:956-1003`; `wearables.ts:258-289`, the `DELETE` at `:286`);
what it did not close is *"the re-bucketing itself"* (`:1005-1009`). A night belongs to the local
day it **ends** on (`mapping.ts:463-498`); a westbound return moves every London night a day
earlier. HealthKit carries `HKMetadataKeyTimeZone` on some samples (`timezone-days.md:135-137`);
`provenanceOf` already parses `sample.metadata` for ARC's own tag and keeps nothing else
(`src/lib/health/healthkit.ts:490-498`; `HealthProvenance`, `src/lib/health/types.ts:26-40`).

### 1g. `body_metrics` — a third day rule, out of scope and named

`body_metrics` has no `date`; it is read through `localDayUtcRange`, built from the **current**
local clock (`date.ts:283-298`; the ±12h flip at `logs.ts:86-95`; `logs.ts:196`; `series.ts:20`),
and two body readers already disagree (`body.ts:43-58` vs `series.ts:136-158`; open at
`docs/project-status.md:660`). A 06:00 London weigh-in read from Los Angeles lands on the previous
day. §3e's `offsetAt` is what that deferred fix needs; it is its own change.

### 1h. What the Coach sees, and what it may do

The state block hands it one line and nothing else (`turn-context.ts:7-12`). The prompt tells it to
offer Travel mode on "traveling this week" (`src/lib/ai/system-prompt.ts:106`) and that today's plan
is its to reshape through `adjust_today` (`:109`). Tools already cover a trip: `set_mode` with
`from`/`until` (`write-tools.ts:1400-1417`), a dated `day_modes` row (`0026_day_modes.sql:23-33`);
`adjust_today` with `scheduled_time` on a move (`:1201-1234`); `set_reminder`; `update_protocol`.
The unattended pass fires once a day or for a new `watch` insight (`pass-schedule.ts:66-71`,
`:81-92`); a landing is neither. The brief is **not** a private channel: its top three headlines
(`src/lib/ai/insights.ts:879-895`) render on Home (`use-daily-brief.ts:19`; `index.tsx:141`), go
uncached on every turn as `Signals:` (`turn-context.ts:201`), and return from `get_insights`
(`read-tools.ts:1450-1454`).

### 1i. Where the parked "Traveling" status meets this

The Modes revamp is decided in shape and deferred: status quick-buttons on the Coach screen sending
a canned prompt, *paired with retiring the old Modes* (`backlog-2026-09.md:64`). The first spike
drew the line — the annotation is the **fact**, the button the **intent** (`timezone-days.md:485-487`)
— and the owner chose no automatic mode (`mission.ts:498-504`). This plan stays on the fact side
and uses the intent once, as a **correction** (§3a), which depends on the revamp keeping the status
*dated* as `set_mode`'s `from`/`until` are now; a stateless button leaves the derivation alone.

---

## 2. The owner's words

> **D4 | Automatic timezone handling** — *"way to note when days have timezone changes"*; asked
> whether it should be automatic: *"Yeah this should work automatically, we will need to do more
> thinking on the subject to make sure it works intelligently."* (`docs/backlog-2026-09.md:59`)

Everything D4 built is the "automatically". This file is the "intelligently", read as: a zone change
is the *start* of something, not a one-day event; and every adjustment must be explicable on screen.

---

## 3. What "intelligent" should mean — six options, and how they depend on each other

**3a (the trip) is a prerequisite for 3b's away-day baseline and for 3f's away-day line; and 3f's
away line depends on 3b's *behaviour*, not only on 3a's *fact*** — the line says the baseline stands
on home days, so the two ship together or not at all (§7, Phase 1). 3c, 3d, 3e and 3f's *landing
turn* — which needs only the seam day — are each separable.

### 3a. Multi-day trips — derive the run, store one fact per seam, let a declaration correct it

**The proposal.** A *trip* is a read-time view over `timezone_changes` and `day_modes`, computed by
an **unbounded** walk of all rows in `changed_at, rowid` order (tens of rows a year; a trip that
opened before a consumer's window still has to be seen, unlike `timezoneChangedDaysIn`,
`day-meta.ts:149-163`):

> A trip **opens** at any change while no trip is open; its home offset `H` is that row's
> `from_offset_min`. Every later row is a **leg**. It **closes** at the earliest of three things:
> a row `R` with `R.to_offset_min = H`, or whose arrival zone observes DST and counts `H` among its
> two seasonal offsets — a trip that leaves in PST and returns in PDT has come home; the day after
> a Traveling window's `until` that overlaps the trip — *the user said he is back*; or
> `TRIP_SETTLE_DAYS = 21` days after its latest seam with no further row — *ARC stops guessing
> "trip" and calls this place home*, and `H` re-seats to that seam's `to_offset_min`. Its **away
> days** are the days strictly inside it; §3b and §3f apply to those.

The declaration **closes** a trip and never **opens** one: a Traveling window with no row (Los
Angeles → Seattle, or an unobserved trip, §1a) makes no away days, because "away" here means the
body is under another offset, which is what readiness's exclusion is about. Where the declaration
and a return row disagree the earlier close wins — a return row is a fact; a later `until` ran over.

**Why the settle rule, and what it costs.** Two failures a rows-only rule cannot otherwise escape.
The first row ARC ever writes can be **inbound**: `observeTimezone` writes the cursor and no row on
its first observation (`day-meta.ts:102`), so a build first launched abroad — or a database restored
abroad, below — makes its first row a return leg, which opens a trip with `H` = the foreign offset
and, without the rule, never closes. The second is a **relocation followed by a later trip**: the
move opens a trip with `H` = the old home and every later trip is a leg of it. With the rule both
self-heal at day 22 and the second trip opens against the new home. What it costs: for those 21
days home days are excluded from the baselines and the Coach line says "away" at home — and a stay
longer than 21 days is called home from day 22, which is a guess. The declaration is the immediate
correction (a Traveling window ending on the landing day closes the trip that evening); test 13 pins both.

**The stored pair (`0059`).** The seasonal close needs the **arrival zone's** January/July pair —
what `observeTimezone` has in hand when it writes the row (`day-meta.ts:110`) and does not keep.
`0059` adds `zone_jan_offset_min` and `zone_jul_offset_min` (§4); the observer writes the probe it
just spread; a `NULL` pair closes on exact equality only. `tripsIn(db, from, to)` and
`currentTrip(db, today)` read **rows only**: no probe, no clock (`classify.ts:1-11`; `db/timezone.
test.mjs:24-38`).

**Considered and rejected: the read-time probe (no migration).** Threading `zoneProbe` into
`tripsIn` with a guard that applies the DST leniency only when `H` is in the current pair is right
only when evaluated from home. Under the settle rule the defect is small: a March trip that returns
in PDT and is read from London in June does not close on the return row, closes 21 days later by
stillness, and the June trip opens correctly — the wrong answer is confined to the 21 home days
after the March return, read from abroad, by then outside every 30-day window. It is still an
answer that changes with where you read it — the defect the trip exists to remove, and the record
screens read past windows. The pair is an observation nothing else records, which is why it may be
stored and the trip may not (`classify.ts:138-140`). Kept as §9 Q1(b), cost attached.

**Observation lag, priced for the trip.** `changed_at` is when ARC looked (`0053:87-89`). A landing
at 22:00 with a first foreground at 05:00 puts the seam on the next logical day: the real first
away day is unmarked and graded as home, and the settle count starts hours late. The same lag
already decides D4's marked day; the trip inherits it and adds nothing (§8 item 2).

**Restore in another zone.** The cursor rides inside the ARCB1 snapshot (`user.ts:308-324`;
`docs/backups-subapp.md:148-182`), so a database restored in a different zone synthesises one row on
the next launch's observation (`client.ts:125`). That row is a true statement — *between the
snapshot's last observation and now, the offset changed* — dated at the relaunch, which is what a
`0053` row means (`:87-89`). It stays: an outbound leg if taken at home and restored abroad, a
return if the reverse; the settle rule bounds either (§8 item 9).

**Also rejected.** (i) *An explicit home offset in Settings* — `users.timezone` is a free-text label
nothing reads (`user.ts:304-306`; `date.ts:63-64`); a control set once before a move makes every
later day "away", and the settle rule plus the declaration cover the case it was held for. (ii)
*The modal offset over 90 days as home* — home DST writes no row, so half a year at home reads as
away. (iii) *Marking every trip day* — clutter. (iv) *A `trips` table* — a second source of truth.

### 3b. Readiness during and after a trip — baselines on home days, verdicts as they are

| # | Option | Verdict |
| --- | --- | --- |
| b1 | **Seams only** (shipped) | The month after a trip grades against a depressed baseline (§1c). |
| **b2** | **Exclude away days from the metric baselines.** Today still grades against them; the pillar note names the cohort | **Recommended.** `baselinePoints` takes an excluded set (`readiness.ts:713-719`); the away set unions into `oddDays` at `:857`. A baseline is *"a claim about what a normal day looks like for this person"* (`:700-702`). |
| b3 | Damped: away days weighted 0.5 | A constant nobody can explain on screen; a clinical rule wearing arithmetic. |
| b4 | A separate travel baseline from away days | Needs five away days, so a four-day trip never gets one. |
| b5 | Exclude the first `min(shift hours, 5)` days after each seam | A claim about **how fast this body adapts**, hardcoded per day into cohort membership. |
| b6 | **Withhold the seam and away days' own Sleep/Recovery verdicts** (`unknown` + note, as nutrition does at `:545-554`) | **Rejected, and put to the owner as Q2(c).** Nutrition withholds because its denominator — a 24-hour target — is wrong on a 29-hour day. Sleep and HRV are absolute readings of the body: four hours on a plane is a reason to back off *because* it was four hours. The verdicts stand; the note says why they read as they do. |

**The standard, applied to b5 and to the settle rule alike.** Both are constants that decide which
days count as normal. b5 encodes a rate of physiological adaptation — the model's domain, and the
reason it is rejected. `TRIP_SETTLE_DAYS` encodes **where ARC says home is** when rows alone cannot
tell a long stay from a move — a definition ARC must pick to compute anything, in the family of
`BASELINE_WINDOW_DAYS = 30` deciding what "recent" means (`:37`), not of the Coach's 5-day horizon,
which only gates what the model is told (`day-meta.ts:52-57`). The concession: on day 22 of a 30-day
stay the baseline starts admitting London days and the Coach stops hearing "away". The model sees
the day count on every away-day turn (§3f) and reasons about adaptation itself; Q2(a′) refuses the
constant, which leaves a relocation's stale `H` to the declaration alone.

**Scope of "every baseline".** b2 reaches the HRV, RHR and active-energy means (`:858-859`, `:869`)
and the evidence gate (`:938-941`). It does **not** reach `setsBaseline` (`:877-882`), computed
inline from `priorSessions` with no excluded set: only trained days have a row, and a trained
travel week contributes sessions that were real. Named as the exception rather than claimed.
**The evidence gate:** a trip under 21 days leaves at least nine home days in the window *if there
is a reading on every home day* — `dailyMetricSeries` yields points only where rows exist
(`wearables.ts:392-421`), so wearable gaps can fall under `BASELINE_MIN_DAYS = 5` (`:39`) inside a
trip. `baselineDaysRemaining` (`:800-810`) gains one clause, *"needs 3 more home days — paused while
away from UTC−8"*. Never let a number sit still unexplained.

**After the return.** Away days stay excluded while they sit in the window, so post-trip mornings
grade against pre-trip home days until new ones arrive. The pillar note says which cohort — *"12%
below your 30-day baseline (home days)"* — in the **serif** voice the notes already use
(`src/components/home/readiness-strip.tsx:145-149`), only while an away day is in the window.
**Not touched, stated once:** the nutrition verdict grades away days normally (a London day is 24
hours); trend windows stay fixed-length (`:708-711`); and **adherence on away days counts** — the
timezone excusal is the seam day's only (`mission.ts:511`), an away day's skip under Normal is a
miss (`:537-541`), and only a mode that `excusesSkips` moves it out of the denominator
(`excusedDatesIn` `:506-513`; `missionOwed = planned − excused`, `:520-522`). An `adjust_today`
skip is a skip, not an excusal. What excuses a travel-day skip once Modes are retired is the
**revamp's** open question, not this plan's answer.

### 3c. Reminders — re-anchor at the foreground that sees the change, without the race

**The proposal.** A small orchestrator, `src/lib/timezone/foreground.ts` — `onForeground(db, now,
deps)`: run `observeTimezone`; when it returns a row (`day-meta.ts:91`), call
`deps.syncReminders(db, now)`; return the row. **Restated against the file:** there is no timezone
listener in `app/_layout.tsx` — the observer rides the backup's subscription (`:171-194`, *"rides
this subscription rather than opening a fourth"*, `:175-176`), which also runs `autoBackupIfDue`
(`:173`) and the estimate drain (`:192`). So the edit is **not** a swap: `onForeground` gets its
**own** `AppState` subscription registered **above** `registerForegroundHealthSync` (`:164`), and
`observeTimezone` leaves the backup listener; the backup and the drain do not move. The row then
exists before the health listener (`sync.ts:478-489`) computes its windows (§3e's trap). This runs
only on the handful of foregrounds a year that return a row.

**Two behaviours named, neither hidden.** Westbound, a still-pending item is nudged **twice** —
the day is 32 hours and the item is owed. Eastbound, today's already-passed items are **dropped**,
not moved (§1e): the 07:00 magnesium is on the mission and in the Coach's `Today so far`, and the
landing turn (§3f) is where "you still owe the 07:00" gets said if the model thinks it worth saying.
Rejected: re-scheduling passed items for "now + 5 minutes" — ARC deciding to nudge for an item the
user may have taken on the plane. Test 17 pins both.

**The guard, owed regardless.** `syncReminderNotifications` gains a module-level in-flight promise
plus a `rerunRequested` flag: a call arriving mid-pass does not join it (the running pass has already
read the reminders; joining would drop the caller's change) and does not start a second; it schedules
one trailing run after the current one settles — `publish.ts:164-184`'s shape with a coalescing tail
instead of a join. It fixes the existing race and the one §3c would make deterministic: an eastbound
overnight landing is also a rollover, which fires `use-today-mission.ts:116` on the same AppState
event. The notifications seam becomes a parameter, as `publishBodyMetrics` takes `deps`.

**Why automatic rather than asked.** ARC already re-anchors on the next unrelated sync; the choice
is "local time now" or "local time at some unpredictable later moment", and daily reminders already
float. **Where the intelligence lives:** a 21:00 melatonin on the first London evening is 13:00 for
the body, and the Coach — which sees the trip (§3f) and can move the item (`write-tools.ts:1224`) —
decides. **Rejected:** ask on Home each time (per-reminder home-time storage no other kind has);
hold home time for the first day (a magic number that fires the 07:00 anchor at 16:00 on the day it
matters most); a gradual shift (a rule table, `turn-context.ts:7-12`).

### 3d. The day boundary in the new zone — keep it, say so, and retire the dead field

At the destination's 04:00: the B3 × D4 rule as pinned (`date.ts:44-61`; `db/timezone.test.mjs`
§11), and right on the merits — Home's question is *"what should I do right now"* where the body is
standing. A **home-zone boundary** (`logicalDateAtOffset` at the home offset, `date.ts:210-220`)
makes Home answer for a zone the user is not in; a **body-clock boundary** is a clinical rule and an
unpredictable filing rule. What changes is copy, and one field. Settings › Profile carries a live
free-text **Timezone** input (`app/settings-profile.tsx:179-192`) directly above **Day starts at**
(`:198-213`); nothing reads it (`user.ts:304-306`; `date.ts:63-64`). Adding "this follows the
phone's zone" under a field that appears to set the zone makes the screen contradict itself, so the
field is **retired in the same change** (the column stays) and the serif line under *Day starts at*
(`:214-219`) gains the sentence.

### 3e. Wearable day attribution — bucket a sample under the zone it was lived in

| # | Option | Cost | Verdict |
| --- | --- | --- | --- |
| e1 | **Status quo, pinned.** Current-zone re-bucketing plus the prune; add the offset-parameter test (the first spike's test 10, still open — `timezone-days.md:28`, `:526`; `wearables-subapp.md:1008-1009`) | ~half a day | History re-dates by a day on big shifts and flips back on return. The test is owed regardless. |
| **e2** | **Bucket by the offset in force at the sample.** `offsetAt(rows, instant)` is a pure **three-branch** step function over the `0053` rows: **before the first row, `rows[0].from_offset_min`**; between rows, the earlier row's `to_offset_min`; after the latest row, `null` meaning "use the live local getters" (DST-correct for the current zone); an empty table is `null` everywhere. `localDayOf` takes an optional offset and, given one, reads the calendar date at it through one new `date.ts` function beside `logicalDateAtOffset`; `syncDayWindows` and `sampleQuerySpan` take the same function | ~2 days + the one-time pass | **Recommended.** D4's rule applied to the one path that broke it — *"the one place ARC already re-attributes … is the bug, not the model"* (`day-meta.ts:12-14`). |
| e3 | **Freeze behind the seam.** The window never reaches back past the latest change's `from_local_date` | ~half a day | Loses the departure-morning night whenever ARC was not opened between waking and the zone changing. Fallback if e2 slips. |
| e4 | Stamp `tz_offset_min` on every wearable row | a migration, every write path | Records what e2 computes and does not decide the bucket. |
| e5 | **Read `HKMetadataKeyTimeZone` per sample.** The key is in the library's schema (`node_modules/@kingstinct/react-native-healthkit/src/generated/healthkit-schema.json:3537-3540`) and `sample.metadata` is already parsed (`healthkit.ts:496-497`), so widening `HealthProvenance` is a fixture and a line, no rebuild | ~half a day to read; **unbounded** to use | **Rejected for bucketing, explicitly.** The value is an `NSTimeZone` *name*; a name becomes an offset at an instant only with tzdata or `Intl`, which Hermes lacks (`classify.ts:24-29`), and a hand-rolled name→pair table is tzdata by another spelling that goes stale the year a country changes its rules. It buys **zone identity**, not an offset. Two things it could still do: flag an **unobserved** trip (§1a) as a string difference between neighbouring samples, and answer residual (i) by identity. Both deferred; §8 item 7 checks whether the Watch even stamps it on the sample types ARC reads. |

**The first-row branch is the outbound leg.** Sending instants before the first row to the live
getters — the destination zone on the commonest trip — would re-bucket every pre-departure sample
under +60 exactly as `localDayOf` does today, and the prune would delete what the re-dating
orphaned. `rows[0].from_offset_min` is in the table (`0053:92`) and is the zone those samples were
lived in, back to the home zone's previous DST change — before that an hour off, residual (ii)'s
class, reached only by a 90-day pass. Test 19 has the one-row case.

**What e2 promises, exactly.** Every night from the first e2 pass onward keeps the wake day it was
lived under, **for trips ARC observed**; an unobserved trip (§1a) has no row, `offsetAt` returns
`null`, and those days bucket as e1 does today. The rebuttal `mapping.ts:139-141` is owed: it asks
for *"a re-bucket MIGRATION over the stored samples"*, but ARC stores no samples — it stores
`hk:<metric>:<date>` aggregates (`wearables-subapp.md:965-966`); the only way to re-bucket is to
re-read HealthKit, which is what a sync pass is. **The one-time pass, and when it is empty:** `0053`
is not in the owner's binary (`backlog-2026-09.md:89`), so there are no rows yet. On the first e2
pass — keyed by a `rebucketedAt` key in `health_sync_state` (`0021_wearables_health.sql:98-110`; no
migration) — the window widens **only to the oldest row's `from_local_date`**, capped at
`FIRST_SYNC_DAYS = 90` (`sync.ts:75`). **No rows, no widening**: shipped in `0053`'s build, its first pass is e1.

**The day bounds under an offset.** For days after the latest row `syncDayWindows` keeps its
local-component arithmetic (`date.ts:32-42`). For days under a stored offset the bounds are UTC
arithmetic at that offset, and the destination's own DST shift, which writes no row, lands those
bounds an hour off for the rest of the stay — residual (ii), for the window as for the sample. The
seam day is `24 + Δ` hours by construction. `sampleQuerySpan` (`sync.ts:108-111`) starts at noon of
the day before the first window day **under that day's offset**. **The 12-hour limit the first
spike named** (`timezone-days.md:173-174`; `wearables-subapp.md:142-143`) is unchanged for days after
the latest row (the cushion is in the current zone, as now) and **narrowed** under a stored offset
(the cushion is in the night's own zone, so a date-line hop cannot shift it); what remains is the
seam night itself, bucketed by its end instant. e2 does not widen it.

**Residuals.** (i) *Observation lag*: samples in the gap bucket under the old offset, inside the
marked seam day. (ii) *DST inside a foreign zone*: an hour off for that stay; only samples within an
hour of midnight can change day, and no wake reading is. (iii) *The upsert key*: a frozen day and a
re-bucketed seam day collide only at the seam, where the seam day owns the key. **The cost to name
plainly:** e2 breaks the mirror rule at `mapping.ts:127-130` for trip-adjacent days — ARC's steps for
the 11th stay the Los Angeles sum while the Health app, if it redraws history in the current zone,
shows the London sum until he is home. A change to a documented rule; §9's Q4.

**Rollback, and the loss surface.** The prune's `DELETE` (`wearables.ts:286`) reaches `hk:` buckets
only — manual rows are never touched (`wearables-subapp.md` §16, rule 1) — and HealthKit keeps the
samples, so nothing e2 does is unrecoverable. "Undo e2" is: revert the code, clear `firstSyncedAt`
in `health_sync_state` (`syncWindowDays` returns the 90-day window when it is null, `sync.ts:127`),
and let one pass re-bucket under e1; or restore the ARCB1 snapshot §7 requires. **The ordering:**
Phase 2 gives the observer its own subscription ahead of the health one (§3c); Phase 3 also makes
the pass self-sufficient — `syncHealthData` calls `observeTimezone(db, now)` before it windows
(`sync.ts:231-234`), a third sanctioned site beside `day-meta.ts:71-76`, throttled to one per 15
minutes (`:79`). Test 20 asserts the pass, not the subscription order. **Considered and rejected:
the zone id (`expo-localization`)** — 3–5 days plus two dependencies (`timezone-days.md:542`) for an
exact home test `0059`'s pair already gives and an `offsetAt` across a foreign DST change that a
*name* cannot give without tzdata (`classify.ts:24-29`). Same verdict as e5; §8 item 8 could reopen
both for free.

### 3f. The Coach — the trip as a fact, one unattended turn, no new tool, nothing in the brief

**The line, and its precedence.** `turn-context.ts:111-125` gains a second branch. On an **away
day** inside an open trip:

```
Timezone: UTC+1 — day 4 away from UTC−8 (left 2026-09-12, 9h east); readiness baseline is home days only
```

On a **seam day** — outbound, return, or any leg — the shipped line, unchanged, including its
*"excluded from baselines"* clause (`:122`). **Precedence, for the implementer:** a seam day prints
the seam line; an away day prints the away line **even inside the shipped five-day tail** — it
carries the seam fact (*left 2026-09-12, 9h east*), so the tail adds nothing it does not say; the
tail prints only after a trip has **closed**. Never both. ~37 tokens at 2.8 chars/token; ceiling 45.

**The landing turn.** `currentSignals` (`pass-schedule.ts:66-71`) gains a **second source** beside
the watch insights: `timezone-changed:<row.id>` for every row whose `from_local_date` or
`to_local_date` is today (the predicate at `day-meta.ts:132-139`). Keyed on the **row id**, not a
date: on a boundary-crossing seam both days see the same id, `markPassRan` stores it on day 1
(`:100-113`), and day 2 does not re-fire — once per seam by construction. The model decides whether
there is anything worth saying. **Nothing enters `computeInsights`** — the brief on Home is
byte-identical on the seam day, the `Signals:` line (`turn-context.ts:201`) and `get_insights` are
unchanged. Cost: one unattended call per leg. **The ordering it rides on, named:** `duePass` reads
the signal synchronously from the database (`pass-store.ts:84-90`) in `useCoachPassRunner`'s
AppState listener (`use-coach-pass.ts:36-40`), registered by a **later** effect (`_layout.tsx:227`)
than the boot effect (`:131`) that will hold `onForeground`'s subscription — so the row is written
before the pass reads. An ordering, not a structure, and **soft**: the signal is read from the row,
not from the frame, so a resume that reads first fires the landing turn on the *next* foreground,
not never. §8 item 5 checks it; test 22 asserts the signal comes from the row, not the observer.

**Considered and rejected: a `timezone-changed` insight with a `kind` the brief excludes.** The
precedent exists (`insights.ts:887-893` excludes `readiness`), but it widens `InsightKind` for a
signal that is not an insight, still lands in `get_insights` (`read-tools.ts:1450-1454`), and is
more machinery than a second source in a function that already returns a sorted list of ids. **What
it may do:** nothing new — every action a trip could want is a tool it has (§1h), all
confirmation-gated. Not added: a rule-driven "jet-lag pass"; a `get_trip` tool; a prompt bullet.

---

## 4. Data-model and migration impact

**One migration, `0059_timezone_zone_pair.sql`:** `ALTER TABLE timezone_changes ADD COLUMN
zone_jan_offset_min INTEGER CHECK (zone_jan_offset_min IS NULL OR abs(zone_jan_offset_min) <= 840)`
and the July twin — the arrival zone's two seasonal offsets, as `zoneProbe` returned them
(`classify.ts:62-67`; `day-meta.ts:110`). Nullable so `0053` rows from an earlier build stay valid;
readers treat an unordered pair and a `NULL` pair as "equality only". Validated by `npm run
db:validate` and test 13. Takes `0059` and no other number; renumbers at merge if anything lands first.

**Why a column and not the `kind` column `0053` rejected** (`:53-59`): a DST ledger is a filter
every reader can forget; a pair on the row is read by one function and forgotten by none. **Not
taken:** a home offset in preferences; a `trips` table (both §3a). `rebucketedAt` lands in
`health_sync_state` (no migration); `users.timezone` stays inert and its field goes (§3d); e2's
calendar-day-at-offset is one function in `date.ts`, and the source scan in `db/day-boundary.test.
mjs:401-431` bans a hand-rolled `Y-M-D` anywhere else. The trip reads `day_modes` (`0026:23-33`) as
it stands; if the revamp retires that table, `tripsIn` loses one branch.

---

## 5. Coach impact and token accounting

The two ceilings guard the **cached prefix**: tool schemas under 9,250 (measured 9,241, nine of
headroom) and the static system prompt under 3,700 (measured 3,668, thirty-two of headroom)
(`db/coach-eval.test.mjs:807-822`, `:650-654`). This plan changes **neither**: no tool added or
widened, no prompt bullet. Delta: **0 / 0**, asserted by re-running the eval unchanged. What it
spends is **uncached**, in one place: the timezone line is ~36 tokens on seam days and the five-day
tail (`db/timezone.test.mjs:656-662`), zero otherwise; under §3f the away line is ~37 tokens on every
away day of an open trip, up to 21 per leg. The landing turn and the brief route add zero (test 22).

**Why the away line may outlast the 5-day rule.** The horizon exists because *"past that the line is
noise on every turn forever"* (`day-meta.ts:52-57`; `turn-context.ts:106-110`) — an argument about
the **seam** line, which reports an event whose relevance decays. The away line reports a **standing
state**: the readiness pillars on the same turn are graded against home days, and a model not told
that reads a fortnight of `caution` as a fact about the user (§1c) — the misreading the shipped
clause at `:96-101` exists to prevent, extended to the days it leaves uncovered. The state changes
every day (*day 4* → *day 5*), so it is not the same sentence re-sent, and it stops the day the trip
closes. If it reads as noise on a long stay, the fix is Q2's constant, not the horizon. A prompt cue
at `system-prompt.ts:106` to offer Travel mode on a `Timezone:` line would cost ~15 tokens against
32 of headroom; recommended against, and moot once the revamp retires Modes.

---

## 6. Tests to write

Headless, `node:sqlite`, `npm run db:test`. `db/timezone.test.mjs` pins `TZ` for the observer
sections and keeps the rules pure over injected values (`:24-38`); §12 is its last, so these are §13 on.

| # | Section | Asserts |
| --- | --- | --- |
| 13 | **Trips.** Out and back; out, leg, back; LA-winter → London → LA-summer closes on the stored pair; LA → Chicago stays open under every probe because none is read; the March-across-DST + June case is two trips; a `NULL`-pair row closes on equality only; **a first-ever row that is inbound opens a trip that closes at day 22 and re-seats `H` to home**; **a relocation followed by a second trip opens the second against the new home**; a Traveling window closes an open trip the day after `until`, and the earlier of a return row and `until` wins; a window with no row opens nothing; a trip that opened before the window is still seen | `tripsIn` / `currentTrip` over seeded rows and `day_modes`; the away-day set per case |
| 14 | **Baselines exclude away days.** 30 days of HRV, a nine-day trip | the HRV mean equals the home-day mean; each away day's own point renders; post-return grading uses pre-trip home days; the note says *home days* only while an away day is in the window; `setsBaseline` is unchanged |
| 15 | **The paused-baseline reason.** Four home days, then a trip; a home-day gap inside a trip | `baselineDaysRemaining` reports 1 and the reason names the pause; day 22 resumes; the gap case reports the honest count |
| 16 | **Re-anchor on observation, once.** `onForeground` with an injected `syncReminders` | called when and only when the observer returns a row; the rebuilt schedule yields the 21:00 item at 21:00 local; a date-line-skipped day's countdown is gone; two concurrent `syncReminderNotifications` calls never interleave and the final schedule matches the database |
| 17 | **The two seam behaviours are deliberate.** Westbound: a still-pending item after the first fire; **eastbound: a 07:00 item re-anchored at 09:00 local** | westbound: the rebuilt schedule contains it once, for local 21:00; **eastbound: the item is absent from the schedule and still pending on the mission** |
| 18 | **`localDayOf` takes an offset** (the first spike's test 10). One sample set under −480 and +60 | pins which buckets re-date under e1, so e2 is a diff against a known baseline |
| 19 | **e2: a night keeps its wake day.** London nights, the return row, the window re-run; **and the one-row case, samples on both sides of a single LA → London row** | every pre-seam session keeps its date in both cases; the seam day's bounds span its real length; the noon lead-in is under the first day's offset; the prune touches only the seam; **an empty table buckets as e1** |
| 20 | **e2's ordering and the one-time pass.** The pass with a fake HealthKit seam and a moved cursor; `rebucketedAt` unset with and without rows | the pass observes before it windows; **no rows, no widening**; rows present, the window reaches the oldest `from_local_date`, capped at 90 |
| 21 | **The Coach line during a trip.** Day 1 (seam), day 4, day 22, the return seam, five days after | trip framing on away days, **including inside the five-day tail**; the shipped seam line on seams; never both; gone at day 22; the tail only after a close; under 45 uncached tokens |
| 22 | **The landing signal, and the brief untouched.** A seam day; a boundary-crossing seam | `currentSignals` includes `timezone-changed:<row.id>` once across both marked days; `markPassRan` silences it; **the signal is present when the row is seeded directly, with no observer call**; `generateDailyBrief` equals its output with the row deleted; `timezoneHomeLine` is the only timezone string Home renders |
| 23 | **`0059` shape.** | the columns accept the pair, refuse ±841, accept `NULL`; `observeTimezone` writes the probe; **a restored cursor produces exactly one row on the next observation** |

Plus the standing assertions: `coach-eval.test.mjs` §6 at 9,241 / 3,668; `day-boundary.test.mjs` §5.

---

## 7. Phases, effort, and which build carries what

| Phase | Contents | Size |
| --- | --- | --- |
| **1 — the trip and the baseline** | `0059` + the observer writes the pair; `tripsIn` / `currentTrip` with the three closes; the away-day set through `deriveReadiness`; the *home days* note; the paused reason; **the trip-aware Coach line, in the same phase as the behaviour it describes**; tests 13, 14, 15, 21, 23 | ~2 days |
| **2 — the landing and the phone** | `onForeground` + its own subscription above the health one + the reminder re-sync + the in-flight guard; the `timezone-changed` signal source; the Settings field retired and the copy line; tests 16, 17, 22 | ~1 day |
| **3 — the wearable seam** | test 18 first; then e2 — the three-branch `offsetAt`, the offset parameter on `localDayOf`, offset-aware `syncDayWindows` / `sampleQuerySpan`, the pass observing first, the one-time pass; tests 19, 20 | ~2 days |
| **4 — the flight** | §8 | one trip |

Total about five days, none of it native. **Builds.** A snapshot cannot be taken on the installed
binary, because backups are not in it. Two sequences honour the gate; the plan recommends the first.
**(A) One build.** Build N carries the owed backlog, backups, and Phases 1–3. Phase 3's first pass
is a no-op on that build — `0053` lands with it, there are no rows, and no rows means no widening
and e1-identical buckets (§3e) — so the risk moment is not first launch but **the first sync after
the first observed trip**. The gate becomes: take an ARCB1 snapshot and exercise restore on build N
**before the first flight**, which the owner controls (§8 item 1). **(B) Two builds.** Build N
carries Phases 1–2 and the owed backlog; the owner takes and restores a snapshot on it; build N+1
carries Phase 3. Safer by construction, for a second EAS build. Either way §3e's rollback exists.

---

## 8. What only a device can settle

1. **A verified ARCB1 snapshot before the first trip on the build carrying Phase 3** — take one,
   restore it, relaunch (`docs/backups-subapp.md:148-182`); under §7(A) on build N before the first
   flight, under (B) on build N before installing N+1. The database has one copy.
2. **When the zone actually changes** — airplane mode, wheels-down, or first cell attach — decides
   residual (i)'s real size for the sample and the seam day; note the clock at landing against `changed_at`.
3. **Whether daily reminders truly float** (`TriggerRecords.swift:122`): a daily 07:00 fires at
   07:00 local on the first morning; a protocol nudge scheduled before §3c fires at home time; after
   Phase 2, an eastbound landing after 07:00 leaves no 07:00 buzz at all.
4. **Whether the Health app redraws history in the current zone** — screenshot a pre-trip day's
   steps and sleep before boarding, compare after. This decides whether e2's mirror cost is real.
5. **Both orderings on a real resume:** the observer's row is in the database before the health
   pass windows and before the Coach pass reads `duePass` — if the landing turn fires on the
   *second* foreground, that is §3f's soft dependency; the fix is to call `maybeRun` from `onForeground`.
6. **The doubled date**, if a Pacific trip happens: which of §1d's two shapes it was — one marked
   day with the 41-hour line, or two with no length clause — and the afternoon items coming round twice.
7. **Whether the Watch stamps `HKMetadataKeyTimeZone`** on the sleep, HRV and RHR samples ARC reads.
   If so, e5's deferred uses become a half-day each; if not, e5 is closed.
8. **Whether this SDK's Hermes resolves `Intl.DateTimeFormat` with a `timeZone` option.** The
   codebase says no (`classify.ts:24-29`); a yes closes residual (ii) and reopens e5 and the zone id.
9. **The restore row.** After item 1, if the restore happened in a different zone from the
   snapshot's last observation, one `timezone_changes` row appears at relaunch (§3a) — one, not one per foreground.
10. **The landing turn's tone** — calm and specific, or a jet-lag lecture; if the latter, the fix is
    the persona.

None of this can be simulated headlessly, and the suite must not try (`date.ts:275-278`).

---

## 9. Questions for the owner

Five. The day boundary (§3d) is settled and not among them. **Q2 presupposes Q1(a) or (b); Q3, Q4
and Q5 stand on their own.** Options §3 has already refuted are not listed as live.

### Q1 — What is a trip?

- **(a) Derived from the rows, with the arrival zone's seasonal pair stored per seam** (migration
  `0059`). Opens at a change; closes on return to the origin or its other season, the day after a
  Traveling window you set ends, or after 21 days of stillness. The same answer wherever read. **(Recommended)**
- **(b) The same without the migration**, reading the phone's current zone at read time. A return
  across a DST change closes 21 days late when a past window is read from a zone that does not share
  home's pair; current-day answers are unaffected.
- **(c) Your Traveling window is the trip; rows only mark the seams.** Exact when you declare it,
  nothing automatic when you do not — which your "automatically" rules out as the sole answer.
- **(d) No trip concept** — seams only, as shipped.

### Q2 — What does readiness do while you are away?

- **(a) Exclude away days from the HRV / RHR / energy baselines; the day's own verdicts stand.**
  Today still grades against the home baseline and the note says *home days*; a month after you
  return, the baseline is not dragged down. **Carries one constant: after 21 days somewhere, ARC calls it home.** **(Recommended)**
- **(a′) As (a) with no 21-day constant** — away for as long as the trip is open. A relocation, or a
  first row written abroad, then stays "away" until you set and end a Traveling window.
- **(b) Seams only**, as shipped.
- **(c) As (a), and also withhold the seam and away days' own Sleep and Recovery verdicts**
  (`unknown`, figures shown), the way nutrition already does.

### Q3 — What happens to reminders when the zone changes?

- **(a) Re-anchor to local time automatically**, at the foreground that sees the change. Westbound,
  a still-owed item may buzz twice; eastbound, an item whose local time has already passed is not
  buzzed today. The Coach may move any time-critical item. **(Recommended)**
- **(b) Ask on Home each time** — keep home time or switch.

### Q4 — Should wearable days stay as they were lived, even if that disagrees with the Health app?

- **(a) Yes.** A London night stays London's; a pre-trip day keeps the home sum; ARC and the Health
  app can disagree on trip-adjacent days. Gated on a verified backup before your first flight. **(Recommended)**
- **(b) No — keep mirroring the Health app**, so history re-dates on big shifts and flips back on
  return, and the pipeline only gains the test that pins it.

### Q5 — Should a landing wake the Coach once?

- **(a) Yes** — one unattended turn on the seam day, nothing added to the brief; the model decides
  whether to say anything. **(Recommended)**
- **(b) No** — the line in the state block on the next conversation is enough.
