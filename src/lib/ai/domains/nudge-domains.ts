/**
 * The Coach's own notifications (0064), as the domain registry sees them — the
 * planned nudges the Coach tab lists with a Cancel on each, and the four
 * settings Settings › Coach gives them (docs/coach-domains.md §10c).
 *
 * The notifications build put both on screens and deferred the Coach's half to
 * the registry. This is that half, and it adds no tool: the settings are four
 * more fields of the `settings` domain (fields cost nothing on the wire), and a
 * planned nudge is one more status domain, like a reminder.
 *
 * ## Parity, act by act
 *
 *   - **The settings** are written through `saveNudgeSettings`, the function
 *     Settings › Coach calls. Turning nudges off therefore cancels every one
 *     still ahead, exactly as the switch does, and moving quiet hours HOLDS a
 *     planned nudge back rather than cancelling it. The OS resync the screen
 *     runs next is the Coach tab's own after every turn (app/(tabs)/coach.tsx
 *     `onTurnComplete`).
 *   - **A planned nudge** is cancelled through `cancelNudge`, the Coach tab's
 *     Cancel. It is a STATUS edit, not a removal: the row stays, marked
 *     cancelled, and the card must not say a row leaves the record. So it rides
 *     `edit_record { status: "cancelled" }` and `delete_record` refuses it,
 *     naming the Cancel — the reminders pattern, where dismissal is the end.
 *   - **Reading** stays where it already was. `list_reminders` has listed the
 *     Coach's planned notifications since 0064 (`coachNotifications`), so this
 *     domain's read is bespoke and it is absent from `query_records` — one path
 *     to one answer. The payload now carries each nudge's id, which is what a
 *     cancel addresses. The settings read through `query_records { domain:
 *     "settings" }`, beside the rest of the settings.
 *
 * ## What the Coach can only see if it is told
 *
 * The Coach tab lists `upcomingNudges`: pending, still ahead, nudges on, and
 * outside the CURRENT quiet hours. A cancel resolves against exactly that list,
 * so the Coach can cancel what the tab can and nothing else. Every other state
 * refuses in words — cancelled or replaced by a newer plan, already opened,
 * already gone out, held back by quiet hours — because a bare "no such row"
 * would leave the model guessing why.
 *
 * **Gone out is a matter of the clock, not the row.** A pending nudge's row
 * does not change when it fires, so the re-read past the gate reads the turn's
 * clock afresh (`CoachToolContext.clock`): a card drawn at 07:25 for a 07:30
 * nudge and approved at 07:31 refuses rather than marking a delivered line
 * cancelled.
 */
import type { Database } from '@/lib/db/database';
import { getDayStartsAt, todayISODate } from '@/lib/db/date';
import {
  cancelNudge,
  getNudge,
  getNudgeSettings,
  saveNudgeSettings,
  upcomingNudges,
  upcomingRows,
  type UpcomingNudge,
} from '@/lib/db/repositories/coach-nudges';
import {
  inQuietHours,
  isClock,
  nudgeDayLabel,
  type NudgeSettings,
} from '@/lib/notifications/nudge-plan';
import { fireInstant } from '@/lib/notifications/protocol-reminders';

import type { CoachToolContext } from '../tools/types';
import {
  boolField,
  enumField,
  plural,
  timeField,
  type CoachDomainEntry,
  type DomainField,
  type DomainRow,
} from './types';

/**
 * The later of the call's instant and the turn's clock read now. At card time
 * the two agree; past the gate the clock has moved by however long the user
 * took to decide, and a nudge that fired inside that window must refuse.
 */
function latest(context: CoachToolContext): Date {
  const wall = context.clock?.();
  return wall !== undefined && wall.getTime() > context.now.getTime() ? wall : context.now;
}

/** "tomorrow, 07:30" — the Coach tab's own words for when a nudge goes out. */
function whenOf(row: { day: string; time: string }, context: CoachToolContext): string {
  return `${nudgeDayLabel(row.day, todayISODate(context.now))}, ${row.time}`;
}

// --- A planned nudge ---------------------------------------------------------

/**
 * id → the nudge the Coach tab lists, or a refusal that says why it is not
 * there. Called at card time and again past the gate, so every state below is
 * also the staleness re-read.
 */
function resolveNudge(db: Database, id: string, context: CoachToolContext): DomainRow {
  const row = getNudge(db, id);
  if (!row) throw new Error(`No planned notification with id ${id}. Call list_reminders first.`);
  const when = whenOf(row, context);
  if (row.status === 'cancelled') {
    throw new Error(
      `The notification for ${when} was cancelled, or replaced by a newer plan. ` +
        'Nothing cancelled. Call list_reminders for what is planned now.'
    );
  }
  if (row.status === 'delivered') {
    throw new Error(
      `The notification for ${when} already went out and was opened. Nothing cancelled.`
    );
  }
  const at = latest(context);
  const listed = upcomingNudges(db, at).find((nudge) => nudge.id === id);
  if (listed) {
    return { id: listed.id, name: listed.body, values: { status: listed.status }, raw: listed };
  }
  const fires = fireInstant(row.day, row.time, getDayStartsAt());
  if (fires === null || fires.getTime() <= at.getTime()) {
    throw new Error(`The notification for ${when} already went out. Nothing cancelled.`);
  }
  const settings = getNudgeSettings(db);
  if (!settings.enabled) {
    throw new Error('Coach nudges are off, so nothing is planned to go out. Nothing cancelled.');
  }
  // Pending, ahead, nudges on, and still not listed: inside quiet hours. The
  // tab does not list it, so it has no Cancel to reach — and neither does this.
  throw new Error(
    `The notification for ${when} is inside quiet hours (${settings.quietStart}–` +
      `${settings.quietEnd}), so it is held back and goes out only if they move off it. ` +
      'The Coach tab does not list it. Nothing cancelled.'
  );
}

const nudgesDomain: CoachDomainEntry = {
  key: 'nudges',
  label: 'planned notification',
  resolve: resolveNudge,
  fields: {
    // `cancelled` and nothing else: the Coach tab's one control. There is no
    // un-cancel on the tab, and planning one is the pass's (NUDGE lines), never
    // a chat write.
    status: enumField(['cancelled'], 'cancelled = the Coach tab’s Cancel; it will not go out'),
  },
  read: { kind: 'bespoke', via: 'list_reminders' },
  // The card names the nudge's line and when it goes out, as the tab shows it.
  // "tomorrow" is judged from the call's one instant (`now`), so the redrawn
  // line past the gate cannot drift from the card; what must refuse there is
  // `resolveNudge`'s to catch.
  summarize: ({ row, context }) => {
    const nudge = row!.raw as UpcomingNudge;
    return `Cancel planned notification "${nudge.body}" — ${whenOf(nudge, context)}`;
  },
  edit: (db, row) => {
    // Belt as well as braces: `resolveNudge` has just re-read the row in this
    // same synchronous call, but a cancel that changed nothing must not
    // report one.
    if (!cancelNudge(db, row.id)) {
      throw new Error('That notification is no longer planned. Nothing cancelled.');
    }
  },
  remove: {
    mode: 'refuse',
    because:
      'No screen deletes a planned notification: the Coach tab’s Cancel ends one, ' +
      'edit_record { status: "cancelled" }.',
  },
};

export const NUDGE_DOMAINS: CoachDomainEntry[] = [nudgesDomain];

// --- The four settings, as fields of the `settings` domain -------------------

/**
 * A quiet-hours end: always a time. Unlike `timeField`, `null` is refused —
 * quiet hours always have both ends, and equal ends mean there are none.
 */
function clockField(note: string): DomainField {
  return {
    editable: true,
    note,
    parse: (fields, key) => {
      const value = fields[key];
      const trimmed = typeof value === 'string' ? value.trim() : value;
      if (!isClock(trimmed)) {
        throw new Error(
          `"${key}" must be a 24-hour "HH:MM" time, e.g. "22:00". Quiet hours always have both ` +
            'ends; set them equal for none.'
        );
      }
      return trimmed;
    },
  };
}

type NudgeFieldName = 'nudges_enabled' | 'quiet_start' | 'quiet_end' | 'checkin_time';

/** Field name → the `NudgeSettings` key `saveNudgeSettings` takes. */
const SETTING_KEYS: Record<NudgeFieldName, keyof NudgeSettings> = {
  nudges_enabled: 'enabled',
  quiet_start: 'quietStart',
  quiet_end: 'quietEnd',
  checkin_time: 'checkinTime',
};

export const NUDGE_SETTING_FIELDS: Record<NudgeFieldName, DomainField> = {
  nudges_enabled: boolField(
    'Coach nudges (up to two a day, planned when ARC opens); false cancels every one planned'
  ),
  quiet_start: clockField('"HH:MM" — quiet hours begin; a nudge timed inside them is dropped'),
  quiet_end: clockField('"HH:MM" — quiet hours end'),
  checkin_time: timeField('"HH:MM" of the daily morning check-in notification, or null for off'),
};

export function isNudgeSettingField(name: string): name is NudgeFieldName {
  return name in SETTING_KEYS;
}

/** The settings as the `settings` domain reads and resolves them. */
export function nudgeSettingValues(db: Database): Record<NudgeFieldName, unknown> {
  const settings = getNudgeSettings(db);
  return {
    nudges_enabled: settings.enabled,
    quiet_start: settings.quietStart,
    quiet_end: settings.quietEnd,
    checkin_time: settings.checkinTime,
  };
}

/** "21:30–07:00", or "none" when the ends are equal (`inQuietHours`' own rule). */
function windowText(start: unknown, end: unknown): string {
  return start === end ? 'none' : `${String(start)}–${String(end)}`;
}

/**
 * The card's words for the nudge fields of a settings patch: old → new as
 * Settings › Coach would say it, and what the write does to planned
 * notifications. One clause per change; an unchanged value says nothing.
 *
 *   `Coach nudges on → off, which cancels 2 planned notifications`
 *   `Quiet hours 21:30–07:00 → 22:00–06:30, which holds back 1 planned notification`
 *   `Morning check-in off → 07:30`
 */
export function describeNudgeSettings(
  db: Database,
  was: Record<string, unknown>,
  patch: Record<string, unknown>,
  now: Date
): string[] {
  const next = { ...was, ...patch };
  const clauses: string[] = [];

  if ('nudges_enabled' in patch && next.nudges_enabled !== was.nudges_enabled) {
    if (next.nudges_enabled === true) {
      clauses.push('Coach nudges off → on');
    } else {
      // What `saveNudgeSettings` cancels: every pending nudge still ahead,
      // listed or held back by quiet hours.
      const cancelled = upcomingRows(db, now).length;
      clauses.push(
        'Coach nudges on → off' +
          (cancelled > 0 ? `, which cancels ${plural(cancelled, 'planned notification')}` : '')
      );
    }
  }

  const before = windowText(was.quiet_start, was.quiet_end);
  const after = windowText(next.quiet_start, next.quiet_end);
  if (('quiet_start' in patch || 'quiet_end' in patch) && before !== after) {
    // Nothing is cancelled by moving the hours — a planned nudge they now
    // cover is HELD BACK, off the tab and off the phone, until they move off it.
    const held =
      next.nudges_enabled === true
        ? upcomingNudges(db, now).filter((nudge) =>
            inQuietHours(nudge.time, next.quiet_start as string, next.quiet_end as string)
          ).length
        : 0;
    clauses.push(
      `Quiet hours ${before} → ${after}` +
        (held > 0 ? `, which holds back ${plural(held, 'planned notification')}` : '')
    );
  }

  if ('checkin_time' in patch && next.checkin_time !== was.checkin_time) {
    clauses.push(
      `Morning check-in ${(was.checkin_time as string | null) ?? 'off'} → ` +
        `${(next.checkin_time as string | null) ?? 'off'}`
    );
  }
  return clauses;
}

/** Write the nudge fields of a patch through Settings › Coach's own save. */
export function saveNudgeSettingFields(
  db: Database,
  patch: Record<string, unknown>,
  now: Date
): void {
  const settings: Partial<NudgeSettings> = {};
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    if (field in patch) (settings as Record<string, unknown>)[key] = patch[field];
  }
  if (Object.keys(settings).length > 0) saveNudgeSettings(db, settings, now);
}
