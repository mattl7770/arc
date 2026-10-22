/**
 * Every threshold the record-hygiene and medical-attention detectors use
 * (src/lib/ai/findings.ts) — **the one place they live**, and the shape
 * Settings › Coach edits (src/components/coach/finding-thresholds.tsx).
 *
 * Two kinds of number live here, and only the first is editable:
 *
 *   - {@link FINDING_THRESHOLD_SPECS}: eleven scalar knobs, each with a
 *     default, a range the screen clamps to, and the reason for its default.
 *     Stored in `users.preferences.coachFindings` (the unit-preferences
 *     pattern, so no migration), and only the keys he has moved are written.
 *   - {@link PHYSIOLOGIC_BANDS} and {@link LAB_NOISE_CV_PCT}: curated reference
 *     data, per biomarker. A band is not a range he could prefer — it is the
 *     edge of what a living body produces — so it is not a setting.
 *
 * Every default is CONSERVATIVE on purpose. A finding that fires on noise
 * teaches him to skim the Coach's notes; a detector that stays quiet when it
 * should not costs one missed sentence, which the Coach reading his data with
 * its own tools can still catch. The detectors only DETECT: nothing here
 * decides what a finding means or what to do about it — that is the Coach's
 * call, every time.
 */
import type { Database } from '@/lib/db/database';
import { getOrCreateUser } from '@/lib/db/repositories/user';

export type FindingThresholds = {
  /** A gap must be this many times his own usual spacing between logs… */
  gapMultiple: number;
  /** …and never fewer than this many whole missed days. */
  gapMinDays: number;
  /** Two identical meals or captures this close together are a duplicate candidate. */
  duplicateWindowMin: number;
  /** A weight reading this far (%) from the one a day or two before is implausible. */
  weightJumpPct: number;
  /** A single HRV / resting-HR reading this many robust SDs from his baseline is implausible. */
  vitalImplausibleSd: number;
  /** A run of readings at least this many SDs out, the worrying way, is persistent… */
  vitalPersistSd: number;
  /** …once it has lasted this many consecutive days. */
  vitalPersistDays: number;
  /** A symptom logged on at least this many days… */
  symptomDays: number;
  /** …of the last this many (today included). */
  symptomWindowDays: number;
  /** z for a lab marker's reference change value (1.96 = the 95% two-sided RCV). */
  labChangeZ: number;
  /** Two same-date reports whose shared values agree within this % are a re-import. */
  labDuplicateTolerancePct: number;
};

export type FindingThresholdKey = keyof FindingThresholds;

export type FindingThresholdSpec = {
  key: FindingThresholdKey;
  label: string;
  /** Printed after the value on the Settings row. */
  unit: string;
  default: number;
  min: number;
  max: number;
  step: number;
};

/**
 * The knobs, in the order Settings lists them. Each default's justification
 * sits beside it, because a threshold without its reason is a number nobody
 * can safely move.
 */
export const FINDING_THRESHOLD_SPECS: readonly FindingThresholdSpec[] = [
  // At a daily cadence a two-day lapse is life, not a hygiene problem; three
  // times his OWN median spacing is well outside his rhythm whatever that
  // rhythm is (a weekly weigher → three weeks).
  {
    key: 'gapMultiple',
    label: 'Gap: times your usual spacing',
    unit: '×',
    default: 3,
    min: 2,
    max: 10,
    step: 0.5,
  },
  // The floor under the multiple — the spec's own example ("weight usually
  // daily, none for 4 days"). Below four days a daily habit is merely paused.
  { key: 'gapMinDays', label: 'Gap: at least', unit: 'days', default: 4, min: 2, max: 30, step: 1 },
  // Nobody eats the same meal twice inside ten minutes; a re-tap, a double
  // save or a second capture of one plate does. Much wider starts catching the
  // same coffee bought twice in a morning.
  {
    key: 'duplicateWindowMin',
    label: 'Duplicate: within',
    unit: 'min',
    default: 10,
    min: 1,
    max: 60,
    step: 1,
  },
  // Day-to-day weight moves 1–2% (water, glycogen, sodium), rarely 3%; a
  // decimal slip (78.4 → 87.4) or a lb/kg mix-up is 10% or more. 4% leaves a
  // hard water cut room and still catches every typo that matters. A
  // deliberate cut (≤1% a WEEK) never comes near it.
  {
    key: 'weightJumpPct',
    label: 'Weight: jump between readings',
    unit: '%',
    default: 4,
    min: 2,
    max: 20,
    step: 0.5,
  },
  // One reading 4 robust SDs (median ± 1.4826·MAD) from his own baseline is
  // ~1 in 15,000 days if it were real and normal — far more often a sensor
  // artefact or a mis-sync. Robust, so the outliers cannot widen their own band.
  {
    key: 'vitalImplausibleSd',
    label: 'HRV / RHR: one reading beyond',
    unit: 'SD',
    default: 4,
    min: 3,
    max: 8,
    step: 0.5,
  },
  // A day 2 SD out the worrying way happens ~2% of days; three in a row is rare
  // even allowing for day-to-day autocorrelation, and is the classic shape of
  // illness or overreaching (RHR up, HRV down).
  {
    key: 'vitalPersistSd',
    label: 'HRV / RHR: a run beyond',
    unit: 'SD',
    default: 2,
    min: 1,
    max: 4,
    step: 0.5,
  },
  {
    key: 'vitalPersistDays',
    label: 'HRV / RHR: run of',
    unit: 'days',
    default: 3,
    min: 2,
    max: 14,
    step: 1,
  },
  // "Most days of a week". A cold logs three or four days; four of seven is
  // persistent enough for the Coach to know about, and not yet chronic.
  { key: 'symptomDays', label: 'Symptom: on', unit: 'days', default: 4, min: 2, max: 14, step: 1 },
  {
    key: 'symptomWindowDays',
    label: 'Symptom: of the last',
    unit: 'days',
    default: 7,
    min: 3,
    max: 30,
    step: 1,
  },
  // The reference change value (Fraser): a change between two draws beyond
  // z·√2·√(CVi² + CVa²) is unlikely to be noise alone. 1.96 is the textbook
  // two-sided 95% bar; anything lower calls ordinary biological variation a
  // worsening.
  {
    key: 'labChangeZ',
    label: 'Lab change: z',
    unit: '',
    default: 1.96,
    min: 1,
    max: 4,
    step: 0.01,
  },
  // A re-imported PDF parses to the same numbers up to rounding; two real
  // draws on one day almost never agree within 1% across most markers.
  {
    key: 'labDuplicateTolerancePct',
    label: 'Lab re-import: values within',
    unit: '%',
    default: 1,
    min: 0,
    max: 10,
    step: 0.5,
  },
];

export const DEFAULT_FINDING_THRESHOLDS: FindingThresholds = Object.fromEntries(
  FINDING_THRESHOLD_SPECS.map((spec) => [spec.key, spec.default])
) as FindingThresholds;

const PREF_KEY = 'coachFindings';

const SPEC_BY_KEY = new Map(FINDING_THRESHOLD_SPECS.map((spec) => [spec.key, spec]));

/** A value pulled into its spec's range and onto its step grid; NaN → the default. */
export function clampThreshold(key: FindingThresholdKey, value: number): number {
  const spec = SPEC_BY_KEY.get(key)!;
  if (!Number.isFinite(value)) return spec.default;
  const stepped = Math.round(value / spec.step) * spec.step;
  // Round off the float dust a fractional step leaves (1.9600000000000002).
  const clean = Math.round(stepped * 1000) / 1000;
  return Math.min(spec.max, Math.max(spec.min, clean));
}

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The thresholds in force. A plain SELECT — never `getOrCreateUser` — because
 * the detectors that call this promise to write nothing, and creating the user
 * row would be a write (db/findings.test.mjs asserts the database is unchanged).
 */
export function getFindingThresholds(db: Database): FindingThresholds {
  const row = db.get<{ preferences: string }>(
    'SELECT preferences FROM users ORDER BY created_at, id LIMIT 1'
  );
  const stored = parseObject(row?.preferences)[PREF_KEY];
  const record =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const out = { ...DEFAULT_FINDING_THRESHOLDS };
  for (const spec of FINDING_THRESHOLD_SPECS) {
    const value = record[spec.key];
    if (typeof value === 'number') out[spec.key] = clampThreshold(spec.key, value);
  }
  return out;
}

/**
 * Write a patch (clamped), keeping every other preference key. A value equal to
 * its default is dropped rather than stored, so "reset" is the absence of the
 * key and a later, better-argued default still reaches him.
 */
export function saveFindingThresholds(
  db: Database,
  patch: Partial<FindingThresholds>
): FindingThresholds {
  const user = getOrCreateUser(db);
  const next = { ...getFindingThresholds(db) };
  for (const spec of FINDING_THRESHOLD_SPECS) {
    const value = patch[spec.key];
    if (typeof value === 'number') next[spec.key] = clampThreshold(spec.key, value);
  }
  const stored: Partial<FindingThresholds> = {};
  for (const spec of FINDING_THRESHOLD_SPECS) {
    if (next[spec.key] !== spec.default) stored[spec.key] = next[spec.key];
  }
  const preferences = parseObject(user.preferences);
  if (Object.keys(stored).length > 0) preferences[PREF_KEY] = stored;
  else delete preferences[PREF_KEY];
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
  return next;
}

/** Every knob back to its default. */
export function resetFindingThresholds(db: Database): FindingThresholds {
  return saveFindingThresholds(db, DEFAULT_FINDING_THRESHOLDS);
}

// --- Curated reference data (not settings) -----------------------------------

/**
 * Per-biomarker PHYSIOLOGIC bands, in the catalog's canonical unit — the edges
 * of what a living, walking person's blood produces. NOT a reference range and
 * not a target. A value outside one is almost always a unit or parse error (a
 * glucose of 5.5 stored as mg/dL was 5.5 mmol/L; a hemoglobin of 150 was g/L; a
 * hematocrit of 0.45 was a fraction). Deliberately wide: a real extreme (a
 * triglyceride of 3,000 in a lipemic sample) must never be called a typo.
 *
 * Applied ONLY when the stored biomarker's unit is the band's unit, so a
 * catalog row a report created under another unit is never judged against a
 * band written in this one. This is the plausible-range check
 * docs/labs-subapp.md §7 said the import lacked — as a FINDING, not a gate:
 * nothing is refused or rewritten.
 */
export const PHYSIOLOGIC_BANDS: Readonly<
  Record<string, { unit: string; low: number; high: number }>
> = {
  apob: { unit: 'mg/dL', low: 10, high: 400 },
  ldl_c: { unit: 'mg/dL', low: 5, high: 600 },
  hdl_c: { unit: 'mg/dL', low: 5, high: 200 },
  triglycerides: { unit: 'mg/dL', low: 10, high: 5000 },
  total_cholesterol: { unit: 'mg/dL', low: 50, high: 1000 },
  hs_crp: { unit: 'mg/L', low: 0, high: 500 },
  homocysteine: { unit: 'umol/L', low: 1, high: 200 },
  fasting_glucose: { unit: 'mg/dL', low: 20, high: 1000 },
  fasting_insulin: { unit: 'uIU/mL', low: 0.1, high: 500 },
  hba1c: { unit: '%', low: 3, high: 20 },
  uric_acid: { unit: 'mg/dL', low: 0.5, high: 20 },
  sodium: { unit: 'mmol/L', low: 100, high: 180 },
  potassium: { unit: 'mmol/L', low: 1.5, high: 9 },
  chloride: { unit: 'mmol/L', low: 60, high: 140 },
  calcium: { unit: 'mg/dL', low: 4, high: 18 },
  phosphorus: { unit: 'mg/dL', low: 0.5, high: 15 },
  alt: { unit: 'U/L', low: 1, high: 5000 },
  ast: { unit: 'U/L', low: 1, high: 5000 },
  albumin: { unit: 'g/dL', low: 1, high: 7 },
  creatinine: { unit: 'mg/dL', low: 0.1, high: 20 },
  bun: { unit: 'mg/dL', low: 1, high: 200 },
  hemoglobin: { unit: 'g/dL', low: 3, high: 25 },
  hematocrit: { unit: '%', low: 10, high: 75 },
  platelets: { unit: '10^3/uL', low: 5, high: 2000 },
  tsh: { unit: 'uIU/mL', low: 0.005, high: 200 },
  free_t4: { unit: 'ng/dL', low: 0.1, high: 10 },
  testosterone_total: { unit: 'ng/dL', low: 5, high: 3000 },
  cortisol: { unit: 'ug/dL', low: 0.5, high: 100 },
  vitamin_d: { unit: 'ng/mL', low: 2, high: 200 },
  vitamin_b12: { unit: 'pg/mL', low: 50, high: 5000 },
  ferritin: { unit: 'ng/mL', low: 1, high: 10000 },
  transferrin_saturation: { unit: '%', low: 1, high: 100 },
};

/**
 * Within-subject biological variation (CVi, %), approximately the EFLM
 * Biological Variation Database's figures, rounded — the noise a marker carries
 * between two draws of the SAME healthy person, which is what "worsened beyond
 * its own noise" has to clear. An unlisted marker takes
 * {@link DEFAULT_LAB_CV_PCT}, deliberately on the noisy side, so an uncurated
 * marker under-reports rather than over-reports.
 */
export const LAB_NOISE_CV_PCT: Readonly<Record<string, number>> = {
  apob: 7,
  ldl_c: 8,
  hdl_c: 6,
  triglycerides: 20,
  total_cholesterol: 5,
  non_hdl_c: 7,
  lp_a: 9,
  hs_crp: 40,
  homocysteine: 9,
  fibrinogen: 11,
  fasting_glucose: 5,
  fasting_insulin: 25,
  hba1c: 2,
  homa_ir: 27,
  uric_acid: 9,
  sodium: 1,
  potassium: 5,
  chloride: 1,
  calcium: 2,
  phosphorus: 8,
  alt: 18,
  ast: 10,
  ggt: 11,
  alp: 6,
  bilirubin_total: 21,
  albumin: 3,
  creatinine: 5,
  egfr: 6,
  bun: 14,
  cystatin_c: 5,
  wbc: 11,
  rbc: 3,
  hemoglobin: 3,
  hematocrit: 3,
  mcv: 1,
  rdw: 3,
  platelets: 8,
  tsh: 18,
  free_t3: 6,
  free_t4: 6,
  testosterone_total: 10,
  testosterone_free: 12,
  shbg: 9,
  estradiol: 18,
  dhea_s: 9,
  cortisol: 20,
  igf_1: 11,
  vitamin_d: 10,
  vitamin_b12: 7,
  folate: 15,
  ferritin: 12,
  iron: 25,
  transferrin_saturation: 25,
  zinc: 9,
  psa_total: 14,
  omega_3_index: 6,
};

/** The CVi for a marker nobody curated — on the noisy side on purpose. */
export const DEFAULT_LAB_CV_PCT = 15;

/** The assay's own imprecision (CVa, %), folded into every RCV. */
export const LAB_ANALYTIC_CV_PCT = 3;

/**
 * The windows the detectors look through — fixed, not settings, because each is
 * a question of how much history it takes to know something rather than of how
 * sensitive he wants the Coach to be. Kept here so every number the detectors
 * use is in this one file.
 */
export const FINDING_WINDOWS = {
  // Eight weeks of his own history set a cadence: a weekly weigher is seen
  // eight times, a daily one fifty-six.
  cadenceDays: 56,
  // Five intervals before a "usual spacing" is claimed at all.
  cadenceMinLogs: 6,
  // A median spacing past three weeks is not a habit with a rhythm to break.
  cadenceMaxIntervalDays: 21,
  // Meals: "usually logged" is judged over days 8–35 back, so the days being
  // checked never dilute the habit they are checked against…
  mealBaselineFromDaysAgo: 35,
  mealBaselineToDaysAgo: 8,
  // …needs two weeks of eligible days, and means meals on 80% of them.
  mealMinEligibleDays: 14,
  mealUsualFraction: 0.8,
  // The complete days checked for a missing meal log (today never is).
  mealLookbackDays: 7,
  // "Active": at least half his median step count that day — the phone was
  // with him and the day was lived — or a workout, a ticked item, a weigh-in.
  mealActiveStepsFraction: 0.5,
  // Duplicates older than two weeks are history the Coach cannot usefully raise.
  duplicateLookbackDays: 14,
  // Weight readings compared only when at most two days apart: past that, a
  // real change has had time to happen.
  weightLookbackDays: 30,
  weightPairMaxDays: 2,
  // HRV / RHR baseline: the 60 days ending a month ago, with at least 14
  // readings — far enough back that a run being looked for is not inside the
  // baseline that judges it.
  vitalBaselineFromDaysAgo: 89,
  vitalBaselineToDaysAgo: 30,
  vitalBaselineMinPoints: 14,
  // Single implausible readings: the last week. Runs: the last month, and the
  // run must reach yesterday or today.
  vitalImplausibleLookbackDays: 7,
  vitalRunLookbackDays: 30,
  // A lab draw older than a year is not news; its finding stops being raised.
  labMaxAgeDays: 365,
  // A re-import shares at least 3 markers, covering 80% of the smaller
  // report, and 90% of those agree within the tolerance.
  labDuplicateMinShared: 3,
  labDuplicateSharedFraction: 0.8,
  labDuplicateMatchFraction: 0.9,
  // How far back a persisting symptom's episode start is traced.
  symptomHistoryDays: 120,
} as const;
