/**
 * The micronutrient vocabulary — the longevity shortlist ARC tracks, with the
 * labels, units, ordering, and reference daily values the UI reads. Pure and
 * DB-free (importable from the UI and the headless tests).
 *
 * Scope is deliberate (docs/nutrition-subapp.md §8: "honest sparse data over
 * fake completeness"): the shortlist the seed catalogue and FDA-mandatory
 * labels can actually fill (Linus Pauling Institute / PNAS "longevity vitamins"
 * — see the research digest in the spec), not a Cronometer-grade 84-nutrient
 * panel most foods have no data for. The seed's `micros` JSON uses exactly
 * these keys; `foods`, `meal_items`, and `meal_template_items` all store per-
 * portion values under them.
 *
 * `reference` is a general daily reference value (FDA DV where one exists;
 * omega-3 uses the ALA Adequate Intake), shown only as calm context — NOT a
 * target the user set, and NOT a good/bad verdict. `ceiling: true` marks
 * nutrients where the reference is an upper limit to stay under (sodium), so
 * the UI frames it "of ~X limit" rather than "of ~X". Nothing here is a signal
 * colour — a daily micro total is not a biological state.
 */

export type MicroKey =
  | 'sodium_mg'
  | 'potassium_mg'
  | 'calcium_mg'
  | 'magnesium_mg'
  | 'iron_mg'
  | 'zinc_mg'
  | 'vitamin_c_mg'
  | 'vitamin_d_mcg'
  | 'b12_mcg'
  | 'folate_mcg'
  | 'omega3_g';

export type MicroDescriptor = {
  key: MicroKey;
  label: string;
  /** Display unit (mg / mcg / g). */
  unit: string;
  /** Decimals to render — sub-milligram nutrients need one, bulk minerals none. */
  decimals: number;
  /** General daily reference value in the same unit (FDA DV / AI). */
  reference: number;
  /** True when `reference` is an upper limit to stay under, not a goal. */
  ceiling?: boolean;
};

/** Display order: bulk minerals, then trace minerals, then vitamins, then fats. */
export const MICROS: MicroDescriptor[] = [
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg', decimals: 0, reference: 2300, ceiling: true },
  { key: 'potassium_mg', label: 'Potassium', unit: 'mg', decimals: 0, reference: 4700 },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', decimals: 0, reference: 1300 },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', decimals: 0, reference: 420 },
  { key: 'iron_mg', label: 'Iron', unit: 'mg', decimals: 1, reference: 18 },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', decimals: 1, reference: 11 },
  { key: 'vitamin_c_mg', label: 'Vitamin C', unit: 'mg', decimals: 0, reference: 90 },
  { key: 'vitamin_d_mcg', label: 'Vitamin D', unit: 'mcg', decimals: 1, reference: 20 },
  { key: 'b12_mcg', label: 'Vitamin B12', unit: 'mcg', decimals: 1, reference: 2.4 },
  { key: 'folate_mcg', label: 'Folate', unit: 'mcg', decimals: 0, reference: 400 },
  { key: 'omega3_g', label: 'Omega-3', unit: 'g', decimals: 1, reference: 1.6 },
];

const MICRO_KEYS = new Set<string>(MICROS.map((m) => m.key));

/** A micros JSON payload: known keys → per-portion (or per-100 g) amount. */
export type Micros = Partial<Record<MicroKey, number>>;

/**
 * Parse a stored `micros` JSON string into a typed object, keeping only known
 * keys with finite non-negative values. Tolerant by design: a malformed or
 * unknown-key payload degrades to what's usable rather than throwing (the DB
 * already guarantees valid JSON; this guards the vocabulary).
 */
export function parseMicros(json: string | null | undefined): Micros {
  if (json == null || json === '') return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Micros = {};
  for (const [k, v] of Object.entries(raw)) {
    if (MICRO_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k as MicroKey] = v;
    }
  }
  return out;
}

/** Serialize a micros object to JSON, dropping empty so "nothing" stores NULL. */
export function serializeMicros(micros: Micros): string | null {
  const entries = Object.entries(micros).filter(
    ([k, v]) => MICRO_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0
  );
  return entries.length === 0 ? null : JSON.stringify(Object.fromEntries(entries));
}

/** Scale a per-100 g micros payload to `grams` (the per-portion snapshot). */
export function microsForGrams(per100Json: string | null | undefined, grams: number): Micros {
  const per100 = parseMicros(per100Json);
  const out: Micros = {};
  for (const m of MICROS) {
    const v = per100[m.key];
    if (v != null) out[m.key] = (v * grams) / 100;
  }
  return out;
}

/** Sum a list of micros payloads into a single total (skips absent keys). */
export function sumMicros(payloads: Micros[]): Micros {
  const out: Micros = {};
  for (const p of payloads) {
    for (const m of MICROS) {
      const v = p[m.key];
      if (v != null) out[m.key] = (out[m.key] ?? 0) + v;
    }
  }
  return out;
}
