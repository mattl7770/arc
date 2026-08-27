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
} from './types';
import {
  ARC_WRITE_METADATA_KEY,
  HEALTH_READ_IDENTIFIERS,
  HEALTH_WRITE_IDENTIFIERS,
} from './mapping';

/**
 * A `FilterForSamples.NOT` clause. The library's `FilterForSamplesBase` supports
 * `sources` (SourceProxy hybrid objects) and a `metadata` key predicate, and
 * `FilterForSamples` combines them with OR/NOT/AND
 * (`lib/typescript/types/QueryOptions.d.ts`).
 */
type SampleExclusion = { sources?: unknown[]; metadata?: { withMetadataKey: string } };

/** The date-plus-exclusions filter every reader here passes. */
type SampleFilter = {
  date: { startDate: Date; endDate: Date };
  NOT?: SampleExclusion[];
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
  queryStatisticsForQuantity(
    identifier: string,
    statistics: string[],
    options: {
      unit?: string;
      filter?: {
        date: { startDate: Date; endDate: Date; strictStartDate?: boolean };
      };
    }
  ): Promise<{ sumQuantity?: { unit: string; quantity: number } } | null | undefined>;
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
 *   - `partial`     — a mix; some types will publish and some won't.
 */
export type HealthWriteAccess =
  'unsupported' | 'unknown' | 'undetermined' | 'granted' | 'denied' | 'partial';

/** HKAuthorizationStatus raw values (types/Auth.d.ts). */
const SHARING_DENIED = 1;
const SHARING_AUTHORIZED = 2;

export function healthWriteAccess(): HealthWriteAccess {
  const mod = hk;
  if (!mod) return 'unsupported';
  const statusFor = mod.authorizationStatusFor;
  if (typeof statusFor !== 'function') return 'unknown';
  let authorized = 0;
  let denied = 0;
  try {
    for (const identifier of HEALTH_WRITE_IDENTIFIERS) {
      const status = statusFor.call(mod, identifier);
      if (status === SHARING_AUTHORIZED) authorized++;
      else if (status === SHARING_DENIED) denied++;
    }
  } catch {
    return 'unknown';
  }
  const total = HEALTH_WRITE_IDENTIFIERS.length;
  if (authorized === total) return 'granted';
  if (denied === total) return 'denied';
  if (authorized === 0 && denied === 0) return 'undetermined';
  return 'partial';
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
 * report a genuinely-saved sample as refused. Not reachable for the three types
 * ARC writes — BodyMass, BodyFatPercentage and WaistCircumference are all
 * members of `QuantityTypeIdentifierWriteable` — but it is why a new published
 * type must be checked against that union rather than against Apple's docs.
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
 * Statistics queries deliberately get no exclusion: they return HealthKit's own
 * MERGED cumulative totals (steps, energy), which ARC neither writes nor could
 * meaningfully filter — the merge is Apple's, computed before the predicate.
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

/**
 * HealthKit-MERGED daily total for one cumulative identifier, one statistics
 * query per local day. Never sums samples manually: iPhone + Watch samples
 * overlap and Apple's cross-source merge is private (spec §3). Sequential on
 * purpose — HK statistics ride XPC; a burst of parallel queries buys nothing.
 */
export async function readDailyCumulative(
  identifier: string,
  unit: string,
  days: { date: string; start: Date; end: Date }[]
): Promise<HealthReadResult<HealthDailyStatistic>> {
  const mod = hk;
  if (!mod) return absentRead();
  const stats: HealthDailyStatistic[] = [];
  let error: string | null = null;
  for (const day of days) {
    try {
      const result = await mod.queryStatisticsForQuantity(identifier, ['cumulativeSum'], {
        unit,
        filter: {
          date: {
            startDate: day.start,
            endDate: day.end,
            // strictStartDate makes each sample belong to exactly ONE day — the
            // day its start falls in, which is how the Health app attributes.
            // Without it the predicate is overlap-based and a sample straddling
            // local midnight is summed whole into BOTH adjacent days (statistics
            // queries don't prorate), inflating each side.
            strictStartDate: true,
          },
        },
      });
      const sum = parseStatisticSum(result);
      if (sum !== null) stats.push({ date: day.date, value: sum });
    } catch (e) {
      // One bad day never sinks the rest of the window — but the first day's
      // error is kept, because "every day threw" and "nothing was recorded"
      // are the two readings of an empty result and they are not the same.
      error = error ?? errorText(e);
    }
  }
  // Statistics carry no own-write exclusion by design (Apple merges before the
  // predicate), so the honest report is `none`, never `refused`.
  return { samples: stats, exclusion: 'none', error };
}

/**
 * Workouts over [start, end). Units are fixed by the native serialiser, not
 * requestable: duration seconds, `totalEnergyBurned` kcal, `totalDistance`
 * meters — all three arrive as `Quantity` objects, unwrapped below.
 */
export async function readWorkouts(
  start: Date,
  end: Date
): Promise<HealthReadResult<HealthWorkoutSample>> {
  const mod = hk;
  if (!mod) return absentRead();
  const { value, outcome } = await withOwnWritesExcluded(exclusionsFor(mod), false, (NOT) =>
    mod.queryWorkoutSamples({
      limit: 0,
      ascending: true,
      filter: { date: { startDate: start, endDate: end }, NOT },
    })
  );
  const workouts: HealthWorkoutSample[] = [];
  for (const item of value ?? []) {
    const parsed = parseWorkoutSample(item);
    if (parsed) workouts.push(parsed);
  }
  return { samples: workouts, ...outcome };
}
