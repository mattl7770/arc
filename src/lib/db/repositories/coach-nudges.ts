/**
 * The Coach's own notifications (0064 `coach_nudges`) and the settings that
 * govern them — storage, the per-pass apply step, and what the Coach tab and
 * the OS resync read.
 *
 * The model proposes (a coach pass's `NUDGE` lines, src/lib/ai/coach-pass.ts);
 * the pure rules decide what survives (src/lib/notifications/nudge-plan.ts);
 * this file writes the survivors and reads them back. It never calls the model
 * and never talks to `expo-notifications` — the OS schedule is rebuilt from
 * these rows by `syncReminderNotifications`, the one pass that owns it.
 *
 * Depends only on the {@link Database} interface, so the same code runs on the
 * phone and against node:sqlite in db/coach-pass.test.mjs and
 * db/notifications.test.mjs.
 *
 * ## What a pass's lines do to the pending set (decided 2026-09-25)
 *
 * The plan left one rule open (its checker's note under (c) › build-up): does a
 * pass that completes silently cancel what is pending? **No.**
 *
 *   - A pass that writes NO nudge line leaves the pending set exactly as it
 *     was. Silence is the common reply, and Haiku forgetting to restate the
 *     evening's plan for the morning must not quietly delete it.
 *   - A pass whose lines produce at least one ACCEPTED nudge replaces every
 *     nudge still ahead with its own set. A restated one keeps its row (same
 *     day, time and words), so a pass that says the same thing twice changes
 *     nothing and records nothing. A restatement is exempt from the five-minute
 *     lead (`standing` in `planNudges`): the directive tells the model to
 *     repeat what it wants kept, so refusing the repeat of a nudge due in four
 *     minutes would have cancelled it just before it landed.
 *   - A pass whose lines are ALL refused by the caps changes nothing. A
 *     formatting slip must not wipe a plan the way a failed pass cannot.
 *   - `NUDGE NONE` is how the model cancels everything ahead on purpose.
 *
 * A nudge whose moment has passed is history, never cancelled: it went out.
 */
import type { Database } from '../database';
import { shiftISODate, todayISODate, getDayStartsAt } from '../date';
import { newId } from '../id';
import { getOrCreateUser } from './user';
import {
  clockOf,
  DEFAULT_NUDGE_SETTINGS,
  inQuietHours,
  isClock,
  NUDGE_MAX_CHARS,
  nudgeDayLabel,
  planNudges,
  REFUSAL_WORDS,
  type NudgeDirective,
  type NudgeRejection,
  type NudgeReply,
  type NudgeSettings,
  type ProposedNudge,
  type RefusedNudge,
} from '@/lib/notifications/nudge-plan';
import { fireInstant } from '@/lib/notifications/protocol-reminders';

export type CoachNudgeStatus = 'pending' | 'delivered' | 'cancelled';

/** One `coach_nudges` row, as a SELECT returns it. */
export type CoachNudgeRow = {
  id: string;
  day: string;
  time: string;
  body: string;
  status: CoachNudgeStatus;
  created_at: string;
  updated_at: string;
};

/** A pending row with its fire instant, under the zone and boundary in force now. */
export type UpcomingNudge = CoachNudgeRow & { when: Date };

// --- Settings --------------------------------------------------------------------

const PREF_KEY = 'coachNudges';

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

/** Every field present; junk in the blob reads as the default, never as a throw. */
export function getNudgeSettings(db: Database): NudgeSettings {
  const section = parsePreferences(getOrCreateUser(db).preferences)[PREF_KEY];
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return { ...DEFAULT_NUDGE_SETTINGS };
  }
  const record = section as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_NUDGE_SETTINGS.enabled,
    quietStart: isClock(record.quietStart) ? record.quietStart : DEFAULT_NUDGE_SETTINGS.quietStart,
    quietEnd: isClock(record.quietEnd) ? record.quietEnd : DEFAULT_NUDGE_SETTINGS.quietEnd,
    checkinTime: isClock(record.checkinTime) ? record.checkinTime : null,
  };
}

/**
 * Change the settings. Turned OFF, every nudge still ahead is cancelled at
 * once (the plan: "Off cancels everything pending at once, through the same
 * resync").
 *
 * Moving QUIET HOURS cancels nothing. A nudge that now falls inside them is
 * held back — {@link upcomingNudges} leaves it out, so it is neither listed nor
 * scheduled — and it comes back if the hours move off it again. Cancelling it
 * outright was the first version, and the wheel made it wrong: the wheel
 * commits every time it settles, so spinning 21:30 towards 22:30 by way of
 * 19:00 would have destroyed a planned nudge he never meant to touch.
 *
 * A malformed time in the patch is ignored rather than stored. The caller
 * resyncs the OS schedule afterwards; this file does not reach the OS.
 */
export function saveNudgeSettings(
  db: Database,
  patch: Partial<NudgeSettings>,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): NudgeSettings {
  const current = getNudgeSettings(db);
  const next: NudgeSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    quietStart: isClock(patch.quietStart) ? patch.quietStart : current.quietStart,
    quietEnd: isClock(patch.quietEnd) ? patch.quietEnd : current.quietEnd,
    checkinTime:
      patch.checkinTime === null
        ? null
        : isClock(patch.checkinTime)
          ? patch.checkinTime
          : current.checkinTime,
  };

  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  preferences[PREF_KEY] = next;
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);

  if (!next.enabled) {
    for (const nudge of upcomingRows(db, now, dayStartsAt)) cancelNudge(db, nudge.id);
  }
  return next;
}

// --- What the last pass had refused --------------------------------------------

/**
 * Its own preferences key, beside the settings rather than inside them, so a
 * settings save can never wipe it and it can never be mistaken for one.
 */
const REFUSED_KEY = 'coachNudgeRefusals';
/** Enough to learn from; a pass writes two or three lines at most. */
const REFUSED_MAX = 6;

/** The lines code refused from the last pass that planned with nudges on. */
export function getRefusedNudges(db: Database): RefusedNudge[] {
  const raw = parsePreferences(getOrCreateUser(db).preferences)[REFUSED_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is RefusedNudge =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as RefusedNudge).line === 'string' &&
        typeof (entry as RefusedNudge).reason === 'string' &&
        (entry as RefusedNudge).reason in REFUSAL_WORDS
    )
    .slice(0, REFUSED_MAX);
}

/** Replace the memory with this pass's refusals — empty clears it. Writes only on a change. */
function recordRefusals(db: Database, refused: RefusedNudge[]): void {
  const next = refused.slice(0, REFUSED_MAX).map(({ line, reason }) => ({
    line: line.slice(0, NUDGE_MAX_CHARS + 40),
    reason,
  }));
  if (JSON.stringify(next) === JSON.stringify(getRefusedNudges(db))) return;
  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  if (next.length === 0) delete preferences[REFUSED_KEY];
  else preferences[REFUSED_KEY] = next;
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
}

// --- Reads -----------------------------------------------------------------------

/** One row by id, any status. */
export function getNudge(db: Database, id: string): CoachNudgeRow | undefined {
  return db.get<CoachNudgeRow>('SELECT * FROM coach_nudges WHERE id = ?', [id]);
}

/** Every row from a logical day onward, in day and clock order. */
export function listNudgesFrom(db: Database, day: string): CoachNudgeRow[] {
  return db.all<CoachNudgeRow>(
    'SELECT * FROM coach_nudges WHERE day >= ? ORDER BY day, time, created_at, id',
    [day]
  );
}

/**
 * Pending rows whose moment is still ahead, soonest first — regardless of the
 * on/off switch and of quiet hours. Both are applied by {@link upcomingNudges};
 * the off switch and a pass's replacement need to see every row, held back or
 * not — and so does the Coach's card for the off switch, which counts what
 * {@link saveNudgeSettings} is about to cancel (src/lib/ai/domains/nudge-domains.ts).
 */
export function upcomingRows(
  db: Database,
  now: Date,
  dayStartsAt: string = getDayStartsAt()
): UpcomingNudge[] {
  // Yesterday onward: under a late day boundary a small-hours nudge belongs to
  // the logical day before the calendar one.
  const from = shiftISODate(todayISODate(now, dayStartsAt), -1);
  const rows: UpcomingNudge[] = [];
  for (const row of listNudgesFrom(db, from)) {
    if (row.status !== 'pending') continue;
    const when = fireInstant(row.day, row.time, dayStartsAt);
    if (when === null || when.getTime() <= now.getTime()) continue;
    rows.push({ ...row, when });
  }
  return rows.sort((a, b) => a.when.getTime() - b.when.getTime());
}

/**
 * What will buzz: pending, still ahead, nudges switched on, and outside the
 * CURRENT quiet hours. The OS resync schedules exactly this list, the Coach
 * tab lists exactly this list and a pass is told exactly this list, so none of
 * them can disagree about what is coming.
 */
export function upcomingNudges(
  db: Database,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): UpcomingNudge[] {
  const settings = getNudgeSettings(db);
  if (!settings.enabled) return [];
  return upcomingRows(db, now, dayStartsAt).filter(
    (row) => !inQuietHours(row.time, settings.quietStart, settings.quietEnd)
  );
}

/**
 * What has already gone out from `day` onward: tapped, or pending with its
 * moment passed — unless that moment is inside the current quiet hours, where
 * it was held back rather than sent. The per-day cap counts these and a pass
 * is told about them, so it does not repeat itself.
 */
export function sentNudgesFrom(
  db: Database,
  day: string,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): CoachNudgeRow[] {
  const settings = getNudgeSettings(db);
  return listNudgesFrom(db, day).filter((row) => {
    if (row.status === 'delivered') return true;
    if (row.status !== 'pending') return false;
    if (inQuietHours(row.time, settings.quietStart, settings.quietEnd)) return false;
    const when = fireInstant(row.day, row.time, dayStartsAt);
    return when !== null && when.getTime() <= now.getTime();
  });
}

// --- Writes ----------------------------------------------------------------------

/** Cancel one pending nudge. True when a row changed. The Coach tab's Cancel. */
export function cancelNudge(db: Database, id: string): boolean {
  const row = getNudge(db, id);
  if (!row || row.status !== 'pending') return false;
  db.run(`UPDATE coach_nudges SET status = 'cancelled' WHERE id = ?`, [id]);
  return true;
}

/**
 * Mark a pending nudge delivered — he tapped it. Returns the row as it was, or
 * null when there is nothing to deliver (already delivered, cancelled, or not
 * on this phone at all, e.g. after a restore).
 */
export function markNudgeDelivered(db: Database, id: string): CoachNudgeRow | null {
  const row = getNudge(db, id);
  if (!row || row.status !== 'pending') return null;
  db.run(`UPDATE coach_nudges SET status = 'delivered' WHERE id = ?`, [id]);
  return row;
}

export type NudgeApplyOutcome = {
  /** New rows written this pass. */
  added: UpcomingNudge[];
  /** Pending rows still ahead that this pass cancelled. */
  cancelled: UpcomingNudge[];
  /** Pending rows still ahead that this pass restated, left as they were. */
  kept: UpcomingNudge[];
  rejected: { nudge: ProposedNudge; reason: NudgeRejection }[];
  /** Lines that began NUDGE and did not parse. */
  malformed: number;
  /** Anything was added or cancelled — the OS schedule needs a resync. */
  changed: boolean;
};

const UNCHANGED: Omit<NudgeApplyOutcome, 'rejected' | 'malformed'> = {
  added: [],
  cancelled: [],
  kept: [],
  changed: false,
};

/**
 * Apply one pass's nudge lines — the rules in the module header. Writes in one
 * transaction, so the pending set is never half-replaced.
 *
 * It also replaces the memory of what was refused ({@link getRefusedNudges})
 * with this pass's refusals — none clears it — so the next pass is told which
 * of its lines code dropped and why. Nothing else reports a refusal.
 */
export function applyNudgeReply(
  db: Database,
  reply: NudgeReply,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): NudgeApplyOutcome {
  const settings = getNudgeSettings(db);
  const base = { rejected: [], malformed: reply.malformed.length };
  if (!settings.enabled) return { ...UNCHANGED, ...base };
  const malformed: RefusedNudge[] = reply.malformed.map((line) => ({ line, reason: 'malformed' }));
  if (reply.proposals.length === 0 && !reply.clear) {
    recordRefusals(db, malformed);
    return { ...UNCHANGED, ...base };
  }

  const today = todayISODate(now, dayStartsAt);
  const ahead = upcomingRows(db, now, dayStartsAt);
  const bare = ({ day, time, body }: ProposedNudge): ProposedNudge => ({ day, time, body });
  const plan = planNudges({
    proposals: reply.proposals,
    sent: sentNudgesFrom(db, shiftISODate(today, -1), now, dayStartsAt),
    standing: ahead.map(bare),
    now,
    dayStartsAt,
    quietStart: settings.quietStart,
    quietEnd: settings.quietEnd,
  });
  recordRefusals(db, [
    ...plan.rejected.map(({ nudge, reason }) => ({
      line: `${nudge.day} ${nudge.time} ${nudge.body}`,
      reason,
    })),
    ...malformed,
  ]);
  if (plan.accepted.length === 0 && !reply.clear) {
    return { ...UNCHANGED, rejected: plan.rejected, malformed: reply.malformed.length };
  }

  const sameAs = (a: { day: string; time: string; body: string }, b: typeof a) =>
    a.day === b.day && a.time === b.time && a.body === b.body;

  const kept = ahead.filter((row) => plan.accepted.some((nudge) => sameAs(row, nudge)));
  const cancelled = ahead.filter((row) => !kept.includes(row));
  const fresh = plan.accepted.filter((nudge) => !kept.some((row) => sameAs(row, nudge)));
  const added: UpcomingNudge[] = [];

  db.transaction(() => {
    for (const row of cancelled) {
      db.run(`UPDATE coach_nudges SET status = 'cancelled' WHERE id = ?`, [row.id]);
    }
    for (const nudge of fresh) {
      const id = newId(db);
      db.run('INSERT INTO coach_nudges (id, day, time, body) VALUES (?, ?, ?, ?)', [
        id,
        nudge.day,
        nudge.time,
        nudge.body,
      ]);
      const row = getNudge(db, id);
      if (row) added.push({ ...row, when: nudge.when });
    }
  });

  return {
    added,
    cancelled,
    kept,
    rejected: plan.rejected,
    malformed: reply.malformed.length,
    changed: added.length > 0 || cancelled.length > 0,
  };
}

/**
 * What the pass directive says about nudges, or null when they are off — in
 * which case the directive carries no nudge instructions at all.
 */
export function nudgeDirectiveFor(
  db: Database,
  now: Date = new Date(),
  dayStartsAt: string = getDayStartsAt()
): NudgeDirective | null {
  const settings = getNudgeSettings(db);
  if (!settings.enabled) return null;
  const today = todayISODate(now, dayStartsAt);
  const bare = ({ day, time, body }: CoachNudgeRow): ProposedNudge => ({ day, time, body });
  return {
    today,
    tomorrow: shiftISODate(today, 1),
    clock: clockOf(now),
    quietStart: settings.quietStart,
    quietEnd: settings.quietEnd,
    pending: upcomingNudges(db, now, dayStartsAt).map(bare),
    sentToday: sentNudgesFrom(db, today, now, dayStartsAt)
      .filter((row) => row.day === today)
      .map(bare),
    refused: getRefusedNudges(db),
  };
}

// --- What the thread records -----------------------------------------------------

/**
 * The line the thread keeps after a pass changed the plan — owner's Q1: every
 * nudge is "recorded in the thread". Code-authored and factual, like a
 * receipt: it lists what is now planned (or says the plan was cleared), never
 * claims the phone will buzz — whether it does is permission and Focus, which
 * the Coach tab reports on its own. Null when nothing changed.
 */
export function describeNudgePlan(outcome: NudgeApplyOutcome, today: string): string | null {
  if (!outcome.changed) return null;
  const now = [...outcome.kept, ...outcome.added].sort(
    (a, b) => a.when.getTime() - b.when.getTime()
  );
  if (now.length === 0) return 'Planned notifications cancelled. None are planned now.';
  return [
    'Planned notifications',
    ...now.map((row) => `${nudgeDayLabel(row.day, today)}, ${row.time} · ${row.body}`),
  ].join('\n');
}
