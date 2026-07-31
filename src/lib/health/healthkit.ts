/**
 * The HealthKit seam — the ONLY impure file in the wearables pipeline.
 *
 * GRACEFUL DEGRADATION (the api-key-store / reminders pattern): the native
 * library is required in try/catch. `@kingstinct/react-native-healthkit` is a
 * Nitro module and creates its hybrid objects at module top level, so when the
 * native side is absent — the current dev build (until the next EAS build) and
 * node — the require throws a synchronous, catchable JS Error and this module
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
 */
import type {
  HealthCategorySample,
  HealthDailyStatistic,
  HealthProvenance,
  HealthQuantitySample,
  HealthWorkoutSample,
} from './types';
import { HEALTH_READ_IDENTIFIERS } from './mapping';

/** The slice of @kingstinct/react-native-healthkit this module touches. */
type HealthKitModule = {
  isHealthDataAvailable(): boolean;
  requestAuthorization(options: { toRead?: string[]; toShare?: string[] }): Promise<boolean>;
  queryQuantitySamples(
    identifier: string,
    options: {
      limit?: number;
      ascending?: boolean;
      unit?: string;
      filter?: { date: { startDate: Date; endDate: Date } };
    }
  ): Promise<unknown[]>;
  queryCategorySamples(
    identifier: string,
    options: {
      limit?: number;
      ascending?: boolean;
      filter?: { date: { startDate: Date; endDate: Date } };
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
    filter?: { date: { startDate: Date; endDate: Date } };
  }): Promise<unknown[]>;
};

// Required in a try/catch so a missing native module (pre-rebuild) or node
// never takes down the bundle — we degrade to "HealthKit absent".
let hk: HealthKitModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hk = require('@kingstinct/react-native-healthkit') as HealthKitModule;
  if (typeof hk?.queryQuantitySamples !== 'function') hk = null;
} catch {
  hk = null;
}

/** Whether the native module made it into this binary (false until the next
 * EAS build, and always false on web/node). The Settings screen keys off this
 * to say "rides the next build" honestly. */
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
 * Show the HealthKit permission sheet for every type ARC reads (spec §2).
 * Lazy — called only from the Settings enable flow, never at boot. Safe to
 * repeat: iOS only presents the sheet for types the user hasn't answered yet.
 * Resolving true means the request was PROCESSED — Apple never reveals whether
 * read access was actually granted; empty query results stay ambiguous.
 */
export async function requestHealthPermissions(): Promise<boolean> {
  const mod = hk;
  if (!mod) return false;
  try {
    return await mod.requestAuthorization({ toRead: [...HEALTH_READ_IDENTIFIERS] });
  } catch {
    return false;
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

/** Pull provenance off a sample's sourceRevision, tolerating shape drift. */
function provenanceOf(sample: Record<string, unknown>): HealthProvenance {
  const revision = asRecord(sample.sourceRevision);
  const source = asRecord(revision.source);
  const name = typeof source.name === 'string' ? source.name : null;
  const bundleId = typeof source.bundleIdentifier === 'string' ? source.bundleIdentifier : null;
  const productType = typeof revision.productType === 'string' ? revision.productType : null;
  return { sourceName: name, bundleId, productType };
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

/** Quantity samples for one identifier over [start, end), in `unit`. */
export async function readQuantitySamples(
  identifier: string,
  unit: string,
  start: Date,
  end: Date
): Promise<HealthQuantitySample[]> {
  const mod = hk;
  if (!mod) return [];
  try {
    const raw = await mod.queryQuantitySamples(identifier, {
      limit: 0, // <= 0 fetches all matches
      ascending: true,
      unit,
      filter: { date: { startDate: start, endDate: end } },
    });
    const samples: HealthQuantitySample[] = [];
    for (const item of raw) {
      const parsed = parseQuantitySample(item);
      if (parsed) samples.push(parsed);
    }
    return samples;
  } catch {
    return [];
  }
}

/** Sleep-analysis category samples over [start, end). */
export async function readSleepSamples(start: Date, end: Date): Promise<HealthCategorySample[]> {
  const mod = hk;
  if (!mod) return [];
  try {
    const raw = await mod.queryCategorySamples('HKCategoryTypeIdentifierSleepAnalysis', {
      limit: 0,
      ascending: true,
      filter: { date: { startDate: start, endDate: end } },
    });
    const samples: HealthCategorySample[] = [];
    for (const item of raw) {
      const parsed = parseCategorySample(item);
      if (parsed) samples.push(parsed);
    }
    return samples;
  } catch {
    return [];
  }
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
): Promise<HealthDailyStatistic[]> {
  const mod = hk;
  if (!mod) return [];
  const stats: HealthDailyStatistic[] = [];
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
    } catch {
      // One bad day never sinks the rest of the window.
    }
  }
  return stats;
}

/**
 * Workouts over [start, end). Units are fixed by the native serialiser, not
 * requestable: duration seconds, `totalEnergyBurned` kcal, `totalDistance`
 * meters — all three arrive as `Quantity` objects, unwrapped below.
 */
export async function readWorkouts(start: Date, end: Date): Promise<HealthWorkoutSample[]> {
  const mod = hk;
  if (!mod) return [];
  try {
    const raw = await mod.queryWorkoutSamples({
      limit: 0,
      ascending: true,
      filter: { date: { startDate: start, endDate: end } },
    });
    const workouts: HealthWorkoutSample[] = [];
    for (const item of raw) {
      const parsed = parseWorkoutSample(item);
      if (parsed) workouts.push(parsed);
    }
    return workouts;
  } catch {
    return [];
  }
}
