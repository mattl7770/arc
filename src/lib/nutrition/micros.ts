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
 * `reference` is a general daily reference value, shown only as calm context —
 * NOT a target the user set, and NOT a good/bad verdict. Each one is sourced,
 * because an unsourced number on a health screen is a number nobody can check:
 *
 *  - **FDA Daily Values** (21 CFR 101.9(c)(8)(iv), the adult/4+ column) for the
 *    minerals and vitamins, including sodium's 2,300 mg.
 *  - **Omega-3** has no DV: 1.6 g is the Institute of Medicine's Adequate
 *    Intake for ALA in adult men.
 *  - **Caffeine** has no DV either: 400 mg is the FDA's stated figure for
 *    healthy adults ("not generally associated with dangerous, negative
 *    effects"), which is guidance for a compound, not a nutrient requirement.
 *
 * `ceiling: true` marks the two where the reference is an upper limit to stay
 * under (sodium, caffeine), so the UI frames it "of ~X limit" rather than
 * "of ~X". Nothing here is a signal colour — a daily micro total is not a
 * biological state.
 *
 * **Caffeine is not a micronutrient**, and it is tracked here anyway (owner,
 * backlog A8: *"important micros: caffeine, fiber, sodium?"*). It belongs with
 * these because it is the same kind of fact — a per-portion amount recorded
 * against a food, summed over a day, read against a daily ceiling — and giving
 * it its own parallel machinery would buy nothing but a second place for the
 * same bug. The third of the owner's three, fiber, stays a fixed column
 * (`foods.fiber_g_100g`) because it is a macro-scale gram value with its own
 * personal target; the micros screen reads it against that target, apart from
 * these references.
 *
 * **Where the three are read (2026-09-23):** on the Eat tab itself, under the
 * macro bars, and as the one notable figure on an item row (a latte's
 * caffeine) — both through src/lib/nutrition/key-micro.ts. The estimator asks
 * for sodium and caffeine wherever an item plausibly carries them, and for the
 * rest of this list only where a portion gives a tenth of a day's value
 * (src/lib/nutrition/estimate.ts, `NOTABLE_MICRO_KEYS`).
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
  | 'omega3_g'
  | 'caffeine_mg';

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

/**
 * Display order: bulk minerals, then trace minerals, then vitamins, then fats —
 * and caffeine last, on its own, because it is not a nutrient and should not
 * read as one filed among the vitamins.
 */
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
  { key: 'caffeine_mg', label: 'Caffeine', unit: 'mg', decimals: 0, reference: 400, ceiling: true },
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
  try {
    return coerceMicros(JSON.parse(json));
  } catch {
    return {};
  }
}

/**
 * The vocabulary filter itself, over an already-parsed value: keep known keys
 * carrying a finite non-negative number, drop everything else. Split out of
 * {@link parseMicros} for the one caller that never sees JSON text — the meal
 * estimator, which reads micros out of a MODEL's reply object
 * (src/lib/nutrition/estimate.ts). A model that invents a key, or answers
 * "about 90" instead of 90, loses it here rather than somewhere downstream.
 */
export function coerceMicros(raw: unknown): Micros {
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

/**
 * Scale a per-100 micros payload to `amount` (the per-portion snapshot).
 *
 * Unit-blind on purpose: the payload is per 100 of the FOOD'S BASIS and the
 * amount is in that same basis (0047), so the ratio is the same arithmetic for
 * a 250 ml drink as for 250 g of rice. Nothing here needs to know which.
 */
export function microsForAmount(per100Json: string | null | undefined, amount: number): Micros {
  const per100 = parseMicros(per100Json);
  const out: Micros = {};
  for (const m of MICROS) {
    const v = per100[m.key];
    if (v != null) out[m.key] = (v * amount) / 100;
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

/**
 * One snapshot from two sources, decided KEY BY KEY: every key `primary`
 * records wins, and `fill` supplies only the keys `primary` does not record
 * (2026-09-23). `primary` is a catalog food's per-portion values; `fill` is the
 * item's own — the model's estimate, or the snapshot a logged item already
 * carries.
 *
 * Key by key rather than whole, which is what it was until this round. The old
 * reason — "a food that records micros at all is the better source for all of
 * them" — does not survive the seed: 0016 was authored before caffeine was a
 * key, so a food that records its iron is silent on its caffeine, and the whole
 * rule dropped a dark chocolate's caffeine for recording iron. Unlike macros,
 * micros carry no arithmetic between keys (there is no kcal to disagree with
 * its protein), so two sources on two keys is two facts, each with ONE source,
 * rather than the half-catalog/half-model item grounding refuses for macros.
 */
export function mergeMicros(primary: Micros, fill: Micros): Micros {
  const out: Micros = {};
  for (const m of MICROS) {
    const v = primary[m.key] ?? fill[m.key];
    if (v != null) out[m.key] = v;
  }
  return out;
}

/** Scale every micro amount by `factor` — re-portioning an already-scaled
 * snapshot (no catalog food to re-derive from). */
export function scaleMicros(micros: Micros, factor: number): Micros {
  const out: Micros = {};
  for (const m of MICROS) {
    const v = micros[m.key];
    if (v != null) out[m.key] = v * factor;
  }
  return out;
}
