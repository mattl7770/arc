/**
 * First-run seeding.
 *
 *  - `seedReferenceData` fills the biomarker catalogue (app-shipped reference
 *    data, idempotent via INSERT OR IGNORE on the unique slug). Runs on boot.
 *  - `ensureTodaySeeded` makes sure a day has its mission, expanded from the
 *    user's OWN active protocols (plus the day's mode). It fabricates nothing:
 *    a user with no protocols gets a genuinely empty day, and Home renders its
 *    honest first-run state over that.
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
import { getActiveMode } from './repositories/day-modes';
import { generateMissionForDay } from './repositories/mission-generate';
import type { LogEntryType } from './types';
import { BIOMARKER_SEED } from '@/lib/labs/catalog';
import { modeChangesPlan } from '@/lib/modes/registry';
import type { MissionItem } from '@/types/home';

/** Mission category label → a real log_entry.type for stored entries. */
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
}

/**
 * Ensure `date` has its mission. The user's ACTIVE protocols are the only plan:
 * {@link generateMissionForDay} expands their live versions (adapted by the
 * day's mode) into `log_entries`. **Nothing is invented.** A user with no
 * protocols gets an empty day, which is the truth — Home renders its first-run
 * state (`src/components/home/mission-empty.tsx`) rather than a demo mission.
 *
 * Home used to plant an eleven-item mock day here whenever the generator
 * produced nothing, two of its rows pre-marked `completed`. That wrote fiction
 * into the user's own health database — the mission opened at "2 of 11", the
 * hero pinned to an invented supplement stack at any hour, and the Coach's
 * `get_today_snapshot` reported the invented rows as genuinely done. Nothing
 * auto-creates protocols, so it replanted every single day. Removed 2026-08-07.
 *
 * The generator is idempotent (it no-ops once the day has planned entries), so
 * this is cheap to call on every open AND every focus — which is what makes
 * "create your first protocol → return to Home" fill the day immediately.
 *
 * `fallbackMission` is a **test fixture affordance only**: passing items plants
 * them (marked `seed: true`) when the day is otherwise empty, so the headless
 * db suites can build a deterministic hand-made day. No app code passes it, and
 * the `seed: true` marking must stay supported regardless — devices that ran
 * the old build still hold seed rows, and the mode re-derive
 * (`mission-generate.ts`) keys off it to avoid deleting them.
 *
 * The guard is on *planned* entries (`countMissionEntries`), not ad-hoc Log-tab
 * captures — otherwise a note logged before Home opens on a new day would
 * suppress the whole day's mission (the note is filtered out of it).
 */
export function ensureTodaySeeded(
  db: Database,
  date: string,
  fallbackMission: MissionItem[] = []
): void {
  // Protocols (and the day's mode) drive the day; if they produced entries, done.
  if (generateMissionForDay(db, date) > 0) return;
  if (fallbackMission.length === 0) return;

  const log = getOrCreateDailyLog(db, date);
  if (countMissionEntries(db, log.id) > 0) return;
  // A plan-changing mode that produced no entries (e.g. a future Fasting mode
  // dropping all meals with no additions) has still HANDLED the day — never
  // paper a fixture over an intentionally-spare mode day.
  if (modeChangesPlan(getActiveMode(db, date))) return;
  db.transaction(() => {
    for (const item of fallbackMission) {
      const type = TYPE_BY_CATEGORY[item.category] ?? 'habit';
      insertMissionItem(db, log.id, type, item, { seed: true });
    }
  });
}
