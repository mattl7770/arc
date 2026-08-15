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

/**
 * Fold a typed exercise name to the form the matcher compares on: lowercase,
 * punctuation to single spaces, and each token de-pluralised.
 *
 * The de-pluralisation is the part that earns its keep. Nobody writes their log
 * in the catalog's singular voice — it is "lat pulldowns", "barbell rows",
 * "bench presses" — and a matcher that only knows "Lat Pulldown" resolves none
 * of them. Three rules, in order, on tokens longer than three characters:
 * an `-es` after a sibilant comes off whole (`presses` → `press`, `crunches` →
 * `crunch`); a word already ending `-ss` is left alone (`press`); otherwise a
 * lone trailing `s` comes off (`rows`, `raises`, `dips`, `pulldowns`). `abs` is
 * short enough to be exempt. It is a stemmer for gym English, not for English.
 */
const singular = (t: string): string => {
  if (t.length <= 3) return t;
  if (/(?:ss|ch|sh|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('ss')) return t;
  return t.endsWith('s') ? t.slice(0, -1) : t;
};

function normalizeExerciseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map(singular)
    .join(' ');
}

/**
 * Resolve a free-text exercise name to a catalog id — the identity every piece
 * of engine intelligence (freshness, e1RM, PRs, volume, progression) keys on.
 *
 * **This is the fix for the 2026-08-14 freshness bug and it is worth being
 * precise about why.** `recentMuscleLoads` joins `workout_sets` to
 * `exercise_muscles` through `exercise_id`, so a set stored with a NULL
 * `exercise_id` contributes *exactly nothing* to the freshness model — not a
 * little, nothing. Three of the four write paths could produce that null: the
 * Manual-log screen never asked for an exercise at all, the Coach's
 * `log_workout` matched on strict exact name only ("lat pulldowns" ≠ "Lat
 * Pulldown"), and a photo import kept unmatched names as free text. So the
 * owner logged a full back day and the body figure moved by almost nothing.
 * The single resolver here, applied as a backstop in `insertSet`
 * (src/lib/db/repositories/exercise.ts), closes all three at once.
 *
 * Confidence discipline is the labs/nutrition-grounding rule, unchanged: a
 * UNIQUE match resolves and anything ambiguous stays null rather than guessing.
 * Three tiers, each tried only if the one above found nothing:
 *
 *   1. exact on the folded catalog name or a folded alias;
 *   2. one name is the other's leading phrase ("incline dumbbell press" for
 *      "incline dumbbell press machine"), multi-token only;
 *   3. nothing.
 *
 * Single-token needles never reach tier 2, which is what keeps "Bench" from
 * claiming "Bench Press" while "Bench Dip" also exists, and "Press" — pinned by
 * db/coach-tools.test.mjs §27 — from claiming anything at all.
 */
export function resolveExerciseByName(db: Database, name: string): string | null {
  const needle = normalizeExerciseName(name);
  if (needle === '') return null;
  // The LIKE narrows on the raw text; folding + uniqueness is decided in JS,
  // because SQLite cannot see through "rows" → "row".
  const first = needle.split(' ')[0] ?? '';
  const rows = db.all<{ id: string; name: string; aliases: string | null }>(
    `SELECT id, name, aliases FROM exercises
     WHERE archived = 0 AND (name LIKE ? OR aliases LIKE ?)`,
    [`%${first}%`, `%${first}%`]
  );
  const folded = rows.map((r) => ({
    id: r.id,
    names: [r.name, ...parseAliases(r.aliases)].map(normalizeExerciseName),
  }));

  const exact = folded.filter((e) => e.names.includes(needle));
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return null;

  if (needle.split(' ').length < 2) return null;
  const prefix = folded.filter((e) =>
    e.names.some((n) => n.startsWith(`${needle} `) || needle.startsWith(`${n} `))
  );
  return prefix.length === 1 ? prefix[0]!.id : null;
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
         (id, name, equipment, movement_pattern, mechanic, logging_type, unilateral, instructions, is_custom)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        input.name.trim(),
        input.equipment,
        input.movementPattern ?? null,
        input.mechanic ?? null,
        input.loggingType,
        input.unilateral ? 1 : 0,
        input.instructions && input.instructions.length > 0
          ? JSON.stringify(input.instructions)
          : null,
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
