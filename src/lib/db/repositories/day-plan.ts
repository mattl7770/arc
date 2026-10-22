/**
 * Smart day, the data layer: gather the day's facts, hold the Coach's plan,
 * and record what became of it (0067 `day_plan_events`).
 *
 * The pure halves are src/lib/home/day-facts.ts (facts), src/lib/home/day-plan.ts
 * (evaluation, the top of Home, the summary) and src/lib/home/plan-lines.ts (the
 * PLAN grammar). This file is the only one that reads or writes rows for them.
 *
 * **The plan** lives in `users.preferences.dayPlan` — the `coachPass` pattern
 * (src/lib/ai/pass-schedule.ts): one value, replaced whole by every pass that
 * writes PLAN lines. **Its history** is the event table, written with
 * `INSERT OR IGNORE` against the (plan, item, event) unique index, so recording
 * `shown` on every Home render costs one row per item, ever.
 *
 * Nothing here reads `day_statuses` (the Status rule: a status is read only by
 * the adherence ledger, the readiness baselines and the record), and nothing
 * here writes a mission row: a Coach item is never one.
 */
import type { Database } from '@/lib/db/database';
import { getDayStartsAt, logicalDayUtcRange, shiftISODate, todayISODate } from '@/lib/db/date';
import { newId } from '@/lib/db/id';
import { activeExperiments } from '@/lib/db/repositories/experiments';
import { listMission } from '@/lib/db/repositories/mission';
import { listPendingEstimates } from '@/lib/db/repositories/pending-estimates';
import { isDueOn, listActiveReminders } from '@/lib/db/repositories/reminders';
import { listRoutines } from '@/lib/db/repositories/routines';
import { dueScreenings, upcomingAppointments } from '@/lib/db/repositories/screenings';
import { getOrCreateUser } from '@/lib/db/repositories/user';
import { waterDaySeries } from '@/lib/db/repositories/water';
import { pickDailyMetric } from '@/lib/db/repositories/wearables';
import { readOpenLiveSession } from '@/lib/exercise/session-bar';
import { buildDayFacts, dayFactsLines, type DayFacts, type FactTag } from '@/lib/home/day-facts';
import {
  evaluatePlan,
  homeTop,
  isPlanAction,
  summarizePlanEvents,
  type DayPlan,
  type EvaluatedItem,
  type HomeTop,
  type PlanEvent,
  type PlanEventRow,
  type PlanItem,
} from '@/lib/home/day-plan';
import { deriveMissionView } from '@/lib/home/derive-mission';
import { planInstructions, type PlanResolution } from '@/lib/home/plan-lines';

/** How far ahead an appointment is a fact worth naming. */
const APPOINTMENT_DAYS = 7;
/** Screenings due within this many days (or overdue) are named. */
const SCREENING_DAYS = 30;
/** The weigh-in window the facts read (they summarise 28 days; the extra is the gap before). */
const WEIGH_READ_DAYS = 60;
/** The learning window (owner: "a compact 14-day summary"). */
export const PLAN_SUMMARY_DAYS = 14;

// --- The facts --------------------------------------------------------------------

/** Read everything {@link buildDayFacts} states, for `now`'s logical day. */
export function gatherDayFacts(
  db: Database,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt(),
  snoozed: ReadonlySet<string> = new Set()
): DayFacts {
  const today = todayISODate(now, dayStartsAt);
  const yesterday = shiftISODate(today, -1);
  const weighFrom = logicalDayUtcRange(shiftISODate(today, -WEIGH_READ_DAYS), dayStartsAt).startUtc;
  const weighIns = db
    .all<{ measured_at: string }>(
      `SELECT measured_at FROM body_metrics
       WHERE weight_kg IS NOT NULL AND measured_at >= ?
       ORDER BY measured_at DESC`,
      [weighFrom]
    )
    .map((row) => row.measured_at);
  if (weighIns.length === 0) {
    // Older than the window: still "the last weigh-in", and still a fact.
    const last = db.get<{ measured_at: string }>(
      `SELECT measured_at FROM body_metrics WHERE weight_kg IS NOT NULL
       ORDER BY measured_at DESC LIMIT 1`
    );
    if (last) weighIns.push(last.measured_at);
  }
  const live = readOpenLiveSession(db);
  const water = waterDaySeries(db, 1, today)[0];
  const horizon = now.getTime() + APPOINTMENT_DAYS * 86_400_000;
  return buildDayFacts({
    now,
    today,
    dayStartsAt,
    mission: listMission(db, today),
    snoozed,
    weighIns,
    meals: db.all(
      `SELECT date, time, kcal, protein_g FROM meals WHERE date >= ? AND date <= ? ORDER BY date, time`,
      [yesterday, today]
    ),
    pendingEstimates: listPendingEstimates(db).length,
    sleepEnd: pickDailyMetric(db, 'sleep_duration_min', today)?.endTime ?? null,
    water: { ml: water?.ml ?? 0, entries: water?.entries ?? 0 },
    workoutsToday: db.all<{ name: string }>(
      `SELECT name FROM workouts WHERE date = ? ORDER BY created_at`,
      [today]
    ),
    liveSession: live ? { name: live.name, startedAt: live.draft.startedAt } : null,
    routines: listRoutines(db).map((r) => ({
      id: r.id,
      name: r.name,
      lastStartedAt: r.lastStartedAt,
    })),
    reminders: listActiveReminders(db)
      .filter((reminder) => isDueOn(reminder, today))
      .map((r) => ({ id: r.id, title: r.title, time: r.time, date: r.date, repeat: r.repeat })),
    appointments: upcomingAppointments(db, now.toISOString())
      .filter((a) => Date.parse(a.scheduled_at) <= horizon)
      .map((a) => ({ title: a.title, scheduledAt: a.scheduled_at })),
    screenings: dueScreenings(db, today, SCREENING_DAYS).map((s) => ({
      name: s.name,
      nextDue: s.next_due!,
    })),
    experiments: activeExperiments(db, today).map((e) => ({
      id: e.id,
      title: e.title,
      ready: e.ready,
      daysLeft: e.daysLeft,
    })),
  });
}

// --- The plan (preferences) ------------------------------------------------------

function parsePreferences(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readItem(raw: unknown): PlanItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const key = str(r.key);
  const title = str(r.title);
  const until = str(r.until);
  if (!key || !title || !until || typeof r.rank !== 'number') return null;
  if (r.kind === 'pin') {
    const entryId = str(r.entryId);
    if (!entryId) return null;
    return {
      key,
      rank: r.rank,
      kind: 'pin',
      entryId,
      title,
      reason: str(r.reason) ?? null,
      until,
      untilGiven: r.untilGiven === true,
    };
  }
  if (r.kind === 'do') {
    const action = str(r.action);
    if (!action || !isPlanAction(action)) return null;
    const targetId = str(r.targetId);
    return {
      key,
      rank: r.rank,
      kind: 'do',
      action,
      ...(targetId ? { targetId } : {}),
      title,
      reason: str(r.reason) ?? null,
      until,
      untilGiven: r.untilGiven === true,
    };
  }
  return null;
}

/** The plan the last pass wrote, or null. A corrupt value reads as no plan. */
export function getDayPlan(db: Database): DayPlan | null {
  const section = parsePreferences(getOrCreateUser(db).preferences)['dayPlan'];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  const r = section as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.day !== 'string' || typeof r.madeAt !== 'string')
    return null;
  const items = Array.isArray(r.items)
    ? r.items.map(readItem).filter((i): i is PlanItem => i !== null)
    : [];
  return { id: r.id, day: r.day, madeAt: r.madeAt, items };
}

function writeDayPlan(db: Database, plan: DayPlan | null): void {
  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  if (plan === null) delete preferences.dayPlan;
  else preferences.dayPlan = plan;
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
}

// --- The events ---------------------------------------------------------------------

/** Record one event for one item. Idempotent: the (plan, item, event) index ignores a repeat. */
export function recordPlanEvent(
  db: Database,
  plan: DayPlan,
  item: PlanItem,
  event: PlanEvent,
  now: Date = new Date()
): void {
  db.run(
    `INSERT OR IGNORE INTO day_plan_events
       (id, day, plan_id, item_key, kind, action, log_entry_id, title, rank, event, at)
     VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM log_entries WHERE id = ?), ?, ?, ?, ?)`,
    [
      newId(db),
      plan.day,
      plan.id,
      item.key,
      item.kind,
      item.kind === 'do' ? (item.action ?? null) : null,
      // Through a sub-select: a pinned row deleted since the plan was written
      // records NULL rather than failing the foreign key.
      item.kind === 'pin' ? (item.entryId ?? null) : null,
      item.title,
      item.rank,
      event,
      now.toISOString(),
    ]
  );
}

function eventsFor(db: Database, planId: string): Set<string> {
  return new Set(
    db
      .all<{ item_key: string; event: string }>(
        'SELECT item_key, event FROM day_plan_events WHERE plan_id = ?',
        [planId]
      )
      .map((row) => `${row.item_key}|${row.event}`)
  );
}

// --- Evaluation --------------------------------------------------------------------

/** What has become of each item of the standing plan, as of `now`. Reads only. */
export function readDayPlan(
  db: Database,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): { plan: DayPlan | null; items: EvaluatedItem[] } {
  const plan = getDayPlan(db);
  if (!plan) return { plan: null, items: [] };
  const today = todayISODate(now, dayStartsAt);
  const since = plan.madeAt;
  const exists = (sql: string, params: (string | number)[]) => db.get(sql, params) !== undefined;
  const live = readOpenLiveSession(db);
  const items = evaluatePlan(plan, {
    now,
    today,
    events: eventsFor(db, plan.id),
    rows: new Map(listMission(db, today).map((row) => [row.id, row])),
    weightSince: exists(
      `SELECT 1 FROM body_metrics WHERE weight_kg IS NOT NULL AND created_at >= ? AND measured_at >= ? LIMIT 1`,
      [since, logicalDayUtcRange(today, dayStartsAt).startUtc]
    ),
    mealSince: exists(`SELECT 1 FROM meals WHERE date = ? AND created_at >= ? LIMIT 1`, [
      today,
      since,
    ]),
    waterSince: exists(
      `SELECT 1 FROM wearable_data WHERE metric_type = 'water_ml' AND date = ? AND created_at >= ? LIMIT 1`,
      [today, since]
    ),
    workoutSince: exists(`SELECT 1 FROM workouts WHERE date = ? AND created_at >= ? LIMIT 1`, [
      today,
      since,
    ]),
    liveStartedAt: live ? live.draft.startedAt : null,
    activeReminders: new Set(listActiveReminders(db).map((r) => r.id)),
    activeExperiments: new Set(activeExperiments(db, today).map((e) => e.id)),
    routines: new Set(listRoutines(db).map((r) => r.id)),
  });
  return { plan, items };
}

/**
 * Read the plan and WRITE what the read found that is not on record yet —
 * the `done`, `dismissed` and `expired` transitions. Home calls it after it has
 * drawn (an effect, never a render); a pass calls it before it writes a new plan.
 */
export function settleDayPlan(
  db: Database,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): { plan: DayPlan | null; items: EvaluatedItem[] } {
  const read = readDayPlan(db, now, dayStartsAt);
  if (read.plan) {
    for (const item of read.items) {
      if (item.transition) recordPlanEvent(db, read.plan, item, item.transition, now);
    }
  }
  return read;
}

/**
 * The top of Home as Home draws it — the mission's time-ordered hero, unless a
 * live plan item comes first. The Coach's state block reads THIS, so it names
 * what the screen shows. `snoozed` is the session's snooze set.
 */
export function homeTopFor(
  db: Database,
  now: Date,
  snoozed: ReadonlySet<string>,
  dayStartsAt: string = getDayStartsAt()
): HomeTop {
  const today = todayISODate(now, dayStartsAt);
  const view = deriveMissionView(listMission(db, today), snoozed);
  return homeTop(view, readDayPlan(db, now, dayStartsAt).items);
}

// --- What a pass does ------------------------------------------------------------

/**
 * Apply a pass's resolved PLAN lines. `keep` changes nothing. `clear` and
 * `replace` first close every still-open item of the standing plan as
 * `replaced` (yesterday's as `expired` — they ended with their day), then write
 * the new plan, or none.
 *
 * Returns the plan now standing.
 */
export function applyDayPlan(
  db: Database,
  resolution: PlanResolution,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): DayPlan | null {
  if (resolution.decision === 'keep') return getDayPlan(db);
  const today = todayISODate(now, dayStartsAt);
  const standing = settleDayPlan(db, now, dayStartsAt);
  if (standing.plan) {
    for (const item of standing.items) {
      if (item.state === 'live') recordPlanEvent(db, standing.plan, item, 'replaced', now);
    }
  }
  const next: DayPlan | null =
    resolution.decision === 'clear'
      ? null
      : { id: newId(db), day: today, madeAt: now.toISOString(), items: resolution.items };
  writeDayPlan(db, next);
  return next;
}

/** The 14-day count summary, as one line for the pass. */
export function dayPlanSummary(db: Database, today: string): string {
  const rows = db.all<PlanEventRow>(
    `SELECT plan_id, item_key, kind, action, event FROM day_plan_events WHERE day > ? AND day <= ?`,
    [shiftISODate(today, -PLAN_SUMMARY_DAYS), today]
  );
  return summarizePlanEvents(rows);
}

/**
 * Everything the pass needs for its Top of Home block: the facts, the summary,
 * the standing plan — and the tags, which only this pass may resolve against.
 */
export function dayPlanDirectiveFor(
  db: Database,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt(),
  snoozed: ReadonlySet<string> = new Set()
): { block: string[]; tags: FactTag[]; today: string } {
  const facts = gatherDayFacts(db, now, dayStartsAt, snoozed);
  const standing = readDayPlan(db, now, dayStartsAt);
  const current = standing.plan && standing.plan.day === facts.today ? standing.items : [];
  return {
    block: planInstructions({
      clock: facts.clock,
      today: facts.today,
      facts: dayFactsLines(facts),
      summary: dayPlanSummary(db, facts.today),
      current,
      tags: facts.tags,
    }),
    tags: facts.tags,
    today: facts.today,
  };
}
