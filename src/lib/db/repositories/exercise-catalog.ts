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
import {
  asLoadBasis,
  deriveLoadBasis,
  effectiveLoadBasis,
  type LoadBasis,
} from '@/lib/exercise/load-basis';
import { resolveUniqueMatch, type NameSource } from '@/lib/exercise/match';
import { asMeasures, MEASURES_FOR_LOGGING_TYPE } from '@/lib/exercise/measures';
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

/**
 * The columns {@link effectiveLoadBasis} reads, from any row that carries them.
 * Shared by the catalog decode and {@link exerciseLoadBases}, so the two can
 * never resolve the same movement differently.
 */
type LoadBasisColumns = Pick<
  ExerciseRow,
  | 'name'
  | 'aliases'
  | 'equipment'
  | 'logging_type'
  | 'measures'
  | 'unilateral'
  | 'movement_pattern'
  | 'load_basis'
>;

function loadBasisOf(row: LoadBasisColumns): {
  effective: LoadBasis | null;
  derived: LoadBasis | null;
  stored: LoadBasis | null;
} {
  const input = {
    name: row.name,
    aliases: parseAliases(row.aliases),
    equipment: row.equipment,
    loggingType: row.logging_type,
    measures: asMeasures(row.measures),
    unilateral: row.unilateral === 1,
    movementPattern: row.movement_pattern,
  };
  // Total read, like `asMeasures`: a value this build does not know reads as
  // "no correction", so ARC's own reading shows rather than nothing.
  const stored = asLoadBasis(row.load_basis);
  return {
    effective: effectiveLoadBasis(input, stored),
    derived: deriveLoadBasis(input),
    stored,
  };
}

function toCatalogExercise(row: CatalogRow): CatalogExercise {
  const muscles: MuscleJson[] = row.muscles_json ? JSON.parse(row.muscles_json) : [];
  const basis = loadBasisOf(row);
  return {
    id: row.id,
    name: row.name,
    aliases: parseAliases(row.aliases),
    equipment: row.equipment,
    movementPattern: row.movement_pattern,
    mechanic: row.mechanic,
    loggingType: row.logging_type,
    // Total read (0046): a row from a build ahead of this one, or a value the
    // CHECK somehow let through, reads as reps × load rather than crashing a
    // picker. `asMeasures` is where that promise lives.
    measures: asMeasures(row.measures),
    unilateral: row.unilateral === 1,
    isCustom: row.is_custom === 1,
    // 0056. A value the CHECK could not produce reads as null rather than being
    // passed through, on the same principle as `asMeasures` above: a screen
    // asking "who wrote this" must get an answer it can render, and "I don't
    // know" is one.
    source:
      row.source === 'seed' || row.source === 'user' || row.source === 'ai' ? row.source : null,
    // 0062. A stored correction on a movement that records no load is not
    // "set by the owner" in any sense a screen could show, so the flag follows
    // the effective value, not the column.
    loadBasis: basis.effective,
    loadBasisDerived: basis.derived,
    loadBasisSetByOwner: basis.stored != null && basis.effective != null,
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
 * Every live catalog row reduced to the names it answers to — the candidate set
 * the matcher ranks. ~70 seeded rows plus whatever the owner has created, so
 * the whole thing is read in one query and folded in JS.
 *
 * It used to be prefiltered with a `LIKE %first token%`, which was right while
 * matching was exact-only and is wrong now: a MISSPELLED first token LIKE-matches
 * nothing at all, so the prefilter would quietly defeat the tolerant tier it is
 * supposed to feed. SQLite cannot see through "rows" → "row" either, let alone
 * "bnech" → "bench". At this table size the honest read costs nothing.
 */
function catalogNames(db: Database): NameSource[] {
  const rows = db.all<{ id: string; name: string; aliases: string | null }>(
    'SELECT id, name, aliases FROM exercises WHERE archived = 0'
  );
  return rows.map((r) => ({ id: r.id, name: r.name, aliases: parseAliases(r.aliases) }));
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
 * The tiers, each tried only if the one above found nothing, now live in
 * src/lib/exercise/match.ts and are shared with the picker's search field:
 *
 *   1. exact on the folded catalog name or a folded alias — including under the
 *      SQUASH, so "skullcrusher" is the Skull Crusher and "pull-downs" is the
 *      Pulldown. That is not a guess: the letters are identical;
 *   2. the typed name is a catalog name's leading phrase — the input is shorter
 *      and exactly one catalog movement extends it ("bulgarian split squat"
 *      resolving to its one dumbbell variant), multi-token only;
 *   3. **within a few edits of exactly one movement** (2026-09-14, owner:
 *      *"common misspellings"*) — "bnech press", "sqaut", "dumbell curl". The
 *      tolerance is small and scales with length, transposition counts as one
 *      edit, and a tie between two movements resolves to NOTHING;
 *   4. nothing.
 *
 * Only the shorter-input direction is safe at tier 2. The reverse — a longer
 * input folding onto a shorter catalog name because the catalog name is its
 * leading phrase — pulls a distinct movement onto an unrelated one whenever the
 * trailing token discriminates rather than qualifies: "deadlift sumo" is not
 * conventional "Deadlift", and "bench press close grip" is not plain "Bench
 * Press". Natural word order ("sumo deadlift", "close grip bench press") leads
 * with the qualifier and matches exactly at tier 1, so nothing is lost.
 *
 * Single-token needles never reach tier 2, which is what keeps "Bench" from
 * claiming "Bench Press" while "Bench Dip" also exists, and "Press" — pinned by
 * db/coach-tools.test.mjs §27 — from claiming anything at all. The picker's
 * CONTAINS tier, which is what makes typing "press" list every press, is never
 * consulted here for exactly that reason.
 */
export function resolveExerciseByName(db: Database, name: string): string | null {
  return resolveUniqueMatch(catalogNames(db), name);
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
 *
 * Two additions in C12 (0056), both because the AI entry authors a WHOLE
 * catalog row where the manual form authors three fields:
 *
 *   - `aliases` is finally written. The column has existed since 0011 and only
 *     the seed ever filled it, so a custom movement answered to exactly one
 *     spelling — which the A7 matcher then had nothing to rank. Stored as the
 *     JSON array the matcher already reads, trimmed and de-duplicated, and NULL
 *     rather than `[]` when there are none (the same shape `instructions` uses,
 *     and what every pre-existing row holds).
 *   - `source` records who wrote the facts. Omitted means `'user'`: the manual
 *     form is the only other caller, and it is the truthful reading of a hand-
 *     filled row. See the migration header for why this is not `is_custom`.
 */
export function createCustomExercise(db: Database, input: NewExercise): string {
  const id = newId(db);
  const aliases = [...new Set((input.aliases ?? []).map((a) => a.trim()).filter((a) => a !== ''))];
  db.transaction(() => {
    db.run(
      `INSERT INTO exercises
         (id, name, aliases, equipment, movement_pattern, mechanic, logging_type, measures, unilateral, instructions, is_custom, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        input.name.trim(),
        aliases.length > 0 ? JSON.stringify(aliases) : null,
        input.equipment,
        input.movementPattern ?? null,
        input.mechanic ?? null,
        input.loggingType,
        // Derived, not asked for (0046): every form in the app authors a
        // `logging_type` and nothing authors measures, so one mapping serves
        // the picker, AI search and the Coach alike — and the two columns
        // cannot drift. An explicit `measures` wins when a caller has one.
        input.measures ?? MEASURES_FOR_LOGGING_TYPE[input.loggingType],
        input.unilateral ? 1 : 0,
        input.instructions && input.instructions.length > 0
          ? JSON.stringify(input.instructions)
          : null,
        input.source ?? 'user',
      ]
    );
    const insertMuscle = (muscle: Muscle, role: MuscleRole) =>
      db.run('INSERT INTO exercise_muscles (id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)', [
        newId(db),
        id,
        muscle,
        role,
      ]);
    // UNIQUE(exercise_id, muscle) (0011) means a muscle repeated anywhere — in
    // the same list, or a secondary already listed primary — trips the second
    // INSERT and rolls the whole exercise back. An LLM-authored "New exercise"
    // can easily return primaryMuscles: ['chest','chest'], so dedupe every list
    // before inserting: primaries against themselves, secondaries against
    // themselves and against the primaries.
    const primarySet = new Set(input.primaryMuscles);
    for (const m of primarySet) insertMuscle(m, 'primary');
    const seenSecondary = new Set<Muscle>();
    for (const m of input.secondaryMuscles ?? [])
      if (!primarySet.has(m) && !seenSecondary.has(m)) {
        seenSecondary.add(m);
        insertMuscle(m, 'secondary');
      }
  });
  return id;
}

/** Hide an exercise from pickers without destroying history that points at it. */
export function archiveExercise(db: Database, id: string): void {
  db.run('UPDATE exercises SET archived = 1 WHERE id = ?', [id]);
}

/**
 * The owner's correction of what a movement's weight figure counts (0062), or
 * `null` to go back to ARC's own reading.
 *
 * Picking the basis ARC would have derived anyway is stored as NULL, not as
 * that value: the column's one meaning is "the owner disagreed with the
 * derivation", and a stored copy of the derivation would also stop following
 * it if the derivation is ever improved.
 *
 * It RELABELS and never rescales: no `workout_sets` row is read or written, and
 * nothing derived from the figures is cached anywhere. The owner typed what was
 * on the dumbbell all along; only what the number is called changes.
 */
export function setExerciseLoadBasis(db: Database, id: string, basis: LoadBasis | null): void {
  if (basis !== null && asLoadBasis(basis) === null) {
    throw new Error(`Unknown load basis "${String(basis)}".`);
  }
  const row = db.get<LoadBasisColumns>(
    `SELECT name, aliases, equipment, logging_type, measures, unilateral, movement_pattern, load_basis
     FROM exercises WHERE id = ?`,
    [id]
  );
  if (!row) throw new Error(`No exercise ${id}.`);
  const derived = loadBasisOf({ ...row, load_basis: null }).derived;
  db.run('UPDATE exercises SET load_basis = ? WHERE id = ?', [
    basis === derived ? null : basis,
    id,
  ]);
}

/**
 * The effective load basis for several movements in one statement — for the
 * live logger's column headings, which need one per block and none of the
 * muscles {@link getExercise} would also decode. Ids that name nothing are
 * simply absent from the map.
 */
export function exerciseLoadBases(
  db: Database,
  exerciseIds: readonly string[]
): Map<string, LoadBasis | null> {
  const out = new Map<string, LoadBasis | null>();
  const ids = [...new Set(exerciseIds)];
  if (ids.length === 0) return out;
  const rows = db.all<LoadBasisColumns & { id: string }>(
    `SELECT id, name, aliases, equipment, logging_type, measures, unilateral, movement_pattern, load_basis
     FROM exercises WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids
  );
  for (const row of rows) out.set(row.id, loadBasisOf(row).effective);
  return out;
}
