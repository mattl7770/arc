/**
 * Coach nudges, the pure half: the line grammar, the caps, quiet hours.
 *
 * The plan of record is docs/spikes/coach-notifications.md (c), accepted by the
 * owner on 2026-09-25. A coach pass (src/lib/ai/coach-pass.ts) may end its
 * reply with strict lines
 *
 *     NUDGE 2026-09-26 07:30 Leg day. Eat before you lift.
 *
 * and everything in this file is what code does with them. **None of it is
 * judgment.** Whether to nudge, what to say and when are the model's calls
 * (memory: judgment lives in the model, not rules); this file only parses,
 * caps, de-duplicates and applies quiet hours, and it never moves a nudge it
 * refuses. A time that is not allowed is DROPPED — the protocol-reminder
 * precedent: moving it would be ARC deciding to nudge at a moment the model
 * did not pick.
 *
 * Pure: no database, no Expo, no clock of its own. The repository
 * (src/lib/db/repositories/coach-nudges.ts) reads the rows and hands them in;
 * db/coach-pass.test.mjs exercises every rule here directly.
 */
import { shiftISODate } from '@/lib/db/date';

import { fireInstant } from './protocol-reminders';

// --- The numbers ---------------------------------------------------------------

/** Owner's Q1: at most two a day, counting the ones already sent that day. */
export const NUDGE_MAX_PER_DAY = 2;
/** No nudge is planned further ahead than this, so none is ever older than a day and a half. */
export const NUDGE_HORIZON_HOURS = 36;
/**
 * A nudge must land at least this far ahead. The pass runs while he is
 * looking at the app, and a buzz a minute later repeats what is on the screen.
 */
export const NUDGE_MIN_LEAD_MIN = 5;
/** What the lock screen can carry without truncating mid-thought. */
export const NUDGE_MAX_CHARS = 140;

/** Owner's Q2: 21:30–07:00 by default, editable in Settings › Coach. */
export const DEFAULT_QUIET_START = '21:30';
export const DEFAULT_QUIET_END = '07:00';

/** What Settings › Coach stores under `users.preferences.coachNudges`. */
export type NudgeSettings = {
  /** Off cancels everything pending and takes the instructions out of the pass. */
  enabled: boolean;
  quietStart: string;
  quietEnd: string;
  /**
   * The morning check-in ("doorbell", plan §3(e)1): a fixed daily notification
   * at a time he picks, reading "Morning check-in" with no health content.
   * Null is off, which is the default — it is opt-in.
   */
  checkinTime: string | null;
};

export const DEFAULT_NUDGE_SETTINGS: NudgeSettings = {
  enabled: true,
  quietStart: DEFAULT_QUIET_START,
  quietEnd: DEFAULT_QUIET_END,
  checkinTime: null,
};

// --- Clock strings -------------------------------------------------------------

/** A real `HH:MM`, zero-padded. */
export function isClock(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/** The wall-clock `HH:MM` of an instant, in the phone's zone. */
export function clockOf(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Is a wall-clock time inside the quiet window? The window may wrap midnight
 * (21:30–07:00 is the default and does). Start is inside, end is not, so a
 * nudge at exactly 07:00 is allowed. A window whose ends are equal is empty —
 * "no quiet hours", not "all day".
 *
 * Plain string comparison throughout: `HH:MM` zero-padded sorts
 * chronologically, the same trick `fireInstant` uses.
 */
export function inQuietHours(time: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) return time >= start && time < end;
  return time >= start || time < end;
}

// --- The line grammar ------------------------------------------------------------

export type ProposedNudge = {
  /** The LOGICAL day it belongs to. */
  day: string;
  /** Wall clock, `HH:MM`. */
  time: string;
  body: string;
};

export type NudgeReply = {
  /** The reply with every NUDGE line taken out — what the thread and Home may show. */
  text: string;
  /** Well-formed lines, in the order written. */
  proposals: ProposedNudge[];
  /** `NUDGE NONE`: cancel everything still pending. */
  clear: boolean;
  /** Lines that began NUDGE and did not parse. Dropped, never guessed at. */
  malformed: string[];
};

export const EMPTY_NUDGE_REPLY: NudgeReply = {
  text: '',
  proposals: [],
  clear: false,
  malformed: [],
};

/**
 * A line that IS a nudge line: after list bullets, quote marks and markdown
 * emphasis, its first word is `NUDGE` in capitals. Case-sensitive on purpose:
 * the sentinel is a token, and a note that happens to start "Nudge yourself
 * toward bed" is prose that must reach him, not a malformed line to swallow.
 */
const NUDGE_LINE = /^[\s>*_`•-]*NUDGE(?![A-Za-z])/;
const NONE_LINE = /^NUDGE:?\s+NONE[.!]?$/;
const FULL_LINE = /^NUDGE:?\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/;

/** A real calendar day, checked componentwise (never `new Date('YYYY-MM-DD')`). */
function realDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const probe = new Date(y, m - 1, d, 12, 0, 0, 0);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

/** Markdown and wrapping quotes stripped, whitespace collapsed. */
function cleanBody(raw: string): string {
  let body = raw
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A separator the model put between the time and the words: "— Leg day".
    .replace(/^[-–—:|]\s*/, '')
    .trim();
  const quoted = /^["“'‘](.*)["”'’]$/.exec(body);
  if (quoted) body = quoted[1]!.trim();
  return body;
}

/**
 * Take a pass reply apart: the note, and the nudge lines.
 *
 * Every line that {@link NUDGE_LINE} recognises is REMOVED from the text,
 * whether or not it parses. That is the `isPassSkip` lesson applied a second
 * time: a sentinel that leaks reaches the owner as the Coach's own words, so a
 * half-formed `NUDGE tomorrow morning …` is dropped and counted, never shown.
 *
 * What parses is exactly `NUDGE YYYY-MM-DD HH:MM text` or `NUDGE NONE`. A
 * one-digit hour is padded (that is notation, not a guess); a missing date, a
 * word for a day, or an impossible date is malformed. The day is never
 * inferred.
 */
export function parseNudgeReply(reply: string): NudgeReply {
  const kept: string[] = [];
  const proposals: ProposedNudge[] = [];
  const malformed: string[] = [];
  let clear = false;

  for (const line of reply.split('\n')) {
    if (!NUDGE_LINE.test(line)) {
      kept.push(line);
      continue;
    }
    // Markdown emphasis anywhere on the line and the bullet in front of it,
    // off. The body loses them anyway (cleanBody), so nothing is lost here.
    const bare = line
      .replace(/[*_`]/g, '')
      .replace(/^[\s>•-]+/, '')
      .trim();
    if (NONE_LINE.test(bare)) {
      clear = true;
      continue;
    }
    const match = FULL_LINE.exec(bare);
    if (!match) {
      malformed.push(line.trim());
      continue;
    }
    const [, y, m, d, hh, mm, rest] = match;
    const hour = Number(hh);
    const minute = Number(mm);
    const body = cleanBody(rest!);
    if (!realDay(Number(y), Number(m), Number(d)) || hour > 23 || minute > 59 || body === '') {
      malformed.push(line.trim());
      continue;
    }
    proposals.push({
      day: `${y}-${m}-${d}`,
      time: `${String(hour).padStart(2, '0')}:${mm}`,
      body,
    });
  }

  return { text: kept.join('\n').trim(), proposals, clear, malformed };
}

// --- The caps --------------------------------------------------------------------

/** Why a proposed nudge was dropped. Every one is a rule, none is a judgment. */
export type NudgeRejection =
  /** It carries a digit. Owner's Q3: the line shows in full, with numbers kept out. */
  | 'number'
  | 'too-long'
  /** Its moment is past, or too close to now to be anything but a repeat of the screen. */
  | 'past'
  | 'beyond-horizon'
  | 'quiet-hours'
  /** The day already has its two. */
  | 'day-cap'
  /** Same slot or same words as one already planned or sent that day. */
  | 'duplicate'
  | 'unplaceable';

export type PlannedNudge = ProposedNudge & { when: Date };

export type PlanInput = {
  proposals: ProposedNudge[];
  /**
   * Nudges that have ALREADY gone out — tapped, or pending with a moment in the
   * past. They count against their day's cap and their words cannot be sent
   * again that day. Pending FUTURE rows are not here: a pass's lines replace
   * them, so they are not competing for the cap.
   */
  sent: ProposedNudge[];
  now: Date;
  dayStartsAt: string;
  quietStart: string;
  quietEnd: string;
};

export type PlanResult = {
  /** Soonest first. */
  accepted: PlannedNudge[];
  rejected: { nudge: ProposedNudge; reason: NudgeRejection }[];
};

/** Case, spacing and a trailing full stop are not a different message. */
export function normalizeBody(body: string): string {
  return body
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .trim();
}

/**
 * Apply every rule to the proposals, in the order the model wrote them — so
 * when it lists three for one day, the two it put first are the two kept.
 */
export function planNudges(input: PlanInput): PlanResult {
  const { now, dayStartsAt, quietStart, quietEnd } = input;
  const earliest = now.getTime() + NUDGE_MIN_LEAD_MIN * 60_000;
  const horizon = now.getTime() + NUDGE_HORIZON_HOURS * 3_600_000;

  const perDay = new Map<string, number>();
  const words = new Set<string>();
  const slots = new Set<string>();
  for (const sent of input.sent) {
    perDay.set(sent.day, (perDay.get(sent.day) ?? 0) + 1);
    words.add(`${sent.day}|${normalizeBody(sent.body)}`);
    slots.add(`${sent.day}|${sent.time}`);
  }

  const accepted: PlannedNudge[] = [];
  const rejected: PlanResult['rejected'] = [];
  const drop = (nudge: ProposedNudge, reason: NudgeRejection) => rejected.push({ nudge, reason });

  for (const nudge of input.proposals) {
    if (/[0-9]/.test(nudge.body)) {
      drop(nudge, 'number');
      continue;
    }
    if (nudge.body.length > NUDGE_MAX_CHARS) {
      drop(nudge, 'too-long');
      continue;
    }
    const when = fireInstant(nudge.day, nudge.time, dayStartsAt);
    if (when === null) {
      drop(nudge, 'unplaceable');
      continue;
    }
    if (when.getTime() < earliest) {
      drop(nudge, 'past');
      continue;
    }
    if (when.getTime() > horizon) {
      drop(nudge, 'beyond-horizon');
      continue;
    }
    if (inQuietHours(nudge.time, quietStart, quietEnd)) {
      drop(nudge, 'quiet-hours');
      continue;
    }
    const slot = `${nudge.day}|${nudge.time}`;
    const said = `${nudge.day}|${normalizeBody(nudge.body)}`;
    if (slots.has(slot) || words.has(said)) {
      drop(nudge, 'duplicate');
      continue;
    }
    if ((perDay.get(nudge.day) ?? 0) >= NUDGE_MAX_PER_DAY) {
      drop(nudge, 'day-cap');
      continue;
    }
    perDay.set(nudge.day, (perDay.get(nudge.day) ?? 0) + 1);
    slots.add(slot);
    words.add(said);
    accepted.push({ ...nudge, when });
  }

  accepted.sort((a, b) => a.when.getTime() - b.when.getTime());
  return { accepted, rejected };
}

// --- What a pass is told ---------------------------------------------------------

/**
 * Everything the pass directive says about nudges, gathered by the repository
 * (`nudgeDirectiveFor`) and phrased by `passDirective`. Null there means nudges
 * are off, and the directive then says nothing about them at all.
 */
export type NudgeDirective = {
  today: string;
  tomorrow: string;
  quietStart: string;
  quietEnd: string;
  /** Still ahead — what the pass's lines would replace. */
  pending: ProposedNudge[];
  /** Already out today, so it is not said twice. */
  sentToday: ProposedNudge[];
};

// --- Words for a day -------------------------------------------------------------

/**
 * "today", "tomorrow", or the ISO day. The horizon is a day and a half, so the
 * third case is rare (a small-hours nudge under a late day boundary); ISO
 * rather than a weekday name because Hermes has no `Intl`.
 */
export function nudgeDayLabel(day: string, today: string): string {
  if (day === today) return 'today';
  if (day === shiftISODate(today, 1)) return 'tomorrow';
  return day;
}
