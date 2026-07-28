/**
 * The training-programs data layer (0020_programs.sql).
 *
 * A program is a multi-week mesocycle: a repeating weekly split (program_days:
 * weekday → routine) plus a length in weeks and marked deload/test weeks
 * (program_weeks). `active_start` (a local date) anchors the running instance;
 * "today's session" is derived from elapsed weeks + the calendar weekday. At
 * most one program is active — activating one clears the rest.
 *
 * Depends only on the {@link Database} interface — runs on device and in
 * db/programs.test.mjs against node:sqlite.
 */
import type { Database } from '../database';
import { todayISODate } from '../date';
import { newId } from '../id';
import type {
  ProgramDay,
  ProgramDetail,
  ProgramInput,
  ProgramListItem,
  ProgramRow,
  ScheduledSession,
  Weekday,
  WeekKind,
} from '@/lib/exercise/types';

// --- pure date helpers (componentwise, timezone-stable) ----------------------

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
/** ISO weekday of a YYYY-MM-DD: 1=Mon … 7=Sun. */
function isoWeekday(s: string): Weekday {
  return (((parseLocalDate(s).getDay() + 6) % 7) + 1) as Weekday;
}
/** Whole days from `a` to `b` (both YYYY-MM-DD), local, DST-safe via round. */
function daysBetween(a: string, b: string): number {
  return Math.round((parseLocalDate(b).getTime() - parseLocalDate(a).getTime()) / 86_400_000);
}

// --- writes ------------------------------------------------------------------

function insertDaysAndWeeks(db: Database, programId: string, input: ProgramInput): void {
  input.days.forEach((day) => {
    db.run('INSERT INTO program_days (id, program_id, dow, routine_id) VALUES (?, ?, ?, ?)', [
      newId(db),
      programId,
      day.dow,
      day.routineId,
    ]);
  });
  // Store only weeks that differ from plain accumulation (sparse).
  input.weekKinds.forEach((kind, i) => {
    if (kind === 'accumulation') return;
    db.run('INSERT INTO program_weeks (id, program_id, week, kind) VALUES (?, ?, ?, ?)', [
      newId(db),
      programId,
      i + 1,
      kind,
    ]);
  });
}

/** Create a program, its split, and its week markers in one transaction. */
export function createProgram(db: Database, input: ProgramInput): string {
  const id = newId(db);
  db.transaction(() => {
    db.run('INSERT INTO programs (id, name, notes, weeks) VALUES (?, ?, ?, ?)', [
      id,
      input.name.trim(),
      input.notes,
      input.weeks,
    ]);
    insertDaysAndWeeks(db, id, input);
  });
  return id;
}

/**
 * Overwrite a program's identity, split, and week markers atomically. Preserves
 * active_start (editing a running program doesn't stop it), but clamps it away
 * if the program shrank below the running week is left to the caller.
 */
export function updateProgram(db: Database, id: string, input: ProgramInput): void {
  db.transaction(() => {
    db.run('UPDATE programs SET name = ?, notes = ?, weeks = ? WHERE id = ?', [
      input.name.trim(),
      input.notes,
      input.weeks,
      id,
    ]);
    db.run('DELETE FROM program_days WHERE program_id = ?', [id]);
    db.run('DELETE FROM program_weeks WHERE program_id = ?', [id]);
    insertDaysAndWeeks(db, id, input);
  });
}

export function deleteProgram(db: Database, id: string): void {
  db.run('DELETE FROM programs WHERE id = ?', [id]);
}

/**
 * Start a program on `startDate` (a local YYYY-MM-DD, typically the Monday of
 * the current week). Clears every other program's active_start in the same
 * transaction, so exactly one program runs at a time.
 */
export function activateProgram(db: Database, id: string, startDate: string): void {
  db.transaction(() => {
    db.run('UPDATE programs SET active_start = NULL WHERE active_start IS NOT NULL AND id != ?', [
      id,
    ]);
    db.run('UPDATE programs SET active_start = ? WHERE id = ?', [startDate, id]);
  });
}

/** Stop the running instance (the program template is kept). */
export function deactivateProgram(db: Database, id: string): void {
  db.run('UPDATE programs SET active_start = NULL WHERE id = ?', [id]);
}

// --- reads -------------------------------------------------------------------

export function getActiveProgram(db: Database): ProgramRow | undefined {
  return db.get<ProgramRow>(
    'SELECT * FROM programs WHERE active_start IS NOT NULL AND archived = 0 LIMIT 1'
  );
}

function weekKindOf(db: Database, programId: string, week: number): WeekKind {
  const row = db.get<{ kind: WeekKind }>(
    'SELECT kind FROM program_weeks WHERE program_id = ? AND week = ?',
    [programId, week]
  );
  return row?.kind ?? 'accumulation';
}

/** Current 1-based week of a running program on `today`, or null if not running/finished. */
function currentWeekOf(program: ProgramRow, today: string): number | null {
  if (!program.active_start) return null;
  const days = daysBetween(program.active_start, today);
  if (days < 0) return null;
  const week = Math.floor(days / 7) + 1;
  return week > program.weeks ? null : week;
}

/**
 * What the active program has scheduled for `today`: a training day (its
 * routine) or a rest day, with the week context. null when no program is
 * running, it hasn't started, or it has finished — the caller then falls back
 * to the freshness-based recommendation.
 */
export function scheduledToday(
  db: Database,
  today: string = todayISODate()
): ScheduledSession | null {
  const program = getActiveProgram(db);
  if (!program) return null;
  const week = currentWeekOf(program, today);
  if (week == null) return null;

  const ctx = {
    programId: program.id,
    programName: program.name,
    week,
    weeks: program.weeks,
    weekKind: weekKindOf(db, program.id, week),
  };
  const dow = isoWeekday(today);
  const day = db.get<{ routine_id: string; name: string }>(
    `SELECT pd.routine_id, r.name
     FROM program_days pd JOIN routines r ON r.id = pd.routine_id
     WHERE pd.program_id = ? AND pd.dow = ?`,
    [program.id, dow]
  );
  if (!day) return { kind: 'rest', program: ctx };
  return { kind: 'train', program: ctx, routineId: day.routine_id, routineName: day.name };
}

/** Programs for the hub list — active first, then name. Empty-safe. */
export function listPrograms(db: Database, today: string = todayISODate()): ProgramListItem[] {
  const rows = db.all<ProgramRow & { training_days: number | null }>(
    `SELECT p.*, count(pd.id) AS training_days
     FROM programs p
     LEFT JOIN program_days pd ON pd.program_id = p.id
     WHERE p.archived = 0
     GROUP BY p.id
     ORDER BY (p.active_start IS NOT NULL) DESC, p.name COLLATE NOCASE, p.id`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    weeks: r.weeks,
    trainingDays: r.training_days ?? 0,
    active: r.active_start != null,
    currentWeek: currentWeekOf(r, today),
  }));
}

/** One program with its split + per-week kinds, for the builder. */
export function getProgram(db: Database, id: string): ProgramDetail | undefined {
  const program = db.get<ProgramRow>('SELECT * FROM programs WHERE id = ?', [id]);
  if (!program) return undefined;
  const dayRows = db.all<{ dow: number; routine_id: string; name: string }>(
    `SELECT pd.dow, pd.routine_id, r.name
     FROM program_days pd JOIN routines r ON r.id = pd.routine_id
     WHERE pd.program_id = ?
     ORDER BY pd.dow`,
    [id]
  );
  const days: ProgramDay[] = dayRows.map((d) => ({
    dow: d.dow as Weekday,
    routineId: d.routine_id,
    routineName: d.name,
  }));
  const weekKinds: WeekKind[] = Array.from({ length: program.weeks }, () => 'accumulation');
  const overrides = db.all<{ week: number; kind: WeekKind }>(
    'SELECT week, kind FROM program_weeks WHERE program_id = ?',
    [id]
  );
  for (const o of overrides)
    if (o.week >= 1 && o.week <= program.weeks) weekKinds[o.week - 1] = o.kind;

  return {
    id: program.id,
    name: program.name,
    notes: program.notes,
    weeks: program.weeks,
    activeStart: program.active_start,
    days,
    weekKinds,
  };
}
