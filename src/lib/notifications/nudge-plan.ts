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
  /**
   * The reply with every NUDGE line taken out, and the scaffolding the model
   * wrapped them in (see {@link parseNudgeReply}) — what the thread and Home
   * may show.
   */
  text: string;
  /**
   * What the reply said BEFORE its first NUDGE line, scaffolding removed —
   * null when there was no NUDGE line. The directive puts the nudge lines at
   * the END of the reply, so this is the note as the model meant it, and its
   * last line is the verdict (coach-pass.ts reads it for SKIP). Anything the
   * model wrote after its nudge lines is outside the grammar.
   */
  lead: string | null;
  /** Well-formed lines, in the order written. */
  proposals: ProposedNudge[];
  /** `NUDGE NONE`: cancel everything still pending. */
  clear: boolean;
  /** Lines that began NUDGE and did not parse. Dropped, never guessed at. */
  malformed: string[];
};

export const EMPTY_NUDGE_REPLY: NudgeReply = {
  text: '',
  lead: null,
  proposals: [],
  clear: false,
  malformed: [],
};

/**
 * A line that IS a nudge line: after list bullets (a numbered item's `1.` or
 * `1)` included), quote marks and markdown emphasis, its first word is `NUDGE`
 * in capitals. Case-sensitive on purpose: the sentinel is a token, and a note
 * that happens to start "Nudge yourself toward bed" is prose that must reach
 * him, not a malformed line to swallow.
 */
const NUDGE_LINE = /^[\s>*_`•-]*(?:\d{1,2}[.)]\s+)?[\s*_`]*NUDGE(?![A-Za-z])/;
/** What sits in front of the word on a nudge line: a bullet, a quote mark, a list number. */
const LINE_MARKER = /^[\s>•-]*(?:\d{1,2}[.)]\s+)?/;
const NONE_LINE = /^NUDGE:?\s+NONE[.!]?$/;
const FULL_LINE = /^NUDGE:?\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/;

/**
 * The scaffolding a model puts round a block of lines: a code fence, a
 * horizontal rule, and a short heading or label directly above it
 * ("Notifications:", "**Planned nudges**", "### Nudges"). Left behind after the
 * NUDGE lines go, any of it would sit BELOW a SKIP and make the reply read as
 * spoken — the 2026-08-11 defect by a new route (review, 2026-09-25). Removed
 * only where it touches a nudge line; see {@link stripScaffolding}.
 */
const FENCE_LINE = /^\s*(?:```|~~~)[\w-]*\s*$/;
const RULE_LINE = /^\s*([-*_=])(?:\s*\1){2,}\s*$/;
/** A label is short. A longer sentence above the block is prose, and stays. */
const LABEL_MAX_CHARS = 60;

function isLabel(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > LABEL_MAX_CHARS) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true; // a markdown heading
  if (/^(\*\*|__)[^*_]+\1:?$/.test(trimmed)) return true; // a line that is all bold
  return /:$/.test(trimmed.replace(/[*_`]+$/, '')); // "Notifications:", "**Nudges:**"
}

/**
 * Mark the scaffolding round the nudge lines as removed too. Runs to a fixed
 * point, so a label above a fence above the lines goes with them:
 *
 *   - an OPENING fence goes when the nearest non-blank line below it is a
 *     nudge line (or a fence or rule that went), and a CLOSING fence when the
 *     nearest one above it is. Fences are paired in order, so the closing
 *     fence of a code block in the note, sitting just above the nudge lines,
 *     is not mistaken for one that opens them;
 *   - a rule goes when its nearest non-blank neighbour on either side is one;
 *   - a label goes when the nearest non-blank line BELOW it is one.
 *
 * A label never takes anything else with it, and nothing that does not border
 * a nudge line is touched: a code block in the note, or a label that
 * introduces prose, stays.
 */
function stripScaffolding(lines: string[], removed: boolean[]): void {
  const nearest = (from: number, step: 1 | -1): number => {
    for (let j = from + step; j >= 0 && j < lines.length; j += step) {
      if (lines[j]!.trim().length > 0) return j;
    }
    return -1;
  };
  // Every fence, in order, alternates opening and closing.
  const opens = new Map<number, boolean>();
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (!FENCE_LINE.test(line)) continue;
    open = !open;
    opens.set(index, open);
  }
  const frame = (j: number) => opens.has(j) || RULE_LINE.test(lines[j]!);
  // A removed nudge line, or a removed fence or rule — never a removed label.
  const anchor = (j: number) =>
    j !== -1 && removed[j] === true && (NUDGE_LINE.test(lines[j]!) || frame(j));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (removed[i] || line.trim().length === 0) continue;
      const fence = opens.get(i);
      const goes =
        fence !== undefined
          ? anchor(nearest(i, fence ? 1 : -1))
          : RULE_LINE.test(line)
            ? anchor(nearest(i, 1)) || anchor(nearest(i, -1))
            : isLabel(line) && anchor(nearest(i, 1));
      if (goes) {
        removed[i] = true;
        changed = true;
      }
    }
  }
}

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
 * The fence, rule or short label the model wrapped them in goes with them
 * ({@link stripScaffolding}), for the same reason: under a SKIP, a leftover
 * "Notifications:" is what the note would end on.
 *
 * What parses is exactly `NUDGE YYYY-MM-DD HH:MM text` or `NUDGE NONE`. A
 * one-digit hour is padded (that is notation, not a guess); a missing date, a
 * word for a day, or an impossible date is malformed. The day is never
 * inferred.
 */
export function parseNudgeReply(reply: string): NudgeReply {
  const lines = reply.split('\n');
  const removed = lines.map((line) => NUDGE_LINE.test(line));
  const first = removed.indexOf(true);
  const proposals: ProposedNudge[] = [];
  const malformed: string[] = [];
  let clear = false;

  for (const [index, line] of lines.entries()) {
    if (!removed[index]) continue;
    // Markdown emphasis anywhere on the line and the bullet or list number in
    // front of it, off. The body loses them anyway (cleanBody), so nothing is
    // lost here.
    const bare = line.replace(/[*_`]/g, '').replace(LINE_MARKER, '').trim();
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

  if (first === -1) return { text: reply.trim(), lead: null, proposals, clear, malformed };
  stripScaffolding(lines, removed);
  const kept = (upTo: number) =>
    lines
      .slice(0, upTo)
      .filter((_, index) => !removed[index])
      .join('\n')
      .trim();
  return { text: kept(lines.length), lead: kept(first), proposals, clear, malformed };
}

// --- The caps --------------------------------------------------------------------

/**
 * Does the line carry a NUMBER — a reading, a dose, a time, a count?
 *
 * Owner's Q3: the line shows in full on the lock screen, with numbers kept
 * out. The plan he accepted said the MODEL is told so; code backs that up for
 * the case that matters, a figure standing on its own ("HRV 38", "7 hours",
 * "500 ml", "7:30"). A digit INSIDE a name that begins with a letter is part
 * of the name, not a reading, so "B12", "D3", "CoQ10" and "Omega-3" pass —
 * the first version refused every digit and silently vetoed ordinary
 * supplement names (review, 2026-09-25). "Zone 2" still counts as a number:
 * the 2 stands alone, and telling it from "Sleep 6" would be judgment.
 */
export function carriesNumber(body: string): boolean {
  return body
    .split(/[^A-Za-z0-9-]+/)
    .some((token) => /[0-9]/.test(token) && !/^[A-Za-z]+-?[0-9]+s?$/.test(token));
}

/** Why a proposed nudge was dropped. Every one is a rule, none is a judgment. */
export type NudgeRejection =
  /** It carries a number ({@link carriesNumber}). Owner's Q3. */
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
  /**
   * Pending nudges still ahead — what the pass's lines would replace. A line
   * that restates one exactly (day, time and words) is exempt from the
   * minimum lead: it is already scheduled, and the directive tells the model
   * to repeat what it wants kept, so refusing the repeat of a nudge four
   * minutes out would cancel it at the moment it was about to land.
   */
  standing?: ProposedNudge[];
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

/** One nudge exactly: the same day, clock and words. */
export function nudgeKey(nudge: ProposedNudge): string {
  return `${nudge.day}|${nudge.time}|${nudge.body}`;
}

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

  const standing = new Set((input.standing ?? []).map(nudgeKey));

  const accepted: PlannedNudge[] = [];
  const rejected: PlanResult['rejected'] = [];
  const drop = (nudge: ProposedNudge, reason: NudgeRejection) => rejected.push({ nudge, reason });

  for (const nudge of input.proposals) {
    if (carriesNumber(nudge.body)) {
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
    // A restated pending nudge only has to be still ahead; a new one has to be
    // far enough ahead not to repeat what is on the screen.
    const floor = standing.has(nudgeKey(nudge)) ? now.getTime() + 1 : earliest;
    if (when.getTime() < floor) {
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
  /**
   * The wall clock as the pass starts, `HH:MM`. Without it the model cannot
   * know which of today's moments are still ahead, and code drops a moment
   * that has passed — so "today" nudges would land or vanish at random
   * (review, 2026-09-25).
   */
  clock: string;
  quietStart: string;
  quietEnd: string;
  /** Still ahead — what the pass's lines would replace. */
  pending: ProposedNudge[];
  /** Already out today, so it is not said twice. */
  sentToday: ProposedNudge[];
  /** What code refused from the last pass's lines, and why, so it can learn. */
  refused: RefusedNudge[];
};

/**
 * A line a pass wrote that code refused. Kept until the next pass is told,
 * because a refusal is otherwise silent: nothing reaches the thread or the
 * Coach tab, and the model would write the same line again tomorrow.
 */
export type RefusedNudge = { line: string; reason: NudgeRejection | 'malformed' };

/** How a refusal is put to the model — plain, and the rule rather than a verdict. */
export const REFUSAL_WORDS: Record<RefusedNudge['reason'], string> = {
  number: 'it had a number in it',
  'too-long': `longer than ${NUDGE_MAX_CHARS} characters`,
  past: `already past, or under ${NUDGE_MIN_LEAD_MIN} minutes away`,
  'beyond-horizon': `more than ${NUDGE_HORIZON_HOURS} hours ahead`,
  'quiet-hours': 'inside quiet hours',
  'day-cap': `that day already had ${NUDGE_MAX_PER_DAY}`,
  duplicate: 'the same time or words as another that day',
  unplaceable: 'that clock time does not exist that day',
  malformed: 'not in the NUDGE YYYY-MM-DD HH:MM text form',
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
