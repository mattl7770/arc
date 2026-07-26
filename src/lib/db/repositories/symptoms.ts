/**
 * The symptom log's data layer: symptoms in, the day's symptoms out.
 *
 * Symptoms live in their own `symptoms` table (0004_symptoms.sql) with
 * structured severity / body-area fields. Manual entry writes here today; a
 * future voice/NL path (Phase 3, Coach) writes the same rows with its own
 * `source`. Depends only on the {@link Database} interface — never op-sqlite —
 * so the same code runs on device and against node:sqlite in db/symptoms.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { NewSymptom, SymptomRow } from '@/lib/symptoms/types';

/** Persist one symptom; returns its id. Absent severity/area/time store as NULL. */
export function logSymptom(db: Database, symptom: NewSymptom): string {
  const id = newId(db);
  db.run(
    `INSERT INTO symptoms (id, date, time, name, severity, body_area, notes, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`,
    [
      id,
      symptom.date,
      symptom.time ?? null,
      symptom.name,
      symptom.severity ?? null,
      symptom.bodyArea ?? null,
      symptom.notes ?? null,
    ]
  );
  return id;
}

/**
 * The day's symptoms in occurrence order — by wall-clock time, untimed last,
 * ties by insertion. `date` is the local calendar day, passed in so the
 * headless tests are deterministic.
 */
export function listTodaySymptoms(db: Database, date: string): SymptomRow[] {
  return db.all<SymptomRow>(
    `SELECT * FROM symptoms WHERE date = ? ORDER BY (time IS NULL), time, created_at, id`,
    [date]
  );
}
