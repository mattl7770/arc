/**
 * Smart day, the deterministic half: FACTS about the day, and nothing else.
 *
 * The owner, correcting the plan this replaced (2026-10-21):
 *
 *   > "none of this should be hard-coded. a 'weigh-in' reminder is not what we
 *   > want. we want an intelligent assistant/coach who reminds you to weigh in
 *   > when it thinks you need that reminder. none of those ideas were things to
 *   > be hard-coded, just examples of what the coach might do."
 *
 * So the spike's rule-made prompts ("no weigh-in before 10:00", "nothing eaten
 * in 5 h") are gone, and what is left is this file: a pure function from what is
 * on disk to a set of statements that are TRUE OR FALSE — the last weigh-in and
 * how often he weighs in, when he last ate and how much today, when he woke,
 * what is open. **No fact implies an action**, no threshold lives here, and no
 * field is named for what it should make anyone do. Whether a nine-day gap in
 * weigh-ins matters this morning is the Coach's call (memory: judgment lives in
 * the model, not rules), made in the coach pass with these lines in front of it
 * (src/lib/home/plan-lines.ts says what it may answer with).
 *
 * **It never reads a status.** A day_statuses row is read only by the adherence
 * ledger, the readiness baselines and the record (docs/information-architecture.md,
 * the Status model). The pass already sees the status in its state block and may
 * weigh it; nothing here may. A source pin in db/smart-day.test.mjs holds that.
 *
 * Pure: no database, no clock of its own, no Expo. The repository
 * (src/lib/db/repositories/day-plan.ts `gatherDayFacts`) reads the rows and
 * hands them in; db/smart-day.test.mjs feeds it fixtures directly.
 */
import { logicalDate, shiftISODate } from '@/lib/db/date';
import { deriveMissionView } from '@/lib/home/derive-mission';
import type { MissionItem } from '@/types/home';

// --- What the repository hands in -----------------------------------------------

export type DayFactsInput = {
  now: Date;
  /** The LOGICAL day `now` belongs to. */
  today: string;
  dayStartsAt: string;
  /** Today's mission rows, as Home reads them. */
  mission: MissionItem[];
  snoozed: ReadonlySet<string>;
  /** `body_metrics.measured_at` of every weight, newest first (a bounded window is fine). */
  weighIns: string[];
  /** Meals filed on yesterday and today: their day, wall-clock time and macros. */
  meals: { date: string; time: string | null; kcal: number | null; protein_g: number | null }[];
  /** Meal estimates still waiting on the model. */
  pendingEstimates: number;
  /** The end of last night's sleep (ISO instant), when a watch recorded one. */
  sleepEnd: string | null;
  water: { ml: number; entries: number };
  /** Workouts filed on today. */
  workoutsToday: { name: string }[];
  /** The open live session, if any: its name and start (epoch ms). */
  liveSession: { name: string; startedAt: number } | null;
  /** Saved workouts. */
  routines: { id: string; name: string; lastStartedAt: string | null }[];
  /** Active reminders due today (a one-off's date is a floor, so `date` may be in the past). */
  reminders: {
    id: string;
    title: string;
    time: string | null;
    date: string | null;
    repeat: string;
  }[];
  /** Scheduled appointments in the next few days. */
  appointments: { title: string; scheduledAt: string }[];
  /** Screenings overdue or coming due. */
  screenings: { name: string; nextDue: string }[];
  /** Active experiments. */
  experiments: { id: string; title: string; ready: boolean; daysLeft: number }[];
};

// --- What comes out ------------------------------------------------------------

/** A tag the pass may name, and what it stands for. Tags live for ONE pass. */
export type FactTag =
  | { tag: string; kind: 'row'; id: string; title: string }
  | { tag: string; kind: 'routine'; id: string; title: string }
  | { tag: string; kind: 'reminder'; id: string; title: string }
  | { tag: string; kind: 'experiment'; id: string; title: string };

export type DayFacts = {
  clock: string;
  today: string;
  mission: {
    done: number;
    total: number;
    /** Open rows (pending or partial), in Home's time order, tagged m1…mN. */
    open: {
      tag: string;
      id: string;
      time: string | null;
      title: string;
      category: string;
      dose: string | null;
      partial: boolean;
      snoozed: boolean;
    }[];
  };
  weighIn: {
    /** The last weigh-in, by logical day and wall clock, or null if there has never been one. */
    last: { day: string; clock: string; daysAgo: number } | null;
    /** Logical days with at least one weigh-in in the 28 days ending today. */
    daysInLast28: number;
    /** Median days between consecutive weigh-in days in the window; null under two. */
    medianGapDays: number | null;
  };
  meals: {
    last: { day: string; time: string } | null;
    todayCount: number;
    todayKcal: number;
    todayProtein: number;
    pending: number;
  };
  /** HH:MM, or null when no sleep end is on record for last night. */
  woke: string | null;
  water: { ml: number; entries: number };
  training: {
    finishedToday: string[];
    live: { name: string; since: string } | null;
    saved: { tag: string; id: string; name: string; lastStarted: string | null }[];
  };
  loops: {
    reminders: {
      tag: string;
      id: string;
      title: string;
      dueSince: string | null;
      time: string | null;
      repeat: string;
    }[];
    appointments: { title: string; day: string; time: string }[];
    screenings: { name: string; due: string; overdue: boolean }[];
    experiments: { tag: string; id: string; title: string; ready: boolean; daysLeft: number }[];
  };
  tags: FactTag[];
};

/** How many saved workouts the facts name. More is a list nobody reads. */
const SAVED_LIMIT = 8;
const REMINDER_LIMIT = 6;
/** The window "how often he weighs in" is measured over. */
const WEIGH_WINDOW_DAYS = 28;

const pad = (n: number) => String(n).padStart(2, '0');
const clockOf = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

/** Whole days from `from` to `to` (YYYY-MM-DD), componentwise in UTC — no zone can shift it. */
export function daysBetween(from: string, to: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function weighInFacts(input: DayFactsInput): DayFacts['weighIn'] {
  const instants = input.weighIns
    .map((iso) => new Date(iso))
    .filter((at) => Number.isFinite(at.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  if (instants.length === 0) return { last: null, daysInLast28: 0, medianGapDays: null };
  const newest = instants[0]!;
  const lastDay = logicalDate(newest, input.dayStartsAt);
  const windowStart = shiftISODate(input.today, -(WEIGH_WINDOW_DAYS - 1));
  const days = [...new Set(instants.map((at) => logicalDate(at, input.dayStartsAt)))]
    .filter((day) => day >= windowStart && day <= input.today)
    .sort();
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(daysBetween(days[i - 1]!, days[i]!));
  return {
    last: { day: lastDay, clock: clockOf(newest), daysAgo: daysBetween(lastDay, input.today) },
    daysInLast28: days.length,
    medianGapDays: median(gaps),
  };
}

function mealFacts(input: DayFactsInput): DayFacts['meals'] {
  const todays = input.meals.filter((meal) => meal.date === input.today);
  // The latest TIMED meal on or before today. An untimed meal has no "when",
  // and guessing one would be a fact this file made up.
  const timed = input.meals
    .filter((meal) => meal.date <= input.today && meal.time !== null)
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const last = timed[timed.length - 1];
  return {
    last: last ? { day: last.date, time: last.time! } : null,
    todayCount: todays.length,
    todayKcal: Math.round(todays.reduce((sum, meal) => sum + (meal.kcal ?? 0), 0)),
    todayProtein: Math.round(todays.reduce((sum, meal) => sum + (meal.protein_g ?? 0), 0)),
    pending: input.pendingEstimates,
  };
}

/**
 * The day, as facts. The tags (m1, w1, r1, e1) are the only handles the pass
 * may use to point at a row, a saved workout, a reminder or an experiment; they
 * are minted here, in display order, and mean nothing after this pass.
 */
export function buildDayFacts(input: DayFactsInput): DayFacts {
  const view = deriveMissionView(input.mission, input.snoozed);
  const tags: FactTag[] = [];

  const open = view.items
    .filter((item) => item.status === 'pending' || item.status === 'partial')
    .map((item, index) => {
      const tag = `m${index + 1}`;
      tags.push({ tag, kind: 'row', id: item.id, title: item.title });
      return {
        tag,
        id: item.id,
        time: item.scheduledTime ?? null,
        title: item.title,
        category: item.category,
        dose: item.dose?.trim() || null,
        partial: item.status === 'partial',
        snoozed: item.snoozed === true,
      };
    });

  const saved = [...input.routines]
    .sort(
      (a, b) =>
        (b.lastStartedAt ?? '').localeCompare(a.lastStartedAt ?? '') || a.name.localeCompare(b.name)
    )
    .slice(0, SAVED_LIMIT)
    .map((routine, index) => {
      const tag = `w${index + 1}`;
      tags.push({ tag, kind: 'routine', id: routine.id, title: routine.name });
      return {
        tag,
        id: routine.id,
        name: routine.name,
        lastStarted: routine.lastStartedAt
          ? logicalDate(new Date(routine.lastStartedAt), input.dayStartsAt)
          : null,
      };
    });

  const reminders = input.reminders.slice(0, REMINDER_LIMIT).map((reminder, index) => {
    const tag = `r${index + 1}`;
    tags.push({ tag, kind: 'reminder', id: reminder.id, title: reminder.title });
    return {
      tag,
      id: reminder.id,
      title: reminder.title,
      // A one-off's date is a floor: past it, the reminder is still owed.
      dueSince:
        reminder.repeat === 'once' && reminder.date !== null && reminder.date < input.today
          ? reminder.date
          : null,
      time: reminder.time,
      repeat: reminder.repeat,
    };
  });

  const experiments = input.experiments.map((experiment, index) => {
    const tag = `e${index + 1}`;
    tags.push({ tag, kind: 'experiment', id: experiment.id, title: experiment.title });
    return { tag, ...experiment };
  });

  const sleepEnd = input.sleepEnd ? new Date(input.sleepEnd) : null;

  return {
    clock: clockOf(input.now),
    today: input.today,
    mission: { done: view.completed, total: view.total, open },
    weighIn: weighInFacts(input),
    meals: mealFacts(input),
    woke: sleepEnd && Number.isFinite(sleepEnd.getTime()) ? clockOf(sleepEnd) : null,
    water: input.water,
    training: {
      finishedToday: input.workoutsToday.map((workout) => workout.name),
      live: input.liveSession
        ? { name: input.liveSession.name, since: clockOf(new Date(input.liveSession.startedAt)) }
        : null,
      saved,
    },
    loops: {
      reminders,
      appointments: input.appointments.map((appointment) => {
        const at = new Date(appointment.scheduledAt);
        return {
          title: appointment.title,
          day: logicalDate(at, input.dayStartsAt),
          time: clockOf(at),
        };
      }),
      screenings: input.screenings.map((screening) => ({
        name: screening.name,
        due: screening.nextDue,
        overdue: screening.nextDue < input.today,
      })),
      experiments,
    },
    tags,
  };
}

/** A title as the pass reads it: quoted, so a title that looks like a tag is still a title. */
const quoted = (text: string) => `"${text.replace(/\s+/g, ' ').trim()}"`;

/**
 * The facts as prompt lines. Plain "Label: fact" lines, like the state block's
 * (src/lib/ai/turn-context.ts) — stable to test, cheap in tokens. Every line
 * states something; none says what to do about it.
 */
export function dayFactsLines(facts: DayFacts): string[] {
  const lines: string[] = [];
  const { mission, weighIn, meals, training, loops } = facts;

  lines.push(
    mission.total === 0
      ? "Mission: no rows on today's list."
      : `Mission: ${mission.done} of ${mission.total} done.` +
          (mission.open.length === 0
            ? ' Nothing open.'
            : ' Open rows, in the time order Home shows:')
  );
  for (const row of mission.open) {
    const notes = [
      row.category,
      row.dose,
      row.partial ? 'partly done' : null,
      row.snoozed ? 'snoozed' : null,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`  ${row.tag} ${row.time ?? '--:--'} ${quoted(row.title)} (${notes})`);
  }

  lines.push(
    weighIn.last === null
      ? 'Weigh-ins: none on record.'
      : `Weigh-ins: last ${weighIn.last.day} at ${weighIn.last.clock} ` +
          `(${weighIn.last.daysAgo === 0 ? 'today' : `${weighIn.last.daysAgo} day${weighIn.last.daysAgo === 1 ? '' : 's'} ago`}); ` +
          `${weighIn.daysInLast28} day${weighIn.daysInLast28 === 1 ? '' : 's'} with one in the last 28` +
          (weighIn.medianGapDays === null ? '.' : `, median gap ${weighIn.medianGapDays} days.`)
  );

  lines.push(
    `Meals: ${meals.last ? `last timed meal ${meals.last.day} at ${meals.last.time}` : 'no timed meal in the last two days'}; ` +
      `today ${meals.todayCount} logged (${meals.todayKcal} kcal, ${meals.todayProtein} g protein)` +
      (meals.pending > 0
        ? `; ${meals.pending} estimate${meals.pending === 1 ? '' : 's'} waiting.`
        : '.')
  );

  lines.push(
    facts.woke
      ? `Woke: ${facts.woke} (end of last night's recorded sleep).`
      : 'Woke: no sleep recorded for last night.'
  );

  lines.push(
    facts.water.entries === 0
      ? 'Water today: none logged.'
      : `Water today: ${Math.round(facts.water.ml)} ml in ${facts.water.entries} entr${facts.water.entries === 1 ? 'y' : 'ies'}.`
  );

  lines.push(
    `Training: ${training.finishedToday.length === 0 ? 'none finished today' : `finished today ${training.finishedToday.map(quoted).join(', ')}`}; ` +
      `${training.live ? `live session ${quoted(training.live.name)} open since ${training.live.since}` : 'no live session open'}.`
  );
  if (training.saved.length > 0) {
    lines.push(
      '  Saved workouts: ' +
        training.saved
          .map(
            (routine) =>
              `${routine.tag} ${quoted(routine.name)} (last started ${routine.lastStarted ?? 'never'})`
          )
          .join(' · ')
    );
  }

  const loopParts = [
    ...loops.reminders.map(
      (reminder) =>
        `${reminder.tag} reminder ${quoted(reminder.title)}` +
        (reminder.dueSince
          ? ` (due since ${reminder.dueSince})`
          : reminder.time
            ? ` (${reminder.repeat}, ${reminder.time})`
            : ` (${reminder.repeat})`)
    ),
    ...loops.appointments.map((a) => `appointment ${quoted(a.title)} ${a.day} ${a.time}`),
    ...loops.screenings.map(
      (s) => `screening ${quoted(s.name)} ${s.overdue ? 'overdue since' : 'due'} ${s.due}`
    ),
    ...loops.experiments.map(
      (e) =>
        `${e.tag} experiment ${quoted(e.title)} ${e.ready ? 'window closed, ready to read out' : `running, ${e.daysLeft} days left`}`
    ),
  ];
  lines.push(`Open loops: ${loopParts.length === 0 ? 'none.' : loopParts.join(' · ')}`);

  return lines;
}
