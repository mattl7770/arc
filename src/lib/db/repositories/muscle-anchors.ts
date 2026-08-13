/**
 * Hand-set muscle freshness — the read/write side of migration 0036.
 *
 * A row here is an ANCHOR, never a value: "as of this instant, this muscle was
 * N percent recovered". `muscleFreshness` decays it on the muscle's own clock
 * and lets later sets deplete from it, so a correction fades the way a session
 * does instead of pinning the figure at a number forever. The reasoning in full
 * is in db/migrations/0036_muscle_freshness_anchors.sql.
 *
 * Depends only on the {@link Database} interface, so it runs headless in
 * db/exercise-ai.test.mjs against node:sqlite.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { FreshnessAnchor, Muscle } from '@/lib/exercise/types';

type AnchorRow = { muscle: Muscle; freshness: number; anchored_at: string };

/** Every anchor the user has set, newest assertion first. */
export function listMuscleAnchors(db: Database): FreshnessAnchor[] {
  return db
    .all<AnchorRow>(
      `SELECT muscle, freshness, anchored_at FROM muscle_freshness_anchors
       ORDER BY anchored_at DESC`
    )
    .map((r) => ({ muscle: r.muscle, freshness: r.freshness, anchoredAt: r.anchored_at }));
}

/**
 * Assert a muscle's freshness AS OF NOW, replacing any earlier assertion.
 *
 * `anchored_at` is stamped by SQLite rather than by JS on purpose: every other
 * instant in this schema comes from `strftime`, and mixing the two clocks is
 * what produced the "16 of 16 fresh straight after a session" bug the freshness
 * model now guards against (SKEW_TOLERANCE_HOURS in src/lib/exercise/freshness.ts).
 * One clock, one ordering.
 */
export function setMuscleAnchor(db: Database, muscle: Muscle, freshness: number): void {
  const value = Math.max(0, Math.min(100, Math.round(freshness)));
  db.run(
    `INSERT INTO muscle_freshness_anchors (id, muscle, freshness, anchored_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (muscle) DO UPDATE SET
       freshness = excluded.freshness,
       anchored_at = excluded.anchored_at`,
    [newId(db), muscle, value]
  );
}

/** Drop a muscle's anchor — the reading goes back to what the sets say. */
export function clearMuscleAnchor(db: Database, muscle: Muscle): void {
  db.run(`DELETE FROM muscle_freshness_anchors WHERE muscle = ?`, [muscle]);
}
