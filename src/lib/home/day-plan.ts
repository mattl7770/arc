/**
 * Smart day, the Coach's half as code sees it: the plan a pass wrote, what has
 * become of each item, and which one Home shows.
 *
 * A coach pass may end its reply with up to three PLAN lines
 * (src/lib/home/plan-lines.ts parses and validates them). What survives is a
 * {@link DayPlan}: at most three ordered items, each either
 *
 *   PIN — an existing mission row the Coach wants first, or
 *   DO  — a Coach item: a short title, one destination from {@link PLAN_ACTIONS},
 *         an optional `until`, and at most one line of reason.
 *
 * **A Coach item is never a mission row.** It is not in `log_entries`, it never
 * counts in "N of M", and nothing in the adherence ledger can see it — it lives
 * in `users.preferences.dayPlan` and its history in `day_plan_events` (0067).
 * It clears when its action's data arrives, when he dismisses it, when its
 * `until` passes (or its day ends), or when the next plan replaces it.
 *
 * **Code judges nothing here.** Which items, in what order, and why are the
 * model's. Everything in this file is bookkeeping a test can state exactly:
 * has the weight arrived since the plan was made, has the time passed, is the
 * pinned row still open. Without a live plan, {@link homeTop} is exactly
 * `deriveMissionView().next` — Home's behaviour before any of this existed.
 *
 * Pure: no database, no clock of its own. db/smart-day.test.mjs drives it.
 */
import type { MissionView } from '@/lib/home/derive-mission';
import type { MissionItem } from '@/types/home';

// --- The destinations -----------------------------------------------------------

/**
 * The doors a Coach item may open — a FIXED list, because a Coach item's tap
 * must land somewhere ARC can open, and "somewhere" the model invented is a
 * dead button. Adding one is a line here and a route in {@link destinationHref};
 * the 0067 `action` column is free text so it is never a migration.
 */
export const PLAN_ACTIONS = [
  'log_weight',
  'log_meal',
  'log_water',
  'start_workout',
  'resume_workout',
  'open_train',
  'open_reminder',
  'open_experiment',
  'open_screenings',
  'open_coach',
] as const;

export type PlanAction = (typeof PLAN_ACTIONS)[number];

export function isPlanAction(value: string): value is PlanAction {
  return (PLAN_ACTIONS as readonly string[]).includes(value);
}

type ActionSpec = {
  /** The kind of tag the action needs, or null for none. */
  target: 'routine' | 'reminder' | 'experiment' | null;
  /**
   * True when the destination has no data of its own to arrive — opening it IS
   * the act, so the tap clears the item. Otherwise the tap is `started` and the
   * item stays until the data lands (a weight, a meal, a session): backing out
   * of the weight keypad must not make the Coach's item vanish.
   */
  clearsOnTap: boolean;
  /** The hero's primary button. */
  button: string;
};

export const ACTION_SPEC: Record<PlanAction, ActionSpec> = {
  log_weight: { target: null, clearsOnTap: false, button: 'Log weight' },
  log_meal: { target: null, clearsOnTap: false, button: 'Log a meal' },
  log_water: { target: null, clearsOnTap: false, button: 'Log water' },
  start_workout: { target: 'routine', clearsOnTap: false, button: 'Start' },
  resume_workout: { target: null, clearsOnTap: false, button: 'Resume' },
  open_train: { target: null, clearsOnTap: true, button: 'Open Train' },
  open_reminder: { target: 'reminder', clearsOnTap: false, button: 'Open' },
  open_experiment: { target: 'experiment', clearsOnTap: true, button: 'Open' },
  open_screenings: { target: null, clearsOnTap: true, button: 'Open' },
  open_coach: { target: null, clearsOnTap: true, button: 'Open Coach' },
};

// --- The plan ---------------------------------------------------------------------

/** At most this many items in one plan (owner: "at most 3 items, ordered"). */
export const PLAN_MAX_ITEMS = 3;
/** A Coach item's title. Short: it is a hero headline and one checklist row. */
export const PLAN_TITLE_MAX = 40;
/** The reason line (owner: "≤ 90 characters, marked as the Coach's"). */
export const PLAN_REASON_MAX = 90;

export type PlanItem = {
  /** Identity inside the plan: `pin:<entry id>`, `do:<action>`, `do:<action>:<target id>`. */
  key: string;
  /** 1-based, in the order the Coach wrote. */
  rank: number;
  kind: 'pin' | 'do';
  /** pin: the mission row. */
  entryId?: string;
  /** do: the destination, and its target id when it takes one. */
  action?: PlanAction;
  targetId?: string;
  /** do: the Coach's title. pin: the row's title at the time (a snapshot). */
  title: string;
  reason: string | null;
  /** ISO instant the item holds until — the end of the logical day when none was given. */
  until: string;
  /** True when the Coach named the time, so Home may print it. */
  untilGiven: boolean;
};

export type DayPlan = {
  id: string;
  /** The logical day the plan was made for. */
  day: string;
  /** ISO instant the pass's plan was written. */
  madeAt: string;
  items: PlanItem[];
};

// --- What has become of each item ----------------------------------------------

export type PlanEvent = 'shown' | 'started' | 'dismissed' | 'done' | 'expired' | 'replaced';

/**
 * Everything {@link evaluatePlan} needs to know, gathered by the repository.
 * Each "since" means *on today's logical day and landed after the plan was
 * made* — data from before the plan cannot answer it.
 */
export type PlanOutcomes = {
  now: Date;
  today: string;
  /** Events already recorded for this plan, as `${item key}|${event}`. */
  events: ReadonlySet<string>;
  /** Today's mission rows by id. */
  rows: ReadonlyMap<string, MissionItem>;
  weightSince: boolean;
  mealSince: boolean;
  waterSince: boolean;
  workoutSince: boolean;
  /** The open live session's start, epoch ms; null when none is open. */
  liveStartedAt: number | null;
  activeReminders: ReadonlySet<string>;
  activeExperiments: ReadonlySet<string>;
  routines: ReadonlySet<string>;
};

/**
 *   live      on Home now
 *   gone      its object is not there any more (a deleted row, a discarded
 *             session) — inert, and nothing is recorded for it
 *   done / dismissed / expired / replaced   closed, as 0067 names them
 */
export type ItemState = 'live' | 'gone' | 'done' | 'dismissed' | 'expired' | 'replaced';

export type EvaluatedItem = PlanItem & {
  state: ItemState;
  /** The event this evaluation found that is not recorded yet — settle writes it. */
  transition: 'done' | 'dismissed' | 'expired' | null;
};

const CLOSED: PlanEvent[] = ['dismissed', 'done', 'replaced', 'expired'];

function dataArrived(item: PlanItem, outcomes: PlanOutcomes, madeAt: number): boolean | 'gone' {
  switch (item.action) {
    case 'log_weight':
      return outcomes.weightSince;
    case 'log_meal':
      return outcomes.mealSince;
    case 'log_water':
      return outcomes.waterSince;
    case 'start_workout':
      if (!item.targetId || !outcomes.routines.has(item.targetId)) return 'gone';
      return (
        outcomes.workoutSince ||
        (outcomes.liveStartedAt !== null && outcomes.liveStartedAt >= madeAt)
      );
    case 'resume_workout':
      if (outcomes.workoutSince) return true;
      return outcomes.liveStartedAt === null ? 'gone' : false;
    case 'open_reminder':
      // Completed or turned off on the Coach tab: the loop closed.
      return !item.targetId || !outcomes.activeReminders.has(item.targetId);
    case 'open_experiment':
      return !item.targetId || !outcomes.activeExperiments.has(item.targetId) ? 'gone' : false;
    default:
      return false;
  }
}

/** What has become of every item of `plan`, as of `outcomes.now`. */
export function evaluatePlan(plan: DayPlan, outcomes: PlanOutcomes): EvaluatedItem[] {
  const madeAt = Date.parse(plan.madeAt);
  return plan.items.map((item): EvaluatedItem => {
    const closed = CLOSED.find((event) => outcomes.events.has(`${item.key}|${event}`));
    if (closed) return { ...item, state: closed as ItemState, transition: null };
    // Yesterday's plan never reaches today: every open item of it expired with its day.
    if (plan.day !== outcomes.today) return { ...item, state: 'expired', transition: 'expired' };
    // A destination with no data of its own was acted on the moment it was tapped.
    if (item.kind === 'do' && item.action && ACTION_SPEC[item.action].clearsOnTap) {
      if (outcomes.events.has(`${item.key}|started`))
        return { ...item, state: 'done', transition: 'done' };
    }

    if (item.kind === 'pin') {
      const row = item.entryId ? outcomes.rows.get(item.entryId) : undefined;
      if (!row) return { ...item, state: 'gone', transition: null };
      if (row.status === 'completed') return { ...item, state: 'done', transition: 'done' };
      if (row.status === 'skipped') return { ...item, state: 'dismissed', transition: 'dismissed' };
    } else {
      const arrived = dataArrived(item, outcomes, madeAt);
      if (arrived === 'gone') return { ...item, state: 'gone', transition: null };
      if (arrived) return { ...item, state: 'done', transition: 'done' };
    }

    if (outcomes.now.getTime() >= Date.parse(item.until)) {
      return { ...item, state: 'expired', transition: 'expired' };
    }
    return { ...item, state: 'live', transition: null };
  });
}

// --- What Home shows --------------------------------------------------------------

export type HomeTop =
  | { kind: 'coach'; item: EvaluatedItem }
  | { kind: 'pin'; row: MissionItem; item: EvaluatedItem }
  | { kind: 'mission'; row: MissionItem }
  | null;

const isOpen = (row: MissionItem) => row.status === 'pending' || row.status === 'partial';

/**
 * The ONE definition of what the top of Home is — the hero renders it, the
 * checklist marks it, and the Coach's state block names it
 * (src/lib/ai/turn-context.ts), so the three cannot disagree.
 *
 * The first LIVE plan item in the Coach's order wins: a Coach item as itself, a
 * pinned row when it is still open and not snoozed (Snooze on a pinned row
 * means what it always meant — not now — so the next item takes the hero).
 * With nothing live, it is the time-ordered hero `deriveMissionView` has always
 * produced, untouched.
 */
export function homeTop(view: MissionView, items: readonly EvaluatedItem[]): HomeTop {
  for (const item of items) {
    if (item.state !== 'live') continue;
    if (item.kind === 'do') return { kind: 'coach', item };
    const row = view.items.find((candidate) => candidate.id === item.entryId);
    if (row && isOpen(row) && !row.snoozed) return { kind: 'pin', row, item };
  }
  return view.next ? { kind: 'mission', row: view.next } : null;
}

/** The Coach items the checklist draws, in the Coach's order (pins are rows already). */
export function coachRows(items: readonly EvaluatedItem[]): EvaluatedItem[] {
  return items.filter((item) => item.kind === 'do' && item.state === 'live');
}

/** What a Coach item looks like to the components — no plan internals. */
export type CoachItemView = {
  key: string;
  title: string;
  reason: string | null;
  action: PlanAction;
  /** The button word. */
  button: string;
  /** HH:MM when the Coach named an `until`, else null. */
  until: string | null;
};

const pad = (n: number) => String(n).padStart(2, '0');

export function toCoachItemView(item: EvaluatedItem): CoachItemView {
  const action = item.action ?? 'open_coach';
  const until = new Date(item.until);
  return {
    key: item.key,
    title: item.title,
    reason: item.reason,
    action,
    button: ACTION_SPEC[action].button,
    until: item.untilGiven ? `${pad(until.getHours())}:${pad(until.getMinutes())}` : null,
  };
}

/**
 * Where a Coach item's tap goes. An expo-router href object, built here so the
 * hook and its test agree. `start_workout` while a live session is already
 * open goes to THAT session — the logger resumes its draft over any routine it
 * is handed anyway (app/workout-live.tsx), and saying so in the href keeps the
 * Train hub's "a workout is already in progress" rule from being sidestepped.
 */
export function destinationHref(
  item: Pick<PlanItem, 'action' | 'targetId'>,
  liveSessionOpen: boolean
): { pathname: string; params?: Record<string, string> } {
  switch (item.action) {
    case 'log_weight':
      return { pathname: '/metric-entry', params: { metric: 'weight', from: 'Home' } };
    case 'log_meal':
      return { pathname: '/(tabs)/eat' };
    case 'log_water':
      return { pathname: '/water' };
    case 'start_workout':
      return liveSessionOpen || !item.targetId
        ? { pathname: '/workout-live', params: { resume: '1' } }
        : { pathname: '/workout-live', params: { routineId: item.targetId } };
    case 'resume_workout':
      return { pathname: '/workout-live', params: { resume: '1' } };
    case 'open_train':
      return { pathname: '/(tabs)/train' };
    case 'open_reminder':
      return item.targetId
        ? { pathname: '/(tabs)/coach', params: { reminderId: item.targetId } }
        : { pathname: '/(tabs)/coach' };
    case 'open_experiment':
      return item.targetId
        ? { pathname: '/experiment-detail', params: { id: item.targetId } }
        : { pathname: '/experiments' };
    case 'open_screenings':
      return { pathname: '/screenings' };
    case 'open_coach':
    default:
      return { pathname: '/(tabs)/coach' };
  }
}

// --- The learning: counts, handed to the model as facts --------------------------

export type PlanEventRow = {
  plan_id: string;
  item_key: string;
  kind: 'pin' | 'do';
  action: string | null;
  event: PlanEvent;
};

/**
 * The 14-day summary the pass is given — COUNTS, never a weight. Nothing in
 * code reads these numbers to change what Home shows; no item kind switches
 * itself off after repeated dismissals. The Coach sees "log_meal 5 shown, 1
 * acted on" and decides what that means, which may be to stop offering it, or
 * to ask (memory: judgment lives in the model, not rules).
 *
 * Counted per ITEM (a plan's item), not per event row: an item tapped twice
 * and then done is one item acted on. "Acted on" is started or done.
 */
export function summarizePlanEvents(rows: readonly PlanEventRow[]): string {
  const items = new Map<string, { label: string; events: Set<PlanEvent> }>();
  for (const row of rows) {
    const id = `${row.plan_id}|${row.item_key}`;
    const entry = items.get(id) ?? {
      label: row.kind === 'pin' ? 'pinned row' : (row.action ?? 'unknown'),
      events: new Set<PlanEvent>(),
    };
    entry.events.add(row.event);
    items.set(id, entry);
  }
  if (items.size === 0) return 'Your plan items, last 14 days: none yet.';

  const count = (event: PlanEvent) => [...items.values()].filter((i) => i.events.has(event)).length;
  const acted = (entry: { events: Set<PlanEvent> }) =>
    entry.events.has('started') || entry.events.has('done');
  const byLabel = new Map<string, { shown: number; acted: number }>();
  for (const entry of items.values()) {
    const tally = byLabel.get(entry.label) ?? { shown: 0, acted: 0 };
    if (entry.events.has('shown')) tally.shown += 1;
    if (acted(entry)) tally.acted += 1;
    byLabel.set(entry.label, tally);
  }
  const kinds = [...byLabel.entries()]
    .sort((a, b) => b[1].shown - a[1].shown || a[0].localeCompare(b[0]))
    .map(([label, t]) => `${label} ${t.shown}/${t.acted}`)
    .join(' · ');
  return (
    `Your plan items, last 14 days: ${count('shown')} shown, ` +
    `${[...items.values()].filter(acted).length} acted on (${count('done')} done), ` +
    `${count('dismissed')} dismissed, ${count('expired')} expired, ${count('replaced')} replaced. ` +
    `By kind (shown/acted on): ${kinds}.`
  );
}
