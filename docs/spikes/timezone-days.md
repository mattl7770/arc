# Spike — automatic timezone handling (backlog **D4**)

**Status:** design proposal, no code. **Date:** 2026-09-14.
**Owner's ask:** *"way to note when days have timezone changes"* — and, asked whether it should be
automatic: *"Yeah this should work automatically, we will need to do more thinking on the subject to
make sure it works intelligently."* (`docs/backlog-2026-09.md:57`)

**Reserved migration:** `0053` (`docs/backlog-2026-09.md:70`). Re-check
`git ls-tree main -- db/migrations/` at merge — the backlog already records seven collisions in a
week.

**Depends on / sequenced after:** **B3**, the configurable day boundary
(`docs/backlog-2026-09.md:29`). Both edit the same function. §4 states the combined rule.

**Recommendation in one line:** **annotate the day, never re-attribute the rows** — detect the
offset change on foreground, record it in `0053`, show *"Timezone changed (UTC−8 → UTC+1)"* on that
day in the record, exclude the day from readiness baselines, excuse its skipped mission items, and
hand the Coach a single fact so it can reason about jet lag without a rule table.

---

## 1. What a travel day actually does to ARC today

Every "today" in the app is the **device's local wall clock**, read componentwise:

```ts
// src/lib/db/date.ts:7-12
export function todayISODate(now: Date = new Date()): string {
  const year = now.getFullYear();           // ← device local, whatever zone iOS is currently in
  ...
}
```

Nothing observes when that zone changes. `users.timezone` exists — `text NOT NULL DEFAULT 'UTC'`
(`db/migrations/0001_init.sql:54`) — and is **inert**: it is written by the Settings profile screen
(`src/lib/db/repositories/user.ts:52-54`) and read by nothing. `date.ts:5` says so out loud: *"When
a real user timezone lands in `users.timezone`, this is where it plugs in."* It never did.

iOS changes the zone by itself, typically within minutes of the phone attaching to a foreign
carrier. So the change is silent, automatic, and entirely invisible to ARC.

### 1a. The 20-hour and the 28-hour day

A calendar day that contains a zone change is **`24 + Δ` hours long**, where Δ is the offset change
(east is negative, west positive). London → New York (Δ = +5) makes a **29-hour day**; Los Angeles →
Chicago (Δ = −2) makes a **22-hour day**. The extremes are the date line: Sydney → Los Angeles
(Δ = +18) lets you live the same `YYYY-MM-DD` twice; Los Angeles → Auckland (Δ ≈ −19) skips a date
entirely.

What that breaks, concretely:

| Surface | Evidence | What happens |
| --- | --- | --- |
| The day itself | `daily_logs.date text NOT NULL **UNIQUE**` (`0001_init.sql:211`) | One row per calendar date, so a 29-hour day is *one* ARC day. There is no second row to hold the extra five hours, and there should not be — the day really was 29 hours. |
| Today's Mission | `generateMissionForDay(db, date)` (`src/lib/db/repositories/mission-generate.ts:343`) | Generated **once per date**. A 29-hour day gets one set of protocol items for 29 hours; a 19-hour day gets a full day's items and ends before the 21:00 ones come round. The short day's tail stays `status = 'pending'` → **missed**, and reads as a compliance dip that never happened. |
| The day cursor | `use-today-mission.ts` — `refresh()` compares `todayISODate()` to `dayRef.current` on every foreground | ~~**It can move backwards.**~~ **FIXED 2026-09-14** (`claude/fixes-sept`). A westbound landing rolled the clock back; `todayISODate()` returned yesterday; the hook silently switched to yesterday's mission and the next completion wrote onto yesterday. The day the user was looking at flickered backwards and work done in the brief "tomorrow" went out of view. The hook now routes through `forwardCursor` (below) — the cursor may SKIP a date but never rewinds. |
| The Coach's daily pass | `src/lib/ai/pass-schedule.ts:77-92`, `:100-113` | **Already hardened for exactly this**, and the comments name it: *"A clock rolled BACKWARD (timezone travel, a manual clock change) must not re-fire the day's pass"*, and `markPassRan` keeps the later of the two dates so *"a signal pass that ran after westbound date-line travel"* cannot rewind the cursor. |
| Automatic backups | `src/lib/backup/snapshot.ts:265-272` | Same defence, again by hand: *"A clock that has moved backwards (timezone travel, a manual set) would otherwise read as 'not due'"* → any non-positive age is treated as due. |

Two subsystems have already paid for this bug independently, each with a local patch and a comment.
That is the argument for modelling it once rather than a third time.

> **DONE, for the cursor half — 2026-09-14** (`claude/fixes-sept`). The guarded comparison is now a
> single function, `forwardCursor(stored, now)` in `src/lib/db/date.ts`, and all three sites route
> through it: `markPassRan`, `isBackupDue` (via the `forwardCursor(marker, now) !== now` idiom — "the
> clock has moved backwards since this was written"), and `use-today-mission.ts`, which never had the
> guard at all. It is generic over `YYYY-MM-DD` strings and epoch milliseconds, because those are the
> two things ARC cursors. Pinned in `db/day-boundary.test.mjs` §7 (a simulated westbound date-line
> day, an eastbound *skipped* date, both DST directions asserted NOT to count, and a source check that
> all three sites still route through it), `db/coach-pass.test.mjs` §1 and `db/backup.test.mjs`.
>
> This is §4(b)'s monotonic clamp, landed early and on its own. Everything else in this file — the
> `0053` table, the detection, the annotation, the baseline exclusion — is untouched and still
> sequenced after B3.

### 1b. A meal at 23:30 that is 02:30 at home

The row itself is **fine and should stay exactly as it is**:

```ts
// src/components/nutrition/log-sheet.tsx:155, :176
const [time, setTime] = useState(() => clockFromISO(new Date().toISOString())); // local HH:MM
...  date: todayISODate(),                                                      // local YYYY-MM-DD
```

Both columns are destination-local, and together they say something true: *this meal was eaten at
23:30 on 3 September, where the user was standing.* Nothing about that is an approximation.

What is wrong is everything **downstream that divides by a day**:

- `todayTotals(db, date)` (`src/lib/db/repositories/nutrition.ts:72-81`) sums `meals` by that `date`
  column, and `deriveReadiness` grades it against one day's target
  (`src/lib/home/readiness.ts:560-565`). A 29-hour day gets a 24-hour calorie target. The kcal band
  is symmetric and tight — `off > 0.3 → poor` (`readiness.ts:268-274`) — so a normal 24 hours plus a
  normal 5 reads as a blowout. **This is the sharpest quantified harm in the whole item: a ratio
  whose denominator is a day and whose numerator is a variable-length day.**
- The "day closed" gate is a bare local-clock hour — `now.getHours() >= NUTRITION_DAY_CLOSE_HOUR`
  (`readiness.ts:75`, `:564`; the constant is 20). On the 19-hour day, 20:00 arrives when only 15
  hours of eating have happened; on the 29-hour day it arrives with five hours still to run.
- "You ate late again" style reasoning compares a destination `time` against a distribution built at
  home. Nothing in ARC says that today's clock is not last month's clock.

### 1c. HealthKit samples carry their own instants; ARC rows carry a locally-stamped `date`

HealthKit samples are **absolute instants** (`startISO` / `endISO`). ARC re-derives a calendar day
from them at map time, under the device's **current** zone:

```ts
// src/lib/health/mapping.ts:112-118
export function localDayOf(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();   // ← today's zone, not the zone the sample was recorded in
  ...
}
```

HealthKit does carry `HKMetadataKeyTimeZone` on some sample types, but ARC never reads it —
`HealthProvenance` carries bundle id, product type, source name and the ARC-written tag, and nothing
else (`src/lib/health/types.ts`, consumed at `mapping.ts:90-107`).

Combine that with the sync strategy and you get a real defect, not a theoretical one. The sync is a
**trailing-window re-aggregation**: every pass recomputes the last 14 days
(`SYNC_WINDOW_DAYS = 14`, `src/lib/health/sync.ts:61`; windows built at `:83-91`) and upserts on a
deterministic day key:

```ts
// src/lib/health/mapping.ts:132-134
export function dayRawId(metricType: string, date: string): string {
  return `hk:${metricType}:${date}`;
}
```

So **the first sync after landing re-buckets the previous fortnight of samples into the new zone's
calendar days.** An HRV sample taken at 20:00 Los Angeles time on 1 Sept is `2026-09-02T03:00Z`; read
under UTC+1 it is 04:00 on the **2nd**. Consequences, in order of severity:

1. **History silently changes.** `hk:hrv:2026-09-01`'s mean is recomputed from a *different* set of
   samples days after the fact, and updated in place. Readiness baselines
   (`readiness.ts:368-372`) and every Coach correlation read those rows.
2. **A day can be orphaned.** `upsertWearableRows` (`src/lib/db/repositories/wearables.ts:129-160`)
   only INSERTs and UPDATEs — **there is no DELETE anywhere in the ingest path**. If every sample
   that used to fall on a day migrates off it, no row is emitted for that day and the **stale row
   from the previous zone is left standing**, now describing nothing.
3. It is *self-limiting*, which is why nobody has noticed: the window is 14 days
   (`sync.ts:148-153` clamps emitted rows to it), so the damage stops 14 days back from the trip and
   the earlier history is frozen at whatever zone it was last computed in. The sync header already
   claims *"timezone shifts all converge on the next pass"* (`sync.ts:16`) — they converge on a
   **new** answer, not the old one, and that distinction is unstated.

**The sleep window survives, and deserves credit.** Sessions are attributed to the local day they
*end* on (`mapping.ts:432`), split on >60-minute gaps (`mapping.ts:361`, `:404`), and the query span
starts at **noon** of the day before (`sync.ts:97-100`) for the documented reason: *"noon exists in
every timezone on every day; midnight doesn't under DST"* (`docs/wearables-subapp.md:139`). That
noon lead-in is a 12-hour cushion, so a transatlantic red-eye across the zone change stays one intact
session on the correct wake day. **It only fails past a 12-hour jump** — a Pacific date-line hop can
truncate the first night. That is a small, nameable limit, and it is the right limit to have.

### 1d. `body_metrics` has no `date` at all

`body_metrics` stores only a UTC `measured_at` (`0001_init.sql:299-301`) and is read through
`localDayUtcRange` (`date.ts:22-26`), which computes the UTC bounds of the *current* local day. The
codebase already knows the sharp edge here and documents it:

> `src/lib/db/repositories/logs.ts:86-96` — a backdated body reading is stamped at **local noon** of
> that day, *"so a LOCAL-day window read lands the reading on the intended day for any timezone"*,
> with the note that *"beyond ±12h local noon flips to an adjacent UTC date"*.

Same ±12h constant, arrived at independently. Three places in the app now reason about it
(`logs.ts`, the sleep noon window, `localDayUtcRange`); none of them knows the others exist.

---

## 2. Detection

### 2a. What the runtime can and cannot tell us

**Available:** `Date.prototype.getTimezoneOffset()` — ES5 core, present in Hermes, no Intl involved.

**Two traps, both load-bearing:**

1. **The sign is inverted.** `getTimezoneOffset()` returns **minutes WEST of UTC**: UTC−8 gives
   `+480`, UTC+1 gives `−60`. Store the **negation** (minutes *east*, so UTC+1 is `+60` and reads the
   way a human says it), and say so in the column comment. This is the same species of trap as the
   HealthKit percent fraction, which the codebase documents at length in both directions
   (`mapping.ts:190-195` inbound, `:636-644` outbound) and pins as a round-trip property test.
2. **The IANA zone name is not obtainable.** `Intl.DateTimeFormat().resolvedOptions().timeZone` needs
   `Intl`, which this runtime does not have — the codebase works around its absence repeatedly
   (`readiness.ts:398-401` *"`toFixed`, not `Intl` — Hermes has no `Intl`"*; `readiness.ts:379-383`
   hand-rolls thousands separators; `src/lib/protocols/cadence.ts:19`). `expo-localization` is not a
   dependency (`package.json`) and adding one is out of scope for this item.

**Therefore: ARC can know the offset, never the zone id.** Copy must say *"UTC−8 → UTC+1"*, never
*"America/Los_Angeles → Europe/London"*. That is a constraint, and it is also honest — the offset is
what actually moved the day boundary.

### 2b. Where to sample

**Foreground, and nowhere near a write path.**

- **Primary: the existing `AppState 'change' → 'active'` hook.** Two already exist
  (`src/lib/health/sync.ts:408-425` `registerForegroundHealthSync`, `use-today-mission.ts:101-106`).
  Add one `observeTimezone(db, now)` call alongside `syncHealthIfEnabled` in the boot/foreground path
  in `app/_layout.tsx`. A phone that changed zone gets foregrounded within minutes of landing.
- **Free second signal, zero cost:** `use-today-mission.ts:92-99` *already* compares
  `todayISODate()` to the cached day on every foreground. A **backwards** day change is only
  explicable by a clock or zone change — that is precisely the reasoning `pass-schedule.ts:100-113`
  encodes for the Coach cursor. Call the observer there too.
- **Not on every write.** Reading the offset is free; *recording* it is a DB write, and writes happen
  in loops — a 14-day sync pass writes hundreds of `wearable_data` rows (`sync.ts:333`). One
  observation per foreground is enough: an offset change that nobody is awake to see is still caught
  the next time the app opens, and what gets recorded is the change, not the observation.
- **`todayISODate()` stays pure.** It is called from ~60 sites across `src/lib`, `src/hooks` and
  `app/`, and is on the render path of every screen. It must never acquire a side effect.

### 2c. Classifying the change — and the rule that keeps DST out

An offset change is either **travel** (the zone itself changed) or **DST** (the same zone's own
annual shift). DST must *not* mark a day. Without `Intl` or tzdata there is no zone id to compare —
but there is an exact, dependency-free probe:

> **The January/July probe.** For the year of the observation, compute
> `jan = offsetOf(new Date(year, 0, 1))` and `jul = offsetOf(new Date(year, 6, 1))`. These two
> values *are* the device's current zone's standard and DST offsets (in either order — the southern
> hemisphere reverses them). If `jan !== jul` **and both `fromOffset` and `toOffset` are members of
> `{jan, jul}`**, the change is a DST transition **within one zone**. Otherwise the zone changed.

It is exact for every real case:

- `America/Los_Angeles`, spring forward: `jan = −480`, `jul = −420`; change `−480 → −420`; both in
  the pair → **DST**, nothing marked.
- `Australia/Sydney`: `jan = +660` (DST), `jul = +600` (standard); change `+660 → +600`; both in the
  pair → **DST**. The probe treats `{jan, jul}` as an unordered set, so the hemisphere never matters.
- LA → London: `from = −480`, `to = +60`; after the move the device is in `Europe/London`, so
  `jan = 0`, `jul = +60`; `−480 ∉ {0, +60}` → **travel**.
- A one-hour hop into a zone with no DST (`jan === jul`, so the pair degenerates to one value) → any
  change at all is **travel**. This is the case a naïve "±60 minutes means DST" rule gets wrong.

The two residual misclassifications are both harmless: a flight between two zones that happen to be
exactly the device's own standard/DST pair annotates nothing (false DST), and a zone change occurring
in the same instant as a home DST change annotates a day that was going to be odd anyway.

**Naming.** ARC observed *the device's timezone changing*. It did not observe travel — a manual
Settings change and a flight are indistinguishable. Copy says *"Timezone changed"*, never *"You
travelled"*. That is the standing honesty rule, stated in the codebase as `readiness.ts:253` —
*"Not 'a rest day': ARC knows nothing was LOGGED, which is a different fact."*

### 2d. Where to record it — table (`0053`), not KV

**Proposed `0053_timezone_changes.sql`** (shape only; conventions per CLAUDE.md §9 / `0001_init.sql`):

```sql
CREATE TABLE timezone_changes (
  id text PRIMARY KEY NOT NULL,
  -- The instant the change was OBSERVED (ISO-8601 UTC).
  observed_at text NOT NULL,
  -- Minutes EAST of UTC — the NEGATION of getTimezoneOffset(). UTC+1 = 60,
  -- UTC−8 = −480. Stored this way so the number reads the way a human says it;
  -- the negation is the whole trap (see §2a).
  from_offset_min integer NOT NULL CHECK (from_offset_min BETWEEN -840 AND 840),
  to_offset_min   integer NOT NULL CHECK (to_offset_min   BETWEEN -840 AND 840),
  -- The local date under the OLD offset at `observed_at`, and under the NEW one.
  -- Equal in the common case; different when the change crossed local midnight.
  from_local_date text NOT NULL CHECK (from_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  to_local_date   text NOT NULL CHECK (to_local_date   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- 'travel' marks days; 'dst' is recorded and marks nothing (§2c). No 'unknown'
  -- bucket: the probe is total.
  kind text NOT NULL CHECK (kind IN ('travel', 'dst')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (from_offset_min <> to_offset_min)
);

CREATE INDEX timezone_changes_from_date_idx ON timezone_changes (from_local_date);
CREATE INDEX timezone_changes_to_date_idx   ON timezone_changes (to_local_date);
-- plus the house AFTER UPDATE trigger
```

The **last-known offset cursor** is a scalar and belongs in the `preferences` JSON blob, beside the
other machine cursors already there (`src/lib/db/repositories/user.ts:110-139`, `:118` *"machine
cursor"*). The first observation on a fresh install writes the cursor and **no** change row: you
cannot report a change you did not see.

**Why a table rather than KV-only** — the KV option is real, and `mapping.ts:74-79` makes exactly
that argument for dodging a migration (*"this feature is otherwise OTA-shippable; not worth a
migration"*):

1. `preferences` is a single JSON column read on **every Coach turn** (`turn-context.ts:72-73`) and
   on most screen mounts. Growing it without bound taxes the hottest read in the app.
2. Nothing in the record is a setting. A zone change is a **fact about a day**, and ARC's facts live
   in tables that export and backup already walk. In `preferences` it would leave the phone as an
   opaque settings blob — which is not "full data ownership" in any sense the owner means.
3. The query shape is `WHERE from_local_date = ? OR to_local_date = ?`, asked by every history row
   render, every baseline computation and every Coach turn. That wants an index.

At real cardinality (a frequent traveller: tens of rows a year) both work. The table wins on
principle, not on performance. **Fallback if `0053` is contested at merge:** the KV version is a
half-day and ships OTA; it loses points 1–3 and can be migrated into the table later.

### 2e. "The day this change happened", when it happens mid-day

This needs a rule, not a judgement call. Let `t` be the change instant, `o_old` / `o_new` the
offsets, and `D_old = localDate(t, o_old)`, `D_new = localDate(t, o_new)`.

> **Both `D_old` and `D_new` are marked.** The change belongs to the *seam* between two days, and the
> seam is exactly what a reader needs to see.

- **`D_old === D_new`** (the common case — an afternoon landing that does not cross local midnight):
  exactly one day is marked, and it is the day that is now `24 + Δ` hours long.
- **`D_new > D_old`** (eastbound over local midnight): the tail of `D_old` never happened. Both are
  marked; `D_old`'s annotation is what explains a day that ends early and a mission with unreachable
  evening items.
- **`D_new < D_old`** (westbound over local midnight — the clock stepped back into yesterday): both
  are marked, and this is the case where a date is **lived twice**. The annotation is what keeps the
  second pass through `D_old` from looking like a data anomaly.

The day's **length** is not stored — it is `24 + (o_new − o_old)/60` hours, derivable from the row.
Storing a derived number is how two sources of truth start.

---

## 3. Treatment — annotate, do not reinterpret

### 3a. The rule

1. **Every row keeps the `date` it was written with.** No backfill, no rewrite, no migration of
   existing data. Ever.
2. **The day carries an annotation** — one line, in the places a day is a thing you look at.
3. **The consumers that divide by a day become tolerant of one odd-length day.**

### 3b. Why re-attribution would be wrong

**The `date` column is not an approximation of anything — it *is* the record.** A meal at 23:30 in
London was eaten at 23:30 in London. Rewriting it to 14:30 on the previous day "at home" invents a
fact: the user was not at home and did not eat at 14:30. Worse, the row would then disagree with the
`time` column sitting next to it, which is also destination-local (`log-sheet.tsx:155`) — so you
would have to rewrite both, and the row would no longer describe any moment the user actually lived
through.

**Re-attribution is not computable from what ARC stores.** It would require re-deriving every row's
`date` from `created_at` plus a zone history — but `created_at` is only the event's instant for rows
written *as they happened*. Backdated rows are everywhere and are deliberate:

- `logs.ts:86-96` stamps **local noon** for a backdated body reading;
- `updateMealTime` (`nutrition.ts:464-472`) moves a meal's `date` on purpose, and the comment
  explains why the date moves with the time;
- `logWater(db, date, ml)` (`water.ts:94-105`) takes the date from the day picker — *"water here can
  be backdated onto the day being viewed"* — and `app/water.tsx:300` re-reads today specifically so a
  stale cursor *"can never backdate the new day's first glass"*.

A re-attribution pass would silently relocate every one of those, in an app whose data has exactly
one copy.

**The one place ARC already re-attributes is the bug, not the model.** §1c: `localDayOf` re-derives a
day from an instant under the current zone, so a fortnight of history gets rewritten after a trip.
The fix there is to re-attribute *less*, not more. The direction of travel is away from
reinterpretation, and re-attributing the manual rows would be walking into the trap the wearables
path is already in.

**A "home timezone" normalisation would make the product worse.** It would have Home answer *"what
should I do right now in Los Angeles"* while the user is standing in London. Home's one question
(CLAUDE.md §5) is *"what should I do right now"*, and "right now" is where the body is.

### 3c. What "tolerant" means, precisely

| Consumer | Evidence | Change |
| --- | --- | --- |
| Readiness baselines | `baselineBefore` (`readiness.ts:368-372`), 30-day window (`:31`), ≥5-day gate (`:33`) | **Exclude marked days from the baseline's denominator.** Still shown, still stored — they just get no vote on what "normal" is. On HRV a 29-hour day is a ~3 % perturbation of a 30-day mean; on `active_energy_kcal` and `steps` it is ~20 % inflation, and an airport day can be 3× the step count — and energy feeds the strain pillar's `energyRatio` (`readiness.ts:554-557`). One filter clause. |
| Nutrition pillar | `nutritionVerdict` (`readiness.ts:312-353`), `todayTotals` (`nutrition.ts:72-81`) | **`unknown` with the note "timezone changed today — not graded"** rather than a fabricated `poor`. This is the shape the function *already has* for a day still in progress (`readiness.ts:339-352`): a state where numbers exist but are not yet a verdict. Reuse it. (Owner question **Q2** — he may prefer a length-scaled target.) |
| Adherence / streaks | `accountForDay` (`src/lib/modes/registry.ts:307`), `excusesSkips` (`:283-296`, `mission.ts:485`) | **Treat a marked day as `excusesSkips`** — a skip on a travel day is the right call, not a miss. The mechanism exists and is already used for Travel / Sick / Social. **The annotation must NOT set the mode** (see **Q1**): recording a fact is not the same as declaring the user is travelling. |
| Trend windows | `localDaysList` (`date.ts:50-57`), `dailyIntakeSeries` (`nutrition.ts:104`), `waterDaySeries` (`water.ts:199`), `nutritionHistory` (`:648`) | **No change.** They yield exactly `count` points by construction, so an odd-length day cannot break the shape. Annotate the point; leave the arithmetic alone. A 29-hour day genuinely contained more water, and saying so is true. |
| Health sync | `localDayOf` (`mapping.ts:112`), `dayRawId` (`:132`), `upsertWearableRows` (`wearables.ts:129`) | **Out of scope for D4, and the defect should be written down** (§1c). It is a real, silent history rewrite, self-limited to 14 days. Test 10 in §6 pins the current behaviour so it cannot get quietly worse; a fix is its own backlog item. |

### 3d. Where it renders

One line, in the register of a calendar fact — not a signal colour. The codebase already says why,
and in this exact context:

> `src/components/home/mode-control.tsx:104-106` — *"`signal-*` marks biology, and 'today is a travel
> day' is a fact about the calendar, not about the body. The FIREWALL holds."*

Copy: **`Timezone changed (UTC−8 → UTC+1)`**. No icon, no exclamation, no "you travelled".

Sites: `app/mission-history.tsx:471-509` (the per-day rows), the `app/(tabs)/log.tsx` folio header
(`:66-80`), `app/nutrition-history.tsx`, and the day strip in `app/water.tsx:637-647`. Home gets it
only on the day it happens — see **Q3**.

---

## 4. Interplay with B3 (the configurable day boundary)

B3 makes the day roll over at a user-set local time (e.g. 04:00) instead of midnight. The rule, in
two sentences:

> **(a) The rollover is a LOCAL wall-clock time and moves with the zone** — on a travel day the day
> boundary travels with the user, at the destination's 04:00. There is no catch-up boundary and no
> double rollover.
> **(b) The resulting "today" is clamped MONOTONIC for writes:** it may skip a date (eastbound over
> the date line) but it never goes backwards.

Mechanically, (a) is free: B3 implements `todayISODate` as `localDate(now − rolloverHours)`, and
`getFullYear/getMonth/getDate` are already local, so the boundary follows the zone with no extra
code. Walk the cases with `rollover = 04:00`:

| Case | Before | After the jump | Result |
| --- | --- | --- | --- |
| Eastbound, mid-day (+8h at 14:00) | 04:00 already passed, day = D | 22:00, still past 04:00 | Day stays D. **Correct, nothing to do.** |
| Eastbound across the boundary (+8h at 01:00) | Before 04:00, so ARC is still on D−1 | 09:00, past 04:00 | Day advances to D. **Correct** — they are landing into a new day. |
| Westbound across the boundary (−8h at 09:00) | Past 04:00, day = D | 01:00, *before* D's 04:00 | Naïvely the day **regresses to D−1**. This is the case (b) guards. |

(b) is the generalisation of a rule the codebase had already written twice by hand:
`pass-schedule.ts` keeps the later of stored and current date for exactly this reason
(*"westbound date-line travel"*), and `use-today-mission.ts` was the same comparison **without**
the guard. **Landed 2026-09-14** as `forwardCursor` in `src/lib/db/date.ts` (§1a) — a monotonic
last-committed-day cursor, so the *implicit* "today" a quick-log writes to only ever advances.
**Reading** a past day stays free — the day pickers exist (`water.tsx:248`, and C1 asks for one in
nutrition) — it is the implicit write target that must not rewind. B3 inherits it rather than
hoisting it.

Two build constraints for whoever lands B3:

1. **B3 does not fix the long day, and should not try.** A 29-hour day really was 29 hours. What B3
   buys is a seam placed at a time the user is asleep; the annotation is what explains the length.
2. **The observer must call the app's one `todayISODate`**, never re-derive a local date. There are
   already three implementations of "local Y/M/D" in the tree — `date.ts:7`, `sync.ts:72-77`
   (a deliberate import-free copy), `mapping.ts:112` — and a fourth inside the timezone observer,
   computing the marked day differently from B3, is the obvious way this ships broken.

---

## 5. What the Coach sees

`buildTurnContext` already opens with `Current date: YYYY-MM-DD (Weekday)`
(`src/lib/ai/turn-context.ts:66-68`). Add **one line, only when there is something to say**:

```
Timezone: UTC+1 — changed today from UTC−8 (+9h east); this day's readings are excluded from baselines
```

and on the days after:

```
Timezone: UTC+1 — changed 2026-09-12 from UTC−8 (+9h east)
```

**Cost:** ~15–25 uncached tokens on a block billed at full rate every request. That is squarely
inside the budget this file already defends: the `Today so far` line is justified at ~35 tokens
because it removes a whole round-trip (`turn-context.ts:104-115`), and the grocery list is capped at
30 names for the same reason (`:37-43`).

**Emit only within 5 days of the change.** Jet lag's practical horizon is roughly a day per hour of
shift; beyond that the line is noise on every turn forever. The fact stays in the record, reachable
by tools. Mirror it into `get_today_snapshot`, where `mode` already rides
(`src/lib/ai/system-prompt.ts:106`).

**No rule table, and this is the point.** The Coach is given the fact and nothing else — no "if jet
lag then melatonin" ladder, no prescribed adjustment to training load. It already sees the readiness
pillars beside the fact, and it knows what a 9-hour eastbound shift does to a circadian rhythm better
than anything ARC could hardcode. This is the standing principle, stated at the top of the file the
line would be added to:

> `turn-context.ts:7-12` — *"It PERCEIVES and GROUNDS only; it never decides. What to do about a
> caution morning … is the model's judgment call."*

The one clause ARC *must* add is the baseline note. Without it the model sees a flat HRV trend across
a trip and explains it with something that is not true.

The parked **Modes revamp** (`docs/backlog-2026-09.md:62`) is the natural complement: a "Traveling"
quick-button that sends a canned prompt. The annotation is the **fact**; that button is the
**intent**. Neither should try to be the other.

---

## 6. Tests that pin it

Harness: headless Node + `node:sqlite`, `db/*.test.mjs`, run by `npm run db:test`
(`package.json:16`). New file: **`db/timezone.test.mjs`**.

**The hard constraint: the suite must stay independent of the host's timezone.** This is already an
explicit rule — `date.ts:19-20` avoids SQLite's `'localtime'` because it *"would read the machine
timezone and make the headless tests non-deterministic"*, and `docs/coach-intelligence-review.md:105`
defers an entire item because *"a JS local-day regroup makes the headless suite
timezone-dependent"*.

Therefore **the classification brain is pure over an injected offset**, never over `new Date()`:

```ts
classifyOffsetChange({
  fromOffsetMin, toOffsetMin,      // minutes EAST of UTC
  atInstant,                       // ISO
  januaryOffsetMin, julyOffsetMin  // the probe's two samples, injected
}): { kind: 'travel' | 'dst'; markedDays: string[] }
```

Same shape as `syncDayWindows` / `shouldAutoSync` / `clampRowsToWindow`, which exist in that form for
exactly this reason (`sync.ts:22-24`: *"pure and exported for the headless tests"*).

| # | Test | Asserts |
| --- | --- | --- |
| 1 | **Eastbound, mid-day.** −480 → +60, observed 14:00 old-local | `travel`; **one** marked day (`D_old === D_new`); derived length 15 h |
| 2 | **Eastbound across local midnight.** −480 → +60 at 23:00 old-local | `travel`; **two** marked days; `D_new === D_old + 1` |
| 3 | **Westbound across local midnight.** +60 → −480 | `travel`; two marked days; **and the monotonic clamp holds** — the write-target day does not regress. The regression test for `use-today-mission.ts:92-99`, unifying the `pass-schedule.ts:100-113` precedent |
| 4 | **DST spring-forward is NOT travel.** `jan −480 / jul −420`, change −480 → −420 | `dst`; **zero marked days**; and the autumn mirror (−420 → −480) |
| 5 | **Southern-hemisphere DST.** `jan +660 / jul +600`, change +660 → +600 | `dst` — the probe treats `{jan, jul}` as an unordered set, not "Jan is standard" |
| 6 | **A 1-hour hop into a no-DST zone is travel.** `jan === jul`, change ±60 | `travel` — kills the naïve "±60 means DST" rule |
| 7 | **Idempotence.** Same offset observed twice; and a first-ever observation | The second write is a no-op; the first writes the cursor and **no** change row |
| 8 | **Baselines exclude, do not delete.** 30 days of HRV, mark D−3 | `deriveReadiness`'s baseline equals the mean of the other 29 **and** the marked day's own point still renders in the metrics strip (`readiness.ts:662-671`) |
| 9 | **Nutrition pillar on a marked day.** kcal ratio 1.4 | `unknown` + the timezone note, not `poor` (`readiness.ts:312-353`) |
| 10 | **Wearable re-bucketing pins the §1c defect.** The same sample set mapped under two offsets | Every `source_raw_id` emitted by pass 1 is either re-emitted or documented as superseded. **This is the one test that needs a code change**: `localDayOf` (`mapping.ts:112`) reads the ambient zone, so it must take an optional offset — otherwise the test needs a child process with `TZ=` set, which is the thing the suite is not allowed to depend on |
| 11 | **The sign is the negation.** Stored `to_offset_min` vs `getTimezoneOffset()` | Same species as the SpO2 percent round-trip in `db/health-mapping.test.mjs` — a one-line assertion so nobody "tidies up" the sign later |

A small separate wiring check (that the observer reads `getTimezoneOffset` at all) may run in a child
process with `TZ` set, but **no rule may be pinned there**.

---

## 7. Alternatives and effort

| # | Option | Effort | Verdict |
| --- | --- | --- | --- |
| 0 | **Do nothing.** | 0 | **Rejected.** The owner asked, and §1's harms are silent: a trip reads as a compliance collapse, the calorie verdict is wrong for a day, and 14 days of wearable history are quietly recomputed. |
| **1** | **Annotate (recommended).** `0053` + foreground observer + day annotation + baseline exclusion + excused skips + one Coach line. | **~1.5 days** — migration + repo + observer + 4 render sites + Coach line + ~12 tests | **Recommended.** The smallest thing that makes the day honest, and it touches no existing row. |
| 1a | **Annotate, KV instead of a table.** Log in the `preferences` blob. | ~1 day, ships OTA | Viable fallback if `0053` is contested at merge. Loses export/backup visibility and taxes the hottest read (§2d). |
| 2 | **Stamp an offset on every row.** `tz_offset_min` on `meals`, `wearable_data`, `daily_logs`, `workouts`, … | 3+ days, every write path, several migrations | **Rejected.** Buys exact re-derivation the app would never use, and every write path becomes a chance to forget the column. |
| 3 | **Full IANA zone handling.** `expo-localization` + a tzdata library, real zone ids, home-zone normalisation. | 3–5 days + 2 dependencies + bundle | **Rejected.** A dependency, and a large one, for a name — and §3b argues the normalisation it enables is the wrong product. |
| 4 | **Re-attribute rows to a home zone.** | 2 days, irreversible | **Rejected** on §3b: invents facts, silently relocates every backdated row, no undo, one copy of the data. |
| 5 | **Leave it to the Coach.** No detection; the user says "I'm in London". | 0 | **Rejected as the answer** — the owner said *automatic*. Kept as a **complement**: the parked Modes revamp's "Traveling" quick-button is the intent; this is the fact. |

**Sequencing: after B3.** B3 owns `todayISODate`; this proposal's monotonic clamp and the
"rollover moves with the zone" rule are edits to the same function. Doing them in one pass is one
careful change instead of two that fight.

---

## 8. Owner questions

Three, with options and a recommendation each.

### Q1 — Does a timezone-changed day get *excused* like a Travel-mode day, or only annotated?

- **(a)** Annotate only. The day still counts toward streaks and adherence exactly as now.
- **(b)** Annotate **and** excuse that day's missed mission items, reusing the existing
  `excusesSkips` machinery (`registry.ts:283-307`) — **without** touching the mode.
- **(c)** Annotate and **auto-set Travel mode** for the day.

**Recommendation: (b).** (c) has ARC decide you are travelling, which it cannot know — a Settings
change looks identical to a flight — and Travel mode reshapes the plan and the Coach's tone, which is
a decision that should stay yours. (a) leaves a trip reading as a compliance collapse, which is the
complaint that will actually land.

### Q2 — On a marked day, does the nutrition verdict grade, go quiet, or scale?

- **(a)** Grade normally — a 29-hour day reads as a large overshoot.
- **(b)** Go `unknown` with *"timezone changed today — not graded"*.
- **(c)** Scale the target by the day's real length — a 29-hour day gets a 1.21× calorie target.

**Recommendation: (b).** (c) is the one place re-interpretation is arithmetically defensible, and it
is tempting — but it invents a target you never set, and C7 is already a full rework of this verdict
(*"it provides almost no value right now"*). Better quiet than clever, and (c) stays cheap to add
later on top of (b). Flagged because you may well prefer (c).

### Q3 — How visible should a timezone change be?

- **(a)** A quiet line on the day, in Log / mission history / nutrition history / water only.
- **(b)** (a) **plus** a one-time line on Home on the day it happens — *"Timezone changed (UTC−8 →
  UTC+1). Today is 15 hours long."*
- **(c)** (a) + (b) + the Coach opening its next message with it.

**Recommendation: (b), and only on the day itself.** Home is sacred (CLAUDE.md §5), but a 15-hour day
genuinely changes what *"do this next"* means, so one line earns its place for one day — and then
disappears. (c) is already covered by §5 in the right way: the Coach is handed the fact and decides
for itself whether the moment calls for mentioning it.
