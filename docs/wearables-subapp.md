# Wearables sub-app — Apple Health

**Spec date:** 2026-07-29 · **Status:** Phase 1 spec → built in the same window
**Amended:** 2026-08-12 — the link is **two-way**: ARC publishes three body measurements
outward (**§10**) and reads the same three back in (**§11**).
**Amended:** 2026-08-25 — **the EAS rebuild happened**, so every "rides the next build" claim
here is re-trued (the runtime guards are untouched); and **Strain left this sub-app** — it is
derived from ARC's own logged sets now, with active energy demoted to a one-directional second
opinion (**§6**).
**Amended:** 2026-08-26 — weight did not arrive on hardware. **§14** reads the answers off the
installed library's own iOS source, fixes the two defects it found (both in ARC), and adds a
per-run **sync log** so the next failure names itself instead of being reported as "not working".
**Read first:** CLAUDE.md §8 (wearables strategy) and §9 (DB conventions), `docs/project-status.md`.

Apple Health is the decided ingestion hub (2026-07-24 ADR): it is on-device, every vendor's
own app does the cloud sync, so ARC stays offline/no-server. Terra is dropped. Device choice
stays open — nothing below depends on which ring/strap Matt ends up wearing; every source
normalises into `wearable_data`, which shipped in 0001 precisely for this.

§§1–9 describe **ingestion into `wearable_data`**, which is the bulk of the integration.
§10 describes the outbound channel, §11 the inbound half of the same three body measurements,
and both hang on the echo suppression written up in §10. **§14 is what that echo suppression
actually did on a device**, and is the section to read before touching any of it.

---

## 1. Library choice

**`@kingstinct/react-native-healthkit` v14** (+ its required peer `react-native-nitro-modules`).

Evaluated July 2026:

| Option | Verdict |
| --- | --- |
| **@kingstinct/react-native-healthkit 14.0.2** | ✅ The only actively maintained option (monthly releases; repo pushed 2026-07-27). Nitro/New-Architecture native, typed string identifiers, statistics + anchored queries, `sourceRevision`/`device` on every sample, ships an Expo config plugin. Peers: react ≥19, RN ≥0.79, nitro ≥0.35 — SDK 57 / RN 0.86 satisfy all. |
| react-native-health (agencyenterprise) | ❌ Abandoned (last publish 2024-10); old-architecture, callback API. |
| @yzlin/expo-healthkit | ❌ Stale (2024-11), narrower API. |
| @kayzmann/expo-healthkit | ❌ Alive but tiny/unproven; no statistics collections or anchored queries. |

**Config plugin** (app.json): no background delivery — smallest surface, no AppDelegate patch,
no background-delivery entitlement:

```json
["@kingstinct/react-native-healthkit", {
  "NSHealthShareUsageDescription": "ARC reads sleep, heart, activity and workout data from Apple Health to power readiness and recovery, and reads the weight, body-fat percentage and waist measurements stored there so a smart scale keeps your ARC record up to date.",
  "NSHealthUpdateUsageDescription": "ARC writes the weight, body-fat percentage and waist measurements you record in ARC to Apple Health, so other apps on your iPhone can see them. Nothing else is written.",
  "background": false
}]
```

`NSHealthUpdateUsageDescription` was `false` — the key omitted entirely — until 2026-08-12,
when ARC started publishing three body measurements outward (**§10**). That string is the
**only** part of publishing that needs a rebuild: `com.apple.developer.healthkit` is a single
boolean covering read *and* write, and the plugin injects it unconditionally
(`app.plugin.ts` → `withEntitlementsPlist`). So there is **no new Apple capability and no
provisioning-profile regeneration** — and no entitlements block belongs in app.json.
Everything else in §10 is JS and ships OTA, **with one hard exception noted in §10**: this JS
must not reach a binary built before that key existed.

**Native-dep reality (re-trued 2026-08-25):** the module **is in the owner's binary.** The EAS
rebuild this section waited on from 2026-07-31 has happened; `@kingstinct/react-native-healthkit`
and `react-native-nitro-modules` were in `package.json` long before it was cut, and so was the
`NSHealthUpdateUsageDescription` string (2026-08-12), so that build carries both halves and
§10's OTA hazard does not apply to it. That is a statement about what is *present* in the
binary and nothing more — whether Apple Health is actually handing rows over is the owner's
observation to make, and no claim about it is made anywhere in this document.

The guarded seam (§5) is unchanged and stays: it is what keeps node, the web preview, and any
dev client or simulator build predating the module from crashing. The library's `modules.ts`
calls Nitro's
`createHybridObject(...)` at module top level, and both it and nitro's own
`TurboModuleRegistry.getEnforcing` throw a *synchronous, catchable JS Error* at `require()`
time when the native side is absent — exactly what the try/catch-require pattern handles. On
the web logic-check preview Metro resolves the library's non-iOS stub, which is inert.

## 2. Read scopes

Requested lazily — only when the user flips Settings › Apple Health on, never at boot:

| HealthKit type | Why |
| --- | --- |
| `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | Recovery (readiness core) |
| `HKQuantityTypeIdentifierRestingHeartRate` | Recovery |
| `HKCategoryTypeIdentifierSleepAnalysis` | Sleep duration + stages |
| `HKQuantityTypeIdentifierStepCount` | Activity |
| `HKQuantityTypeIdentifierActiveEnergyBurned` | Raises Strain; cardio/NEAT the sets cannot see |
| `HKQuantityTypeIdentifierBasalEnergyBurned` | Energy context |
| `HKQuantityTypeIdentifierRespiratoryRate` | Sleep-time vitals |
| `HKQuantityTypeIdentifierOxygenSaturation` | Sleep-time vitals |
| `HKQuantityTypeIdentifierBodyTemperature` | Illness signal (manual/BT thermometer) |
| `HKQuantityTypeIdentifierAppleSleepingWristTemperature` | Nightly temp trend (read-only type) |
| `HKQuantityTypeIdentifierVO2Max` | Fitness marker (project-status "Exercise as measured data") |
| `HKQuantityTypeIdentifierDietaryWater` | **Hydration — IN only (§15).** A wrist tap, the Health app, or any hydration app already on the phone |
| `HKWorkoutTypeIdentifier` | Sessions from other apps/devices |
| `HKQuantityTypeIdentifierHeartRate` | **The WORKOUT path only (§18).** A session's own avg/max, into that workout row's `metadata.hr` — **never** a daily bucket |
| `HKQuantityTypeIdentifierBodyMass` | **Body — two-way (§11).** A smart scale's weight |
| `HKQuantityTypeIdentifierBodyFatPercentage` | **Body — two-way (§11).** Scale body-fat estimate |
| `HKQuantityTypeIdentifierWaistCircumference` | **Body — two-way (§11).** Tape measure, from anywhere |

The last three are the only types ARC both reads and writes, and they land in `body_metrics`
rather than `wearable_data` (§11). Everything above them is read-only, and every declared
scope has an ingest path — a test asserts that, because a requested scope with nothing behind
it is a permission prompt for data that then silently never arrives.

Permission truth (Apple's design, not a bug): **read grants are invisible.** A denied type
returns empty results indistinguishable from "no data"; `getRequestStatusForAuthorization`
only says *should we show the sheet* (`shouldRequest`) or *the user has already answered*
(`unnecessary` — which does NOT mean granted). The Settings screen is honest about this:
after enabling it says "Connected — if data looks missing, check Settings → Privacy →
Health → ARC", and empty states everywhere read "no data or no access", never "denied".
Re-requesting is a safe no-op for already-answered types, so enable can always re-request.

⚠️ **The corollary that bites once per late scope.** Because iOS presents the sheet only for
types the user has *not* answered, **adding a row to this table asks nobody anything on an
install that already connected.** The new scope is requested, granted nothing, and reads empty
forever — indistinguishable from a source that does not write it. So a scope added after the
fact needs an explicit control, and ARC needs to know which scopes an ask has covered: the
`apple_health_scopes` KV key holds `{ askedFor }`, stamped after every processed request, and
`unaskedReadScopes` is the pure rule the Settings control keys off (§18.2). The stamp records
that ARC **asked**, never that anything was granted — that stays unknowable.

## 3. Mapping — HealthKit → `wearable_data`

The 0001 table is already the right shape: tall/narrow, `metric_type` free text, `date`
local `YYYY-MM-DD`, canonical-unit `value`, `source_device` label,
`UNIQUE (source_device, source_raw_id)` for idempotent re-sync. One row per **metric ×
local day × source** (except workouts: one row per workout).

| ARC `metric_type` | From | value / unit | Day rule |
| --- | --- | --- | --- |
| `hrv` | SDNN samples (ms) | daily mean · `ms` | sample's local day |
| `rhr` | RestingHeartRate samples | **last** sample of day · `bpm` (the Watch replaces earlier same-day estimates) | local day |
| `steps` | StepCount **statistics** | daily sum · `count` | local-midnight buckets |
| `active_energy_kcal` | ActiveEnergyBurned statistics | daily sum · `kcal` | local-midnight buckets |
| `resting_energy_kcal` | BasalEnergyBurned statistics | daily sum · `kcal` | local-midnight buckets |
| `water_ml` | DietaryWater **statistics** | daily sum · `ml` (HKUnit `mL` — §15) | local-midnight buckets |
| `respiratory_rate` | RespiratoryRate samples | daily mean · `brpm` | local day |
| `spo2_pct` | OxygenSaturation samples | daily mean **×100** · `pct` (HK stores fraction 0–1) | local day |
| `body_temp_c` | BodyTemperature samples | daily mean · `c` | local day |
| `wrist_temp_c` | AppleSleepingWristTemperature | nightly sample · `c` (absolute °C; Health app shows a *delta* — ARC's read-side computes its own baseline delta) | local day of sample end |
| `vo2max` | VO2Max samples | latest sample · `ml_kg_min` (sparse — a "last known as-of" metric) | local day |
| `sleep_duration_min` | SleepAnalysis | asleep minutes (values 1/3/4/5) · `min`; `start_time`/`end_time` = session bounds | **wake day** (§ sleep) |
| `sleep_core_min` / `sleep_deep_min` / `sleep_rem_min` / `sleep_awake_min` / `sleep_in_bed_min` | SleepAnalysis | per-stage minutes · `min` — a stage row exists **only when the source wrote stages** (WHOOP doesn't; 0 ≠ unknown) | wake day |
| `workout` | HKWorkout samples | `duration` minutes (not end−start; pauses differ) · `min`; metadata: activity type raw int + name, kcal, distance_km, source name | local day of workout **end** |

**"Local day" in that last column means the day the sample was LIVED in**, not the day it
would land on if re-read from wherever the phone is standing now — §19, from 2026-09-19.
Before that it meant the latter, and a trip re-dated a fortnight of history.

Already-shipping metric types are untouched and merge naturally: manual keypad `hrv`/`rhr`
rows and `water_ml` live in the same table. **That last one stopped being hypothetical on
2026-09-14** — `DietaryWater` is a read scope now, it landed by adding three literals to
`STATISTIC_METRICS`, and no migration was needed, exactly as this paragraph predicted. What
the prediction did not cover is what happens when two sources fill one metric: see §15.

**Sleep attribution — the night ending on the morning of day D belongs to D.** Query window
`[D−1 12:00, D 12:00)` local (noon exists in every timezone on every day; midnight doesn't
under DST). Per source bucket: cluster samples into sessions (a gap > 60 min splits), take
the longest session, sum stage durations by category value (0 inBed / 1 asleepUnspecified /
2 awake / 3 core / 4 deep / 5 REM — `inBed` *spans* the stage samples, so summing everything
double-counts the night; asleep = 1+3+4+5 only).

**Cumulative metrics use HealthKit's merged statistics, never manual sample sums.** iPhone
and Watch both record steps and their samples overlap; HealthKit's merge algorithm is
private and cannot be reproduced from outside (Apple engineer, verbatim guidance). So steps
and energy land as ONE row per day, labelled `source_device = 'apple_health'` — the merged
total, matching what the Health app shows. Discrete metrics (HRV, RHR, sleep, SpO2, temps,
VO2max, workouts) carry real per-sample provenance, so they get true per-device rows.

## 4. Source labeling & dedup

**`source_device`** buckets from `sourceRevision` (bundle id + productType):

| Match | Bucket |
| --- | --- |
| bundle `com.arcresilience.app` (ARC's own published samples — §10) | `manual` |
| bundle `com.ouraring.oura` | `oura` |
| bundle `com.whoop.iphone` | `whoop` |
| bundle `com.garmin.connect.mobile` | `garmin` |
| bundle `com.ultrahuman.ios` | `ultrahuman` |
| bundle `com.withings.*` | `withings` |
| bundle `com.eightsleep.*` | `eight_sleep` |
| bundle `com.apple.health*` + productType `Watch*` | `apple_watch` |
| bundle exactly `com.apple.Health` (manual entry in the Health app) | `manual` |
| HK-merged daily statistics (no single device by design) | `apple_health` *(added to the CHECK in 0021)* |
| anything else (incl. iPhone-recorded) | `other` |

The raw provenance is never thrown away: `metadata.hk` keeps
`{source_name, bundle_id, product_type, samples}` so an unmatched vendor is recoverable
without a migration (mirrors the free-text `metric_type` philosophy).

**Dedup = the 0001 unique index.** `source_raw_id` is deterministic:
- day-bucket rows → `hk:<metric_type>:<date>` (unique per source via the composite index);
- workouts → the HealthKit sample UUID (real per-object identity).

Ingest is `INSERT … ON CONFLICT (source_device, source_raw_id) WHERE source_raw_id IS NOT
NULL DO UPDATE` — re-syncing updates rows instead of duplicating them, exactly what the
0001 comment promised ("Re-syncing a device updates rows rather than duplicating them").

**Sync strategy: trailing-window re-aggregation.** Each sync recomputes the last **14 days**
and upserts. Self-healing by construction: late-arriving Watch data (its HealthKit sync lags
minutes–hours), the Watch's own delete-and-replace of resting HR estimates, and timezone
shifts all converge on the next pass. Three rules make the windowing correct rather than
merely approximate (all pure and headless-tested in `syncWindowDays` / `clampRowsToWindow`):

1. **First sync backfills 90 days — and stays armed until a pass actually lands rows.**
   `firstSyncedAt` is stamped only when `rowsWritten > 0`. HealthKit makes a *denied* read
   indistinguishable from *no data*, so a pass after "Don't Allow" completes having written
   nothing; stamping it then would burn the one-time backfill and leave days 15–90
   unreachable forever once the user grants access from iOS Settings.
2. **The window stretches to cover any gap since the last sync** (capped at 365 days). A
   fixed 14 days would leave a permanent hole whenever ARC went unopened for longer, or the
   toggle was switched off and back on months later — HealthKit still holds that data, but
   no later pass would ever look at those days again.
3. **Emitted rows are clamped to the window's dates.** The sample span deliberately starts
   at *noon of the day before* the window so the first night's sleep session is fully
   covered — but the mappers bucket each sample by its own local day, so that half-day tail
   also produces rows for an out-of-window day built from **afternoon samples only**. They
   carry the same deterministic `hk:<metric>:<date>` id as the complete rows written while
   that day was in-window, so without the clamp the upsert would overwrite a true full-day
   aggregate with a fragment — corrupting *every* day of history exactly once, on the day it
   aged out (a daily HRV mean silently becoming "whatever was recorded after noon"; a
   7-hour night replaced by a 30-minute nap). Baselines and Coach correlations read those
   rows, so the damage would be invisible and permanent. `db/wearables.test.mjs` runs the
   two-pass sequence end-to-end to prove it.

Known, accepted limits: deletions older than the window linger, and a workout deleted in
Health lingers (an HKAnchoredObjectQuery — which reports deletions and has serialisable
anchors in this library — is the documented refinement if that ever matters; the
`health_sync_state` KV table is where its anchors would live).

**Cumulative day queries pass `strictStartDate`,** so each sample belongs to exactly one day
— the day its start falls in, matching how the Health app attributes. The default predicate
is overlap-based and statistics queries don't prorate, so a step/energy sample straddling
local midnight would otherwise be summed *whole into both* adjacent days.

**Wire shapes are parsed in exported pure functions** (`parseWorkoutSample`,
`parseQuantitySample`, `parseCategorySample`, `parseStatisticSum`) with fixture tests
pinned to the installed library's actual payloads. This is not ceremony: workout
`duration` / `totalEnergyBurned` / `totalDistance` and statistics sums are `Quantity`
**objects** (`{unit, quantity}`) while `QuantitySample.quantity` is a bare **number**, and
reading either at the wrong shape fails *soft* — the record is dropped with no error, which
on device looks like "no workouts exist" rather than a bug. Duration also reads its unit
string rather than assuming seconds, so a library change to minutes can't rescale training
history 60×.

**Cadence (foreground-only app, no background delivery):** boot + app-foreground
(throttled to ≥15 min) + immediately after enabling + a manual "Sync now" in Settings.
Everything written while ARC was closed is waiting in the store when the query runs.

## 5. Architecture — the guarded seam

Mirrors `api-key-store.ts` / `notifications/reminders.ts` / `nutrition/estimate.ts` exactly:
the native module is `require()`d in try/catch and **all logic that can be pure is pure**,
headless-tested against `node:sqlite`.

```
src/lib/health/
  healthkit.ts   ← the ONLY impure file: guarded require of @kingstinct/react-native-healthkit;
                   availability probe, requestHealthPermissions(), thin readers returning
                   plain JS shapes. No-ops (null/false/[]) when native is absent.
  mapping.ts     ← PURE: source bucketing, day bucketing, sleep sessionisation, spo2 ×100,
                   row building with deterministic raw ids. Headless-tested.
  sync.ts        ← orchestration: enabled-flag (users.preferences.health), window maths,
                   healthkit.ts reads → mapping.ts rows → wearables repo upsert,
                   sync-state stamping, foreground throttle. Testable with a fake reader.
src/lib/db/repositories/wearables.ts
                 ← upsertWearableRows (ON CONFLICT), daily series / latest / history reads,
                   source-priority day-value picker, health_sync_state get/set.
src/lib/home/readiness.ts
                 ← PURE readiness derivation over the Database interface (§6).
```

UI: `app/settings-health.tsx` (toggle + lazy permission + status + Sync now),
`app/wearables.tsx` (Data-tab history), Home wiring via `src/hooks/use-readiness.ts`.

**Migration 0021** (`0021_wearables_health.sql`):
1. rebuilds `wearable_data` with `'apple_health'` added to the `source_device` CHECK (the
   merged-statistics label; the sibling `source` enums in 0001 already carry it). Straight
   copy — no incoming FKs, indexes + trigger recreated;
2. adds `health_sync_state` — a tiny KV table (`key` UNIQUE, `value` json) holding
   `{lastSyncedAt, firstSyncEpoch…}` under key `apple_health`; future anchors land here too.
0022–0023 stay free (0019 = RAG, 0024–0026 = labs are reserved).

The **enable flag** lives in `users.preferences.health.syncEnabled` (same JSON blob as unit
prefs — a toggle is a preference, not schema).

## 6. The readiness seam (Home)

`deriveReadiness(db, today)` in `src/lib/home/readiness.ts` — pure, deterministic,
DB-interface only — replaces `mockDay.readiness/pillars/metrics` on Home. Per metric it
picks the day's row by source priority (`apple_watch > oura > whoop > ultrahuman > garmin >
eight_sleep > withings > other > apple_health > manual` — manual counts when it's all there
is, e.g. keypad HRV).

- **Baselines:** 30-day mean before today; a metric needs ≥ 5 prior days or its verdict is
  `unknown` (n=2 baselines are noise, and the Coach is supposed to be evidence-seeking).
- **Recovery:** HRV ratio r = today/baseline → ≥0.97 optimal · ≥0.90 good · ≥0.80 caution ·
  else poor; degraded one level when RHR is ≥ +5 bpm over its baseline. RHR-only fallback
  when HRV is absent.
- **Sleep:** asleep minutes → ≥450 optimal · ≥390 good · ≥330 caution · else poor.
- **Strain (rewritten 2026-08-25 — it is no longer a wearable derivation):** yesterday's
  **role-weighted working sets, logged in ARC**, ÷ the mean over prior **training days** in
  the 30 days ending yesterday, then raised — never lowered — by the active-energy ratio when
  energy has its own baseline. Bands unchanged: ≤0.75 optimal (fresh) · ≤1.30 good ·
  ≤1.70 caution · else poor. Gate: **5 prior logged sessions**, not 5 days.

  Owner: *"switch to ARC computing"*. Active energy is a calorie-burn proxy and a hard
  resistance session burns few calories, so the morning after a back day this pillar read
  `optimal / fresh` while the muscle figure on the same screen reported lats at 27%. It now
  reads the SAME substrate the freshness engine reads (`dailyMuscleSetLoad`, over
  `workout_sets`), which is why the two can no longer contradict each other — and it needs no
  HealthKit at all. Energy stays as a second opinion under `max()` because sets cannot see a
  two-hour hike; `max` is one-directional by construction, so energy can add strain the sets
  missed and can never talk a hard lifting day back down. Calibration table and pinned
  representative days: the `strainLevel` docblock and `db/readiness.test.mjs` §6.
- **Nutrition pillar:** graded against the versioned `nutrition_targets` since 2026-08-14 —
  calories symmetric within band, protein one-sided, worst-of wins once the day closes at
  20:00, and before then only completed facts grade it. (This bullet read "presence-only for
  now" until then; it was already stale when strain was rewritten beside it.)
- **Verdict** = worst of Recovery & Sleep (unknowns ignored); labels: optimal "Primed" ·
  good "Ready" · caution "Recovery low" · poor "Back off today". Detail line prefers the
  HRV sentence ("HRV 42 ms · 14% below your 30-day baseline"), then RHR, then sleep. With
  no data at all Home shows an honest `unknown` state that points at Settings › Apple
  Health — never fake numbers. The metrics strip (Sleep/HRV/RHR/Steps) reads the same rows
  and renders `—` for gaps.

`useDailyBrief`'s insight engine and the Coach's `series.ts` already read `wearable_data`
and pick these rows up with zero changes — that's the point of ingesting canonical rows
instead of wiring HealthKit straight into screens.

## 7. What lands where (UI)

- **Settings › Apple Health** (`/settings-health`, replaces the "Needs a build" chip row):
  the module-absent state says "rides the next dev build" honestly — it is keyed off
  `isHealthKitSupported()` at runtime, so it is true whenever it renders and, since the
  owner's 2026-08-25 build, should not render on his phone; enable flow = flip →
  `requestHealthPermissions()` (lazy, first time only) →
  first 90-day sync with progress; then last-synced line, per-domain latest values, the
  read-permission caveat, Sync now, and the toggle off (which stops syncing; rows keep —
  they're the user's data).
- **Settings › Apple Health** (`/settings-health`): since 2026-08-12 the two scope lists
  ("What ARC reads" / "What ARC writes") are ONE record — **What syncs** — with a direction
  per row (In · Out · Both). A two-list layout could only have shown the three two-way
  measurements by printing them twice, and the user's real question about a health integration
  is not what it touches but who is writing their record.
- **Data › Wearables & recovery** (`/wearables`): 30-day sparklines + latest per metric
  (Recovery / Sleep / Activity groups), a recent-workouts list, per-row source chips,
  last-synced footer. Honest empties before the first sync.
- **Home:** readiness verdict + pillar bar + metrics strip go real via `useReadiness()`;
  mock-day stays only as the mission's no-protocol seed. Since 2026-09-23 a metrics-strip cell
  with no reading today is a one-tap Apple Health sync, or says why it cannot be (§20).

## 8. Tests (headless, `npm run db:test`)

- `db/health-mapping.test.mjs` — pure mapping: source bucketing table, spo2 fraction→pct,
  sleep sessionisation (gap split, longest-session pick, inBed-vs-stage no-double-count,
  stage rows only when stages exist, wake-day attribution across midnight), deterministic
  raw ids, workout rows (duration-not-span, uuid raw id); window sizing (backfill armed
  until rows land, gap coverage, 365-day cap) and clamping; and the wire-shape parser
  fixtures (Quantity-vs-number, `toJSON()` proxies, unit awareness). Plus the two-way guards
  (§10–11): the `unsuppressedEchoIdentifiers()` tripwire, the overlap being *exactly* the body
  channel, no published type on the unfiltered-retry path, every read scope having an ingest
  path, `isIngestableSample` (ARC's bundle / the metadata tag / **unknown source**), the
  `ARCPublishedFrom` wire shape, instant-merging, CHECK-bound dropping, and the
  publish↔ingest **round-trip property** on units.
- `db/wearables.test.mjs` — repo against real SQLite: upsert-not-duplicate on re-sync,
  cross-source non-collision, series/latest reads, source-priority day picker, sync-state
  round-trip, 0021 rebuild preserves pre-existing rows (manual water/hrv), and the
  **two-pass ingest** proof that a day aging out of the window keeps its full-day values.
  Plus the whole publish channel (§10): cursor KV, keyset walk over backdated and
  same-millisecond rows, arming-without-backfill over 40 rows of history, unit conversion on
  the wire, stop-on-refusal, and the toggle governing both directions. Plus the inbound body
  ingest (§11): the natural-key upsert (idempotent re-sync, in-place correction, late column
  merging in, a manual row at the same instant left alone), the real CHECK still refusing
  weight ≤ 0, and the end-to-end proof that an ingested row is never published back.
- `db/readiness.test.mjs` — baselines, all four pillar gradings, RHR degradation, the
  ≥5-day evidence gate, honest unknowns, metrics-strip formatting.

## 9. Deferred, deliberately

- **Background delivery / anchored queries** — foreground windows are enough for a daily
  operating system; anchors documented above if deletion-fidelity ever matters.
- **DietaryWater ingest** (smart bottle), **heart_rate intraday**, full-history import
  (365-day paging) — all additive: new scope + mapping entry, no migration.
- **Per-source attribution rows for merged cumulatives** (`separateBySource`) — only if the
  Coach ever needs "which device produced these steps".

## 10. Publishing outward (2026-08-12)

Write-back moved from "deferred, assess first" (§9) to shipped. `body_metrics` owns the three
columns below and Apple Health gets a copy so the rest of the phone can see it.

**Three columns, and the list is structurally closed.** `HEALTH_WRITE_IDENTIFIERS` is
*derived* from `BODY_PUBLISH_METRICS`, which is keyed to `body_metrics` columns, so a type can
only become a write scope by being given a body column. That is what keeps water out
(§15): `DietaryWater` is read-only and must stay read-only, because a `cumulativeSum`
statistics query carries no own-write exclusion — Apple merges before the predicate — so a
published water total would be read straight back and doubled with nothing in the ladder able
to stop it. `db/health-mapping.test.mjs` §8 asserts water's absence from the write list by
name, and proves it behaviourally: a `body_metrics` row carrying all three columns emits
exactly three samples, none of them dietary.

**No single VALUE is ever owned in two places** — that is what makes the two-way link (§11)
safe. Each `body_metrics` row records where it came from, and this pass publishes only rows
ARC originated: `publishableBodyAfter` filters `source <> 'apple_health'` in SQL. A number
typed into ARC goes out; a number that came in from a scale stays put, because Health already
has it.

| `body_metrics` column | HealthKit type | Unit on the wire |
| --- | --- | --- |
| `weight_kg` | `HKQuantityTypeIdentifierBodyMass` | `kg` — canonical already, no conversion |
| `body_fat_pct` | `HKQuantityTypeIdentifierBodyFatPercentage` | `%` — **÷100**, see below |
| `waist_cm` | `HKQuantityTypeIdentifierWaistCircumference` | `cm` — canonical already |

**The body-fat unit is the trap.** `HKUnit.percent()` measures a FRACTION, 0.0–1.0, not
0–100 — the same fact the read side already handles in reverse (`spo2_pct` multiplies by
100 on the way in). `body_metrics.body_fat_pct` is CHECK-bounded 0–100, so publishing it
unconverted would put "1850 %" body fat into a medical record, silently: HealthKit does not
sanity-check magnitudes. Units were verified against the library's own generated map
(`lib/typescript/generated/healthkit.generated.d.ts` → `QuantityUnitByIdentifierMap`, which
types BodyMass as `MassUnit`, WaistCircumference as `LengthUnit`, BodyFatPercentage as `'%'`)
and `types/Units.d.ts` (`'kg'`/`'cm'` are exact members).

**No backfill, ever.** A publish is irreversible from inside ARC: nothing stores the
HealthKit sample UUID `saveQuantitySample` returns, so ARC cannot delete what it wrote —
only the user can, by hand, in the Health app. ARC may hold years of manual weight, and
"publish everything" would post all of it in one burst with no undo. So the first pass
**arms**: the cursor jumps to the newest existing `body_metrics` row and writes nothing.
Everything logged afterwards publishes. A bounded backfill was considered and dropped —
every bound is arbitrary, the irreversibility is identical at any size, and ARC already
keeps and renders that history itself.

**The cursor needs no migration.** It is a second key (`apple_health_publish`) in the 0021
`health_sync_state` KV — `key` carries no CHECK and `value` is free JSON, which 0021 wrote
down explicitly so a second cursor would not be a schema change. It holds
`{armedAt, cursorCreatedAt, cursorId, lastPublishedAt}`. The walk is keyset pagination over
`(created_at, id)`, **not** `measured_at`: a backdated reading (`logMetric` stamps local noon
of the intended day) has a past `measured_at`, so a `measured_at` watermark would step over
it and it would never be published. The `id` half breaks millisecond ties. The cursor
advances only over rows published in FULL — the first refusal stops the pass, so a revoked
share permission publishes nothing and loses nothing.

### Echo suppression

This is the whole hazard of a two-way link, and it is worth being exact about. ARC publishes a
weight; HealthKit stores it; ARC's next read sees it; ARC files it as a new measurement; the
publish walk sees a new row and posts it back. Each pass duplicates, in a medical record, with
no undo from inside ARC. Five independent guards, listed in the order a sample meets them:

1. **Query-level exclusion — a LADDER, strongest first** (corrected 2026-08-26; see §14 for
   why). Every sample reader tries `filter.NOT = [{ sources: [currentAppSource()] }]` and, if
   HealthKit refuses that predicate, `[{ metadata: { withMetadataKey: 'ARCPublishedFrom' } }]`
   — the key ARC stamps on every sample it writes, carrying the originating `body_metrics.id`.
   Source first because it is categorical (it covers every sample ARC ever wrote, including any
   predating the metadata scheme); metadata second because it is a plain key predicate with no
   source set behind it. Statistics queries get no exclusion on purpose: they return Apple's own
   merged cumulative totals, computed before any predicate, and ARC writes none of those types.
2. **Two failure postures for that ladder, and the difference is the point.** On a type ARC
   only READS, a ladder HealthKit exhausts falls back to an **unfiltered** query — losing the
   filter is harmless there and losing the data is not (readers swallow errors to `[]`, so a
   bad filter would silently empty the whole Data tab). On a type ARC also WRITES, the reader
   passes `failClosed` and returns **nothing** instead, reporting `exclusion: 'refused'`: there
   the unfiltered read *is* the echo loop, and a weight missing for one pass is recoverable
   where a duplicate is not.

   > The ladder is what was missing until 2026-08-26. The code picked **one** clause — source
   > when `currentAppSource` existed, metadata only when that API was absent or threw — so the
   > metadata rung was unreachable in the case that actually bites: the API present and its
   > *predicate* refused. On a `failClosed` type that is zero weight, forever, with no error
   > anywhere. The docs described a fallback the code did not have.
3. **Per-sample rejection** (`isIngestableSample`, pure and tested). A body sample is dropped
   if it carries the `ARCPublishedFrom` tag, or ARC's bundle id, **or no bundle id at all**.
   That last clause is the one that is easy to get backwards: *unknown source is not safe* on
   a type ARC writes. `SourceRevision.source.bundleIdentifier` is a non-optional string in the
   library's own types, so a null means the shape drifted — precisely the case a fallback
   exists for. An unattributable `BodyMass` sample cannot be shown *not* to be ARC's own
   reflection, and refusing it costs at worst a measurement still visible in the Health app.
   (Scoped to the body types only. Applying it to wearable reads would discard real vendor
   data, which is the mistake guard 5 warns about.)

   > ⚠️ The teeth in that clause are why the PARSER matters as much as the guard.
   > `sourceRevision.source` is a Nitro **hybrid object**, not a struct, and a parser that
   > cannot read one does not mis-source weight — it deletes it (§14). Since 2026-08-26 each
   > refusal is also counted by reason (`ingestRejectionFor`) and rendered, because
   > `unattributed: 14` and `arcTag: 14` are opposite diagnoses and used to be the same
   > silent zero. `isIngestableSample` is defined in terms of that reason-giver, so the guard
   > and the explanation cannot drift.
4. **The structural guard: `source <> 'apple_health'` on the publish walk.** Every other guard
   decides whether a sample *looks* like ARC's. This one decides that a value which came FROM
   Apple Health is never sent back TO Apple Health, whatever it looks like — so even if guards
   1–3 failed simultaneously and an echo landed as a row, the circuit still cannot close. It
   is also simply true: Health already has that number.
5. **Source bucketing** (`wearable_data` only). `com.arcresilience.app`, or the metadata tag
   alone, maps to `manual`. Without a case, ARC's bundle would fall through to `other` — index
   7 in `SOURCE_PRIORITY`, *above* `apple_health` (8) and `manual` (9) — and ARC would prefer
   its own reflection to both the merged Apple total and the user's keypad entry. `'other'`
   was deliberately **not** demoted: no wearable is chosen yet (CLAUDE.md §8), so an
   unrecognised ring landing in `other` is the expected state, and demoting it would make a
   real measuring device lose to a stale manual entry. A distinct `'arc'` device value was
   rejected because `source_device` is a CHECK-constrained enum — that is a migration, and
   numbering is forward-only. `manual` is also simply true: everything ARC publishes started
   as a number the user typed into ARC.

**The tripwire, and why it changed shape.** It used to be `readWriteScopeOverlap()`, asserted
EMPTY: nothing could echo while ARC read none of what it wrote. That was correct for a one-way
channel and became obsolete the moment reading weight back was the point — so the assertion
had to fail or be deleted, and neither is acceptable for a guard. What it was actually
protecting is kept exactly, in `unsuppressedEchoIdentifiers()`: **no type may be both read and
written without echo suppression behind it.** The overlap is now expected (and asserted to be
*precisely* the body channel, so an unnoticed fourth type fails CI too); what must be empty is
the overlap not covered by suppression. It still fires for the case that matters now — a new
write scope for a type already read on the ordinary, unfiltered-retry path. The suppressed set
is derived from `BODY_INGEST_METRICS` rather than written out, so it cannot claim coverage the
ingest path does not implement. Still a pure function, not a module-scope assertion: Expo
Router eagerly requires everything under `app/`, so a throw at import time is an app-**startup**
crash.

**When it runs.** Inside the same pass as ingestion (`syncHealthData`) — boot, foreground
(throttled 15 min), and Settings › Apple Health → *Sync now*. Same enable flag both
directions: *Turn off* stops writing too.

**Permission asymmetry.** Unlike reads, iOS reports share authorization truthfully
(`authorizationStatus(for:)`), so `healthWriteAccess()` returns a state that can be believed
and Settings says it out loud instead of assuming success. An already-connected user's read
grants predate the write scopes, leaving sharing `undetermined` — so the connected plate
grows an **Allow publishing** button in exactly that state, and only that state (iOS will not
re-present a sheet the user has already answered).

> ⚠️ **Ship the app.json string in the same binary.** iOS *terminates* an app that requests
> share types without `NSHealthUpdateUsageDescription`, at the ObjC level, where no JS
> try/catch can hold it. This JS must therefore never be delivered OTA to a build made before
> that key existed. **The window is real but historical:** the module landed 2026-07-31 and
> the string on 2026-08-12, so a binary cut in those twelve days has one and not the other.
> The owner's build is 2026-08-25 and carries both, and any build cut from `main` since
> 2026-08-12 does too. Keep the rule anyway — it costs nothing and the next person to install
> an old dev client is the one it protects.

**Still out of scope, and why each one stays out** — every candidate was re-checked when the
link went two-way:

- **Workouts and nutrition.** No column stores a HealthKit UUID, so a written workout or meal
  could never be deleted — and both are edited constantly. Needs a migration and its own
  slice.
- **Water** (`wearable_data.water_ml`). The row is a running daily TOTAL that the quick-add
  updates all day. Publishing an update appends another sample (there is no delete), and
  HealthKit would sum them — 500 ml logged three times would read as 3 000 ml. Wrong in a way
  the user cannot see, so: no.
- **Muscle mass** → `LeanBodyMass`. Not the same quantity: lean body mass includes bone,
  organs and water; a BIA muscle-mass estimate does not. Publishing one as the other puts a
  wrong number in a medical record under a correct-looking label.
- **Hip** — HealthKit has no hip-circumference type. **BMI/Height** — ARC stores no height, so
  BMI would have to be invented rather than owned.

## 11. Reading the body measurements back (2026-08-12)

The other half of the same three types, and the answer to "do we have full two-way sync?" —
which, before this, was **no, and weight was zero-way**: `BodyMass` appeared in neither
`SAMPLE_METRICS` nor `STATISTIC_METRICS`, so a smart scale syncing to Health had never reached
ARC at all.

| HealthKit type | → `body_metrics` column | Unit on the wire |
| --- | --- | --- |
| `HKQuantityTypeIdentifierBodyMass` | `weight_kg` | `kg` — canonical, no conversion |
| `HKQuantityTypeIdentifierBodyFatPercentage` | `body_fat_pct` | `%` — **×100**, see below |
| `HKQuantityTypeIdentifierWaistCircumference` | `waist_cm` | `cm` — canonical |

**Into `body_metrics`, not `wearable_data`.** That table owns these three columns, so a scale
reading has to reach the same trend, the same Coach tools and the same export as a number
typed into ARC. Landing it in `wearable_data` would have been easier and would have produced a
weight the Weight trend cannot see — two-way on paper only.

**The percent trap, in reverse.** `HKUnit.percent()` is a FRACTION, so a real 18.5 % arrives
as `0.185` and is multiplied by 100 on the way in. Stored raw it would read as 0.185 % body
fat — small enough to pass the 0–100 CHECK and poison every trend and correlation silently.
Inbound and outbound are asserted to be exact inverses as a **round-trip property**
(`fromHealthKit(toHealthKit(v)) === v`), not as two separate constants, so the pair cannot
drift apart one edit at a time.

**No migration.** `body_metrics.source` has admitted `'apple_health'` since 0001 — which also
means there is no `source_raw_id` column to key on, so the natural key does the job:
`(source = 'apple_health', measured_at)`. HealthKit start dates carry millisecond resolution,
so two distinct readings colliding is not a real case, and re-reading the trailing window
UPDATEs instead of duplicating. Scoping the key to the ingest source is what makes it safe: a
manual row is never matched, never merged into and never overwritten by a sync, whatever
instant it carries. Merging by instant is a feature — a scale reporting weight and body fat
from one weigh-in stamps both samples identically, and they belong in one row, exactly the
shape the keypad produces.

**Bounds are enforced in the mapper, before the INSERT.** `body_metrics` CHECKs weight `> 0
AND < 1000`, body fat `0–100`, waist `> 0 AND < 10000`. An out-of-range sample would throw and
take the whole batch with it, so the pure mapper drops it (after conversion — 1.5 as a
fraction is 150 %, and the bound belongs on the converted value).

**Window.** The same trailing span as ingestion (14 days steady state, 90 on first sync,
capped at 365). Rows are NOT run through `clampRowsToWindow`: that clamp exists for day
AGGREGATES rebuilt from a truncated tail, and these are individual measurements at their own
instants, so a sample from the span's half-day lead-in is a complete, correctly dated reading.

**Backfill is fine here, unlike outbound.** Ingest is reversible — the rows are ARC's own
database and the user can delete them — so the 90-day first sync applies. The asymmetry with
§10's no-backfill rule is the asymmetry between "data I can delete" and "data I cannot".

**Every read reports itself** (2026-08-26). `readQuantitySamples` returns the samples *plus*
which exclusion predicate survived and any native error, and the per-sample guards return their
rejections by reason. Settings › Apple Health renders both under **Last sync** as
`returned → rows` with the gap explained on the line beneath it. This exists because this
direction failed on the first device that ever ran it and nothing in the app could say where —
see §14.

---

## 12. Metric audit — what a Garmin can actually deliver (2026-08-14)

Answering the owner's *"quickly check over all the metrics we are trying to read from a
wearable — which are not able to be acquired from our Garmin CIRQA + Apple HealthKit setup?
Do some of them just need a week or two of data before they start transmitting?"*

**The headline used to be that none of this could run** — when this audit was written
(2026-08-14) the HealthKit native module was not in the app binary, `isHealthKitSupported()`
returned false, every read was a no-op, and Garmin CIRQA was syncing into Apple Health where
ARC could not see any of it. **The owner rebuilt on 2026-08-25 and the module is now in his
binary,** so that blocker is gone. What this section can honestly claim stops there: the
module is present. Whether Apple Health is handing rows over, and whether the per-metric
findings below hold in practice, is a device observation nobody has recorded yet — the table
is still assembled from documentation and from Garmin's published behaviour, and its four
`unverified` rows are still unverified.

The table's source of truth is **`src/lib/health/coverage.ts`**, not this file — it is what the
Settings screen renders, and `db/health-coverage.test.mjs` asserts that every read scope has a
row and every row names a real read scope, so the two cannot drift apart.

### The table

| HealthKit type | What ARC does with it | Garmin to Apple Health | Days before it reads |
|---|---|---|---|
| `HeartRateVariabilitySDNN` | Home **Recovery**, today vs 30-day baseline | NEVER | 6 (moot) |
| `RestingHeartRate` | Corroborates HRV; **becomes Recovery on its own** | Sends | 6 |
| `ActiveEnergyBurned` | **Raises** Home Strain (never lowers it); ledger | Sends | 6 |
| `SleepAnalysis` (+ stages) | Home **Sleep**; stages in the ledger | Sends | 1 |
| `StepCount` | Metrics strip, ledger | Sends | 1 |
| `HKWorkoutType` | Wearables workout list; Coach reads daily minutes | Sends | 1 |
| `BasalEnergyBurned` | Ledger only | Unverified | 1 |
| `OxygenSaturation` | Ledger only | NEVER | — |
| `RespiratoryRate` | Ledger only | NEVER | — |
| `VO2Max` | Ledger only | NEVER | — |
| `BodyTemperature` | Ledger only | Unverified | 1 |
| `AppleSleepingWristTemperature` | Ledger only | Unverified | 1 |
| `DietaryWater` | The Water record's day total, beside manual captures | **Unverified — nothing checked** | 1 |
| `BodyMass` | Body metrics, weight trend (also published **out**) | Sends | 1 |
| `BodyFatPercentage` | Body metrics (also published **out**) | Sends, flaky | 1 |
| `WaistCircumference` | Body metrics (also published **out**) | Unverified, leans no | 1 |

`DietaryWater`'s verdict is the weakest in the table and says so on purpose. It is not
"unverified after looking" like `BasalEnergyBurned` — **nothing was checked at all**, because
the scope did not exist when this audit was written and no source has been consulted since.
The premise that a Garmin writes hydration is plausible and unestablished. The test is one
evening: log a hydration entry on the watch, sync, see whether a row lands. It also matters
less than the others, because unlike HRV this scope has a second filler — any hydration app
already on the phone writes the same type, and that is most of the reason to read it.

**Never leaves Garmin Connect at all** — Body Battery and Training Readiness / training status.
Neither has *any* HealthKit type, so this is a platform fact, not a Garmin policy ARC could
wait out. ARC's Recovery pillar is its own derivation and does not need them.

### The four that will never arrive

**HRV, blood oxygen, respiratory rate and VO2max are not exportable from Garmin Connect.** The
Apple Health categories exist; Garmin does not offer toggles for them. This is a years-old,
still-open feature request with Garmin-staff acknowledgement as recently as 2024.

The consequence for Home is specific and worth stating plainly: **`hrvLevel` is the primary
Recovery derivation and it will never fire on a Garmin-only setup.** Recovery runs permanently
on the `rhrLevel` fallback (§6), which is the branch designed for exactly this and the reason
it exists. It is a coarser signal — a delta in bpm against baseline rather than a ratio — and
the Coach should be told the difference rather than left to assume HRV is merely missing today.

Those four are also the concrete answer to CLAUDE.md §8's *"direct vendor API only where
HealthKit lacks fidelity"*: **this is where it lacks fidelity.** If Garmin stays the device, a
direct Garmin Connect integration is the only route to HRV, SpO2, respiratory rate, VO2max,
Body Battery and Training Readiness. That is a real architecture decision and it is not made
here.

### "Do some just need a week or two?"

No — nothing needs a fortnight, and the wait is shorter than it looks:

- Anything that is only **displayed** reads from the **first sample**. Sleep, steps, weight,
  workouts and the ledger metrics show a number the day they arrive.
- Anything **graded against a baseline** needs `BASELINE_MIN_DAYS` = **5 prior days**, so the
  verdict appears on the **6th day** of readings. That is Recovery.
- **Strain is the one exception, and since 2026-08-25 it does not wait on a wearable at all.**
  It grades *yesterday* against your usual SESSION, so its gate counts sessions, not days:
  `STRAIN_MIN_SESSIONS` = **5 prior logged workouts**. On a four-day split that is a little
  over a fortnight — the only place in this document where the answer to the owner's question
  is "yes, about two weeks", and only because a rest day genuinely teaches a session baseline
  nothing. The pillar says how many sessions are left while it fills.

Before 2026-08-14 the screens did not say any of this: a pillar with a half-filled baseline
drew the same blank as a pillar with no data and the same blank as a pillar that could never
receive data. It now says which of the three it is (`Pillar.note`), and where a baseline is
genuinely filling it says how many days are left. A correctly-unknown metric that explains
itself is not a defect; a blank one is.

### Confidence

Garmin's own support article on Apple Health sharing is a JS-rendered page that could not be
retrieved, so the Sends/Never verdicts rest on Garmin Forums threads (including Garmin-staff
replies) and specialist coverage. The Unverified rows are genuinely unestablished, not soft
noes, and each records what was missing. **The cheapest way to close all four is empirical:**
open Garmin Connect → Settings → Connected Apps → Apple Health and read the live toggle list.

Garmin CIRQA is a real, current product (screen-free band, announced 2026-07-21) and syncs
through the same Garmin Connect pipeline as every other Garmin device — no source suggests it
gets expanded HealthKit export, so every verdict above applies to it unchanged.

---

## 13. The wearables workout log — fixed, not removed (2026-08-14, migration 0042)

The owner's report: *"there is a workout log that does not work well. It has lots of
duplicates. I don't think this is currently even being used anywhere, but we should probably
just remove this unless you think there is good value to be gained from fixing it."*

**Recommendation: keep it and fix it.** Three reasons.

1. **It is not unused.** Besides the Data › Wearables list, the Coach reads these rows —
   `src/lib/ai/tools/read-tools.ts` declares `metric_type = 'workout'` as *"Workout minutes
   (Apple Health)"* with `agg: 'sum'`. Deleting the log blinds the Coach to every session
   trained outside ARC, which for a wearable owner is most of them.
2. **The identity was already there.** The standing note that *"no column stores a HealthKit
   UUID"* is out of date for this table: `workoutRows` has always written the HK sample UUID
   into `source_raw_id`. What was wrong was the KEY built over it, which is a one-index fix.
3. **It unblocks the outward direction.** A stable, stored HK UUID is exactly what publishing
   workouts back to Apple Health would need in order to update or delete what it wrote.

### Why it duplicated — two mechanisms, not one

**(a) The idempotency key was too loose for a workout.** 0001 gave every ingested row
`UNIQUE (source_device, source_raw_id)`. That composite is right for day-bucket rows, whose
raw id `hk:<metric>:<date>` is the same string for every device, so the device prefix is what
keeps two rings' HRV apart. It is wrong for a workout: the HK UUID is *already* globally
unique, and qualifying it by device does not tighten the key, it **loosens** it.

And the device bucket is not stable. `sourceDeviceFor` buckets on `provenance.bundleId`, and
`provenanceOf` deliberately yields a **null** bundle id whenever a sample's `sourceRevision`
arrives in a shape the seam cannot parse — a null bundle falls through to `'other'`. Parse the
same sample successfully next pass and it buckets to `'garmin'`. Under the composite key those
are two rows, and every flip adds another.

Migration **0042** keys workouts on the UUID alone (a partial unique index, so day-bucket rows
are untouched) and the workout upsert rewrites `source_device` in its `DO UPDATE`, so a
re-bucket now corrects the label in place. The migration deduplicates first — a
`CREATE UNIQUE INDEX` over a violating table fails, and the runner's transaction would roll
the whole thing back and strand the device below 42 — keeping the best-sourced row per UUID by
the same `SOURCE_PRIORITY` order the read side arbitrates with.

**(b) One session, two recorders.** This is the one the UUID key cannot fix, and the one a
Garmin owner actually sees: a single run recorded by both Garmin Connect and the iPhone is two
genuinely distinct HealthKit objects with two distinct UUIDs. Both rows are true; listing both
is not, because the user did not do two runs. `recentWearableWorkouts` was the only wearable
read in the repository doing a bare `SELECT` with **no source arbitration at all** — every
other metric goes through `pickDailyMetric` — which is why it was the only one that looked
duplicated. It now collapses rows sharing more than half of the shorter session's span,
keeping the `SOURCE_PRIORITY` winner. Sessions that merely abut are not collapsed, and a row
with no readable time span is kept rather than silently dropped.

### Migration numbering

0042, not the 0039 this branch was briefed to take: 0039 (reports) and 0038 (knowledge) had
already merged to `main` before the work started, and 0040/0041 are held by branches running in
parallel. Numbering is forward-only — `pendingMigrations` filters `version > user_version`, so
a file numbered at or below a device's stamp is skipped silently, with no error and no tables.

⚠️ **Neither fix has been observed working**, because at the time it was written no workout
had ever been ingested — the module was not in the binary. It is in the owner's binary as of
2026-08-25, so ingestion is now *possible*; nothing here has been watched happening. On the
owner's device 0042's `DELETE` still affects zero rows, because the duplicates it removes
could only have been created by passes that never ran.

---

## 14. The weight that never arrived — what the library actually does (2026-08-26)

The owner, on the first day HealthKit was live in his binary: *"Weight sync with apple health is
not working in the read direction, possibly write as well."* Everything else appeared to arrive.
Weight, body fat and waist are the only three types ARC both reads and writes, so they are the
only three that run the echo-suppression path — and no device had ever executed it.

The three things §10 said could not be known without hardware were then read off the installed
library instead: `node_modules/@kingstinct/react-native-healthkit@14.0.2` ships its TypeScript
source, its Nitro specs **and its iOS Swift**, so most of what was guessed is checkable. Two of
the three guesses were wrong in ARC's favour; the fault was in ARC's own code.

### What the library actually does

| Question | Answer | Evidence |
| --- | --- | --- |
| Is `NOT: [{ sources: [...] }]` the grammar the native side parses? | **Yes**, exactly. `NOT` → `createAndPredicateForSamples` → `createPredicateForSamplesBase` → `createSourcePredicate` → `NSCompoundPredicate(notPredicateWithSubpredicate: HKQuery.predicateForObjects(from:))`, ANDed with the date predicate. | `ios/PredicateHelpers.swift` — `createNotPredicateForSamples`, `createSourcePredicate`, `createPredicateForSamples` |
| Does a *malformed* sources array fail closed? | **No — it fails OPEN.** `createSourcePredicate` returns `nil` when the cast fails, the whole NOT chain collapses to `nil`, and the query runs date-only. So a bad `sources` payload loses the exclusion silently; it does not empty the read. | `ios/PredicateHelpers.swift`, `createSourcePredicate` (the `sourceSet.count > 0` guard) |
| Is `sourceRevision` returned by default, or does it need a query option? | **Always returned. There is no option.** `serializeQuantitySample` sets `sourceRevision: serializeSourceRevision(sample.sourceRevision)` unconditionally, and `BaseObject.sourceRevision` is non-optional in the library's own types. | `ios/Serializers.swift`, `serializeQuantitySample`; `src/types/Shared.ts`, `BaseObject` |
| …so does guard 3 get a bundle id? | **Only if the parser can read a hybrid object.** `SourceRevision.source` is not a struct — it is a Nitro **HybridObject** whose `name`/`bundleIdentifier` are getters on a shared **prototype**, so it has no own keys and does not spread or stringify. The library ships `toJSON()` for exactly this. | `ios/SourceProxy.swift`; `react-native-nitro-modules/cpp/core/HybridObject.cpp`, `registerHybrids` |
| Does `undefined` from `saveQuantitySample` mean "saved"? | **No. It means failure**, and ARC's conservative reading was right: `let succeeded = try await saveAsync(sample:); return succeeded ? try serializeQuantitySample(...) : nil` — `nil` is reached only when `HKHealthStore.save` reported `success == false`. | `ios/QuantityTypeModule.swift`, `saveQuantitySample`; `ios/Helpers.swift`, `saveAsync` |
| Is `limit: 0` really "all"? | **Yes.** `getQueryLimit` maps `<= 0`, `NaN` and `Infinity` to `HKObjectQueryNoLimit`. | `ios/Helpers.swift`, `getQueryLimit` |
| Is `'cumulativeSum'` the right statistics token? | **Yes** — `StatisticsOptions` is a plain string union, and the Swift enum case is Nitro's lowercased codegen of it. | `src/types/QuantityType.ts`; `ios/Helpers.swift`, `buildStatisticsOptions` |
| Is `metadata` a plain object in both directions? | **Yes.** Nitro's `AnyMap` is `Record<string, ValueType>` in JS, so reading `sample.metadata['ARCPublishedFrom']` and passing `{ ARCPublishedFrom: id }` to a save both work. | `react-native-nitro-modules/src/AnyMap.ts` |

Also checked, and clean: all fifteen read identifiers and all three write identifiers are members
of the library's generated unions (`src/generated/healthkit.generated.ts`), so no Nitro enum
conversion can reject them; `NSHealthShareUsageDescription` and `NSHealthUpdateUsageDescription`
are both in `app.json`.

### The two defects, both in ARC

**1. The exclusion was a choice, not a ladder — and that is the read failure.**
`ownWriteExclusion` returned the source clause whenever `currentAppSource` existed, and the
metadata clause *only* when that API was missing or threw. The metadata rung was therefore
unreachable in the one case that matters: the API present and its **predicate** refused. On a
`failClosed` type a refused predicate returns nothing, so weight would be empty forever, with the
narrower predicate never attempted and no error recorded anywhere. §10 already described the
fallback; the code did not implement it.

It is now a ladder — source, then metadata, then (read-only types only) unfiltered — and nothing
is weakened: a published type still never reaches an unfiltered read, and exhausting the ladder
reports `exclusion: 'refused'` rather than looking like a quiet week.

This also explains the *shape* of the report. `readQuantitySamples` runs the exclusion for every
quantity metric, not just the body ones — but HRV, RHR and the rest pass `failClosed: false`, so
a refused predicate costs them the filter and nothing else. Only the three body types fail
closed. **A predicate iOS will not accept produces exactly the observed symptom: everything
arrives except weight, body fat and waist.**

**2. Provenance was parsed off a hybrid object as if it were a struct.**
`provenanceOf` read `sourceRevision.source.bundleIdentifier` directly. That is a prototype getter
on a Nitro hybrid, and the base `HybridObject` prototype registers a `name` getter of its own
(the hybrid's class name) that a derived `name` must shadow. `sourceRecord` now prefers
`source.toJSON()` — the library's own answer, a plain `{ name, bundleIdentifier }` built natively
— and falls back to direct property access. This matters because guard 3 refuses any body sample
with **no readable bundle id**: a provenance parser that cannot read the wire shape does not
mis-source weight, it *deletes* it.

**Verdicts.** Suspect 1 (filter grammar / fail-closed): **confirmed as the mechanism**, though
which predicate iOS refuses is still device-only. Suspect 2 (`sourceRevision` needs a query
option): **ruled out** — but the hybrid-object hazard behind it was real and is fixed. Suspect 3
(`undefined` means saved): **ruled out**; ARC was already correct, so *"possibly write as well"*
is the **armed-cursor design** (§10, rule 1) — the first pass publishes nothing on purpose — and
the screen now says so instead of reporting a bare zero.

### The sync log — because this must not recur silently

Every failure in this pipeline is deliberately silent, and each decision is right on its own: a
refused predicate returns `[]`, an unattributable sample is dropped, one bad day never sinks a
window. Together they made an empty read indistinguishable from a quiet week, so the only signal
left was the owner noticing a number had stopped moving. That is the least useful bug report a
system can force a person to write.

So every step now counts what it did, and Settings › Apple Health renders it under **Last sync**:

- per metric — samples HealthKit returned, rows that reached the database, which exclusion
  predicate survived, any native error text (clamped to 200 chars), and for the three body types
  the per-guard rejection tally (`arcTag` / `arcBundle` / `unattributed` / `outOfBounds` /
  `nonFinite`). `unattributed: 14` and `arcTag: 14` are opposite diagnoses with nothing in common,
  and used to be the same silent zero;
- outbound — attempted vs accepted overall and **per type** (a partial share grant is otherwise
  invisible), plus the armed cursor stated in words: *"Armed — your next weight, body fat or
  waist entry will publish."*

The guards themselves are untouched. `isIngestableSample` is now defined in terms of
`ingestRejectionFor`, so the reason-giver and the guard are one decision in two shapes and cannot
drift; no rejection was traded away to get the reporting.

**No migration.** A third key, `apple_health_log`, in the 0021 `health_sync_state` KV — the same
argument as the publish cursor: `key` carries no CHECK and `value` is free JSON. It holds the
**last run only**, overwritten each pass. Diagnostics, not history; a trend of syncs would be a
table and nothing here is worth one. `value` is `CHECK json_valid`, so the reachable corruption is
a wrong *shape* (a log written by an older build), and `parseSyncLog` re-derives every field, so
that reads as "no log" rather than throwing on the one screen a user opens when something is
already wrong.

⚠️ **What is still device-only.** Whether iOS accepts `NOT` over `predicateForObjects(from:)`, and
whether it accepts it over `predicateForObjects(withMetadataKey:)`. The ladder means ARC survives
either answer, and the log means the next run *names* the answer instead of leaving it to be
inferred from a number that stopped moving. If the owner's next sync shows Weight as `0 → 0` with
*"Apple Health refused both echo-suppression filters"*, both predicates are out and the fix is a
different exclusion mechanism — not more retries.

---

## 15. Hydration comes in, and never goes out (D2, 2026-09-14)

`HKQuantityTypeIdentifierDietaryWater` is a read scope. A hydration tap on a watch, in the
Health app, or in any hydration app already installed becomes an ARC row on the next sync —
which is the only path in the whole water feature that works when the phone is in another
room. The in-app half (the Log tab's water row) is in `docs/information-architecture.md`;
the spike that ranked both is `docs/spikes/water-fast-logging.md`.

**Three literals and an audit row. That was the whole change.**

| Where | What |
| --- | --- |
| `mapping.ts` → `STATISTIC_METRICS` | `{ water_ml, DietaryWater, hkUnit 'mL', unit 'ml', decimals 0 }` |
| `coverage.ts` → `METRIC_COVERAGE` | a row, `garmin: 'unverified'` (§12) |
| `settings-health.tsx` → `SYNC_SCOPES` | *Water (hydration)* · **In** |

No migration (`metric_type` is free text), no new dependency, no Info.plist key — a READ
scope needs `NSHealthShareUsageDescription`, which the plugin already supplies; it is
`NSHealthUpdateUsageDescription` that would force a rebuild, and that one is for `toShare`.
It rides the existing statistics pass: `sync.ts` already loops `STATISTIC_METRICS` through
`readDailyCumulative`, which is generic over the identifier and takes the HKUnit as a
parameter.

### The unit string is the load-bearing detail

**`'mL'`, capital L.** It is handed to `HKUnit(from:)` on the native side
(`ios/Helpers.swift` → `parseUnitStringSafe`, which throws on a string HealthKit will not
parse), so the authority is the library's generated `QUANTITY_IDENTIFIER_CANONICAL_UNITS`,
where `HKQuantityTypeIdentifierDietaryWater` is `"mL"`. That constant reproduces every other
spec in this file exactly — including VO2Max's parenthesised `ml/(kg*min)` — so it is
trustworthy here.

The library's **hand-written** `VolumeUnit` union disagrees: it is prefix-plus-lowercase-`l`,
which would suggest `'ml'`. The generated constant wins — it is derived from the real HKUnit
and the union is not, and `QuantityUnitByIdentifierMap` types this identifier as a bare
`string` precisely because the union does not cover it. A test reads the unit out of
`node_modules` and asserts it matches the spec, so a library upgrade that moves it fails the
gate rather than shipping a factor of a thousand into a health record.

### Why it must never be published — the echo argument, pinned

A statistics query **cannot** filter out ARC's own samples: Apple merges across sources
before the predicate runs, which is why `readDailyCumulative` reports `exclusion: 'none'`
rather than pretending otherwise. So if ARC ever published water, reading it back would
double it with no rung of the exclusion ladder able to intervene.

It cannot happen by accident: `publish.ts` walks `body_metrics` only, and
`HEALTH_WRITE_IDENTIFIERS` is derived from `BODY_PUBLISH_METRICS` (§10). Water lives in
`wearable_data`. Making water publishable would mean giving it a `body_metrics` column on
purpose. Three assertions keep it that way — water present in READ and absent from WRITE,
`bodySamplesFor` unable to emit a dietary identifier, and `unsuppressedEchoIdentifiers()`
still empty with the new scope in place.

### Two sources, one total, and NO dedupe

An inbound bucket is **one `apple_health` row per day** under `hk:water_ml:<date>`, in the
same table manual captures use. The day total sums both, and that is a decision, not an
oversight:

- there is nothing to match on — a merged day total has no per-drink identity;
- subtracting ARC's manual total would assume the bucket contains it, and it does not,
  because ARC publishes nothing;
- any heuristic dedupe (nearest amount, nearest minute) is a guess that silently deletes real
  intake.

So the rule is **behavioural: pick one door**, and Settings › Apple Health says so in a
sentence. A double is legible rather than mysterious — `/water` lists the two rows side by
side, the synced one marked *"From apple_health — edit it there"* and refused for editing by
the repository (`AND source_raw_id IS NULL`), so the correction is deleting the manual
duplicate. That the mistake is visible is what makes summing honest rather than a shrug.

Two further consequences, both accepted:

- **It does not appear on the Log tab's feed**, which filters `source_device = 'manual'`.
  Leave that filter alone: the Log tab is a record of what you *captured*, and a merged Apple
  total is a *reading*. `/water` is where the whole record lives.
- **Its `created_at` is the sync instant, not drink o'clock**, so it sorts into the day's
  entry list at sync time. A merged day total has no drink time to report; inventing one
  would be worse.

---

## 16. The re-window pass now DELETES what it did not produce (2026-09-14)

`docs/spikes/timezone-days.md` §1c named a defect the ingest path had from the start:

> *"`upsertWearableRows` only INSERTs and UPDATEs — there is no DELETE anywhere in the ingest
> path. If every sample that used to fall on a day migrates off it, no row is emitted for
> that day and the stale row from the previous zone is left standing, now describing
> nothing."*

The bucket key `hk:<metric>:<date>` embeds the date, so a sample that re-buckets from the 1st
to the 2nd writes a new row on the 2nd and orphans the row on the 1st. Readiness baselines
and every Coach correlation keep reading the orphan. A timezone trip is only the loudest
cause — a sample deleted in the Health app strands a bucket exactly the same way, and always
did. §4's claim that *"timezone shifts all converge on the next pass"* was true of the rows
the pass rewrites and silent about the rows it abandons.

**The fix.** When `upsertWearableRows` is given a `prune` window, the same transaction that
writes the batch also deletes every `hk:` bucket inside that window, for a metric the batch
produced, that the batch did not produce. Four scoping rules, each the difference between a
fix and a data loss:

1. **`hk:` raw ids only** (`GLOB 'hk:*'`, case-sensitive where `LIKE` is not). A manual
   capture leaves `source_raw_id` NULL and is untouched — the same line water's editability
   draws. A hand-logged glass is never deleted by a sync.
2. **Per metric, allow-listed by the caller AND produced by the batch.** Two independent
   guards. `sync.ts` allow-lists only metrics whose read reported no error; the repository
   additionally refuses to prune a metric that produced nothing. So a refused predicate, a
   denied permission or a native throw prunes nothing, and an empty batch can never empty the
   window whatever it was handed.
3. **Inside `[first, last]` only** — the same bounds `clampRowsToWindow` uses, so the
   half-day noon lead-in cannot reach back and delete settled history.
4. **Identity is `(source_device, source_raw_id)`**, matching the conflict key. Two devices
   reporting one metric on one day are reconciled independently: the read is not
   source-filtered, so anything still in HealthKit was re-emitted, and a device whose samples
   are gone loses its own row while the other keeps its own.

Workouts are out of reach by construction — their raw id is a HealthKit UUID, not an `hk:`
bucket key — and `sync.ts` leaves `workout` off the allow-list anyway so the intent is stated
rather than implied by a GLOB.

Deletions count into `rowsWritten`, because a delete is a change the pass made and a run that
only cleaned up would otherwise report *"0 rows changed"* on the one occasion that mattered.

`db/wearables.test.mjs` §20 pins all of it: the orphan goes, the moved row stands in its
place, the day reads as nothing rather than as a stale 60 ms, a manual capture in the window
survives, an out-of-window bucket survives, an unread metric survives, an empty batch prunes
nothing, a partial pass prunes only what it read, a UUID-keyed workout is untouched even when
allow-listed, and a rejected batch writes nothing and deletes nothing.

~~**Still open**, and explicitly not fixed here: the re-bucketing itself.~~ **CLOSED
2026-09-19 — see §19.** The prune made the pass converge *cleanly*; §19 is what makes it
converge on the *same* answer.

---

## 17. Ingested workouts are joined to ARC's own (D3, 2026-09-14, migration 0054)

Backlog **D3**, and the first slice of `docs/spikes/ingested-workouts.md`. The owner's ask:
*"auto-pair an ingested session with a manually logged one by time, pulling calories and other
data into the manual session."*

### 17.1 The defect it closes

§13 argued for keeping the workout log because *"the Coach reads these rows"*. That is true,
and it was also the bug: the Coach reads `metric_type = 'workout'` minutes through
`get_metric_series`, **and** reads `workouts` through `get_training_summary`. A session logged
in ARC and also recorded by the watch appeared in both, with nothing able to reconcile them —
one 60-minute lift plus a 40-minute walk could be reported as 100 minutes of training for the
lift alone. Pairing is what finally makes the subtraction possible.

### 17.2 The rule

**Overlap, not duration, and exactly one definition of it.** A manual session and an ingested
one are the same session when their spans share at least `SAME_SESSION_OVERLAP` (0.5) of the
*shorter* one — the identical predicate `recentWearableWorkouts` already uses to collapse the
two-recorder duplicate (§4). `overlapFraction`, `workoutSpan` and `SOURCE_PRIORITY` are now
exported from the wearables repository so pairing borrows them whole; a second threshold would
agree with the first only until one of them was tuned.

The manual side needs a span, which a `workouts` row did not have. **0054 adds
`workouts.started_at`**, nullable, and only the live logger writes it. Null means "no knowable
span", so a backdated log, a photo import and anything the Coach writes cannot be matched on a
clock at all. The migration backfills `created_at − duration_min` only where the row was
written on the day it is about, the duration is present and under six hours.

> ⚠️ **0054 concluded from that "never auto-pair", and the owner reversed it on 2026-09-21.**
> Those sessions now pair by **day** instead — §17.7. The span rule below is unchanged; it
> simply no longer has the last word on a session it cannot see.

**The day is an index filter; the overlap is the rule.** Candidates are pre-filtered to the
session's day ±1, because `workouts.date` is a LOGICAL day (it can start at 04:00) and
`wearable_data.date` is the calendar day the workout *ended* — one hour of training can
legitimately carry two day strings. Widening the filter cannot create a false pair: two
genuinely different sessions do not share a clock.

**Ties, stated and deterministic.** Two ingested rows over one session resolve by
`SOURCE_PRIORITY`, then the longer span, then `created_at`, then `id` — 0042's own ordering.
Two sessions over one ingested row resolve by iteration order (`date`, `started_at`,
`created_at`, `id`). Re-running the pass is a no-op: both sides exclude what is already
linked.

**When it runs:** at the end of every HealthKit sync *and* on workout save, because either
side can arrive second.

### 17.3 The link table, and why nothing is copied

`workout_ingest_links` (0054) holds `workout_id`, `wearable_id`, `linked_by` (`auto` | `user`)
and the `overlap` that justified an automatic link. **Its two unique indexes ARE the
one-to-one guarantee** — not the pairing code, because code is where a one-to-one guarantee
goes to die. Both sides `ON DELETE CASCADE`: deleting the ARC session frees the mirror to
re-pair, and deleting the ingested row (which a re-sync legitimately does) leaves the session
whole.

kcal, distance, duration and activity are **joined at read time, never copied**.
`wearable_data` is a mirror that corrects itself on the trailing window, so a copied calorie
figure would go stale with nothing to repair it — and it would be a second source of truth for
a number the app already holds. A hand link (`linked_by = 'user'`, written when the owner fills
in a blank) replaces an automatic one: an assertion outranks an inference.

### 17.4 What changed for the reader

- **Data › Wearables** still lists a paired session — this screen *is* the ingest record — but
  marks it `· logged in ARC`, so nobody counts it as a second workout.
- **The Coach's `workout` metric** now reports only sessions ARC has no log for, and its label
  and `aggregation` say so in words. `get_training_summary` gains `ingestedSessions` listing
  exactly those, with a note that they are already excluded from the totals above.
- **The Train hub** shows what the watch measured beside what the owner typed, and asks about
  strength-coded sessions it refuses to guess at (`docs/exercise-subapp.md` §11).

### 17.5 HR was deferred — it landed as D3b (§18)

kcal, distance, duration and activity are already stored by `workoutRows`. Avg/max HR *during*
a workout was not: it needed `HKQuantityTypeIdentifierHeartRate` added to the read scopes, a
row in `METRIC_COVERAGE` (its tripwire refuses a scope with no audit row, §12) and a
per-session query over the span. The owner's call was **ship pairing now, add HR once pairing
is observed working on device**. Built 2026-09-19 — **§18**.

### 17.6 Tests

`db/wearables.test.mjs` §21: two overlapping recorders produce exactly one link, attached to
the logged session, resolved to the `SOURCE_PRIORITY` winner, carrying `linked_by` and the
overlap; re-running links nothing new; a re-sync corrects the row in place without re-pairing,
and the corrected kcal is visible *through* the link; both unique indexes refuse a second link;
a non-overlapping hour and the same hour a day earlier refuse to pair; the span rule never
claims a session with no `started_at` (any link such a session carries records no overlap, so
it was not made here); one watch record can only ever be claimed once; the double-count goes
from 100 minutes to 40; the wearables list marks rather than hides; both CASCADEs behave; a
hand link replaces an automatic one and records no overlap.
`db/coach-tools.test.mjs` §38 pins the same defect at the tool boundary, across both tools and
the snapshot. The day rule's own tests are §17.7 below.

### 17.7 The DAY rule — a second way to pair (owner, 2026-09-21, **no migration**)

The owner, from the device: *"the apple health found workouts should be attempted to be linked
to workouts i've logged that are around the same time automatically."* Only the live logger
writes `started_at`, so in practice **most** of his sessions had no span and sat unpaired
forever beside the watch's copy of the same hour. §17.2's departure — *a session with no span
never auto-pairs* — is **reversed by that instruction**; the guard it was protecting (a wrong
pair nothing on screen would show as wrong) is answered by a one-tap unpair instead.

**The rule.** A logged session with `started_at IS NULL` on logical day **D** is offered the
unpaired ingested sessions whose own logical day is D, and then:

| the day holds | outcome |
| --- | --- |
| exactly one record | **pair**, with no tolerance consulted |
| several, and the log has a `duration_min` | the **closest duration** wins, and only if it clears the tolerance |
| several, and the closest still fails the tolerance | **nothing is linked** — failing a tolerance is an answer |
| several, and the log has no duration | **nothing is linked** — there is no ground left to choose on |

**"Exactly one" counts the day, not what is still unclaimed.** Two logs and two records on one
day: the first log takes the nearer record on duration, and the second is then judged on
duration too rather than inheriting a free pass because only one candidate remains. Otherwise a
25-minute walk rejected for one session would be accepted by the next one down the list, and
whether a pair happened would depend on iteration order.

**The tolerance is `DAY_PAIR_MIN_RATIO = 0.5`: the shorter of the two durations must be at
least half the longer.** It is the same 0.5 as `SAME_SESSION_OVERLAP`, applied to the only
quantity this rule can compare — the app has one number for "close enough to be the same
session". A 60-minute log and a 25-minute record are two sessions; a 60 and a 47 are one
session measured twice.

**The day is LOGICAL on both sides.** `workouts.date` already is; `wearable_data.date` is the
plain calendar day the session ended (§4 — the B3 boundary deliberately does not reach the
wearable pipeline), so the ingested side is re-read through `logicalDate` from its own
`end_time`, falling back to the stored `date` when there is no readable clock. The known cost
is stated rather than hidden: that re-read uses the device's *current* zone, so a session lived
abroad and re-read at home can land a day out. The span rule has no such exposure — it compares
instants — which is one more reason **it runs first**. The two rules are disjoint on the
`workouts` side (`started_at` present or not), so they can never fight over a session; they can
over a `wearable_data` row, and a clock beats a calendar.

**It runs exactly where the span rule runs** — inside `pairIngestedWorkouts`, therefore at the
end of every HealthKit sync and on workout save, over the same `PAIR_LOOKBACK_DAYS = 90`
window. So a phone that already holds months of both pairs its history on the next ordinary
sync; there is no backfill step and nothing to trigger. The **free-form logger** now calls the
pass on save as well (`app/workout-log.tsx`) — it never did, because nothing it wrote could
pair; that session is the one the owner is looking at, and it should be paired by the time the
hub redraws rather than at the next fifteen-minute sync. The call sits in its own `try`: the
session is already committed, and a pairing problem must not skip the draft discard and leave
him one tap from saving it twice. A **photo import** still waits for the sync, which is what
the retroactive window is for.

**How a link's method is read back — with no new column.** The link table already says it:

| `linked_by` | `overlap` | method (`PairedIngest.pairedBy`) |
| --- | --- | --- |
| `'user'` | NULL | by hand, from the blank inbox |
| `'auto'` | a fraction | **span** — the number *is* the justification |
| `'auto'` | NULL | **day** — nothing on the clock justified it |

Total, because the three writers are. A day pair therefore **says so where it is read**: the
watch line on the Train hub and in the session editor ends `· same day` (spoken: *"matched by
day, not by clock"*), and `get_training_summary` adds `watchPairedBy: "same day"` to that row —
omitted for a span pair, which shares a clock and needs no caveat.

**Unpairing, and the refusal.** `unlinkIngestedWorkout` is one tap on the watch line in the
session editor: no confirmation, because nothing of the owner's goes — the sets stay, the
watch's record stays, and what is discarded is an inference. It must not come back on the next
sync, and it does not: the pair is recorded as a **refusal** which both rules consult. It is
recorded for the *pair*, not for either row alone — the owner said these two are not one
session, not that this session was never recorded. A hand link clears any refusal touching
either side: an assertion outranks having once refused one.

The refusals live in `health_sync_state` under the key `'workout_pairing'` — a **second key**,
never a field on the `'apple_health'` cursor row, which is named for the sync cursor. 0021
shaped that table as one row per key with free JSON, and 0060 already used the freedom for a
second cursor. **No migration is possible on the link table anyway**: `linked_by` is
`CHECK (linked_by IN ('auto','user'))` so there is no third value, both id columns are NOT NULL
so there is no tombstone shape, and a kept row would sit inside the two unique indexes —
blocking both rows from ever pairing again — while reading as a live link to `pairedIngestFor`,
the Data-tab list and the `UNPAIRED_WORKOUT` predicate. A refusal is not a link. Each entry
carries the logged session's `date` and is pruned once a pass's window no longer reaches it, so
the list is bounded by the lookback rather than growing forever.

**Tests.** `db/wearables.test.mjs` §23: the unique case pairs and records `auto` + NULL
overlap, reads back as `pairedBy: 'day'` and prints `· same day`; the pass is idempotent; a log
with no duration pairs when nothing competes; three records on a day hand the 60-minute log the
47-minute one; a 25-minute record against a 60-minute log is refused on the tolerance; two
candidates against a log with no duration are refused; an adjacent day does not pair; a
contested record goes to the session sharing its clock; one record is claimed once however many
span-less sessions share its day; a 60-day-old pair is made on an ordinary pass while a
120-day-old one is out of the window; unpairing drops the link, records the refusal, survives
the next pass, returns the record to the unpaired reads, and is cleared by a hand link; and a
refusal outside the window is pruned. `db/training-engine.test.mjs` §9 pins that a day-paired
session infers **zero** and the freshness ledger is byte-identical — the same firewall a span
pair gets. `db/coach-tools.test.mjs` §45 pins the single count across both tools plus the
`watchPairedBy` field and its absence on a span pair.

---

## 18. Heart rate during a workout (D3b, 2026-09-19, **no migration**)

The second half of D3, and the plan is `docs/spikes/ingested-workout-heart-rate.md`. The
figure lives in the workout row's `metadata` JSON — free-form since `0021` — so there is no
table, no migration and no native module. One read scope, two `WorkoutProxy` methods and one
module method already present in `@kingstinct/react-native-healthkit@14.0.2`.

**The owner answered all five of the plan's questions (a).** Neither Home pillar moves; no
zones; shown on the Train hub, in the session editor, on the Data › Wearables row and in the
Coach's training summary; the intraday curve is not stored; door 1 unfloored, door 2 floored.

### 18.1 Which figure, and in what order

Per ingested workout, stopping at the first that yields a number:

1. **The workout's own statistic** — `WorkoutProxy.getStatistic(HeartRate, 'count/min')`. What
   the Health app prints under the session, hence first, and **unfloored**: it is the writer's
   own association, and the Health app does not floor it either. `method: 'workout'`.
2. **The source's own samples over the span** — `queryStatisticsForQuantitySeparateBySource`
   with `discreteAverage` / `discreteMax` over `[startDate, endDate]`, then the response
   belonging to the workout's own writer picked by `bundleIdentifier` in JS. The same exported
   samples without the association. `method: 'source'`, **floored** (§18.3).
3. **Nothing.** No key is written and the line prints no heart rate. An absence is an absence,
   not a zero — the rule `statisticDailyRows` already applies to a zero-value day.

`pickSourceStatistic` is the load-bearing half of door 2 and is pinned against a
**mixed-source fixture**. Door 2's query is a *date-only* predicate, so a phone in the owner's
pocket and a second wearable are both in the response set; a Garmin session showing an average
dragged toward resting by the phone would be wrong in a way no screen could show.

`strictStartDate` is deliberately omitted. `readDailyCumulative` passes it so a sample
straddling midnight is summed into one day; a heart-rate sample is a *point*, so overlap and
strict coincide — and for an interval sample, overlap admits one that began just before the
workout (negligible in a time-weighted hour) where strict would drop every session's first
reading.

**Door 3** (`filter.workout` as a sample query) is door 1's constraint with a longer round
trip and can never return more than door 1 averaged. Not taken.

### 18.2 Where it lives, and what it is not

```
metadata: { activity, activity_type_raw, kcal, distance_km,
            hr: { avg: 142, max: 171, method: 'workout' | 'source' }, hk: { source } }
```

Integers, bpm. **`hr` absent means "not available"** — never null members, never zeros, and no
`samples` field, because neither door reports a count and the floor gates whether the key is
written at all. It is spread in, so a `null` cannot reach the CHECK-validated JSON; a test
asserts that on the *serialised* string. Both decoders — `decodeIngested` and the inline parse
in `recentWearableWorkouts` — read it through one shared `readWorkoutHr`, because two readings
of "a usable figure" would agree right up until one of them was tuned.

**`HKQuantityTypeIdentifierHeartRate` must never enter `SAMPLE_METRICS` or
`STATISTIC_METRICS`.** A daily mean of all-day heart-rate samples is a number with no meaning
— a rest day and a race day produce the same kind of row — and it would sit one `metric_type`
string away from `rhr`, which *is* a baseline the Recovery pillar reads. The scope is claimed
by the workout path alone, the ingest-path assertion names it, and a test asserts that a store
full of figures still makes `wearableMetricInventory` list no heart-rate metric.

**Columns on `workouts` were rejected** — that breaks `0054`'s nothing-copied rule — and so
were **per-workout `wearable_data` rows**, which would put a per-session figure into a
per-(day, device) model built for day aggregates. `hk.source` already lives in this same JSON:
it is the established carrier.

### 18.3 The floor, said plainly

**At least six of the span's first 48 samples must be the writer's own**, or door 2's figure is
withheld. One bounded `queryQuantitySamples` per unanswered session, with
`sources: [proxy.sourceRevision.source]` and a JS post-filter on the bundle id.

The post-filter is the control, not the predicate: `ios/PredicateHelpers.swift` returns nil for
the whole `sources` clause if the `SourceProxy` cast fails, which collapses the query to
date-only. The post-filter still holds, and a second writer would then have to contribute 43
of the first 48 samples to withhold a figure — the conservative direction, a blank rather than
somebody else's number.

Door 2's figure is one **ARC derives**, not one the writer asserted, which is the whole reason
it is floored: `avg 142` from four samples of a sparse export is a claim ARC would be making in
the owner's own mono voice, and a blank line is honest. Door 1 stays unfloored for the mirror
of that reason.

### 18.4 Which sessions, each pass

**Door 1 runs for every workout in the window, every pass, with no skip set** — deliberately:
it is how a revised association lands, and the upsert's `CHANGED` guard stays the arbiter of
whether anything is actually written. **Door 2 runs only where door 1 answered nothing and the
stored row has no `hr`**, from one `json_extract(metadata, '$.hr') IS NOT NULL` query
(`workoutUuidsWithHr`). **No cap:** steady state is the 14-day window, so at most two bounded
queries per unanswered session in a fortnight. A session door 2 found nothing for is re-probed
each pass while it is in the window — how a late Connect export lands — and frozen when it
leaves.

**The re-read matters as much as the ask.** The steady-state window is a fortnight, the 90-day
backfill runs only on a first sync, and `get_training_summary` looks back 28 days. Without a
one-time 90-day pass most of the history every heart-rate surface feeds would stay blank
however the sheet was answered, so the Settings control passes `syncHealthData` a `windowDays`
override. An override rather than clearing `firstSyncedAt`, whose re-stamp is conditional on a
pass having written something precisely so a denied permission cannot burn the backfill.

### 18.5 The error posture, and the one failure worth reading

`readWorkouts`'s parse loop had **no try/catch of its own**, and a throw there left the
function entirely — which `syncHealthData` awaits *before* the upsert, the cursor and the log,
so the pass's rows were discarded and Settings kept the previous log. Adding a per-session
native call to that loop without a guard would have made that silent total failure reachable
for the first time. The loop is now `collectWorkouts(items, probe)`: a rejecting probe costs
that session its `hr` key and nothing else, and the first error text is kept for the log. The
probe is *injected*, so the whole posture is testable with no native module present — the
`ownWriteExclusions` precedent.

**The real failure mode is the loud one.** With a unit override supplied, `getUnitToUse` has
exactly two outcomes: the override, or a rejected promise. So a wrong override string rejects
`getStatistic` for *every* workout — door 1 dead for the whole feature — while the
`getAllStatistics` diagnostic, which supplies no override and cannot fail on units, keeps
happily reporting *associated: HeartRate*. Only the log row's error text tells that apart from
"Garmin is silent", which is why §18.11 says to read it first.

### 18.6 The sync log's `workout_hr` row

One `HealthMetricLog` row: `metric: 'workout_hr'`, `returned` = workouts examined this pass,
`rows` = workouts that produced a figure, `exclusion: 'none'` (statistics carry no own-write
exclusion), `error` = the first probe error, and a new optional `detail` —
*"associated: HeartRate, ActiveEnergyBurned · by workout 0 · by source 12"*, from
`getAllStatistics` on the newest workout only, identifier **names** and never its
preferred-unit values.

`parseSyncLog` re-derives every field and drops unknown ones, so `detail` reaches the screen
only because the parser learned it. `metricNote` gains a `workout_hr` branch **ahead of the
generic ones**, because the generic error branch fires only when `returned === 0` and this
row's error arrives with `returned > 0`: every workout *was* read; the heart-rate call inside
the loop is what was refused. The branch reads, in order, a non-null error, then the
declined-grant sentence at `returned > 0 && rows === 0`, then the detail — and falls through to
"Nothing recorded in this window." on a phone that has never recorded a workout.

### 18.7 The ask, and exactly when the control shows

Settings › Apple Health renders **Read heart rate (90 days)** while `enabled` **and either**
something is unasked **or** the last `workout_hr` row reads `returned > 0 && rows === 0`.

Honestly stated: on a **fresh install** `enable` stamps every scope and the control never
appears; on an **existing install** it appears once and iOS presents a sheet for Heart Rate
alone. It **stays visible after an ask that produced nothing**, because that is the one state
in which tapping again can change something — if the sheet was declined iOS will not
re-present it, and the only recovery is **Settings › Privacy & Security › Health › ARC › Heart
Rate**, which the row's note says. It disappears once a figure lands.

Not folded into `syncHealthData`: that runs on every foreground, so the sheet would appear over
whatever screen the owner had returned to. The house precedent for a late scope is a control
rendered only while it applies (`allowPublishing`).

**A phone with no watch.** Then the scope is asked once, the control shows once and never
again, the `workout_hr` row reads `0 → 0` with the existing *"Nothing recorded in this
window."*, the coverage row reads *Unverified*, and no line on any screen changes — the
footprint the `workout` row has had on such a device since `0021`.

### 18.8 What it feeds, and what it must not

**Feeds.** The Train hub's watch line (`Garmin · 612 kcal · 8.4 km · avg 142 · max 171 bpm`),
the session editor — which had loaded `stored.ingested` since `0054` and never rendered it —
the Data › Wearables row, and `get_training_summary` on both `recentSessions` (through the
0054 link, `w.id` selected as a join key and never emitted) and `ingestedSessions`. Omitted
rather than nulled, on the rule already applied to `away` and `setMetres`.

**Two strings, not one.** `ingestDetail` gains a `{ spoken: true }` variant — *"average heart
rate 142, peak 171 beats per minute"* — because whatever an `accessibilityLabel` says,
VoiceOver speaks, and `avg 142 · max 171 bpm` read aloud is a string of tokens rather than a
measurement. The Train hub and the editor each compute both.

**The two derivations are shown identically, on purpose.** Both are HealthKit's own
time-weighted average and maximum over the writer's *exported* samples for the span; door 1
differs only in that the writer associated them. A `max` below the watch face is therefore
Connect's export cadence, not which door answered, and applies to both equally — marking one
*"from samples"* would claim a distinction the numbers do not have. `method` stays in metadata
as a diagnostic and is never rendered.

**No signal colour.** The firewall marks biological *state*, and a bare 142 has no verdict:
what it means depends on the load, which ARC does not hold.

**Must not feed.** *Strain* — the owner moved that pillar off wearables onto ARC's logged
volume; a heart-rate input would be a third instrument under `max()` and a wearable derivation
re-entering the pillar. *Recovery* — argued, not waved off: it is one-legged on a Garmin (no
HRV at all), and in-workout heart rate is the one new cardiac signal a Garmin might deliver.
Not taken for a reason stronger than "not resting": **heart rate at a moment of training is a
function of the load at that moment**, and ARC holds no load control — no pace, no power, no
grade. A session average 8 bpm above the last four could be fatigue, illness, heat, or a
harder run; 8 bpm *below* could be fitness or parasympathetic suppression. The sign is
ambiguous without the load, so a deterministic corroboration in `deriveReadiness` would be a
clinical rule hardcoded from a confounded signal. The Coach, holding the session list *and*
the RHR baseline, can say *"your easy runs ran 8 bpm high this week at the same pace"* and
qualify it. The honest corroborator would be heart-rate *recovery* after exercise — another
unverified Garmin row for another day. `db/readiness.test.mjs` §11 asserts the non-effect.

*Freshness, volume, pairing* — nothing. `ingestedMuscleLoads` doses by duration and role
weight, and an intensity multiplier is a second model of the same hour, which the D3 spike
rejected; volume reads `workout_sets`; pairing is span overlap, one definition.

**No zones, and no sentence in a tool description.** Zone minutes need a threshold ARC does not
hold, and a per-session *average* says almost nothing about time in zone — fifty minutes
averaging 142 could be forty at 135 and ten at 170. The Coach interprets the numbers against
the owner's age and resting-HR baseline; the turn context carries that age only when
`users.date_of_birth` is set and otherwise says *"profile not filled in"*, so the model knows
to ask. That is the house rule (judgment in the model) rather than a description sentence
pre-empting it. Coach cost is therefore **payload only**: the schema budget is unchanged at
~9,236 of 9,250. If a transcript ever shows `max` being misread as resting, one sentence is
the fix and it is affordable.

### 18.9 The coverage row, and the boundary

`METRIC_COVERAGE` gains *Heart rate during workouts*, `garmin: 'unverified'`,
`verdictDays: null`. Unverified is **not a soft no**: nothing in this repository establishes
that Garmin Connect writes in-workout heart-rate samples to Apple Health at all, at what
cadence, or whether it associates them. The note ends with the sentence that matters most —
*"A blank can also mean the read grant was declined — iOS never tells ARC. Check Settings ›
Privacy & Security › Health › ARC › Heart Rate before reading a zero as a Garmin fact."*

**The boundary, said plainly.** After the re-read, a session with no clause is either both
doors empty or older than 90 days when the scope landed; a session entering the store *after*
the re-read is re-probed for fourteen days and then frozen.

**`0053`, `0055` and the day boundary are all moot.** The figure is keyed to a workout, not a
day. `0053`'s timezone days withdraw votes from *baselines*, and this figure enters none;
`0055`'s away bit governs load *comparison* on `workouts`, and the ingested row is compared to
nothing. Neither reads the new key.

**The link-to-loser edge is documented, not fixed.** `0054` never revisits a link, so a
session paired to a phone row before the watch's copy arrived keeps reading the phone's — the
Data tab's duplicate collapse shows the watch's. Heart rate simply inherits that.
`db/wearables.test.mjs` §22 pins it as a statement of current behaviour.

### 18.10 Tests

`db/health-mapping.test.mjs` §16–22 — the statistics parser and its unit branch, door 2's
selector against a mixed-source fixture, the floor as the query delivers it, the loop's error
posture, `metadata.hr` present/absent on the serialised JSON, THE invariant,
`unaskedReadScopes`, and the log row's `detail` and note. `db/health-coverage.test.mjs` §5 —
the audit row. `db/wearables.test.mjs` §22 — the skip set, the `CHANGED` guard, the metric
inventory, both decoders, the absence, the link-to-loser edge. `db/coach-tools.test.mjs` §43 —
both payload lists, the omitted field, the id kept out, and no heart-rate sentence in the
description. `db/readiness.test.mjs` §11 — the non-effect on Home. `db/screens-render.test.mjs`
— the Settings fixture's `workout_hr` row and its sentence.

### 18.11 What only a device can settle

Every item presupposes the next EAS build — the owner's phone has never run `0054`'s pairing
and cannot run this.

- **Step 0.** iOS Settings › Privacy & Security › Health › ARC — confirm *Heart Rate* is on,
  and only then read the `workout_hr` row. A `31 → 0` before that check is not a fact about
  Garmin.
- **Whether Garmin Connect writes in-workout heart rate to Apple Health at all**, and at what
  cadence. One workout: Health › Heart › Heart Rate, filter to Garmin, look at the hour; then
  tap *Read heart rate (90 days)* and read the row.
- **If the row shows an error, read the error text before concluding anything about Connect.**
  A rejected `getStatistic` on every workout produces `rows 0` while the detail line still says
  *associated: HeartRate*: door 1 is wrong, not Garmin silent. Confirm iOS 16 or later — both
  statistics methods are gated `if #available(iOS 16.0, *)` and return nothing below it, so an
  empty door 1 there says nothing about Connect either.
- **Whether door 1 ever answers for a Garmin workout** — the detail line's *associated:* list.
  If everything arrives *by source*, door 1 stays for a future Apple Watch.
- **The real session count, and door 1's cost.** `SELECT count(*) FROM wearable_data WHERE
  metric_type = 'workout' AND date >= date('now','-90 days')` — the re-read costs about twice
  that in round trips, and it is the figure any future cap argument starts from.
- **Whether `sources: [proxy.sourceRevision.source]` survives the cast** (confirmation only —
  the JS post-filter is the control), and **how far the source-derived `max` sits below the
  watch face's**: cadence in another form, applying to both doors.
- **The two rows and the control.** Whether `avg 142 · max 171 bpm` reads as one line under a
  session title at 10 pt mono on the Train hub; whether the Wearables right column, now three
  lines deep, still sits cleanly in its `min-h-[44px]` row; how the spoken form sounds in
  VoiceOver; and whether *Read heart rate (90 days)* appears where it should — the headless
  render cannot see it, because under node the connected plate takes the "Rides the next build"
  branch (its visibility *rule* is pinned pure instead).

---

## 19. A day is the day it was LIVED in (2026-09-19, no migration for this file)

`docs/spikes/timezone-handling-intelligent.md` §3e, owner's **Q4(a)**. §16 closed the debris
the re-bucketing left behind. This closes the re-bucketing itself.

### 19.1 The defect, in one sample

A HealthKit sample is an absolute instant. ARC re-derived a calendar day from it at map time
under the device's **current** zone, and the sync is a trailing re-aggregation over the last
14 days — so **the first sync after landing re-dated the previous fortnight**. An HRV reading
taken at 20:00 on 1 September in Los Angeles is `2026-09-02T03:00Z`; read under UTC+1 it is
04:00 on the **2nd**. `hk:hrv:2026-09-01`'s mean was recomputed from a different set of
samples days after the fact, and the readiness baselines and every Coach correlation read the
new answer. Since §16, the prune then deleted the bucket the re-dating orphaned.

The direction of travel in D4 is to re-attribute **less**. `src/lib/db/repositories/day-meta.ts`
names this path as *"the one place ARC already re-attributes … is the bug, not the model"*.

### 19.2 The rule

> **A sample is bucketed under the offset that was in force when it happened, not the offset
> in force when it is read.**

`offsetAt(rows, instant)` (`src/lib/timezone/offset-history.ts`) is a pure **three-branch step
function** over the `timezone_changes` rows:

| Where the instant falls | Answer | Why that one |
| --- | --- | --- |
| **Before the first row** | `rows[0].from_offset_min` | This is the **outbound leg**, and it is the branch that matters. Sending pre-departure instants to the live getters would re-bucket every one of them under the destination — the defect, reintroduced for the commonest trip there is. |
| **Between two rows** | the earlier row's `to_offset_min` | What the phone arrived in and stayed in. |
| **After the latest row** | `null` — use the live local getters | They are DST-correct for the zone the phone is actually in, and this table is not. |
| **Empty table** | `null` everywhere | A build that never observed a change behaves byte-identically to one without this code. |

Threaded through `localDayOf`, `quantityDailyRows`, `sleepDailyRows`, `workoutRows`,
`syncDayWindows` and `sampleQuerySpan` — the same lookup instance per pass, because the window
that queries the samples and the function that buckets them must be the same day definition or
the `hk:<metric>:<date>` key misses. Read once and closed over: a 90-day pass maps tens of
thousands of instants, and the table holds tens of rows a year.

### 19.3 The day's bounds, and the seam day's real length

A day's **start** is its midnight under the offset in force on it, probed at that day's NOON
(noon exists in every zone on every day; a midnight probe would be asking about the boundary
it is trying to place). A day's **end** is the NEXT day's start. So a seam day's bounds come
out spanning its true `24 + Δ` hours with no special case — start under the old offset, end
under the new — and a nine-hours-east flight makes the 12th a 15-hour window rather than a
24-hour one with nine hours clipped off.

The **noon lead-in** (§4's 12-hour cushion, *"noon exists in every timezone on every day;
midnight doesn't under DST"*) is now taken in its own day's zone, so a date-line hop cannot
shift the cushion out from under the night it exists to cover. **The 12-hour limit itself is
unchanged**, and so is what it costs: a Pacific hop can still truncate the seam night, which
is the night the seam day owns anyway.

### 19.4 The one-time reach back — and why it is usually empty

§16's *"the fix is a re-bucket MIGRATION over the stored samples"* was owed a rebuttal, and it
is this: **ARC stores no samples.** It stores `hk:<metric>:<date>` aggregates, so there is
nothing for a migration to walk. The only way to re-bucket is to read HealthKit again, and a
sync pass *is* that read.

`rebucketWindowDays` is therefore the migration, spelled the only way this data model can
spell one: while `rebucketedAt` is unset, the window widens back to the oldest row's own day,
capped at `FIRST_SYNC_DAYS = 90`. Three properties:

1. **No rows, no widening.** With an empty table the step function is `null` everywhere and
   the pass is identical to the one before it. This is what makes shipping this in the same
   binary as `0053` a no-op on first launch — **the risk moment is the first sync after the
   first observed TRIP**, not the first launch.
2. **Only back to the oldest row.** Further back, no row speaks for the days and the answer is
   unchanged by construction.
3. **Stamped once a pass has both landed data AND had rows to widen for**, so a denied
   permission cannot burn it and neither can a build that simply has not travelled yet.

`rebucketedAt` rides the `health_sync_state` JSON — **no migration**, exactly as `0021` wrote
down when it left that value free.

### 19.5 The pass observes before it windows

`syncHealthData` calls `observeTimezone(db, now)` before it computes anything — a third
sanctioned observation site beside the database open and the foreground listener, and the only
one that is there for an **ordering** rather than for coverage. A change ARC had not yet
recorded would send the whole window to the live getters and re-bucket the fortnight under the
new zone, which is the defect. The foreground listener normally gets there first
(`app/_layout.tsx` registers it above the health sync); this makes the pass self-sufficient
rather than dependent on that. `db/timezone.test.mjs` §20 asserts the ordering **inside the
pass**, not a subscription order, because the subscription order is a soft dependency.

### 19.6 The price, stated plainly

**ARC and the Health app can disagree about trip-adjacent days.** §3's rule 2
(*falsifiability* — "ARC's steps for a day must equal what the phone shows for that day") is
the one thing this change spends. ARC's steps for the 11th stay the Los Angeles sum while the
Health app, if it redraws history in the current zone, shows the London sum until the user is
home. That is a documented rule being changed, and it is the owner's call (Q4(a)): a history
that does not rewrite itself, in exchange for a disagreement on the days around a flight.

Three residuals, none of them fixed and all of them bounded:

- **Observation lag.** `changed_at` is when ARC looked, not when the plane landed, so samples
  in that gap bucket under the old offset — inside the seam day, which is marked and already
  excluded from the baselines.
- **DST inside a foreign zone.** A zone's own shift writes no row, so a day under a stored
  foreign offset is an hour out for the rest of that stay. Only a sample within an hour of
  midnight could change day on that, and no wake reading is.
- **The upsert key.** A frozen day and a re-bucketed seam day collide only at the seam, where
  the seam day owns the key.

`HKMetadataKeyTimeZone` was considered and **rejected for bucketing**: the value is an
`NSTimeZone` *name*, and a name becomes an offset at an instant only with tzdata or `Intl`,
neither of which Hermes has. A hand-rolled name-to-offset table is tzdata by another spelling
that goes stale the year a country changes its rules. It buys zone *identity*, not an offset —
still potentially useful for flagging a trip ARC never observed, and still deferred.

### 19.7 Rollback

Nothing here is unrecoverable. The prune reaches `hk:` buckets only (§16 rule 1), HealthKit
still holds every sample, and "undo" is: revert the code, clear `firstSyncedAt` in
`health_sync_state`, and let one pass re-read 90 days under whichever rule the code carries.
The ARCB1 snapshot is the other way back, and §8 item 1 of the spike puts a **verified restore
before the first flight** on the build that carries this.

## 20. A blank is one tap from a sync (2026-09-23, **no migration**)

Owner, from the device: *"new method for HRV + other data from garmin? — when hrv is blank, put
quick apple health sync button there"*. This section is the second half only. A different route
for Garmin data is being researched separately, and nothing here is Garmin-specific.

### 20.1 What changed on Home

Any cell of the metrics strip (Sleep · HRV · Resting HR · Steps) whose reading has not arrived
today stops being an em-dash and becomes a control. It costs nothing extra to do all four rather
than HRV alone: a sync is one pass for every metric, so the four cells share one state. The
decision is pure and lives in `src/lib/home/metric-sync.ts` (`metricSyncCell`). The facts it
reads are gathered by `src/hooks/use-metric-sync.ts`, and the control is drawn by
`src/components/home/metrics-strip.tsx`.

| State | What the blank cell shows | Why |
|---|---|---|
| A reading | Unchanged | The control only ever replaces a blank |
| Module absent (web preview, an older build) | The plain blank, unchanged | A sync cannot run. Settings › Apple Health in that build has nothing to switch on, so a door there would lead nowhere. The readiness line already names the cause |
| Sync switched off | **Connect ›**, then "Apple Health sync is off". Opens Settings › Apple Health | Enable is the one tap that makes a sync possible, and "No data yet" would imply something is on its way |
| HealthKit unavailable on the device | The plain blank | A pass returns `unavailable`, and no switch changes that |
| Apple Health sent none of this metric on the last pass | The blank, with "Apple Health sent none in 14 days" beneath it. **No button** | The brief's "instead of offering the same button forever". See 20.3 |
| A pass is running, from anywhere | Spinner + **Syncing**, disabled | Visible, and cannot be started twice (20.2) |
| The last pass this control waited on threw | **Sync Apple Health**, with "sync failed at 09:14" | Quiet and honest, with no alert, and the retry is still there. A later successful pass supersedes it |
| Otherwise | **Sync Apple Health**, with "none as of 07:02" (or "not synced today", "never synced") | What the last pass found, stated beside the verb |

"None as of" is only quoted when the last pass completed after today's day began. A pass from
last night never looked at today's bucket, so quoting its time would claim a check that never
happened.

The control replaces the value slot and is held to its 28pt line, so a cell is the same height in
every state and nothing is added around the grid (CLAUDE.md §5). **It takes no accent.** Home's
accent budget is the hero, the completion stamps and the active tab, and 00-design-spec.md allows
one primary action per screen, which on Home is the hero's. A sync is a housekeeping verb beside
a reading, so it is set in the label voice, in ink, with a sync glyph. That is the register of
`PROTOCOLS ›` / `PLAN ›` under the mission, not a filled button. It takes no signal colour
either: the control is chrome, not biology.

When the pass lands, `emitSynced` re-reads the numbers through `useReadiness`, the same way a
foreground sync always has. The control re-reads the cursor and the log on the same event, and
again when the pass settles.

### 20.2 One pass at a time: the gate in `sync.ts`

Nothing used to stop two passes running at once: the foreground hook, Settings' *Sync now*, and
now this control. That is harmless to the data, because every write is an upsert on a
deterministic key. But it doubles the HealthKit reads, and a control cannot honestly say
"Syncing" about a pass it cannot see. So `src/lib/health/sync.ts` gained a small additive gate
(`syncHealthData` itself is untouched):

- `startOrJoinHealthSync(db)` joins the newest running pass, or starts a tracked one. The
  foreground hook (`syncHealthIfEnabled`), Settings' *Sync now* and the Home control all use it.
- `startHealthSync(db, now, options)` always starts a tracked pass and never joins. Settings'
  three setup flows (Enable, Allow publishing, Read heart rate) use it, because their pass must
  read **after** the permission sheet they have just shown. A pass that began before the grant
  would read without it.
- `isHealthSyncRunning()` / `subscribeHealthSyncRunning()` are what turn every blank cell to
  "Syncing" while any tracked pass runs. A pass that throws still clears the flag.

After this change, the only thing that calls `syncHealthData` directly is the gate. The
headless suite pins that on the source, for both `syncHealthIfEnabled` and
`app/settings-health.tsx`.

### 20.3 "Apple Health sent none", and exactly when it is believed

The evidence is the last pass's own log (§14), the same record Settings › Apple Health
renders. A metric counts as sent-none only when its line reads `returned: 0` **with no native
error**. A read that reported an error may have been refused rather than empty, so it proves
nothing and the offer stays. A metric the log does not name also proves nothing. Sleep is one
line for every sleep sample, so it can judge the Sleep cell. It cannot judge the deep or REM
rows: a source can send sleep with no stages, and one count cannot tell those apart.

This will be the HRV cell's usual state on the owner's phone. §12's table (and
`src/lib/health/coverage.ts`) records that a Garmin writes no HRV to Apple Health in any form.
iOS also makes "read access declined" indistinguishable from "no data", which is why the copy
says what happened (*sent none*) and not why. The statement does not flip to "Syncing" during
a foreground pass: a verdict about a whole window should not flicker every time the app comes
forward. If a source starts writing the metric, the next pass that reads it clears the
statement.

### 20.4 The same rule, elsewhere

- **Data › Wearables** (`app/wearables.tsx`) gets the statement and **not** the control. A
  ledger row is the metric's *latest ever* value, so an empty row means *never*, and the pass
  that could answer that has already run. Its descriptor now reads "Apple Health sent none in
  14 days" in place of "No data yet" when the log says so, and only while sync is on. A log
  left behind by a pass before the switch went off describes a pipe that is no longer running.
- **Home's Recovery pillar note** ("no HRV or resting heart rate reading today") is unchanged.
  The pillar is a verdict, not a measurement slot, and a second control on Home would be the
  one addition CLAUDE.md §5 forbids. The metrics strip is the one place the action lives.
- **The Coach's readiness payload** (`turn-context.ts`, `read-tools.ts`, `insights.ts`) has no
  blank to replace. It is unchanged.

### 20.5 Tests

- `db/readiness.test.mjs`: every row of the 20.1 table through `metricSyncCell`. Also the
  sent-none evidence rules (error, unnamed metric, no log, window plural, the sleep key map),
  the failure being superseded by a later pass, and `syncFromBlank` resolving `failed` rather
  than throwing, and `skipped` rather than `failed` for disabled/unavailable.
- `db/wearables.test.mjs`: the gate. A second caller joins, a settled pass is not re-joined,
  `startHealthSync` never joins, a later caller joins the newest pass, and a pass that throws
  still clears the flag. Plus the two source pins in 20.2.
- `db/screens-render.test.mjs` §17b: Home under node (no module) draws only the plain blank.
  `MetricsGrid` draws every state: the control on exactly the blank cells, the em-dash replaced
  and not joined, Syncing disabled, sent-none as a statement, Connect, and failed. The
  wearables ledger ignores a sent-none log while the module is absent. The no-accent rule is
  checked on the source, because react-native-web hashes class names out of the markup.

### 20.6 What only the phone can settle

- That the label face fits "SYNC APPLE HEALTH" on one line in a half-width cell at 375pt.
- That the spinner and the 28pt action row keep the grid from jumping when a pass starts and
  lands.
- How long a tap-started pass takes on real HealthKit, and whether "Syncing" feels like
  feedback or like a wait.
- That the HRV cell reads "Apple Health sent none in 14 days" from the first foreground on the
  Garmin setup, as §12 predicts, and that Resting HR, Sleep and Steps offer the control only
  before their data has come through.
