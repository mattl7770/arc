# Wearables sub-app — Apple Health

**Spec date:** 2026-07-29 · **Status:** Phase 1 spec → built in the same window
**Amended:** 2026-08-12 — ARC now also PUBLISHES three body measurements outward (**§10**).
**Read first:** CLAUDE.md §8 (wearables strategy) and §9 (DB conventions), `docs/project-status.md`.

Apple Health is the decided ingestion hub (2026-07-24 ADR): it is on-device, every vendor's
own app does the cloud sync, so ARC stays offline/no-server. Terra is dropped. Device choice
stays open — nothing below depends on which ring/strap Matt ends up wearing; every source
normalises into `wearable_data`, which shipped in 0001 precisely for this.

§§1–9 describe **ingestion**, which is the bulk of the integration. §10 describes the much
smaller outbound channel and the rules that keep the two from feeding each other.

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
  "NSHealthShareUsageDescription": "ARC reads sleep, heart, activity and workout data from Apple Health to power readiness and recovery.",
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
  fixtures (Quantity-vs-number, `toJSON()` proxies, unit awareness).
- `db/wearables.test.mjs` — repo against real SQLite: upsert-not-duplicate on re-sync,
  cross-source non-collision, series/latest reads, source-priority day picker, sync-state
  round-trip, 0021 rebuild preserves pre-existing rows (manual water/hrv), and the
  **two-pass ingest** proof that a day aging out of the window keeps its full-day values.
  Plus the whole publish channel (§10): cursor KV, keyset walk over backdated and
  same-millisecond rows, arming-without-backfill over 40 rows of history, unit conversion on
  the wire, stop-on-refusal, and the toggle governing both directions.
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

Write-back moved from "deferred, assess first" (§9) to shipped, in one narrow form. **ARC
stays authoritative and PUBLISHES; this is not two-way sync.** No value is ever owned in two
places: `body_metrics` owns the three columns below, Apple Health gets a copy so the rest of
the phone can see it, and nothing flows back.

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

**Echo suppression, in the same build.** Nothing echoes *today* only because ARC does not
read `BodyMass`, `BodyFatPercentage` or `WaistCircumference`. That safety is accidental and
expires the moment someone adds weight to the read set, so it is now guarded three ways:

1. `readWriteScopeOverlap()` — a pure function asserted empty by the test suite. It is the
   tripwire: adding a published type to the read scopes fails CI. (A function, not a
   module-scope assertion — Expo Router eagerly requires everything under `app/`, so a throw
   at import time is an app-**startup** crash.)
2. **Query-level exclusion.** Every sample reader passes
   `filter.NOT = [{ sources: [currentAppSource()] }]`, falling back to the metadata predicate
   `[{ metadata: { withMetadataKey: 'ARCPublishedFrom' } }]` when that API is unavailable —
   the key ARC stamps on every sample it writes, carrying the originating `body_metrics.id`.
   Statistics queries get no exclusion on purpose: they return Apple's own merged cumulative
   totals, computed before any predicate, and ARC writes none of those types. If the native
   layer rejects the predicate the reader retries **unfiltered** rather than returning
   nothing — a bad filter must not silently empty the whole Data tab. That fallback is only
   safe while guard 1 holds; if the scopes ever overlap it must be changed to fail closed.
3. **Source bucketing.** `com.arcresilience.app` maps to `manual`, so even a defeated filter
   cannot let an echo outrank its own origin. Without a case, ARC's bundle would fall through
   to `other` — index 7 in `SOURCE_PRIORITY`, *above* `apple_health` (8) and `manual` (9) —
   and ARC would prefer its own reflection to both the merged Apple total and the user's
   keypad entry. `'other'` was deliberately **not** demoted: no wearable is chosen yet
   (CLAUDE.md §8), so an unrecognised ring landing in `other` is the expected state, and
   demoting it would make a real measuring device lose to a stale manual entry. A distinct
   `'arc'` device value was rejected because `source_device` is a CHECK-constrained enum —
   that is a migration, and numbering is forward-only. `manual` is also simply true:
   everything ARC publishes started as a number the user typed into ARC.

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

**Still out of scope** — workouts and nutrition. Both hit the same wall: no column stores a
HealthKit UUID, so a written workout or meal could never be deleted, and both are edited
constantly. That needs a migration and its own slice. **Reading** `BodyMass` is also out of
scope; it is the thing that would open the echo loop.
