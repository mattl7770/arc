/**
 * The HealthKit seam — the ONLY impure file in the wearables pipeline.
 *
 * GRACEFUL DEGRADATION (the api-key-store / reminders pattern): the native
 * library is required in try/catch. `@kingstinct/react-native-healthkit` is a
 * Nitro module and creates its hybrid objects at module top level, so when the
 * native side is absent — web/node, and any build predating the module (it
 * landed in the owner's 2026-08-25 EAS build) — the require throws a
 * synchronous, catchable JS Error and this module
 * degrades to `hk = null`: every reader returns an empty result, availability
 * reports false, and nothing crashes. On the web logic-check preview Metro
 * resolves the library's inert non-iOS stub instead.
 *
 * Everything returned here is a PLAIN shape from `types.ts` (ISO strings, no
 * Date objects, no hybrid-object handles), so the pure mapping layer and its
 * headless tests never see anything native. Per-call failures are swallowed to
 * empty results on purpose: a single bad type identifier must not sink the
 * whole sync (sync.ts reports per-metric row counts, so a silent gap is
 * visible in Settings › Apple Health rather than fatal).
 *
 * As of 2026-08-12 the seam is no longer read-only: {@link saveHealthQuantity}
 * publishes ARC-owned body measurements outward, and the same three types are
 * read back in, making the link two-way (docs/wearables-subapp.md §10–11).
 * Since 2026-09-21 water is the fourth two-way type (§20): manual captures go
 * out, the merged daily total comes back with ARC's own samples excluded, and
 * {@link deleteHealthQuantityByTag} takes a capture's sample back out when the
 * capture is undone — the one delete in this file.
 * Writes get the opposite failure posture to reads — a refused save reports
 * false so the caller can decline to advance its cursor, because a silently
 * dropped write means a number missing from a medical record.
 *
 * Reads exclude ARC's own samples, so the publish channel can never feed itself,
 * and the two directions get DIFFERENT failure postures for that exclusion: on a
 * type ARC only reads, a rejected filter falls back to an unfiltered query
 * (losing the filter is harmless; losing the data is not); on a type ARC also
 * writes, `failClosed` returns nothing instead, because there the unfiltered
 * read is the echo loop.
 *
 * Every reader also REPORTS what happened — how many samples came back, which
 * exclusion predicate the query actually ran with, and the native error text
 * when one was refused. Before 2026-08-26 all three were unknowable from
 * outside: a refused predicate on a published type returned `[]` exactly like a
 * quiet day, so "weight sync is not working" was a sentence nothing in the app
 * could answer. `sync.ts` folds these into the per-run log rendered in Settings
 * › Apple Health.
 */
import type {
  HealthCategorySample,
  HealthDailyStatistic,
  HealthExclusion,
  HealthProvenance,
  HealthQuantitySample,
  HealthWorkoutSample,
  WorkoutHr,
} from './types';
import {
  ARC_WRITE_METADATA_KEY,
  HEALTH_READ_IDENTIFIERS,
  HEALTH_WRITE_IDENTIFIERS,
  HEART_RATE_IDENTIFIER,
  HEART_RATE_UNIT,
} from './mapping';

/**
 * A `FilterForSamples.NOT` clause. The library's `FilterForSamplesBase` supports
 * `sources` (SourceProxy hybrid objects) and a `metadata` key predicate, and
 * `FilterForSamples` combines them with OR/NOT/AND
 * (`lib/typescript/types/QueryOptions.d.ts`).
 */
export type SampleExclusion = {
  sources?: unknown[];
  metadata?: { withMetadataKey: string; operatorType?: number; value?: string };
};

/**
 * The date-plus-exclusions filter every reader here passes.
 *
 * `sources` (a positive `HKQuery.predicateForObjects(from:)`, not a NOT clause)
 * is used by exactly one caller — the heart-rate floor — and takes the library's
 * `SourceProxy` HYBRID objects, never plain records. `ios/PredicateHelpers.swift`
 * casts them and returns nil for the whole clause if the cast fails, which
 * collapses the predicate to date-only; the floor's JS post-filter is what
 * actually enforces the rule, so that collapse costs nothing.
 */
type SampleFilter = {
  date: { startDate: Date; endDate: Date };
  NOT?: SampleExclusion[];
  sources?: unknown[];
};

/** The slice of @kingstinct/react-native-healthkit this module touches. */
type HealthKitModule = {
  isHealthDataAvailable(): boolean;
  requestAuthorization(options: { toRead?: string[]; toShare?: string[] }): Promise<boolean>;
  /** iOS reports SHARE (write) authorization truthfully — 0/1/2, see
   * {@link HealthWriteAccess}. Present since v14; probed before use anyway. */
  authorizationStatusFor?(identifier: string): number;
  /** This app's own HKSource, for excluding ARC's writes from ARC's reads. */
  currentAppSource?(): unknown;
  saveQuantitySample?(
    identifier: string,
    unit: string,
    value: number,
    start: Date,
    end: Date,
    metadata?: Record<string, unknown>
  ): Promise<unknown>;
  queryQuantitySamples(
    identifier: string,
    options: {
      limit?: number;
      ascending?: boolean;
      unit?: string;
      filter?: SampleFilter;
    }
  ): Promise<unknown[]>;
  queryCategorySamples(
    identifier: string,
    options: {
      limit?: number;
      ascending?: boolean;
      filter?: SampleFilter;
    }
  ): Promise<unknown[]>;
  /**
   * `filter` is a full `FilterForSamples` in the library's own types
   * (`types/QuantityType.d.ts` → `StatisticsQueryOptions`), which is what makes
   * the own-write exclusion reachable on a cumulative read at all — see
   * {@link readDailyCumulative}. Only the members ARC passes are typed here.
   */
  queryStatisticsForQuantity(
    identifier: string,
    statistics: string[],
    options: {
      unit?: string;
      filter?: {
        date: { startDate: Date; endDate: Date; strictStartDate?: boolean };
        NOT?: SampleExclusion[];
      };
    }
  ): Promise<{ sumQuantity?: { unit: string; quantity: number } } | null | undefined>;
  /**
   * Delete samples matching a filter, returning how many went. Optional, and
   * probed before use: a build predating it must degrade to "the sample stays
   * in Health", never throw. `SampleTypeIdentifierWriteable` on the library
   * side, so only types ARC also publishes can be passed.
   */
  deleteObjects?(identifier: string, filter: SampleExclusion): Promise<number>;
  /**
   * Door 2 of the heart-rate probe (docs §15): one `HKStatisticsQuery` with
   * `.separateBySource`, so HealthKit does the arithmetic and ARC only picks the
   * workout's own writer in JS. Probed before use like every optional member
   * here — a build predating it must degrade, not throw.
   */
  queryStatisticsForQuantitySeparateBySource?(
    identifier: string,
    statistics: string[],
    options: {
      unit?: string;
      filter?: { date: { startDate: Date; endDate: Date } };
    }
  ): Promise<unknown[]>;
  queryWorkoutSamples(options: {
    limit?: number;
    ascending?: boolean;
    filter?: SampleFilter;
  }): Promise<unknown[]>;
};

// Required in a try/catch so a missing native module (web/node, or any build
// predating the 2026-08-25 EAS rebuild) never takes down the bundle — we
// degrade to "HealthKit absent".
let hk: HealthKitModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hk = require('@kingstinct/react-native-healthkit') as HealthKitModule;
  if (typeof hk?.queryQuantitySamples !== 'function') hk = null;
} catch {
  hk = null;
}

/** Whether the native module is in this binary. False on web/node, and on any
 * build predating the module — it landed in the owner's 2026-08-25 EAS build.
 * The Settings screen keys off this to report the module's presence
 * honestly. */
export function isHealthKitSupported(): boolean {
  return hk !== null;
}

/** Whether HealthKit itself is usable on this device (module present AND the
 * OS says health data is available). */
export function isHealthKitAvailable(): boolean {
  const mod = hk;
  if (!mod) return false;
  try {
    return mod.isHealthDataAvailable();
  } catch {
    return false;
  }
}

/**
 * Show the HealthKit permission sheet for every type ARC reads (spec §2) and
 * every type ARC publishes (spec §10). Lazy — called only from the Settings
 * enable / allow-publishing flows, never at boot. Safe to repeat: iOS only
 * presents the sheet for types the user hasn't answered yet.
 *
 * Resolving true means the request was PROCESSED. For READ types that is all it
 * can mean — Apple never reveals whether read access was granted, so empty query
 * results stay ambiguous. WRITE types are different: iOS reports share
 * authorization truthfully, so {@link healthWriteAccess} can be believed and the
 * Settings screen says what actually happened instead of assuming success.
 *
 * ⚠️ Requesting `toShare` requires `NSHealthUpdateUsageDescription` in the
 * binary's Info.plist (app.json). iOS terminates an app that asks for share
 * types without it, and that is an ObjC-level abort no JS try/catch can hold —
 * so this JS must never be shipped OTA to a binary built before that key
 * existed. See docs/wearables-subapp.md §10.
 */
export async function requestHealthPermissions(): Promise<boolean> {
  const mod = hk;
  if (!mod) return false;
  try {
    return await mod.requestAuthorization({
      toRead: [...HEALTH_READ_IDENTIFIERS],
      toShare: [...HEALTH_WRITE_IDENTIFIERS],
    });
  } catch {
    return false;
  }
}

/**
 * What iOS says about ARC's permission to WRITE the published types.
 *
 * Unlike reads, this is knowable: `HKHealthStore.authorizationStatus(for:)`
 * describes sharing only, and Apple answers it honestly. So a denied publish is
 * detectable and gets said out loud rather than silently swallowed.
 *
 *   - `unsupported` — no native module (web, node, or a build predating the
 *                     module's 2026-08-25 EAS landing);
 *   - `unknown`     — the module is here but the status API isn't, or threw;
 *   - `undetermined`— the share sheet hasn't been answered for these types (the
 *                     state an already-connected user lands in after this update
 *                     ships: their read grants predate the write scopes);
 *   - `granted` / `denied` — every published type is authorised / refused;
 *   - `incomplete`  — everything answered so far is authorised, and at least one
 *                     type has never been ASKED (2026-09-21). This is the state
 *                     every install that connected before water went two-way
 *                     lands in: weight, body fat and waist granted in August,
 *                     water never put to the user. It is not a refusal, and the
 *                     fix is not in iOS Settings — a type ARC has never
 *                     requested is not even listed there. The fix is to ask, and
 *                     iOS presents the sheet for the unanswered type alone;
 *   - `partial`     — a mix that includes a refusal; some types will publish
 *                     and some won't until the user changes it in iOS Settings.
 */
export type HealthWriteAccess =
  'unsupported' | 'unknown' | 'undetermined' | 'incomplete' | 'granted' | 'denied' | 'partial';

/** HKAuthorizationStatus raw values (types/Auth.d.ts). */
const SHARING_NOT_DETERMINED = 0;
const SHARING_DENIED = 1;
const SHARING_AUTHORIZED = 2;

/**
 * The classification, PURE — one HKAuthorizationStatus per write identifier in,
 * one state out — so the case that matters most is pinned headlessly: a late
 * write scope must read as `incomplete` (ask again) and never as `partial` (go
 * to iOS Settings), or the new type is never requested and every save of it is
 * refused forever.
 */
export function classifyWriteAccess(statuses: readonly number[]): HealthWriteAccess {
  const total = statuses.length;
  const authorized = statuses.filter((s) => s === SHARING_AUTHORIZED).length;
  const denied = statuses.filter((s) => s === SHARING_DENIED).length;
  if (total === 0) return 'unknown';
  if (authorized === total) return 'granted';
  if (denied === total) return 'denied';
  if (authorized === 0 && denied === 0) return 'undetermined';
  if (denied === 0) return 'incomplete';
  return 'partial';
}

/** Each write identifier's raw sharing status, or null when it is unknowable. */
function writeStatuses(): number[] | null {
  const mod = hk;
  if (!mod) return null;
  const statusFor = mod.authorizationStatusFor;
  if (typeof statusFor !== 'function') return null;
  try {
    return HEALTH_WRITE_IDENTIFIERS.map((identifier) => statusFor.call(mod, identifier));
  } catch {
    return null;
  }
}

export function healthWriteAccess(): HealthWriteAccess {
  if (!hk) return 'unsupported';
  const statuses = writeStatuses();
  return statuses === null ? 'unknown' : classifyWriteAccess(statuses);
}

/**
 * The write identifiers iOS reports as never asked — what a share sheet would
 * still present. The late-WRITE-scope twin of `unaskedReadScopes` (§18.7), and
 * it needs no stamp: read grants are unknowable so asking had to be recorded,
 * but sharing is answered truthfully, and `notDetermined` IS "never asked".
 */
export function unaskedWriteIdentifiers(): string[] {
  const statuses = writeStatuses();
  if (statuses === null) return [];
  return HEALTH_WRITE_IDENTIFIERS.filter((_, i) => statuses[i] === SHARING_NOT_DETERMINED);
}

/**
 * Write one quantity sample. Returns whether HealthKit accepted it — the caller
 * advances its publish cursor on true ONLY, so a refused write is retried next
 * pass rather than silently lost.
 *
 * `undefined` from the library means FAILURE, and as of 2026-08-26 that is read
 * off the library rather than assumed. `ios/QuantityTypeModule.swift` ends
 * `saveQuantitySample` with
 *
 *     let succeeded = try await saveAsync(sample: sample)
 *     return succeeded ? try serializeQuantitySample(sample: sample, unit: unit) : nil
 *
 * — so nil is reached only when `HKHealthStore.save` reported `success == false`
 * (`ios/Helpers.swift`, `saveAsync`). A thrown save rejects instead, and is
 * caught here. The conservative reading was therefore the correct one; it is no
 * longer conservative.
 *
 * One wrinkle worth knowing: `serializeQuantitySample` THROWS on an identifier
 * outside the library's generated `QuantityTypeIdentifier` union, which would
 * report a genuinely-saved sample as refused. Not reachable for the four types
 * ARC writes — BodyMass, BodyFatPercentage, WaistCircumference and (since
 * 2026-09-21) DietaryWater are all members of `QuantityTypeIdentifierWriteable`
 * in `lib/typescript/generated/healthkit.generated.d.ts`, checked there for water
 * as this note asks — but it is why a new published type must be checked
 * against that union rather than against Apple's docs.
 */
export async function saveHealthQuantity(
  identifier: string,
  unit: string,
  value: number,
  start: Date,
  end: Date,
  metadata: Record<string, unknown>
): Promise<boolean> {
  const mod = hk;
  if (!mod || typeof mod.saveQuantitySample !== 'function') return false;
  if (!Number.isFinite(value)) return false;
  try {
    const saved = await mod.saveQuantitySample(identifier, unit, value, start, end, metadata);
    return saved !== undefined && saved !== null;
  } catch {
    return false;
  }
}

// --- Echo suppression ----------------------------------------------------------------

/** One rung of the exclusion ladder. */
export type ExclusionRung = { kind: 'source' | 'metadata'; NOT: SampleExclusion[] };

/**
 * The `NOT` clauses that keep ARC's own published samples out of ARC's reads,
 * strongest first — **a ladder, not a choice.** This is the 2026-08-26 fix.
 *
 * The preferred form is source-based: `currentAppSource()` hands back this app's
 * HKSource (`ios/CoreModule.swift` returns `SourceProxy(source: HKSource.default())`)
 * and `ios/PredicateHelpers.swift` turns `NOT: [{ sources: [...] }]` into
 * `NSCompoundPredicate(notPredicateWithSubpredicate: HKQuery.predicateForObjects(from:))`.
 * It is categorical — it covers every sample ARC has ever written, including any
 * written before a metadata scheme existed.
 *
 * The second rung is the metadata tag stamped on every write
 * ({@link ARC_WRITE_METADATA_KEY}) — `HKQuery.predicateForObjects(withMetadataKey:)`,
 * a plain key predicate with no source set behind it, so it is the likelier of
 * the two to survive negation on a given iOS.
 *
 * **Why both, in order.** Until now this function returned ONE clause: the
 * source form when `currentAppSource` existed, the metadata form only when that
 * API was missing or threw. The metadata rung was therefore unreachable in the
 * case that actually matters — the API present, the resulting PREDICATE refused
 * by HealthKit — and on a published type that lands in `failClosed`, which
 * returns nothing. One refused predicate meant no weight, forever, with no
 * error anywhere and the narrower predicate never tried. The docs described a
 * fallback the code did not have.
 *
 * Nothing is weakened by laddering: a published type still never falls through
 * to an unfiltered read.
 *
 * Statistics queries get the SAME rungs, but only for an identifier ARC also
 * publishes (2026-09-21, water). For steps and energy — types ARC neither
 * writes nor could meaningfully filter — the reader passes no rungs at all and
 * the query goes out exactly as it always has. See {@link readDailyCumulative}
 * for why a cumulative read has no third rung to fall back on.
 *
 * Takes the `currentAppSource` FUNCTION rather than the module, so the ladder's
 * shape is pinnable with no native module present — the same reasoning that
 * gave `publishBodyMetrics` its injected deps. Everything that went wrong here
 * went wrong in a branch node could not reach.
 */
export function ownWriteExclusions(currentAppSource?: () => unknown): ExclusionRung[] {
  const rungs: ExclusionRung[] = [];
  try {
    if (typeof currentAppSource === 'function') {
      const source = currentAppSource();
      if (source) rungs.push({ kind: 'source', NOT: [{ sources: [source] }] });
    }
  } catch {
    // The metadata rung stands alone.
  }
  rungs.push({
    kind: 'metadata',
    NOT: [{ metadata: { withMetadataKey: ARC_WRITE_METADATA_KEY } }],
  });
  return rungs;
}

/** Native error text, clamped — this gets persisted and rendered. */
function errorText(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error ?? 'unknown error');
  return raw.length > 200 ? `${raw.slice(0, 199)}…` : raw;
}

/** What a read did, beyond the samples themselves. */
export type ReadOutcome = { exclusion: HealthExclusion; error: string | null };

/** The ladder for a live module — `currentAppSource` bound, or absent. */
function exclusionsFor(mod: HealthKitModule): ExclusionRung[] {
  const source = mod.currentAppSource;
  return ownWriteExclusions(typeof source === 'function' ? source.bind(mod) : undefined);
}

/**
 * Walk the exclusion ladder, then — for a type ARC does NOT write — unfiltered.
 *
 * The unfiltered rung is the difference between a bad predicate costing nothing
 * and it costing the entire wearables pipeline: a filter iOS won't accept would
 * otherwise make every metric silently vanish, invisible until someone noticed
 * an empty Data tab.
 *
 * ⚠️ `failClosed` types (the body channel) never reach it. There an unfiltered
 * read IS the echo loop, so exhausting the ladder returns nothing and says
 * `refused` — recoverable, and now visible. `unsuppressedEchoIdentifiers()` is
 * what keeps a written type from being read without `failClosed` by mistake.
 */
export async function withOwnWritesExcluded<T>(
  rungs: readonly ExclusionRung[],
  failClosed: boolean,
  run: (not: SampleExclusion[] | undefined) => Promise<T>
): Promise<{ value: T | null; outcome: ReadOutcome }> {
  let error: string | null = null;
  for (const rung of rungs) {
    try {
      return { value: await run(rung.NOT), outcome: { exclusion: rung.kind, error: null } };
    } catch (e) {
      error = errorText(e);
    }
  }
  if (failClosed) return { value: null, outcome: { exclusion: 'refused', error } };
  try {
    return { value: await run(undefined), outcome: { exclusion: 'none', error } };
  } catch (e) {
    return { value: null, outcome: { exclusion: 'none', error: errorText(e) } };
  }
}

// --- Defensive extraction helpers -------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Date | ISO string | epoch → ISO instant, or null when unparseable. */
function toISO(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Unwrap a HealthKit `Quantity` — `{ unit: string, quantity: number }`, NOT a
 * bare number. Load-bearing: the library returns quantities in this shape for
 * every workout field (`duration`, `totalEnergyBurned`, `totalDistance`) and in
 * statistics responses, so reading such a field as a plain number silently
 * yields null and drops the record. (Plain-number fields do exist too —
 * `QuantitySample.quantity` is one — so both accessors are needed.)
 */
function quantityValue(value: unknown): number | null {
  return toNumber(asRecord(value).quantity);
}

/**
 * A duration Quantity → seconds. The native side serialises workout duration
 * with `HKUnit.second()` (unitString 's'), but the unit is read rather than
 * assumed so a library change to minutes/ms can't silently rescale training
 * history by 60×.
 */
function durationSeconds(value: unknown): number | null {
  const quantity = quantityValue(value);
  if (quantity === null) return null;
  const unit = asRecord(value).unit;
  switch (typeof unit === 'string' ? unit : 's') {
    case 'ms':
      return quantity / 1000;
    case 'min':
      return quantity * 60;
    case 'h':
    case 'hr':
      return quantity * 3600;
    default:
      return quantity; // 's' — the documented default
  }
}

/**
 * A sample's `sourceRevision.source` as a PLAIN record.
 *
 * Load-bearing, and the 2026-08-26 correction. `SourceRevision.source` is not a
 * struct — it is a Nitro **hybrid object** (`ios/SourceProxy.swift`), and Nitro
 * installs a hybrid's properties as getters on a shared PROTOTYPE
 * (`react-native-nitro-modules/cpp/core/HybridObject.cpp`, `registerHybrids`),
 * not as own properties. Two consequences: the object does not spread or
 * stringify, and the base `HybridObject` prototype registers a `name` getter of
 * its own (the hybrid class name) that a derived `name` has to shadow.
 *
 * `toJSON()` is the library's own answer to exactly this — it returns a plain
 * `{ name, bundleIdentifier }` built natively from the HKSource. Preferring it
 * takes the whole class of "the hybrid object did not read the way we assumed"
 * out of `bundleIdentifier`, and `bundleIdentifier` is what guard 3
 * (`isIngestableSample`) refuses a body sample for lacking. Direct property
 * access remains the fallback, so a library that drops `toJSON` still works.
 */
function sourceRecord(revision: Record<string, unknown>): Record<string, unknown> {
  const source = asRecord(revision.source);
  const toJSON = source.toJSON;
  if (typeof toJSON === 'function') {
    try {
      const plain = asRecord((toJSON as () => unknown).call(source));
      if (typeof plain.bundleIdentifier === 'string' || typeof plain.name === 'string') {
        return plain;
      }
    } catch {
      // Fall through to reading the properties directly.
    }
  }
  return source;
}

/**
 * Pull provenance off a sample's sourceRevision, tolerating shape drift.
 *
 * `arcWritten` is read from the sample's own metadata rather than its source,
 * which is the point: it is the one piece of identity ARC controls end-to-end
 * (publish.ts stamps it on every write), so it still answers "did we write
 * this?" when `sourceRevision` arrives in a shape this parser cannot read.
 *
 * `sourceRevision` itself is always present on the wire — `serializeQuantitySample`
 * in `ios/Serializers.swift` sets it unconditionally and the library types it
 * non-optional on `BaseObject` — so there is no query option to ask for it and
 * nothing to turn on. Whether it PARSES is the part that needed fixing; see
 * {@link sourceRecord}.
 */
function provenanceOf(sample: Record<string, unknown>): HealthProvenance {
  const revision = asRecord(sample.sourceRevision);
  const source = sourceRecord(revision);
  const name = typeof source.name === 'string' ? source.name : null;
  const bundleId = typeof source.bundleIdentifier === 'string' ? source.bundleIdentifier : null;
  const productType = typeof revision.productType === 'string' ? revision.productType : null;
  const metadata = asRecord(sample.metadata);
  const arcWritten = metadata[ARC_WRITE_METADATA_KEY] !== undefined;
  return { sourceName: name, bundleId, productType, arcWritten };
}

// --- Pure sample parsers ------------------------------------------------------------
//
// The library's wire shapes are parsed HERE, in exported pure functions, rather
// than inline in the async readers — so db/health-mapping.test.mjs can pin them
// against fixtures shaped like the real payloads with no native module present.
// That coverage is the point: a field read at the wrong shape (a `Quantity`
// object taken for a number) fails soft, dropping records with no error at all,
// which is invisible on device until someone notices an always-empty list.

/** One `QuantitySample` → the plain shape, or null when unusable. */
export function parseQuantitySample(raw: unknown): HealthQuantitySample | null {
  const record = asRecord(raw);
  // QuantitySample.quantity IS a plain number (unlike workout/statistics
  // fields, which are Quantity objects) — the unit came from the query.
  const value = toNumber(record.quantity);
  const startISO = toISO(record.startDate);
  const endISO = toISO(record.endDate);
  if (value === null || !startISO || !endISO) return null;
  return { value, startISO, endISO, provenance: provenanceOf(record) };
}

/** One sleep `CategorySample` → the plain shape, or null when unusable. */
export function parseCategorySample(raw: unknown): HealthCategorySample | null {
  const record = asRecord(raw);
  const value = toNumber(record.value);
  const startISO = toISO(record.startDate);
  const endISO = toISO(record.endDate);
  if (value === null || !startISO || !endISO) return null;
  return { value, startISO, endISO, provenance: provenanceOf(record) };
}

/**
 * One workout → the plain shape, or null when unusable. `duration`,
 * `totalEnergyBurned`, and `totalDistance` are all `Quantity` OBJECTS here
 * (`{ unit, quantity }`), never bare numbers.
 */
export function parseWorkoutSample(raw: unknown): HealthWorkoutSample | null {
  // WorkoutProxy is a hybrid object; toJSON() flattens it to plain data.
  const record = asRecord(raw);
  const plain =
    typeof record.toJSON === 'function' ? asRecord((record.toJSON as () => unknown)()) : record;
  const uuid = typeof plain.uuid === 'string' ? plain.uuid : null;
  const startISO = toISO(plain.startDate);
  const endISO = toISO(plain.endDate);
  const durationSec = durationSeconds(plain.duration);
  if (!uuid || !startISO || !endISO || durationSec === null) return null;
  const meters = quantityValue(plain.totalDistance);
  return {
    uuid,
    activityTypeRaw: toNumber(plain.workoutActivityType) ?? 3000,
    durationSec,
    startISO,
    endISO,
    kcal: quantityValue(plain.totalEnergyBurned),
    distanceKm: meters !== null ? Math.round((meters / 1000) * 100) / 100 : null,
    provenance: provenanceOf(plain),
  };
}

/** A statistics response → its merged cumulative sum, or null. */
export function parseStatisticSum(raw: unknown): number | null {
  return quantityValue(asRecord(raw).sumQuantity);
}

// --- In-workout heart rate: the two doors, pure (docs §15) --------------------
//
// Both doors hand back a `QueryStatisticsResponse`, so both are parsed by the
// same function. Everything below is pure and exported, because the whole of
// what can go wrong here is shape-reading — and a field read at the wrong shape
// fails SOFT, dropping the figure with no error at all.

/**
 * A `Quantity` from a heart-rate statistic → whole bpm, or null.
 *
 * The unit is READ, never assumed, for the reason {@link durationSeconds} gives:
 * the installed library can only answer in the requested `count/min` or reject
 * outright ({@link getUnitToUse} has exactly those two outcomes), so this branch
 * guards a library change rather than today's behaviour — and getting it wrong
 * would put a number sixty times too small into a health record, silently.
 * HeartRate's canonical HKUnit is `count/s`, which is the one a future library
 * would fall back to.
 */
function heartRateBpm(value: unknown): number | null {
  const quantity = quantityValue(value);
  if (quantity === null) return null;
  const unit = asRecord(value).unit;
  const bpm = unit === 'count/min' ? quantity : unit === 'count/s' ? quantity * 60 : null;
  if (bpm === null || !Number.isFinite(bpm) || bpm <= 0) return null;
  return Math.round(bpm);
}

/**
 * A statistics response → the session's average and maximum, or null.
 *
 * **Both or nothing.** An average with no maximum is half a reading, and half a
 * reading printed in the owner's mono voice is a claim ARC would be making on
 * its own behalf. Neither door reports a sample count, which is why there is no
 * `samples` field anywhere in this feature.
 */
export function parseWorkoutHrStatistic(raw: unknown): { avg: number; max: number } | null {
  const record = asRecord(raw);
  const avg = heartRateBpm(record.averageQuantity);
  const max = heartRateBpm(record.maximumQuantity);
  if (avg === null || max === null) return null;
  return { avg, max };
}

/**
 * Door 2's selector: the per-source statistics response belonging to the
 * workout's OWN writer, or null when that writer contributed none.
 *
 * This is the whole reason door 2 is safe. Its query is a date-only predicate,
 * so a phone's incidental readings and a second wearable's are in the response
 * set too — and a Garmin session showing an average dragged toward resting by
 * the phone in the owner's pocket would be wrong in a way no screen could show.
 * HealthKit splits by source; this picks one, by bundle id, exactly.
 *
 * A workout whose own bundle id could not be read matches nothing, deliberately:
 * without it there is no way to tell whose samples these are.
 */
export function pickSourceStatistic(
  responses: readonly unknown[],
  bundleId: string | null
): { avg: number; max: number } | null {
  if (!bundleId) return null;
  for (const response of responses) {
    const record = asRecord(response);
    let id: string | null = null;
    try {
      const plain = sourceRecord(record);
      id = typeof plain.bundleIdentifier === 'string' ? plain.bundleIdentifier : null;
    } catch {
      // A source that will not read is a source that cannot be matched — skip
      // it. One unreadable entry must never cost the other sources' figures.
      continue;
    }
    if (id !== bundleId) continue;
    return parseWorkoutHrStatistic(record);
  }
  return null;
}

/**
 * The floor's numerator: how many of the sampled window were the writer's own.
 *
 * Post-filtered in JS rather than trusted to the `sources` predicate, because
 * that predicate can collapse to date-only (see {@link SampleFilter}) and a
 * silently-unfiltered count would pass the floor on somebody else's samples.
 */
export function countWriterSamples(raw: readonly unknown[], bundleId: string | null): number {
  if (!bundleId) return 0;
  let count = 0;
  for (const item of raw) {
    try {
      if (provenanceOf(asRecord(item)).bundleId === bundleId) count++;
    } catch {
      // An unreadable sample is not the writer's as far as this count knows.
    }
  }
  return count;
}

/**
 * **The door-2 floor.** Nothing is stored unless at least this many of the
 * span's first {@link HR_SAMPLE_PROBE_LIMIT} samples were the workout's own
 * writer.
 *
 * Door 2's figure is one ARC derives, not one the writer asserted — so `avg 142`
 * from four samples of a sparse export is a claim ARC would be making in the
 * owner's own mono voice. A blank line is honest; a confident wrong number is
 * not. Door 1 is deliberately UNFLOORED: it is the writer's own association,
 * and the Health app prints it unfloored too.
 */
export const HR_MIN_SAMPLES = 6;

/** How many samples the floor's bounded probe asks for. One query per session. */
export const HR_SAMPLE_PROBE_LIMIT = 48;

// --- Readers ------------------------------------------------------------------------

/** Per-read policy. */
export type QuantityReadOptions = {
  /**
   * Set for identifiers ARC also WRITES (the body channel). If the own-write
   * exclusion cannot be applied, return NOTHING rather than falling back to an
   * unfiltered read — for a published type the unfiltered read is the echo loop
   * itself, and a missing weight for one pass is recoverable where a duplicate
   * posted into a medical record is not.
   */
  failClosed?: boolean;
};

/**
 * What one read produced. The samples are the point; the rest is what makes an
 * empty result readable — `exclusion: 'refused'` with a native error says
 * "HealthKit would not accept either exclusion predicate", which is a completely
 * different fact from an empty `samples` under `exclusion: 'source'`.
 */
export type HealthReadResult<T> = {
  samples: T[];
  exclusion: HealthExclusion;
  /** Native error text from the last refusal, clamped to 200 chars. */
  error: string | null;
};

/** The empty result an absent native module produces. */
function absentRead<T>(): HealthReadResult<T> {
  return { samples: [], exclusion: 'none', error: null };
}

/** Quantity samples for one identifier over [start, end), in `unit`. */
export async function readQuantitySamples(
  identifier: string,
  unit: string,
  start: Date,
  end: Date,
  options: QuantityReadOptions = {}
): Promise<HealthReadResult<HealthQuantitySample>> {
  const mod = hk;
  if (!mod) return absentRead();
  const { value, outcome } = await withOwnWritesExcluded(
    exclusionsFor(mod),
    options.failClosed === true,
    (NOT) =>
      mod.queryQuantitySamples(identifier, {
        limit: 0, // <= 0 fetches all matches
        ascending: true,
        unit,
        filter: { date: { startDate: start, endDate: end }, NOT },
      })
  );
  const samples: HealthQuantitySample[] = [];
  for (const item of value ?? []) {
    const parsed = parseQuantitySample(item);
    if (parsed) samples.push(parsed);
  }
  return { samples, ...outcome };
}

/** Sleep-analysis category samples over [start, end). */
export async function readSleepSamples(
  start: Date,
  end: Date
): Promise<HealthReadResult<HealthCategorySample>> {
  const mod = hk;
  if (!mod) return absentRead();
  const { value, outcome } = await withOwnWritesExcluded(exclusionsFor(mod), false, (NOT) =>
    mod.queryCategorySamples('HKCategoryTypeIdentifierSleepAnalysis', {
      limit: 0,
      ascending: true,
      filter: { date: { startDate: start, endDate: end }, NOT },
    })
  );
  const samples: HealthCategorySample[] = [];
  for (const item of value ?? []) {
    const parsed = parseCategorySample(item);
    if (parsed) samples.push(parsed);
  }
  return { samples, ...outcome };
}

/** One day of the cumulative window. */
export type CumulativeDay = { date: string; start: Date; end: Date };

/**
 * The one native call {@link readDailyCumulative} makes — injectable for exactly
 * the reason `PublishDeps` is: every branch that has gone wrong in this file
 * went wrong somewhere node could not reach, and an echo on a published type is
 * not a branch worth discovering on a device.
 */
export type CumulativeDeps = {
  queryStatistics: (
    identifier: string,
    options: {
      unit?: string;
      filter: {
        date: { startDate: Date; endDate: Date; strictStartDate?: boolean };
        NOT?: SampleExclusion[];
      };
    }
  ) => Promise<unknown>;
};

/** The live module bound as {@link CumulativeDeps}, or null when it is absent. */
function nativeCumulativeDeps(): CumulativeDeps | null {
  const mod = hk;
  if (!mod) return null;
  return {
    queryStatistics: (identifier, options) =>
      mod.queryStatisticsForQuantity(identifier, ['cumulativeSum'], options),
  };
}

/**
 * HealthKit-MERGED daily total for one cumulative identifier, one statistics
 * query per local day. Never sums samples manually: iPhone + Watch samples
 * overlap and Apple's cross-source merge is private (spec §3). Sequential on
 * purpose — HK statistics ride XPC; a burst of parallel queries buys nothing.
 *
 * ## `failClosed`, and why a statistic gets the METADATA rung only (2026-09-21)
 *
 * Until water became a published type this reader ran with no exclusion at
 * all, and the docs said it could not have one ("Apple merges before the
 * predicate"). The library says otherwise: `queryStatisticsForQuantityInternal`
 * (`ios/QuantityTypeModule.swift`) builds its predicate with the SAME
 * `createPredicateForSamples(options?.filter)` the sample readers use and hands
 * it to `HKStatisticsQuery(quantitySamplePredicate:)` — the predicate that
 * selects which samples the sum is taken over. So an exclusion is reachable.
 *
 * But a statistic arrives **pre-summed**. There is no per-sample provenance to
 * inspect, so guard 3 (`isIngestableSample`) has nothing to refuse, and the
 * query predicate is the ONLY place ARC's own contribution can be removed. That
 * changes which rung is safe:
 *
 *   - The SOURCE rung can fail OPEN. `createSourcePredicate` returns nil when
 *     the `SourceProxy` cast fails, the whole `NOT` chain collapses, and the
 *     query runs date-only — succeeding, and so reporting `exclusion: 'source'`
 *     over an unfiltered total (§14's own table records this). On a sample read
 *     guard 3 catches every ARC sample that leaks through; on a sum nothing
 *     can, and the leak IS the double. So it is withheld here, deliberately.
 *   - The METADATA rung cannot collapse. Given only a key,
 *     `createMetadataPredicate` always returns
 *     `HKQuery.predicateForObjects(withMetadataKey:)`, so the `NOT` either
 *     filters or HealthKit refuses it — and a refusal throws.
 *
 * `ownWriteExclusions()` called WITHOUT a source accessor is exactly the
 * metadata rung ("the metadata rung stands alone"), so this is the same ladder
 * and the same walker with one rung withheld, not a second mechanism. It works
 * because ARC stamps {@link ARC_WRITE_METADATA_KEY} on every sample it writes.
 *
 * `failClosed` then does what it does for weight: a refused predicate yields no
 * rows and `exclusion: 'refused'` rather than an unfiltered total, because for
 * a published cumulative type the unfiltered total is not a risk of the double
 * — it is the double.
 *
 * **A rung is judged on the WINDOW, not on a day.** One day that throws is still
 * tolerated (it must not sink a fortnight), but a clause under which not ONE day
 * was accepted is the clause's fault, not the data's — so the rung is rejected
 * and the ladder steps. Otherwise a refusal on day one would leave the rest of
 * the window running under a predicate already known to be refused.
 *
 * With `failClosed` unset (steps, energy — every identifier ARC does not write)
 * there are no rungs, the filter object is byte-identical to the one this
 * reader always sent (`NOT` is spread in only when present), and
 * `withOwnWritesExcluded` goes straight to its unfiltered rung, reporting
 * `exclusion: 'none'` exactly as before.
 */
export async function readDailyCumulative(
  identifier: string,
  unit: string,
  days: CumulativeDay[],
  options: QuantityReadOptions = {},
  deps: CumulativeDeps | null = nativeCumulativeDeps()
): Promise<HealthReadResult<HealthDailyStatistic>> {
  if (!deps) return absentRead();
  const failClosed = options.failClosed === true;
  // No source accessor passed, on purpose — see "the SOURCE rung can fail OPEN".
  const rungs = failClosed ? ownWriteExclusions() : [];

  let dayError: string | null = null;
  const { value, outcome } = await withOwnWritesExcluded(rungs, failClosed, async (NOT) => {
    const stats: HealthDailyStatistic[] = [];
    let error: string | null = null;
    let accepted = 0;
    for (const day of days) {
      try {
        const result = await deps.queryStatistics(identifier, {
          unit,
          filter: {
            date: {
              startDate: day.start,
              endDate: day.end,
              // strictStartDate makes each sample belong to exactly ONE day —
              // the day its start falls in, which is how the Health app
              // attributes. Without it the predicate is overlap-based and a
              // sample straddling local midnight is summed whole into BOTH
              // adjacent days (statistics queries don't prorate), inflating
              // each side.
              strictStartDate: true,
            },
            ...(NOT ? { NOT } : {}),
          },
        });
        accepted++;
        const sum = parseStatisticSum(result);
        if (sum !== null) stats.push({ date: day.date, value: sum });
      } catch (e) {
        // One bad day never sinks the rest of the window — but the first day's
        // error is kept, because "every day threw" and "nothing was recorded"
        // are the two readings of an empty result and they are not the same.
        error = error ?? errorText(e);
      }
    }
    // Not one day accepted this clause: blame the clause, not the fortnight.
    if (accepted === 0 && days.length > 0) throw new Error(error ?? 'statistics query refused');
    dayError = error;
    return stats;
  });

  return { samples: value ?? [], exclusion: outcome.exclusion, error: outcome.error ?? dayError };
}

/**
 * `ComparisonPredicateOperator.equalTo` (`types/QueryOptions.d.ts`). A literal
 * rather than the library's enum because importing a VALUE from the library
 * would load the Nitro module outside the guarded require at the top of this
 * file.
 */
const PREDICATE_EQUAL_TO = 4;

/**
 * Delete every sample of `identifier` ARC wrote for one originating row — the
 * {@link ARC_WRITE_METADATA_KEY} tag EQUAL to `sourceRowId`
 * (`createMetadataPredicate` → `predicateForObjects(withMetadataKey:operatorType:value:)`).
 * Returns how many went; 0 when the module, the API or the delete itself was
 * unavailable, and 0 when nothing carried the tag (the capture was never
 * published), which is what lets a caller use the count as "was it out there?".
 *
 * **This is what the body channel cannot do, and the difference is where the
 * row lives, not a policy.** A weight is irreversible from inside ARC because
 * nothing could ever find its sample again. A water capture's own id IS the
 * tag on its sample, so the sample is findable by the id the Undo already
 * holds. No UUID is stored, and none needs to be.
 *
 * Best-effort on purpose. A failure leaves a glass in the Health app that ARC no
 * longer holds — visible and correctable there — and costs ARC's own numbers
 * nothing, because the cumulative read excludes ARC's samples either way.
 */
export async function deleteHealthQuantityByTag(
  identifier: string,
  sourceRowId: string
): Promise<number> {
  const mod = hk;
  if (!mod || typeof mod.deleteObjects !== 'function') return 0;
  try {
    const removed = await mod.deleteObjects(identifier, {
      metadata: {
        withMetadataKey: ARC_WRITE_METADATA_KEY,
        operatorType: PREDICATE_EQUAL_TO,
        value: sourceRowId,
      },
    });
    return typeof removed === 'number' && Number.isFinite(removed) ? removed : 0;
  } catch {
    return 0;
  }
}

/**
 * Asked of every workout the pass sees: what was the heart doing?
 *
 * Takes the live proxy (the hybrid handle the statistics hang off) AND the
 * already-parsed plain sample (its span, its writer). Resolving null means "no
 * figure", which is the ordinary answer on a source that does not export
 * in-workout heart rate at all.
 *
 * Injected rather than called directly so {@link collectWorkouts} — and with it
 * the whole error posture — is testable with no native module present. Every
 * branch that went wrong in this file historically went wrong in one node could
 * not reach.
 */
export type WorkoutProbe = (
  proxy: unknown,
  sample: HealthWorkoutSample
) => Promise<WorkoutHr | null>;

/**
 * Parse a page of workout proxies, asking `probe` about each one's heart rate.
 *
 * **A probe can never sink the pass.** Before this existed the parse loop had no
 * try/catch of its own, and a throw inside it left `readWorkouts` entirely —
 * which `syncHealthData` awaits BEFORE the upsert, the cursor and the log, so
 * the pass's rows were discarded and Settings kept the previous log. Adding a
 * per-session native call to that loop without a guard would have made the
 * silent-total-failure mode reachable for the first time. So: a rejecting probe
 * costs that session its `hr` key and nothing else, and the first error text is
 * kept for the log exactly as {@link readDailyCumulative} keeps a day's.
 *
 * `hr` is SPREAD in, never assigned — an unanswered session carries no key at
 * all, so a `null` member cannot reach the stored JSON.
 */
export async function collectWorkouts(
  items: readonly unknown[],
  probe?: WorkoutProbe
): Promise<{ samples: HealthWorkoutSample[]; error: string | null }> {
  const samples: HealthWorkoutSample[] = [];
  let error: string | null = null;
  for (const item of items) {
    const parsed = parseWorkoutSample(item);
    if (!parsed) continue;
    let hr: WorkoutHr | null = null;
    if (probe) {
      try {
        hr = await probe(item, parsed);
      } catch (e) {
        error = error ?? errorText(e);
      }
    }
    samples.push(hr ? { ...parsed, hr } : parsed);
  }
  return { samples, error };
}

/** The live `SourceProxy` hybrid off a workout proxy, or null. */
function workoutSourceHandle(proxy: unknown): unknown {
  try {
    return asRecord(asRecord(proxy).sourceRevision).source ?? null;
  } catch {
    return null;
  }
}

/** `HKQuantityTypeIdentifierHeartRate` → `HeartRate`, for the log's detail line. */
function shortIdentifier(raw: string): string {
  return raw.replace(/^HK(Quantity|Category)TypeIdentifier/, '');
}

/**
 * The real two-door probe (docs §15 §3.1). Every native call sits in its own
 * try/catch and degrades to "no figure"; `report` carries the first error text
 * out to the log, because THE failure mode worth reading is the loud one.
 *
 * A wrong unit override rejects `getStatistic` for *every* workout — the native
 * side has exactly two outcomes with an override supplied, the override or a
 * rejected promise — so door 1 would be dead for the whole feature while the
 * `getAllStatistics` diagnostic (no override, so it cannot fail on units) keeps
 * happily reporting *associated: HeartRate*. Only the log row's error text makes
 * that readable as "door 1 is wrong" rather than "Garmin is silent".
 */
function workoutHrProbe(
  mod: HealthKitModule,
  skip: ReadonlySet<string>,
  report: (error: string) => void
): WorkoutProbe {
  return async (proxy, sample) => {
    // Door 1 — the workout's own statistic: what the Health app prints under
    // the session. Runs for EVERY workout, every pass, with no skip set, which
    // is how a revised association lands; the upsert's CHANGED guard stays the
    // arbiter of whether anything is actually written.
    const getStatistic = asRecord(proxy).getStatistic;
    if (typeof getStatistic === 'function') {
      try {
        const raw = await (
          getStatistic as (type: string, unitOverride?: string) => Promise<unknown>
        ).call(proxy, HEART_RATE_IDENTIFIER, HEART_RATE_UNIT);
        const parsed = parseWorkoutHrStatistic(raw);
        if (parsed) return { ...parsed, method: 'workout' };
      } catch (e) {
        report(errorText(e));
      }
    }

    // Door 2 — the same writer's samples over the span, without the
    // association. Skipped for a session whose stored row already carries a
    // figure: door 1 above is the path by which a better answer can still
    // arrive, and re-deriving one ARC already has buys nothing.
    if (skip.has(sample.uuid)) return null;
    const separate = mod.queryStatisticsForQuantitySeparateBySource;
    if (typeof separate !== 'function') return null;
    const bundleId = sample.provenance.bundleId;
    const startDate = new Date(sample.startISO);
    const endDate = new Date(sample.endISO);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;

    let picked: { avg: number; max: number } | null = null;
    try {
      // No `strictStartDate`: a heart-rate sample is a point, so overlap and
      // strict coincide — and for an interval sample, overlap admits one that
      // began just before the workout (negligible in a time-weighted hour)
      // where strict would drop every session's FIRST reading.
      const responses = await separate.call(
        mod,
        HEART_RATE_IDENTIFIER,
        ['discreteAverage', 'discreteMax'],
        { unit: HEART_RATE_UNIT, filter: { date: { startDate, endDate } } }
      );
      picked = pickSourceStatistic(responses ?? [], bundleId);
    } catch (e) {
      report(errorText(e));
      return null;
    }
    if (!picked) return null;

    // The floor. One bounded query per unanswered session, post-filtered in JS
    // — said plainly: the gate passes when at least six of the span's first 48
    // samples were this writer's.
    try {
      const handle = workoutSourceHandle(proxy);
      const raw = await mod.queryQuantitySamples(HEART_RATE_IDENTIFIER, {
        limit: HR_SAMPLE_PROBE_LIMIT,
        ascending: true,
        unit: HEART_RATE_UNIT,
        filter: {
          date: { startDate, endDate },
          ...(handle ? { sources: [handle] } : {}),
        },
      });
      if (countWriterSamples(raw ?? [], bundleId) < HR_MIN_SAMPLES) return null;
    } catch (e) {
      report(errorText(e));
      return null;
    }
    return { ...picked, method: 'source' };
  };
}

/** What a workout read produced, plus what the heart-rate probe had to say. */
export type WorkoutReadResult = HealthReadResult<HealthWorkoutSample> & {
  /** First heart-rate probe error this pass, or null. Read this FIRST. */
  hrError: string | null;
  /**
   * Quantity-type names the NEWEST workout carries associated statistics for —
   * `getAllStatistics`, no unit override, so it cannot fail the way door 1 can.
   * Null when there was no workout, or the call was refused.
   */
  associated: string[] | null;
};

/** Per-pass policy for the workout read. */
export type WorkoutReadOptions = {
  /**
   * HealthKit UUIDs whose stored row already carries a heart-rate figure. Door
   * 2 is skipped for these; door 1 still runs for every session.
   */
  hrSkip?: ReadonlySet<string>;
};

/**
 * Workouts over [start, end). Units are fixed by the native serialiser, not
 * requestable: duration seconds, `totalEnergyBurned` kcal, `totalDistance`
 * meters — all three arrive as `Quantity` objects, unwrapped below.
 *
 * Since 2026-09-19 each session is also asked about its heart rate, through the
 * injected {@link WorkoutProbe} — the one place in this seam that makes a native
 * call PER RECORD rather than per metric, which is why the loop grew a guard.
 */
export async function readWorkouts(
  start: Date,
  end: Date,
  options: WorkoutReadOptions = {}
): Promise<WorkoutReadResult> {
  const mod = hk;
  if (!mod) return { ...absentRead<HealthWorkoutSample>(), hrError: null, associated: null };
  const { value, outcome } = await withOwnWritesExcluded(exclusionsFor(mod), false, (NOT) =>
    mod.queryWorkoutSamples({
      limit: 0,
      ascending: true,
      filter: { date: { startDate: start, endDate: end }, NOT },
    })
  );
  const items = value ?? [];
  let probeError: string | null = null;
  const probe = workoutHrProbe(mod, options.hrSkip ?? new Set(), (error) => {
    probeError = probeError ?? error;
  });
  const collected = await collectWorkouts(items, probe);

  // The diagnostic, for the NEWEST workout only (the read is ascending, so it
  // is the last item): which quantity types this writer actually ASSOCIATED
  // with the session. Its identifier NAMES only — never its preferred-unit
  // values, which is why it is a diagnostic and not a storage path.
  let associated: string[] | null = null;
  const newest = items[items.length - 1];
  const getAll = newest === undefined ? undefined : asRecord(newest).getAllStatistics;
  if (typeof getAll === 'function') {
    try {
      const all = asRecord(await (getAll as () => Promise<unknown>).call(newest));
      associated = Object.keys(all).map(shortIdentifier).sort();
    } catch (e) {
      probeError = probeError ?? errorText(e);
    }
  }

  return {
    samples: collected.samples,
    ...outcome,
    hrError: probeError ?? collected.error,
    associated,
  };
}
