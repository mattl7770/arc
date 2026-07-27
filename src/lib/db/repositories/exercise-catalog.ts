/**
 * The exercise catalog data layer (0011_exercise_catalog.sql).
 *
 * Reads the movement library — seeded core (stable slug ids) plus user-created
 * custom exercises (UUID ids, is_custom = 1) — with each movement's muscles
 * decoded from its exercise_muscles children (json_group_array keeps it one
 * query per list, no N+1). Depends only on the {@link Database} interface, so
 * the same code runs on device and in db/exercise-catalog.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type {
  CatalogExercise,
  CatalogFilter,
  ExerciseRow,
  Muscle,
  MuscleRole,
  NewExercise,
} from '@/lib/exercise/types';

type MuscleJson = { muscle: Muscle; role: MuscleRole };
type CatalogRow = ExerciseRow & { muscles_json: string | null };

const MUSCLES_SUBQUERY = `(
  SELECT json_group_array(json_object('muscle', m.muscle, 'role', m.role))
  FROM exercise_muscles m WHERE m.exercise_id = e.id
) AS muscles_json`;

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toCatalogExercise(row: CatalogRow): CatalogExercise {
  const muscles: MuscleJson[] = row.muscles_json ? JSON.parse(row.muscles_json) : [];
  return {
    id: row.id,
    name: row.name,
    aliases: parseAliases(row.aliases),
    equipment: row.equipment,
    movementPattern: row.movement_pattern,
    mechanic: row.mechanic,
    loggingType: row.logging_type,
    unilateral: row.unilateral === 1,
    isCustom: row.is_custom === 1,
    primaryMuscles: muscles.filter((m) => m.role === 'primary').map((m) => m.muscle),
    secondaryMuscles: muscles.filter((m) => m.role === 'secondary').map((m) => m.muscle),
  };
}

/**
 * Live (non-archived) catalog exercises, name-ordered, each with its muscles.
 * Filters AND-combine: `search` matches name or an alias (cheap LIKE over the
 * raw JSON — case-insensitive for ASCII); `muscle` matches any role; `equipment`
 * is exact. Empty-safe.
 */
export function listExercises(db: Database, filter: CatalogFilter = {}): CatalogExercise[] {
  const where: string[] = ['e.archived = 0'];
  const params: (string | number)[] = [];

  if (filter.search && filter.search.trim() !== '') {
    const like = `%${filter.search.trim()}%`;
    where.push('(e.name LIKE ? OR e.aliases LIKE ?)');
    params.push(like, like);
  }
  if (filter.equipment) {
    where.push('e.equipment = ?');
    params.push(filter.equipment);
  }
  if (filter.muscle) {
    where.push(
      'EXISTS (SELECT 1 FROM exercise_muscles mm WHERE mm.exercise_id = e.id AND mm.muscle = ?)'
    );
    params.push(filter.muscle);
  }

  const rows = db.all<CatalogRow>(
    `SELECT e.*, ${MUSCLES_SUBQUERY}
     FROM exercises e
     WHERE ${where.join(' AND ')}
     ORDER BY e.name COLLATE NOCASE`,
    params
  );
  return rows.map(toCatalogExercise);
}

/** One catalog exercise by id (including archived), or undefined. */
export function getExercise(db: Database, id: string): CatalogExercise | undefined {
  const row = db.get<CatalogRow>(
    `SELECT e.*, ${MUSCLES_SUBQUERY} FROM exercises e WHERE e.id = ?`,
    [id]
  );
  return row ? toCatalogExercise(row) : undefined;
}

/** The primary/secondary muscles for a set of exercise ids, keyed by id. */
export function musclesByExercise(
  db: Database,
  exerciseIds: string[]
): Map<string, { primary: Muscle[]; secondary: Muscle[] }> {
  const out = new Map<string, { primary: Muscle[]; secondary: Muscle[] }>();
  if (exerciseIds.length === 0) return out;
  const placeholders = exerciseIds.map(() => '?').join(', ');
  const rows = db.all<{ exercise_id: string; muscle: Muscle; role: MuscleRole }>(
    `SELECT exercise_id, muscle, role FROM exercise_muscles
     WHERE exercise_id IN (${placeholders})`,
    exerciseIds
  );
  for (const r of rows) {
    const entry = out.get(r.exercise_id) ?? { primary: [], secondary: [] };
    (r.role === 'primary' ? entry.primary : entry.secondary).push(r.muscle);
    out.set(r.exercise_id, entry);
  }
  return out;
}

/**
 * Create a custom exercise + its muscle mappings in one transaction. Returns the
 * new exercise id (a UUID — seeded rows use slugs, custom rows use newId).
 */
export function createCustomExercise(db: Database, input: NewExercise): string {
  const id = newId(db);
  db.transaction(() => {
    db.run(
      `INSERT INTO exercises
         (id, name, equipment, movement_pattern, mechanic, logging_type, unilateral, is_custom)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        input.name.trim(),
        input.equipment,
        input.movementPattern ?? null,
        input.mechanic ?? null,
        input.loggingType,
        input.unilateral ? 1 : 0,
      ]
    );
    const insertMuscle = (muscle: Muscle, role: MuscleRole) =>
      db.run('INSERT INTO exercise_muscles (id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)', [
        newId(db),
        id,
        muscle,
        role,
      ]);
    for (const m of input.primaryMuscles) insertMuscle(m, 'primary');
    // A muscle can't be both primary and secondary (UNIQUE(exercise, muscle)) —
    // drop any secondary that's already primary so the insert can't trip it.
    const primarySet = new Set(input.primaryMuscles);
    for (const m of input.secondaryMuscles ?? [])
      if (!primarySet.has(m)) insertMuscle(m, 'secondary');
  });
  return id;
}

/** Hide an exercise from pickers without destroying history that points at it. */
export function archiveExercise(db: Database, id: string): void {
  db.run('UPDATE exercises SET archived = 1 WHERE id = ?', [id]);
}
