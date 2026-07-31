/**
 * Experiments data layer (0027) — the n-of-1 self-experimentation loop
 * (docs/ai-coach.md §6). The Coach designs an experiment (change one thing,
 * watch metrics for N days), it runs, then the Coach reads the matching series
 * and writes the readout/conclusion. Pure over the {@link Database} interface,
 * headless-tested in db/experiments.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';

export type ExperimentStatus = 'active' | 'completed' | 'abandoned';

/** A row as stored (metrics is raw JSON text). */
type ExperimentRow = {
  id: string;
  title: string;
  hypothesis: string;
  intervention: string;
  metrics: string;
  start_date: string;
  end_date: string;
  status: ExperimentStatus;
  success_criteria: string | null;
  protocol_changes: string | null;
  outcome_notes: string | null;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
};

/** An experiment with `metrics` parsed to an array. */
export type Experiment = Omit<ExperimentRow, 'metrics'> & { metrics: string[] };

/** `date` shifted by `delta` days (UTC arithmetic, DST-proof), YYYY-MM-DD. */
function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function toExperiment(row: ExperimentRow): Experiment {
  const parsed: unknown = JSON.parse(row.metrics);
  const metrics = Array.isArray(parsed)
    ? parsed.filter((m): m is string => typeof m === 'string')
    : [];
  return { ...row, metrics };
}

export type NewExperiment = {
  title: string;
  hypothesis: string;
  intervention: string;
  metrics: string[];
  startDate: string;
  /** Inclusive length; end_date = startDate + (durationDays - 1). */
  durationDays: number;
  successCriteria?: string | null;
  protocolChanges?: unknown;
};

/** Create an active experiment; returns its id. */
export function createExperiment(db: Database, input: NewExperiment): string {
  if (!Number.isInteger(input.durationDays) || input.durationDays < 1) {
    throw new Error('durationDays must be a positive integer.');
  }
  const id = newId(db);
  const endDate = addDays(input.startDate, input.durationDays - 1);
  db.run(
    `INSERT INTO experiments
       (id, title, hypothesis, intervention, metrics, start_date, end_date,
        status, success_criteria, protocol_changes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      input.title,
      input.hypothesis,
      input.intervention,
      JSON.stringify(input.metrics),
      input.startDate,
      endDate,
      input.successCriteria ?? null,
      input.protocolChanges == null ? null : JSON.stringify(input.protocolChanges),
    ]
  );
  return id;
}

/** Experiments, newest first, optionally filtered by status. */
export function listExperiments(db: Database, status?: ExperimentStatus): Experiment[] {
  const rows = status
    ? db.all<ExperimentRow>(
        `SELECT * FROM experiments WHERE status = ? ORDER BY start_date DESC, created_at DESC`,
        [status]
      )
    : db.all<ExperimentRow>(`SELECT * FROM experiments ORDER BY start_date DESC, created_at DESC`);
  return rows.map(toExperiment);
}

export function getExperiment(db: Database, id: string): Experiment | null {
  const row = db.get<ExperimentRow>(`SELECT * FROM experiments WHERE id = ?`, [id]);
  return row ? toExperiment(row) : null;
}

/**
 * Active experiments, each flagged `ready` when its window has closed
 * (`end_date < today`) — the ones the Coach should read out.
 */
export function activeExperiments(
  db: Database,
  today: string
): (Experiment & { ready: boolean; daysLeft: number })[] {
  return listExperiments(db, 'active').map((e) => ({
    ...e,
    ready: e.end_date < today,
    daysLeft: Math.max(0, Math.round((Date.parse(e.end_date) - Date.parse(today)) / 86_400_000)),
  }));
}

/** The most-recently-CONCLUDED experiments, newest readout first (by
 * updated_at, which is stamped at completion — not start_date). */
export function recentlyConcluded(db: Database, limit = 5): Experiment[] {
  return db
    .all<ExperimentRow>(
      `SELECT * FROM experiments WHERE status = 'completed' ORDER BY updated_at DESC LIMIT ?`,
      [limit]
    )
    .map(toExperiment);
}

/** Conclude an experiment: record the verdict + readout, mark completed. Only
 * an ACTIVE experiment can be concluded (the `AND status` guards a double
 * readout that would overwrite an existing verdict). */
export function completeExperiment(
  db: Database,
  id: string,
  result: { conclusion: string; outcomeNotes?: string | null }
): void {
  db.run(
    `UPDATE experiments SET status = 'completed', conclusion = ?, outcome_notes = ?
     WHERE id = ? AND status = 'active'`,
    [result.conclusion, result.outcomeNotes ?? null, id]
  );
}

/** Abandon an experiment (stopped early, invalid). */
export function abandonExperiment(db: Database, id: string, reason?: string | null): void {
  db.run(`UPDATE experiments SET status = 'abandoned', outcome_notes = ? WHERE id = ?`, [
    reason ?? null,
    id,
  ]);
}
