# Wearables sub-app — Apple Health

**Spec date:** 2026-07-29 · **Status:** Phase 1 spec → built in the same window
**Amended:** 2026-08-12 — the link is **two-way**: ARC publishes three body measurements
outward (**§10**) and reads the same three back in (**§11**).
**Read first:** CLAUDE.md §8 (wearables strategy) and §9 (DB conventions), `docs/project-status.md`.

Apple Health is the decided ingestion hub (2026-07-24 ADR): it is on-device, every vendor's
own app does the cloud sync, so ARC stays offline/no-server. Terra is dropped. Device choice
stays open — nothing below depends on which ring/strap Matt ends up wearing; every source
normalises into `wearable_data`, which shipped in 0001 precisely for this.

§§1–9 describe **ingestion into `wearable_data`**, which is the bulk of the integration.
§10 describes the outbound channel, §11 the inbound half of the same three body measurements,
and both hang on the echo suppression written up in §10.

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

**Native-dep reality:** the module is NOT in the current dev build. It rides the next
`eas build` (batched with expo-secure-store & co., docs/dev-build.md). Until then the guarded
seam (§5) makes everything compile and no-op: the library's `modules.ts` calls Nitro's
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
| `HKQuantityTypeIdentifierActiveEnergyBurned` | Strain |
| `HKQuantityTypeIdentifierBasalEnergyBurned` | Energy context |
| `HKQuantityTypeIdentifierRespiratoryRate` | Sleep-time vitals |
| `HKQuantityTypeIdentifierOxygenSaturation` | Sleep-time vitals |
| `HKQuantityTypeIdentifierBodyTemperature` | Illness signal (manual/BT thermometer) |
| `HKQuantityTypeIdentifierAppleSleepingWristTemperature` | Nightly temp trend (read-only type) |
| `HKQuantityTypeIdentifierVO2Max` | Fitness marker (project-status "Exercise as measured data") |
| `HKWorkoutTypeIdentifier` | Sessions from other apps/devices |
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
| `respiratory_rate` | RespiratoryRate samples | daily mean · `brpm` | local day |
| `spo2_pct` | OxygenSaturation samples | daily mean **×100** · `pct` (HK stores fraction 0–1) | local day |
| `body_temp_c` | BodyTemperature samples | daily mean · `c` | local day |
| `wrist_temp_c` | AppleSleepingWristTemperature | nightly sample · `c` (absolute °C; Health app shows a *delta* — ARC's read-side computes its own baseline delta) | local day of sample end |
| `vo2max` | VO2Max samples | latest sample · `ml_kg_min` (sparse — a "last known as-of" metric) | local day |
| `sleep_duration_min` | SleepAnalysis | asleep minutes (values 1/3/4/5) · `min`; `start_time`/`end_time` = session bounds | **wake day** (§ sleep) |
| `sleep_core_min` / `sleep_deep_min` / `sleep_rem_min` / `sleep_awake_min` / `sleep_in_bed_min` | SleepAnalysis | per-stage minutes · `min` — a stage row exists **only when the source wrote stages** (WHOOP doesn't; 0 ≠ unknown) | wake day |
| `workout` | HKWorkout samples | `duration` minutes (not end−start; pauses differ) · `min`; metadata: activity type raw int + name, kcal, distance_km, source name | local day of workout **end** |

Already-shipping metric types are untouched and merge naturally: manual keypad `hrv`/`rhr`
rows and `water_ml` live in the same table (a smart-bottle later lands on `water_ml` via
HealthKit by adding `DietaryWater` to the scopes — no migration).

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
- **Strain:** yesterday's active energy vs its 28-day baseline → ≤0.75 optimal (fresh) ·
  ≤1.30 good · ≤1.70 caution · else poor.
- **Nutrition pillar:** presence-only for now (meals logged today → good, none → unknown);
  target-aware grading is the nutrition sub-app's future call.
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
  module-absent state says "rides the next dev build" honestly (same posture as the Coach
  key screen); enable flow = flip → `requestHealthPermissions()` (lazy, first time only) →
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
  mock-day stays only as the mission's no-protocol seed.

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

1. **Query-level exclusion.** Every sample reader passes
   `filter.NOT = [{ sources: [currentAppSource()] }]`, falling back to the metadata predicate
   `[{ metadata: { withMetadataKey: 'ARCPublishedFrom' } }]` when that API is unavailable —
   the key ARC stamps on every sample it writes, carrying the originating `body_metrics.id`.
   Statistics queries get no exclusion on purpose: they return Apple's own merged cumulative
   totals, computed before any predicate, and ARC writes none of those types.
2. **Two failure postures for that filter, and the difference is the point.** On a type ARC
   only READS, a predicate the native layer rejects falls back to an **unfiltered** query —
   losing the filter is harmless there and losing the data is not (readers swallow errors to
   `[]`, so a bad filter would silently empty the whole Data tab). On a type ARC also WRITES,
   the reader passes `failClosed` and returns **nothing** instead: there the unfiltered read
   *is* the echo loop, and a weight missing for one pass is recoverable where a duplicate is
   not.
3. **Per-sample rejection** (`isIngestableSample`, pure and tested). A body sample is dropped
   if it carries the `ARCPublishedFrom` tag, or ARC's bundle id, **or no bundle id at all**.
   That last clause is the one that is easy to get backwards: *unknown source is not safe* on
   a type ARC writes. `SourceRevision.source.bundleIdentifier` is a non-optional string in the
   library's own types, so a null means the shape drifted — precisely the case a fallback
   exists for. An unattributable `BodyMass` sample cannot be shown *not* to be ARC's own
   reflection, and refusing it costs at worst a measurement still visible in the Health app.
   (Scoped to the body types only. Applying it to wearable reads would discard real vendor
   data, which is the mistake guard 5 warns about.)
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
> that key existed. Today that is not reachable — the HealthKit module is in no shipped
> binary at all (§1), so the first build containing it will also contain the key — but a
> build cut from `main` before this branch merges would create exactly that binary.

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
