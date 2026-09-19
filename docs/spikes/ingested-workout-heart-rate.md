# D3b — Heart rate from ingested workouts

**Status: BUILT — 2026-09-19** (branch `claude/hr`). Drafted 2026-09-15 and revised twice the
same day after review; §4's "Considered and rejected" records what each round changed. The
owner then answered all five of §7's questions **(a)**, so the recommended slice was built
exactly as written: Phase 1a (the ask), Phase 1b (the probe), Phase 2 (surface) and the twelve
tests. **Phase 3 — zones and the intraday table — was declined and is not in scope.** No
migration; the figure lives in the existing workout row's `metadata` JSON plus one new
`health_sync_state` KV key.

**The shipped spec of record is `docs/wearables-subapp.md` §18**, with the screen-side facts in
`docs/exercise-subapp.md` §11.4. This file is the plan, kept as written.

### Departures from the plan as written

1. **§3.5's Settings docblock count.** The plan said *"twelve identifiers read as six ideas"*
   becomes *thirteen and seven*. Both numbers were already stale when the plan was written —
   hydration (`DietaryWater`, 2026-09-14) had made it thirteen read-only identifiers in seven
   groups without the docblock being updated. Shipped as **fourteen and eight**, the true
   count, rather than inheriting the drift.
2. **§1's Coach budget figure.** The plan quoted *"last measured 9,241 of 9,250"* from a
   comment in `db/coach-eval.test.mjs`. Measured on `main` the number is **9,236** — the
   comment predates a later trim. Re-measured after this work: **9,236, unchanged**, confirmed
   by running §6 against `main`'s `read-tools.ts` and against the new one. Payload cannot touch
   the schema budget, and no tool description gained a sentence.
3. **§3.9 test 11's render assertion, half-delivered.** The Settings fixture gains the
   `workout_hr` row and its sentence is asserted, as planned. The *Read heart rate (90 days)*
   **control itself is not assertable headlessly**, and the reason is structural rather than an
   omission: it lives inside the connected plate, which under node takes the `!supported`
   ("Rides the next build") branch because there is no HealthKit module to report —
   `allowPublishing` has always been invisible to that suite for the same reason. Its whole
   *visibility rule* is pure and pinned instead (`unaskedReadScopes`,
   `db/health-mapping.test.mjs` §21), so what a device settles is whether the button is where
   it should be, not whether it appears when it should.
4. **`readWorkoutHr` is shared rather than duplicated.** §3.6 says both decoders "must learn
   `hr`". They learn it through one exported helper in `wearables.ts` (the lower module, so no
   import cycle), because two readings of "a usable figure" would agree right up until one of
   them was tuned — the same argument §3.9 test 9 makes about the two decoders.

### Verified against the installed library before building

`WorkoutProxy.getStatistic(quantityType, unitOverride?)` and `getAllStatistics()` exist on
`specs/WorkoutProxy.nitro.d.ts`; `queryStatisticsForQuantitySeparateBySource` exists on the
module and on `specs/QuantityTypeModule.nitro.d.ts`; `FilterForSamplesBase.sources?:
SourceProxy[]` exists on `types/QueryOptions.d.ts`; `SourceProxy.toJSON()` returns
`{ name, bundleIdentifier }`. All four as the plan describes them.

---

*(The plan as written follows, unchanged.)*

The half of D3 the owner
deferred — *"ship pairing now, add HR as a follow-up once pairing is observed working on
device"* (`docs/spikes/ingested-workouts.md:484-488`, answer 3a). Pairing shipped as `0054`;
the installed TestFlight build predates it — *"pushed 2026-09-15, not yet built — the next
build applies 0045 → 0058 in one go"* (`docs/project-status.md:5`) — and nothing else
reaches the phone (`expo-updates` is in neither `package.json` nor `app.json`).

**Backlog:** `docs/backlog-2026-09.md:58` (D3, *"HR deferred per the owner"*).
**Migration:** **none**; the figure lives in the workout row's `metadata` JSON, free-form
since `0021` (`0021_wearables_health.sql:66`). `0059` (above main's head of `0058`; never a
lower number) appears only on a yes to §7 question 4. **Native module:** none — one new
*read scope*, two `WorkoutProxy` methods and one module method already in the installed
`@kingstinct/react-native-healthkit@14.0.2` (`package.json:21`), two additions to ARC's own
module slice (§3.4). A read scope needs only `NSHealthShareUsageDescription`, which the
plugin supplies (`docs/wearables-subapp.md:890-892`); it reaches the phone in the next EAS build.

---

## 1. Current state

### A workout row carries duration, kcal and distance, and nothing about the heart

One `wearable_data` row per HealthKit workout (`src/lib/health/mapping.ts:623-643`):
`value` is HealthKit's duration in minutes, `source_raw_id` the HK UUID, `date` the local
calendar day the workout *ended* (`:627`), `metadata` exactly `{ activity,
activity_type_raw, kcal, distance_km, hk: { source } }` (`:635-641`). **Two readers decode
that blob, both reading named keys only:** `decodeIngested`
(`src/lib/db/repositories/workout-ingest.ts:85-115`), which every link read routes through
(`toPairedIngest`, `:311-322`) into `PairedIngest` (`src/lib/exercise/types.ts:135-148`),
and an inline parse in `recentWearableWorkouts` (`src/lib/db/repositories/wearables.ts:601-607`)
that builds `WearableWorkout` for the Data tab. No heart-rate field exists on either path.

### The seam discards the handle that carries the statistics, and its loop has no guard

`readWorkouts` (`src/lib/health/healthkit.ts:699-718`) calls `queryWorkoutSamples` through
the exclusion ladder (`withOwnWritesExcluded`, `:366-385`, which catches inside the query)
and then, at `:713-716`, hands every proxy to `parseWorkoutSample` (`:537-558`) with **no
try/catch of its own**. A throw there leaves `readWorkouts`; `syncHealthData` awaits it at
`src/lib/health/sync.ts:312` — before the upsert (`:386`), the cursor (`:405-414`) and the
log (`:448-452`) — and `syncHealthIfEnabled` swallows it (`:463-471`): the pass's rows are
discarded and Settings keeps the previous log, the inverse of the posture at `:14-19`.
There is no module-injection seam: under node `hk` is null and `readWorkouts` returns
`absentRead()` (`:593`) before its loop, which shapes §3.9's probe test.

### What the installed library can do — read off the source

**Door 1 — the workout's own statistics.** `WorkoutProxy.getStatistic(quantityType,
unitOverride?)` (`lib/typescript/specs/WorkoutProxy.nitro.d.ts:11`) runs
`self.workout.statistics(for:)` (`ios/WorkoutProxy.swift:181-194`) and serialises the
`HKStatistics` (`ios/QuantityTypeModule.swift:54-124`) as `QueryStatisticsResponse`
(`types/QuantityType.d.ts:13-24`) — average, maximum, `startDate`, `endDate`, `sources`,
**no sample count** — every `Quantity` carrying `unit: unit.unitString` (`:59-72`). **The
unit is decided by `getUnitToUse` (`ios/CoreModule.swift:20-37`), and with an override
supplied there are exactly two outcomes: the override, or a rejected promise** —
`parseUnitStringSafe` throws on a string HealthKit cannot parse, an incompatible override
throws `"Unit … is incompatible with quantityType …"` (`:21-29`), and the preferred-unit
branch (`:32-35`) is reached only with no override. A wrong override is loud on every
workout, never silently rescaled. HeartRate's canonical unit is `count/s`
(`generated/healthkit.generated.d.ts:283`); `count/min` is what `rhr` requests (`mapping.ts:198`).
It reports only samples the writer *associated* with the HKWorkout; absence is `undefined`.
**Both statistics methods are gated `if #available(iOS 16.0, *)` and return nil/empty
below it** (`:185`, `:199`); `app.json` pins no `deploymentTarget`.

**Door 2 — per-source statistics over the span.** `queryStatisticsForQuantitySeparateBySource`
(`ios/QuantityTypeModule.swift:309-330`) runs an `HKStatisticsQuery` over the same
`createPredicateForSamples(options?.filter)` the sample readers use (`:19-30`), always
`.separateBySource` with `discreteAverage` / `discreteMax` honoured (`ios/Helpers.swift:448`,
`:457-465`); the response is one `{ source, averageQuantity, maximumQuantity, … }` per
contributing source (`:185-200`; `types/QuantityType.d.ts:25-27`), the `source` a
`SourceProxy` hybrid (`ios/Serializers.swift:78-82`; `bundleIdentifier`,
`specs/SourceProxy.nitro.d.ts:4`) that `sourceRecord` already reads through `toJSON`
(`healthkit.ts:460-474`). Its unit goes through the same `getUnitToUse` (`:321-324`).
HealthKit does the arithmetic; ARC picks the workout's own writer in JS. **Door 3** —
`filter.workout`, ANDed at `ios/PredicateHelpers.swift:249-267` — is door 1's constraint as
a sample query and can never return more than door 1 averaged.

### Heart rate is not a read scope, nothing can ask for it, and the audit cannot speak for Garmin

`HEALTH_READ_IDENTIFIERS` (`mapping.ts:952-958`) has no HeartRate identifier.
`requestHealthPermissions` (`healthkit.ts:172-183`) requests that list; iOS presents a
sheet only for unanswered types (`:157-158`); its two call sites are `enable`
(`app/settings-health.tsx:166-185`), rendered only under `!enabled` (`:261`), and
`allowPublishing` (`:195-209`), rendered only while write access is undetermined (`:340`),
a shape the repo has been bitten by (`:187-193`). **Adding the scope to the list asks
nobody anything.** And `allowPublishing` is never a no-op only because iOS reports *share*
status truthfully (`healthkit.ts:186-193`); for reads *"Apple never reveals whether read
access was granted, so empty query results stay ambiguous"* (`:160-162`).

`METRIC_COVERAGE` (`src/lib/health/coverage.ts:69`) has no row for heart rate and its
tripwire (`:242-249`, asserted at `db/health-coverage.test.mjs:33-39`) refuses a scope
without one. Its docblock (`:5-12`) names the four causes of a blank a screen cannot tell
apart — (2) "the source never writes that type" is the one this table exists to state, and
`:14-17` records that a Garmin writes **no HRV at all**. **Nothing in the repository
establishes whether Garmin Connect writes heart-rate samples to Apple Health, at what
cadence, or whether it associates them** — `unverified` on day one (`:24-31`).

### The window, the pairing join, and what reads the session today

The workout upsert rewrites `metadata` on conflict (`wearables.ts:87-99`) only when
something changed (`CHANGED`, `:62-67`), so a later pass that finds heart rate for a
session that had none is one UPDATE, counted once in `rowsWritten`. But the steady-state
window is `SYNC_WINDOW_DAYS = 14` (`sync.ts:73`); the 90-day backfill runs only while
`firstSyncedAt` is null (`:131-133`, guarded for the reason at `:408-414`);
`get_training_summary` defaults to 28 days (`read-tools.ts:1088`, `:1094`) and
`recentWearableWorkouts` has no date filter (`wearables.ts:551-555`). Without a one-time
re-read roughly half of every surface this feeds would stay blank.

`0054` copies nothing (`db/migrations/0054_ingested_workout_pairing.sql:33-40`):
`pairedIngestFor` / `pairedIngestForMany` (`workout-ingest.ts:325-347`) join through
`LINK_JOIN_SQL` (`:307-309`); `getWorkoutDetail` (`src/lib/db/repositories/exercise.ts:199-219`)
and the recent-sessions read (`:434-455`) attach it as `ingested`. Pairing resolves two
recorders of one hour by `SOURCE_PRIORITY`, then the longer span (`:167-175`), the Data
tab's own order (`wearables.ts:567-573`); by inference from *"everything already linked is
excluded from both sides by the `NOT EXISTS` clauses"* (`:179-180`), a link made to a phone
row is not revisited when a better recorder's row lands later. Heart rate inherits that.

The Train hub's `ingestDetail` (`src/lib/exercise/format.ts:141-150`) joins `deviceLabel ·
kcal · distance` into one `watch` variable rendered at `app/exercise.tsx:562-565` **and
interpolated into the row's `accessibilityLabel`** at `:545-547` — whatever the string
says, VoiceOver speaks. Data › Wearables renders `WearableWorkout` (`wearables.ts:598-617`)
as a right-aligned `items-end` stack (`app/wearables.tsx:217-229`). The Coach's
`recentSessions` (`read-tools.ts:1108-1148`) selects no `w.id`, so it cannot be joined
through the link; `ingestedSessions` (`:1192-1206`) already carries `kcal` / `km`;
`:1143-1147` states the budget rule — result fields cost nothing against the schema, whose
ceiling is asserted at `db/coach-eval.test.mjs:814-822` and last measured 9,241 of 9,250 (`:807`).

---

## 2. The owner's words

> **D3 | Ingested workouts → training data [spec]** — … **auto-pair** an ingested session
> with a manually logged one by time, pulling calories and other data into the manual
> session. *"A topic to continue thinking on further."*

His answer to the spike's third question (`ingested-workouts.md:484-488`): **(a)** ship
pairing now, *"and add HR as a follow-up once pairing is observed working on device."* The
spike's own framing (`:347-354`): a scope, an audit row, a per-session query — *"Real work."*

---

## 3. Proposed design

### 3.1 Which figure: a stated precedence

Per ingested workout, in order, stopping at the first that yields a number:

1. **The workout's own statistics** — door 1, `getStatistic('HKQuantityTypeIdentifierHeartRate',
   'count/min')`: what the Health app prints under the workout, hence first. `method:
   'workout'`. No floor.
2. **The source's own samples over the span** — door 2, HealthKit's per-source average and
   maximum between `startDate` and `endDate` for the workout's own writer: the same
   exported samples without the association. `method: 'source'`. Floored: nothing is stored
   unless **at least `HR_MIN_SAMPLES = 6` of the span's first 48 samples were that writer's** (§3.4).
3. **Nothing.** No key is written; the line prints no heart rate. An absence is an
   absence, not a zero (`statisticDailyRows`, `mapping.ts:384-389`).

### 3.2 Where it lives: the workout row's `metadata`, no migration

```
metadata: { activity, activity_type_raw, kcal, distance_km,
            hr: { avg: 142, max: 171, method: 'workout' | 'source' }, hk: { source } }
```

Integers (bpm). `hr` absent means "not available" — never `null` members, never zeros, no
`samples` field: neither door returns a count, and the floor gates whether `hr` is written.
The alternatives are §4 F–H: columns on `workouts` break `0054`'s nothing-copied rule
(`0054:33-40`), and per-workout `wearable_data` rows put a per-session figure into a
per-(day, device) model built for day aggregates (`docs/wearables-subapp.md:116-118`,
`wearables.ts:387-421`). `metadata` is `CHECK (json_valid(…))` (`0021:66`); **both**
decoders read named keys and ignore the rest (`workout-ingest.ts:91-98`;
`wearables.ts:602-604`), and both must learn `hr` (§3.6). `hk.source` already lives in the
same JSON (`mapping.ts:640`): the established carrier.

### 3.3 Never a daily heart-rate bucket

`HKQuantityTypeIdentifierHeartRate` must **not** enter `SAMPLE_METRICS` (`mapping.ts:185`)
or `STATISTIC_METRICS`: a daily mean of all-day samples is a number with no meaning, and a
rest day and a race day would produce a row in the same table as `rhr`, one `metric_type`
string from a baseline. The scope is claimed by the *workout* path alone; the ingest-path
assertion (`db/health-mapping.test.mjs:766-783`) is extended by name, and `get_metric_series`'s
inventory (`read-tools.ts:108-117`, `:598`) has nothing to list — asserted (§3.9 test 6).

### 3.4 The seam

**Shape, and the injected probe.** `HealthWorkoutSample` (`src/lib/health/types.ts:67-79`)
gains an *optional* `hr?: WorkoutHr`, `WorkoutHr = { avg: number; max: number; method:
'workout' | 'source' }`. `parseWorkoutSample` stays pure and synchronous and never sets it.
The loop at `healthkit.ts:713-716` is extracted into an exported `collectWorkouts(items,
probe)` that parses, awaits `probe(item, parsed)` and spreads `hr` in when the probe
returned one; `readWorkouts` calls it, and that is what makes the probe testable without a
native module. The probe, `(proxy: unknown, sample: HealthWorkoutSample) =>
Promise<WorkoutHr | null>`, defaults to the two-door implementation (the `ownWriteExclusions`
precedent, `healthkit.ts:310-331`). Every native call inside it sits in its own try/catch and resolves to `null`, the first
error text kept for the log row as `readDailyCumulative` keeps a day's (`:682-687`); a
probe can never throw out of `collectWorkouts`. **The real failure mode is the loud one:**
a wrong override string rejects `getStatistic` for *every* workout (§1), door 1 is dead
for the whole feature, and `getAllStatistics` — no override, so it cannot fail on units —
keeps reporting *associated: HeartRate*. Only the log row's `error` text makes that
readable, so the log paragraph below and §6 treat a non-null `error` as the first thing to read.

**Door 1.** `getStatistic(HeartRate, 'count/min')`, parsed by a pure
`parseWorkoutHrStatistic(raw)`: `averageQuantity` and `maximumQuantity` through
`quantityValue` (`:415-417`), reading each `unit` — `count/min` as is, `count/s` × 60,
anything else → null; both or nothing. The installed library can only return `count/min`
or reject, so the unit branch guards a library change, as `durationSeconds` does (`:419-440`).

**Door 2.** `queryStatisticsForQuantitySeparateBySource(HeartRate, ['discreteAverage',
'discreteMax'], { unit: 'count/min', filter: { date: { startDate, endDate } } })` — a
date-only predicate; HealthKit splits by source. A pure `pickSourceStatistic(responses,
bundleId)` selects the response whose `source`, read through the `sourceRecord` path
(`:460-474`), has the workout's own `provenance.bundleId` (`types.ts:30`, read at
`healthkit.ts:494`); no match → null. Pinned against a mixed-source fixture, so a phone's
readings or a second wearable cannot enter a Garmin figure whatever any predicate did. The
module slice (`:72-120`) gains this signature. **`strictStartDate` is deliberately
omitted:** `readDailyCumulative` passes it so a sample straddling midnight is summed into
one day (`:671-676`); a heart-rate sample is a point, so overlap and strict coincide, and
for interval samples overlap admits one that began before the workout — negligible in a
time-weighted hour — where strict would drop every session's first reading.

**The floor's count, and what it actually counts.** One bounded sample query per door-2
session: `queryQuantitySamples(HeartRate, { limit: 48, ascending: true, unit: 'count/min',
filter: { date, sources: [proxy.sourceRevision.source] } })`, post-filtered in JS to the
workout's bundle id, then counted. `SampleFilter` (`healthkit.ts:66-69`) gains `sources`
(`types/QueryOptions.d.ts:45`). Said plainly: **the gate passes when at least six of the
span's first 48 samples were the writer's.** If the hybrid object fails the cast at
`ios/PredicateHelpers.swift:15`, `createSourcePredicate` returns nil (`:21`) and the
predicate collapses to date-only; the post-filter still holds, and a second writer would
then have to contribute 43 of the first 48 samples to withhold a figure. On a Garmin-only
setup the phone writes no heart rate, so the happy path does not depend on the cast; §6 confirms it.

**Which workouts, each pass.** Door 1 runs for every workout in the window, every pass,
with no skip set — deliberately: it is how a revised association lands, and the `CHANGED`
guard (`wearables.ts:62-67`) stays the arbiter of whether anything is written. Door 2 runs
only where door 1 answered nothing **and** the stored row has no `hr` (`sync.ts` passes
the UUIDs already carrying one — one `json_extract(metadata, '$.hr') IS NOT NULL` query). **No cap.** Steady state is the 14-day
window (`sync.ts:73`): at most two bounded queries per unanswered session in a fortnight,
sequential like the statistics loop (`healthkit.ts:649-653`); a session door 2 found
nothing for is re-probed each pass while in the window — how a late Connect export lands —
and frozen when it leaves it. The 90-day re-read (§3.5) is one tap, uncapped, complete: at
three sessions a day ~270 sessions and ~540 sequential round trips, the same order as the
360 statistics queries the first enable already makes; §6 measures the real count.

**Diagnostic.** Each pass, for the newest workout only, `getAllStatistics()` (`WorkoutProxy.swift:196-209`,
try/catch → null) contributes its identifier *names* — never its preferred-unit values (`:202`) — to the log row.

**The sync log** (`src/lib/health/log.ts:29-46`) gains one `HealthMetricLog` row: `metric:
'workout_hr'`, `label: 'Heart rate during workouts'`, **`returned` = workouts examined this
pass, `rows` = workouts that produced an `hr` key** — the direction the type declares
(`:33-36`) and Settings renders as `returned → rows` (`settings-health.tsx:438`, spoken at
`:427`, stated in the margin at `:497-498`); `exclusion: 'none'` (statistics carry no
own-write exclusion, `healthkit.ts:689-691`); `error` = the first probe error; `rejected:
null`; and a new optional `detail: string | null` — *"associated: HeartRate,
ActiveEnergyBurned · by workout 0 · by source 12"*. `parseSyncLog` re-derives every field
and drops unknown ones (`log.ts:111-114`, asserted at `db/health-mapping.test.mjs:1560-1573`),
so `detail` must be added to the parser or it never reaches the screen. It sits **beside**
the existing note: `metricNote` (`log.ts:183`) gains a `workout_hr` branch ahead of the
generic ones, because the generic error branch fires only when `returned === 0`
(`:184-188`) and this row's error arrives with `returned > 0`. The branch reads, in order:
a non-null `error` → *"Apple Health returned an error while reading heart rate."* plus the
text; `returned > 0 && rows === 0` → the declined-grant sentence of §3.5; then the `detail`.
Settings can then say *"31 → 0"* with the sentence that explains it — the failure §14 of
the wearables doc (`docs/wearables-subapp.md:768`) exists to make nameable.

### 3.5 The ask, the re-read, the scope, the audit row, the Settings line

**The ask is Phase 1, not a device question.** A new KV key `apple_health_scopes` under
`health_sync_state` — the no-migration pattern the publish cursor used
(`wearables.ts:658-666`) — holds `{ askedFor: string[] }`, stamped after every
`requestHealthPermissions()` that resolves true; a pure `unaskedReadScopes(stamp,
HEALTH_READ_IDENTIFIERS)` is pinned in a test.

**The control, and exactly when it shows.** Settings › Apple Health renders *Read heart
rate (90 days)*, modelled on `allowPublishing` (`settings-health.tsx:187-209`, `:340-363`),
while `enabled` **and either** something is unasked **or** the last `workout_hr` log row
has `returned > 0 && rows === 0`. Its tap: `requestHealthPermissions()`, stamp, 90-day
re-read. Honestly stated: on a fresh install `enable` stamps every scope and the control
never appears; on an existing install it appears once and iOS presents a sheet for
HeartRate only (answered types present nothing, `healthkit.ts:157-158`). It stays visible
after an ask that produced nothing, because that is the one state in which tapping again
can change something: if the owner declined the sheet, iOS will not re-present it, and
**the only recovery is Settings › Privacy & Security › Health › ARC › Heart Rate** — the
row's note says so, and after flipping it the re-read is one tap. It disappears once a
figure lands. Read grants stay unknowable (`:160-162`): the stamp records only that ARC *asked*.

**The re-read.** `syncHealthData(db, now, { windowDays })` gains an options argument
(today's signature is `(db, now)`, `sync.ts:220-223`); the control passes `FIRST_SYNC_DAYS`.
A `windowDays` override rather than clearing `firstSyncedAt`, whose re-stamp is conditional
on `written > 0` (`:414`) so a denied permission cannot burn the backfill — the cursor keeps
its meaning and its guard (`:408-414`). `lastSyncedAt` is stamped as on every pass
(`:405-406`), which only resets the elapsed-time widening at `:132-137` — harmless, the pass
just covered 90 days. It reuses *"Syncing 90 days…"* (`settings-health.tsx:303`).

- `HEALTH_READ_IDENTIFIERS` (`mapping.ts:952-958`) gains the HeartRate identifier, with a
  comment naming the workout path as its claimant.
- `METRIC_COVERAGE` (`coverage.ts:69`) gains a row: label *Heart rate during workouts*, use
  *the paired session's line and the Coach's training summary; never a daily figure*,
  `garmin: 'unverified'`, `verdictDays: null`, and a `garminNote` naming what was not
  checked — whether Connect writes heart-rate samples, at what cadence, whether it
  associates them — **ending: "A blank can also mean the read grant was declined — iOS
  never tells ARC. Check Settings › Privacy & Security › Health › ARC › Heart Rate before
  reading a zero as a Garmin fact."** The same sentence is the log row's note (§3.4).
- `SYNC_SCOPES` (`settings-health.tsx:98-110`) gains *Heart rate during workouts · In*, and
  its docblock's *"twelve identifiers read as six ideas"* (`:94-97`) becomes thirteen and seven.

**A phone with no watch.** Device choice is undecided (`CLAUDE.md` §8) and the owner's
phone may never have produced an HKWorkout. Then the scope is asked once, the control
shows once and never again, the `workout_hr` row reads `0 → 0` with the existing *"Nothing
recorded in this window."* (`log.ts:200-202`), the coverage row reads *Unverified*, and no
line on any screen changes — the footprint the `workout` row has had on such a device since `0021`.

### 3.6 What it feeds

**(a) The paired session's line.** `PairedIngest` and `IngestedWorkout` gain `avgHr` /
`maxHr` (`number | null`); `decodeIngested` (`workout-ingest.ts:85-115`) reads `hr.avg` /
`hr.max`. `ingestDetail` (`format.ts:141-150`) appends `avg 142 · max 171 bpm` after
distance — the plate's existing line, no new device, no accent, **no signal colour**: the
firewall (`00-design-spec.md:78`) marks biological *state*, and a bare 142 has no verdict.
**Two strings, not one:** `ingestDetail` gains a `{ spoken: true }`
variant — *"average heart rate 142, peak 171 beats per minute"* — and `exercise.tsx`
computes `watch` for the visible line (`:562-565`) and `watchSpoken` for the
`accessibilityLabel` (`:545-547`); today one variable feeds both. The editor, which loads
`WorkoutDetail.ingested` (`types.ts:211`, `app/workout-live.tsx:550-553`) and never renders
it, gains one mono line under the header with the display string when `editing`; the
filling-in line (`:1167-1172`) stays — it identifies the session.

**(b) The wearables list — its own line item.** The inline decoder in
`recentWearableWorkouts` (`wearables.ts:601-607`) learns `hr`; `WearableWorkout` gains the
two fields; the row's right column (`app/wearables.tsx:217-229`) gains a third mono line
`avg 142 · max 171 bpm` under kcal. Three lines deep in a `min-h-[44px]` row — 15 + 10 +
10 px with half-unit gaps clears the minimum on paper; §6 checks it.

**(c) The Coach — payload only.** `get_training_summary`'s `recentSessions` SELECT gains
`w.id` (one column, and the typed row) so `pairedIngestForMany` can run over the ten ids as
the hub list does (`exercise.ts:434-437`); rows gain `hr: { avg, max }` from the pair,
`ingestedSessions` rows the same. Omitted when absent, on the rule the file applies to
`away` and `setMetres` (`read-tools.ts:1139-1147`). **No sentence is added to the tool
description**: the fields are self-describing and the schema sits nine tokens under its
ceiling. The turn context carries the owner's age only when `users.date_of_birth` is set
(`src/lib/ai/turn-context.ts:54-61`, `:75-82`; nullable at `0001_init.sql:50`); when null
the model receives the numbers and *"profile not filled in"* (`:81`) — it knows it lacks
the age and can ask, which is the house rule (judgment in the model) rather than a
description sentence pre-empting it. If a transcript shows `max` misread as resting, one
sentence (~20 tokens) is paid for by the `get_metric_series` restatement
`coach-eval.test.mjs:809-813` already names. The self-review
(`src/lib/reports/assemble-self-review.ts:301-303`, no wearable row) and the doctor pack
take nothing: a period-average across walks, lifts and runs is not a figure a person can act on.

**(d) Training zones — the Coach interprets; ARC stores no zone table.** Zone minutes need
a threshold ARC does not hold, and a per-session *average* says almost nothing about time
in zone — fifty minutes averaging 142 could be forty at 135 and ten at 170; a deterministic
zone verdict from an average is the clinical decision the house rule keeps out of code.
`zone2Min`'s placeholder (`types.ts:215-222`) stays until §7 Q2 or Q4 says otherwise.

### 3.7 What it must NOT feed, and the one option that deserved an argument

**Strain** — the owner moved this pillar *off* wearables onto ARC's logged volume
(`src/lib/home/readiness.ts:127-137`); `strainVerdict` (`:214-230`) takes `max(setsRatio,
energyRatio)` over `StrainInputs` (`:179-188`), the one-directional argument at `:191-212`.
Neither changes: a heart-rate input would be a third instrument under `max()` and a
wearable derivation re-entering the pillar. §7 Q1(b).

**Recovery — argued, not waved off.** Recovery is HRV ratio first, RHR delta second
(`:904-911`) over `dailyMetricSeries` of `hrv` and `rhr` (`:851-859`), and on the owner's
device it is one-legged: a Garmin exports no HRV (`coverage.ts:14-17`), so it runs on the
RHR delta alone, and in-workout heart rate is the one new cardiac signal a Garmin would
actually deliver. The candidate is not a daily bucket (§3.3 stands) but a *trend of
session averages* corroborating the surviving input. Not taken, for a reason stronger than
"not resting": **heart rate at a moment of training is a function of the load at that
moment**, and ARC holds no load control — no pace, no power, no grade. A session average
8 bpm above the last four could be fatigue, illness, heat, or a harder run; 8 bpm *below*
could be fitness or parasympathetic suppression. The sign is ambiguous without the load,
so a deterministic corroboration in `deriveReadiness` would be a clinical rule hardcoded
from a confounded signal — what the house rule forbids. The Coach, holding the session
list with `minutes`, `km`, `setMetres` and now `hr` plus the RHR baseline, can say *"your
easy runs ran 8 bpm high this week at the same pace"* and qualify it. The honest
corroborator would be heart-rate *recovery* after exercise
(`HKQuantityTypeIdentifierHeartRateRecoveryOneMinute`, `healthkit.generated.d.ts:4`) —
another unverified Garmin row for another day. §7 Q1(c) puts the trend option to the owner anyway.

**Freshness, volume, pairing** — nothing. `ingestedMuscleLoads` doses by duration and role
weight (`workout-ingest.ts:520-558`) and an intensity multiplier is a second model of the
same hour, which the D3 spike rejected (`ingested-workouts.md:435`); volume reads
`workout_sets` (`docs/exercise-subapp.md:487-490`); pairing is span overlap, one definition
(`workout-ingest.ts:137-144`).

### 3.8 Provenance, the two derivations, the boundary, and the day

The line reads `Garmin · 612 kcal · 8.4 km · avg 142 · max 171 bpm`. The source is named
first; the figure cannot be mistaken for a typed one because there is nowhere to type it.
`method` stays in metadata for diagnostics, and **the two derivations are shown
identically, on purpose**: both are HealthKit's time-weighted average and maximum over the
writer's *exported* samples for the span; door 1 differs only in that the writer
associated them. A `max` below the watch face is therefore Connect's export cadence, not
which door answered, and applies to both equally — marking one *"from samples"* would
claim a distinction the numbers do not have. The `0034` rule (`0034_recipe_photo_autoresolve.sql:15-21`)
is about a number of unknown origin entering a rollup; no rollup takes this number.

**The boundary, said plainly.** After the re-read, a session with no clause is either both
doors empty or older than 90 days when the scope landed; a session entering the store
*after* the re-read is re-probed for fourteen days and then frozen. The coverage row says
so, so a blank on a two-month-old session is not read as a Garmin verdict. The
link-to-loser edge from §1 is documented in a test (§3.9 test 9), not fixed.

**Between Phase 1 and Phase 2, nothing is visible.** `metadata.hr` lands on rows the hub
and the Data tab already render, but both decoders read named keys
(`workout-ingest.ts:91-98`, `wearables.ts:602-604`) and neither knows `hr` until Phase 2;
the write is one `CHANGED`-guarded UPDATE per session (`wearables.ts:62-67`).

**The day boundary, 0053 and 0055 are all moot.** The figure is keyed to a workout, not a
day: the row keeps HealthKit's calendar day (`mapping.ts:627`, argued at `:113-141`),
`logicalDate` (`src/lib/db/date.ts:168-177`) governs only what he logs, and pairing bridges
the two with its ±1-day filter (`workout-ingest.ts:156-165`). `0053`'s timezone days
withdraw votes from *baselines* (`readiness.ts:855-859`) and this figure enters none;
`0055`'s away bit governs load *comparison* on `workouts` (`0055_workout_away.sql:9-19`)
and the ingested row is compared to nothing. Neither reads the new key.

### 3.9 Tests, and what the shape changes touch

Headless, `node:sqlite`, in `db/health-mapping.test.mjs`, `db/wearables.test.mjs` (§21,
`:1622`), `db/coach-tools.test.mjs` (§38, `:2975-2980`), `db/health-coverage.test.mjs` and
`db/screens-render.test.mjs` (`:2354`). Gates first; documentation last, labelled.

1. `parseWorkoutHrStatistic`: `Quantity` objects, not bare numbers; `undefined` → null;
   average without maximum → null; `unit: 'count/s'` with `2.37` → 142; `unit: 'kcal'` → null.
2. `pickSourceStatistic`: Garmin, iPhone and a second wearable → the Garmin figure only;
   no matching bundle → null; a `source.toJSON` that throws → skipped, not fatal.
3. The floor, as the query delivers it: 48 returned, six the writer's → pass; five → fail;
   48 of which 43 are the phone's → five → fail, labelled as the multi-source under-count.
4. **The rejecting probe:** `collectWorkouts` over one fixture proxy with a rejecting probe
   yields the row with **no `hr` key** and an `error` for the log, and the pass reaches the
   upsert; **door 1 rejecting on every workout** with door 2 answering yields
   `method: 'source'` figures only and a non-null `error`.
5. `workoutRows` writes `metadata.hr` when present and **no key** when absent — on the
   serialised JSON, so a `null` member can never appear.
6. **The invariant:** HeartRate is in `HEALTH_READ_IDENTIFIERS`, claimed by the workout
   path, **absent** from `SAMPLE_METRICS` and `STATISTIC_METRICS`; `wearableMetricInventory`
   over a store holding workout rows with `hr` lists no heart-rate metric.
7. `uncoveredReadIdentifiers()` stays empty; the new row is `garmin: 'unverified'` with a
   note containing *"Privacy & Security"*. `unaskedReadScopes`: no stamp → every scope; a
   stamp missing HeartRate → `[HeartRate]`; a full stamp → `[]`.
8. Skip set and re-sync: a row carrying `hr` is not probed by door 2 and one lacking it is
   probed again next pass; a row upserted again with a new `hr` is one UPDATE counted in
   `rowsWritten`, and the same row unchanged writes nothing.
9. Through the link: `pairedIngestFor` and `recentWearableWorkouts` return `avgHr` /
   `maxHr`, nulls when the row has none; `ingestDetail` renders / omits the clause and its
   spoken form differs from the display form. Plus the documented edge: a link to a phone
   row, then a watch row for the same hour — list shows the watch, paired line the phone's.
10. `get_training_summary`: paired `recentSessions` rows carry `hr`, unpaired
    `ingestedSessions` rows carry `hr`, rows without it carry **no key**.
11. The log: `parseSyncLog` round-trips `detail` beside the unknown-key assertion at
    `:1560-1573`, which must keep passing; `metricNote` on a `workout_hr` row names an error
    even though `returned > 0`, and with `returned > 0, rows 0` names the iOS Settings path;
    the render suite's Settings fixture gains that row and asserts the sentence.
12. *Documentation, not gates:* `deriveReadiness` output is identical with and without
    `hr` (`readiness.ts:851-882` never parses workout metadata); `coach-eval.test.mjs` §6's
    schema token count is unchanged (payload cannot touch it).

**What the two shape changes touch.** `HealthWorkoutSample` gains an optional key; the
`parseWorkoutSample` assertions (`health-mapping.test.mjs:621-667`) compare named fields
and keep passing. `HealthMetricLog` gains optional `detail`; its consumers are `parseSyncLog`,
`metricNote` and the screen (`settings-health.tsx:421-445`), exercised by `health-mapping`
(`:1536-1590`) and `screens-render` (`:2354+`). No DDL, so `db:validate` is untouched.

---

## 4. Alternatives considered

| # | Alternative | Verdict |
| --- | --- | --- |
| A | HeartRate in `SAMPLE_METRICS` as a daily mean | Rejected. A meaningless number one string from `rhr`; §3.3 |
| B | Door 2 only, or door 3 (`filter.workout`) as the fallback | Rejected. Door 1 matches the Health app when it answers; door 3 is door 1's constraint with a longer round trip |
| D | Door 2 with no source restriction | Rejected. A phone's incidental readings would enter a Garmin session's average unseen |
| E | `getAllStatistics()` as the storage path | Rejected as storage, kept as the diagnostic. Preferred units (`WorkoutProxy.swift:202`) |
| F | Copy `avg_hr` / `max_hr` onto `workouts` | Rejected. `0054`'s nothing-copied rule |
| G | A per-workout `wearable_data` row per figure | Rejected. A third identity scheme; §3.2 |
| H | Store the intraday series now (`0059`) | Owner's call (§7 Q4) |
| I | Zones from `220 − age` | Rejected. An invented threshold and a verdict from an average |
| J | Heart rate into strain as a third `max()` instrument | Owner's call (§7 Q1), recommended no |
| J' | A session-average trend corroborating Recovery | Owner's call (§7 Q1), recommended no; argued in §3.7 |
| K | Scale inferred muscle load by heart rate | Rejected. A second model of the same hour (`ingested-workouts.md:435`) |
| L | One sentence in the tool description | Deferred until a transcript shows it is needed |
| M | A per-pass cap on door 2 with a deferred count | **Withdrawn** (second review). See below |
| N | Drop the door-2 floor entirely | Rejected. See below |

**Considered and rejected — the reviews' alternatives not taken.**

*Re-request the scope automatically inside `syncHealthData`.* Not taken: `syncHealthIfEnabled`
runs on every foreground (`sync.ts:463-471`, throttled at `:79`), so the sheet would appear
over whatever screen the owner returned to; the house precedent for a late scope is a
control rendered only while it applies (`settings-health.tsx:187-193`).

*The cap (M), and why it is gone.* The first revision capped door 2 at 120 per pass and
asserted the 90-day re-read fit at ~1.3 sessions a day — a figure nothing in the repo
supports; `workoutRows` ingests every HKWorkout with a positive duration (`mapping.ts:625`),
and the D3 example is an auto-detected walk (`backlog-2026-09.md:58`). A capped re-read
with no second chance strands sessions, as the critic said, but both remedies offered — a
cursor with a chunked backfill, or a control visible while `deferred > 0` — fix a problem
the cap created: sessions with no heart rate at all would fill the first slots of every
pass and starve the rest. No cap: no deferred count, no cursor, no starvation; the cost is
stated in §3.4 and measured in §6.

*Drop the floor (N).* Not taken. Door 2 is a figure ARC derives, not one the writer
asserted, and `avg 142` from four samples of a sparse export is a claim ARC would be
making in the owner's mono voice; its semantics are now stated as the query delivers them,
and door 1 stays unfloored as the writer's own association (§7 Q5). *Marking the door-2
figure on screen* is not taken either — §3.8: the cadence caveat applies to both doors.

*Two of the critic's line numbers.* The `SourceProxy` cast is at `PredicateHelpers.swift:15`
(`:14` opens the `compactMap`) and the nil return at `:21`; the firewall blockquote is
`00-design-spec.md:78` (`:77` is blank). Both re-read; the other four corrections are applied above.

---

## 5. Effort and phases

| Phase | Piece | Size |
| --- | --- | --- |
| **1a — the ask** | scope + claim comment, coverage row with the declined-grant sentence, Settings scope line + docblock count, `apple_health_scopes` stamp + `unaskedReadScopes`, the *Read heart rate (90 days)* control and its visibility rule, `syncHealthData` `windowDays` option | ≈ 1 day |
| **1b — the probe** | `SampleFilter.sources`, the module slice, `collectWorkouts` extraction, `parseWorkoutHrStatistic`, `pickSourceStatistic`, the floor, the injected probe with its error posture, the skip set, the `getAllStatistics` diagnostic, `metadata.hr`, the log row + `detail` + parser + `metricNote` branch | ≈ 1 day |
| **2 — surface** | `PairedIngest` / `IngestedWorkout` / `WearableWorkout` fields, **both** decoders, `ingestDetail` + spoken form, the two strings in `exercise.tsx`, the wearables row, the editor line, `w.id` + the two Coach payload fields | ≈ half a day |
| **tests** | the twelve above | ≈ half a day |
| **3 — conditional** | zones or the series table, only on a yes to Q2 or Q4, and only after §6's cadence answer | 1–2 days, not estimated further |
| **Total for the recommended slice** | | **≈ 3 days**; no migration; no native module, so no Info.plist change — it rides the next EAS build like every JS change here |

Phase 1a ships alone if it must — it is the ask, and §6's first check needs nothing else;
1b is invisible except in Settings › Apple Health (§3.8).

---

## 6. What only a device can settle

Every item presupposes the next EAS build: the owner's phone has never run `0054`'s
pairing, and cannot run this.

- **Step 0.** iOS Settings › Privacy & Security › Health › ARC — confirm *Heart Rate* is
  on, and only then read the `workout_hr` row; a `31 → 0` before that check is not a fact about Garmin.
- **Whether Garmin Connect writes heart-rate samples to Apple Health at all**, and at what
  cadence. One workout: Health › Heart › Heart Rate, filter to Garmin, look at the hour;
  then tap *Read heart rate (90 days)* and read the row.
- **If the row shows an error, read the error text before concluding anything about
  Connect.** A rejected `getStatistic` on every workout produces `rows 0` while the `detail`
  line still says *associated: HeartRate*: door 1 is wrong, not Garmin silent. Confirm iOS
  16 or later (`WorkoutProxy.swift:185`, `:199`) — below it both statistics methods return
  nothing and an empty door 1 says nothing about Connect either.
- **Whether door 1 ever answers for a Garmin workout** — the `detail` line's *"associated:
  …"* list on the first pass; if everything arrives *by source*, door 1 stays for a future Apple Watch.
- **The real session count, and door 1's cost.** `SELECT count(*) FROM wearable_data WHERE
  metric_type = 'workout' AND date >= date('now','-90 days')` — the re-read costs twice that
  in round trips, the figure any future cap argument starts from; the log's own timing says
  whether door 1 adds measurable time.
- **Whether `sources: [proxy.sourceRevision.source]` survives the cast** at
  `PredicateHelpers.swift:15` (confirmation only; the JS post-filter is the control), and
  **how far the source-derived `max` sits below the watch face's** — cadence in another
  form, applying to both doors (§3.8).
- **The two rows.** Whether `avg 142 · max 171 bpm` reads as one line under a session title
  at 10 pt mono on the Train hub; whether the Wearables right column, now three lines deep,
  still sits cleanly in its row; and how the spoken form sounds in VoiceOver.

---

## 7. Questions for the owner

**1. Should in-workout heart rate move a Home pillar?** Strain today is your logged sets,
raised (never lowered) by active energy; Recovery on a Garmin is resting heart rate alone.
§3.7 argues neither should take it: a session's heart rate depends on the load in that
session, and ARC does not hold the load.

- (a) **(Recommended)** Neither. Heart rate is shown and handed to the Coach, who can say
  *"your easy runs ran high this week"* without a pillar moving.
- (b) Strain: a third one-directional instrument under `max()` — the day's highest
  paired-session average against its own baseline. Adds strain, never subtracts.
- (c) Recovery: a trend of session averages corroborating the resting-heart-rate delta. A
  confounded signal made into a rule; not recommended.

**2. Training zones — from what threshold?** A per-session average cannot give
time-in-zone, and ARC holds no max-HR figure.

- (a) **(Recommended)** No zones now. Show avg and max; the Coach interprets them against
  your age and resting-HR baseline, and asks for your age if you have not entered a birth date.
- (b) Zones from a max HR you enter once in Settings — a key in the `users.preferences`
  JSON beside units (`0001_init.sql:55`, read by `getPreferences`, `user.ts:120-124`); no
  migration.
- (c) Zones from `220 − age` — crude, and stated as such on the line.

**3. Where the figure shows.** The Train hub's watch line (`Garmin · 612 kcal · 8.4 km`)
shipped under D3 and is not on the table here; the question is where heart rate joins.

- (a) **(Recommended)** On that hub line, in the session editor, on the Data › Wearables
  row, and in the Coach's training summary.
- (b) Leave the hub line as `0054` shipped it; add heart rate only in the editor and the Coach.
- (c) Hub line, editor and Coach — but not the Wearables row, which stays the
  minutes-and-kcal ingest record it is today.

**4. Store the intraday heart-rate curve?** A new table (`0059`) holding the samples per
workout, so a session could draw its curve and, with a threshold, count minutes in zone —
a real migration, only meaningful if Garmin's cadence turns out dense.

- (a) **(Recommended)** Not now. Store avg and max in the workout's metadata and ask again
  once a device has shown what Garmin actually writes.
- (b) Yes, in the same slice — design the table now.

**5. The floor applies to the fallback only.** Door 1's figure is HealthKit's own for the
workout, printed unfloored by the Health app itself; door 2's is withheld unless at least
six of the span's first 48 samples were the writer's.

- (a) **(Recommended)** Door 1 unfloored; door 2 floored as stated. A number from four
  samples is a claim, and a blank line is honest.
- (b) Show whatever exists, marked *"from few samples"* on the line.
- (c) Floor door 1 too by requiring door 2's count as well — one extra query for every
  session, and the Health app's own figure withheld whenever Garmin's export is sparse.
