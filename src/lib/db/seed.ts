/**
 * First-run seeding.
 *
 *  - `seedReferenceData` fills the biomarker catalogue (app-shipped reference
 *    data, idempotent via INSERT OR IGNORE on the unique slug). Runs on boot.
 *  - `ensureTodaySeeded` plants a demo mission for today the first time the app
 *    opens on a given day, so the Home screen has something real to render
 *    before any live data exists. Caller passes the seed items (kept data-
 *    agnostic so it's testable and so mock-day stays the single source).
 *
 * Both are safe to call repeatedly.
 */
import type { Database } from './database';
import { newId } from './id';
import {
  countMissionEntries,
  getOrCreateDailyLog,
  insertMissionItem,
} from './repositories/mission';
import { generateMissionForDay } from './repositories/mission-generate';
import type { BiomarkerCategory, LogEntryType } from './types';
import type { MissionItem } from '@/types/home';

/** Mock category label → a real log_entry.type for stored entries. */
const TYPE_BY_CATEGORY: Record<string, LogEntryType> = {
  Morning: 'habit',
  Supplements: 'supplement',
  Nutrition: 'meal',
  Training: 'workout',
  Therapies: 'therapy',
  Evening: 'habit',
};

/**
 * A small, longevity-oriented starter catalogue. Optimal ranges are starting
 * points to refine against Function ranges later; `higher_is_better` is null
 * where the metric is U-shaped (neither direction is simply better).
 */
type BiomarkerSeed = {
  slug: string;
  name: string;
  category: BiomarkerCategory;
  unit: string;
  optimalLow: number | null;
  optimalHigh: number | null;
  higherIsBetter: 0 | 1 | null;
};

const BIOMARKERS: BiomarkerSeed[] = [
  {
    slug: 'apob',
    name: 'ApoB',
    category: 'cardiovascular',
    unit: 'mg/dL',
    optimalLow: null,
    optimalHigh: 80,
    higherIsBetter: 0,
  },
  {
    slug: 'ldl_c',
    name: 'LDL Cholesterol',
    category: 'cardiovascular',
    unit: 'mg/dL',
    optimalLow: null,
    optimalHigh: 100,
    higherIsBetter: 0,
  },
  {
    slug: 'hdl_c',
    name: 'HDL Cholesterol',
    category: 'cardiovascular',
    unit: 'mg/dL',
    optimalLow: 50,
    optimalHigh: null,
    higherIsBetter: 1,
  },
  {
    slug: 'triglycerides',
    name: 'Triglycerides',
    category: 'cardiovascular',
    unit: 'mg/dL',
    optimalLow: null,
    optimalHigh: 80,
    higherIsBetter: 0,
  },
  {
    slug: 'lp_a',
    name: 'Lipoprotein(a)',
    category: 'cardiovascular',
    unit: 'nmol/L',
    optimalLow: null,
    optimalHigh: 75,
    higherIsBetter: 0,
  },
  {
    slug: 'homocysteine',
    name: 'Homocysteine',
    category: 'cardiovascular',
    unit: 'umol/L',
    optimalLow: null,
    optimalHigh: 9,
    higherIsBetter: 0,
  },
  {
    slug: 'hs_crp',
    name: 'hs-CRP',
    category: 'inflammation',
    unit: 'mg/L',
    optimalLow: null,
    optimalHigh: 1,
    higherIsBetter: 0,
  },
  {
    slug: 'hba1c',
    name: 'HbA1c',
    category: 'metabolic',
    unit: '%',
    optimalLow: null,
    optimalHigh: 5.4,
    higherIsBetter: 0,
  },
  {
    slug: 'fasting_glucose',
    name: 'Fasting Glucose',
    category: 'metabolic',
    unit: 'mg/dL',
    optimalLow: 70,
    optimalHigh: 90,
    higherIsBetter: null,
  },
  {
    slug: 'fasting_insulin',
    name: 'Fasting Insulin',
    category: 'metabolic',
    unit: 'uIU/mL',
    optimalLow: null,
    optimalHigh: 5,
    higherIsBetter: 0,
  },
  {
    slug: 'vitamin_d',
    name: 'Vitamin D (25-OH)',
    category: 'nutrient',
    unit: 'ng/mL',
    optimalLow: 40,
    optimalHigh: 60,
    higherIsBetter: null,
  },
  {
    slug: 'ferritin',
    name: 'Ferritin',
    category: 'hematology',
    unit: 'ng/mL',
    optimalLow: 30,
    optimalHigh: 150,
    higherIsBetter: null,
  },
];

/** Idempotent: adds any biomarkers not already present (by slug). */
export function seedReferenceData(db: Database): void {
  db.transaction(() => {
    for (const b of BIOMARKERS) {
      db.run(
        `INSERT OR IGNORE INTO biomarkers
           (id, slug, name, category, unit, optimal_range_low, optimal_range_high, higher_is_better)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(db),
          b.slug,
          b.name,
          b.category,
          b.unit,
          b.optimalLow,
          b.optimalHigh,
          b.higherIsBetter,
        ]
      );
    }
  });
}

/**
 * Ensure `date` has a mission, protocol-first. The user's ACTIVE protocols are
 * the plan: {@link generateMissionForDay} expands their live versions into the
 * day's `log_entries`. The `fallbackMission` (mock-day) is planted ONLY when the
 * generator produced nothing — i.e. a fresh install with no protocols yet — so
 * Home is never empty before the user (or the Coach) has built any protocol.
 *
 * Both paths are guarded on *planned* entries (`countMissionEntries`), not
 * ad-hoc Log-tab captures — otherwise a note logged before Home opens on a new
 * day would suppress the whole day's mission (the note is filtered out of it).
 * The guard is per-day, so this fires on the first open of *every* day; once
 * protocols exist that is exactly right (the day is regenerated from them), and
 * a protocol edited today only reshapes tomorrow (today is already committed).
 * Fallback rows carry `seed: true`, generated rows `generated: true`, so the
 * three sources (protocol / mock seed / ad-hoc) stay distinguishable.
 */
export function ensureTodaySeeded(
  db: Database,
  date: string,
  fallbackMission: MissionItem[]
): void {
  // Protocols drive the day; if any active protocol produced entries, done.
  if (generateMissionForDay(db, date) > 0) return;

  // No protocols (or the day is already populated) — fall back to the mock demo
  // only when the day is genuinely empty of planned entries.
  const log = getOrCreateDailyLog(db, date);
  if (countMissionEntries(db, log.id) > 0) return;
  db.transaction(() => {
    for (const item of fallbackMission) {
      const type = TYPE_BY_CATEGORY[item.category] ?? 'habit';
      insertMissionItem(db, log.id, type, item, { seed: true });
    }
  });
}
