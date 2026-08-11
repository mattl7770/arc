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
import { ingestCorpus } from '@/lib/rag/corpus';
import { newId } from './id';
import {
  countMissionEntries,
  getOrCreateDailyLog,
  insertMissionItem,
} from './repositories/mission';
import { getActiveMode } from './repositories/day-modes';
import { generateMissionForDay } from './repositories/mission-generate';
import type { LogEntryType } from './types';
import { BIOMARKER_SEED } from '@/lib/labs/catalog';
import { modeChangesPlan } from '@/lib/modes/registry';
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
 * The longevity-oriented biomarker catalogue now lives beside the labs
 * pipeline's other reference data (`src/lib/labs/catalog.ts`), which is what
 * maps a report's printed names onto it. Kept idempotent below: the 12 rows
 * seeded before that file existed are reproduced there byte-identically,
 * because INSERT OR IGNORE cannot update an already-seeded device.
 */

/** Idempotent: adds any biomarkers not already present (by slug). */
export function seedReferenceData(db: Database): void {
  db.transaction(() => {
    for (const b of BIOMARKER_SEED) {
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
  // ARC's curated longevity reference (src/lib/rag/corpus.ts) — the corpus the
  // Coach cites. Idempotent by pack version, and cheap: a few thousand words
  // of text, no vectors (those backfill when the embedder ships).
  ingestCorpus(db);
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
  //
  // Since 2026-08-08 a RUNNING EXPERIMENT also contributes an item (its
  // intervention, so adherence is visible), which means a user with an
  // experiment and no protocols gets a real one-item mission and no demo. That
  // is the intended reading of this guard, not an accident: the mock day exists
  // only to keep Home from being EMPTY on a fresh install, and a day with a
  // live experiment on it is not empty. Papering a fake demo over the user's
  // own experiment would be strictly worse.
  if (generateMissionForDay(db, date) > 0) return;

  // No protocols (or the day is already populated) — fall back to the mock demo
  // only when the day is genuinely empty of planned entries.
  const log = getOrCreateDailyLog(db, date);
  if (countMissionEntries(db, log.id) > 0) return;
  // A plan-changing mode that produced no entries (e.g. a future Fasting mode
  // dropping all meals with no additions) has still HANDLED the day — never
  // paper the mock demo over an intentionally-spare mode day.
  if (modeChangesPlan(getActiveMode(db, date))) return;
  db.transaction(() => {
    for (const item of fallbackMission) {
      const type = TYPE_BY_CATEGORY[item.category] ?? 'habit';
      insertMissionItem(db, log.id, type, item, { seed: true });
    }
  });
}
