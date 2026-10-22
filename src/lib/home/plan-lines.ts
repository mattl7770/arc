/**
 * Smart day: the PLAN line grammar, its validation, and the pass's one block
 * of instructions about it.
 *
 * A coach pass may end its reply with up to three strict lines, most important
 * first:
 *
 *     PLAN PIN m2 UNTIL 11:00 | You train at 17:30 and this one slipped twice.
 *     PLAN DO log_weight | Weigh in | Last one was nine days ago.
 *     PLAN DO start_workout w1 UNTIL 18:30 | Upper A
 *     PLAN NONE
 *
 * The NUDGE lines' precedent (src/lib/notifications/nudge-plan.ts), and its
 * lesson: every line that BEGINS `PLAN` is removed from the reply whether or not
 * it parses, with the fence, rule or label round it, because a sentinel that
 * reaches the thread is the Coach's instruction shipped as its own words.
 *
 * **Code judges nothing.** What goes on top and why is the model's call. This
 * file only refuses what cannot be shown honestly: an action ARC has no door
 * for, a tag the pass was not given (or one of the wrong kind), a row that is
 * no longer open, a time already past, a title or reason over its length, a
 * fourth item. A refused line is DROPPED — never repaired, never guessed at,
 * never truncated (a cut-off reason would be words the Coach did not say).
 *
 * Pure apart from `fireInstant` (a clock helper). db/smart-day.test.mjs drives
 * every rule here.
 */
import { logicalDayUtcRange } from '@/lib/db/date';
import { stripScaffolding } from '@/lib/notifications/nudge-plan';
import { fireInstant } from '@/lib/notifications/protocol-reminders';

import type { FactTag } from './day-facts';
import {
  ACTION_SPEC,
  isPlanAction,
  PLAN_ACTIONS,
  PLAN_MAX_ITEMS,
  PLAN_REASON_MAX,
  PLAN_TITLE_MAX,
  type EvaluatedItem,
  type PlanAction,
  type PlanItem,
} from './day-plan';

// --- The grammar --------------------------------------------------------------------

export type ProposedPlanLine =
  | { kind: 'pin'; line: string; tag: string; until: string | null; reason: string | null }
  | {
      kind: 'do';
      line: string;
      action: string;
      tag: string | null;
      until: string | null;
      title: string;
      reason: string | null;
    };

export type PlanReply = {
  /** The reply with every PLAN line (and its scaffolding) removed. */
  text: string;
  /** What came BEFORE the first PLAN line — its last line is the verdict. Null with no PLAN line. */
  lead: string | null;
  /** Well-formed lines, in the order written. */
  lines: ProposedPlanLine[];
  /** `PLAN NONE`. */
  clear: boolean;
  /** Lines that began PLAN and did not parse. */
  malformed: string[];
};

/** A line that IS a plan line: after bullets, quote marks and emphasis, its first word is `PLAN`, in capitals. */
const PLAN_LINE = /^[\s>*_`•-]*(?:\d{1,2}[.)]\s+)?[\s*_`]*PLAN(?![A-Za-z])/;
const LINE_MARKER = /^[\s>•-]*(?:\d{1,2}[.)]\s+)?/;
const NONE_LINE = /^PLAN:?\s+NONE[.!]?$/i;
const HEAD = /^PLAN:?\s+(PIN|DO)\s+(.+)$/i;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

export const isPlanLine = (line: string): boolean => PLAN_LINE.test(line);

/** Wrapping quotes off, whitespace collapsed; a leading separator ("— why") off. */
function cleanField(raw: string | undefined): string {
  let text = (raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—:]\s*/, '')
    .trim();
  const quoted = /^["“'‘](.*)["”'’]$/.exec(text);
  if (quoted) text = quoted[1]!.trim();
  return text;
}

function parseLine(line: string): ProposedPlanLine | 'none' | null {
  // Emphasis and a bullet off — but NOT underscores: they are inside the
  // action names (log_weight), and stripping them would make every line junk.
  const bare = line.replace(/[*`]/g, '').replace(LINE_MARKER, '').trim();
  if (NONE_LINE.test(bare)) return 'none';
  const parts = bare.split('|');
  const head = HEAD.exec(parts[0]!.trim());
  if (!head) return null;
  const verb = head[1]!.toUpperCase();
  const tokens = head[2]!.trim().split(/\s+/);

  let until: string | null = null;
  const at = tokens.findIndex((token) => /^until$/i.test(token));
  if (at !== -1) {
    if (at !== tokens.length - 2) return null;
    const clock = CLOCK.exec(tokens[at + 1]!);
    if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) return null;
    until = `${clock[1]!.padStart(2, '0')}:${clock[2]}`;
    tokens.splice(at, 2);
  }

  const fields = parts.slice(1).map(cleanField);
  const reasonOf = (field: string | undefined) => (field && field.length > 0 ? field : null);

  if (verb === 'PIN') {
    if (tokens.length !== 1 || fields.length > 1) return null;
    return {
      kind: 'pin',
      line: line.trim(),
      tag: tokens[0]!.toLowerCase(),
      until,
      reason: reasonOf(fields[0]),
    };
  }
  if (tokens.length < 1 || tokens.length > 2 || fields.length < 1 || fields.length > 2) return null;
  const title = fields[0]!;
  if (title.length === 0) return null;
  return {
    kind: 'do',
    line: line.trim(),
    action: tokens[0]!.toLowerCase(),
    tag: tokens[1]?.toLowerCase() ?? null,
    until,
    title,
    reason: reasonOf(fields[1]),
  };
}

/**
 * Take a pass reply apart: the note, and the plan lines. Every PLAN-looking
 * line goes, parsed or not.
 */
export function parsePlanReply(reply: string): PlanReply {
  const lines = reply.split('\n');
  const removed = lines.map(isPlanLine);
  const first = removed.indexOf(true);
  const parsed: ProposedPlanLine[] = [];
  const malformed: string[] = [];
  let clear = false;
  for (const [index, line] of lines.entries()) {
    if (!removed[index]) continue;
    const result = parseLine(line);
    if (result === 'none') clear = true;
    else if (result === null) malformed.push(line.trim());
    else parsed.push(result);
  }
  if (first === -1) return { text: reply.trim(), lead: null, lines: parsed, clear, malformed };
  stripScaffolding(lines, removed, isPlanLine);
  const kept = (upTo: number) =>
    lines
      .slice(0, upTo)
      .filter((_, index) => !removed[index])
      .join('\n')
      .trim();
  return { text: kept(lines.length), lead: kept(first), lines: parsed, clear, malformed };
}

// --- Validation -----------------------------------------------------------------------

export type PlanRefusalReason =
  | 'malformed'
  | 'unknown-action'
  | 'unknown-tag'
  | 'wrong-tag'
  | 'title-too-long'
  | 'reason-too-long'
  | 'stale-until'
  | 'duplicate'
  | 'too-many';

export type PlanResolution = {
  /**
   * keep     no usable PLAN line — the plan already standing stays (a reply of
   *          junk must not wipe a good plan)
   * clear    PLAN NONE and nothing valid beside it
   * replace  `items` is the new plan
   */
  decision: 'keep' | 'clear' | 'replace';
  items: PlanItem[];
  refused: { line: string; reason: PlanRefusalReason }[];
};

export type PlanContext = {
  now: Date;
  /** The logical day the plan is for. */
  today: string;
  dayStartsAt: string;
  /** Exactly the tags this pass was shown. */
  tags: readonly FactTag[];
};

/** Validate parsed lines against the tags this pass was given. */
export function resolvePlan(reply: PlanReply, context: PlanContext): PlanResolution {
  const refused: PlanResolution['refused'] = reply.malformed.map((line) => ({
    line,
    reason: 'malformed',
  }));
  const byTag = new Map(context.tags.map((tag) => [tag.tag, tag]));
  const endOfDay = logicalDayUtcRange(context.today, context.dayStartsAt).endUtc;
  const items: PlanItem[] = [];
  const keys = new Set<string>();

  for (const line of reply.lines) {
    const refuse = (reason: PlanRefusalReason) => refused.push({ line: line.line, reason });

    let until = endOfDay;
    if (line.until !== null) {
      const at = fireInstant(context.today, line.until, context.dayStartsAt);
      if (!at || at.getTime() <= context.now.getTime()) {
        refuse('stale-until');
        continue;
      }
      until = at.toISOString();
    }
    if (line.reason !== null && line.reason.length > PLAN_REASON_MAX) {
      refuse('reason-too-long');
      continue;
    }

    let item: Omit<PlanItem, 'rank'>;
    if (line.kind === 'pin') {
      const tag = byTag.get(line.tag);
      if (!tag) {
        refuse('unknown-tag');
        continue;
      }
      if (tag.kind !== 'row') {
        refuse('wrong-tag');
        continue;
      }
      item = {
        key: `pin:${tag.id}`,
        kind: 'pin',
        entryId: tag.id,
        title: tag.title,
        reason: line.reason,
        until,
        untilGiven: line.until !== null,
      };
    } else {
      if (!isPlanAction(line.action)) {
        refuse('unknown-action');
        continue;
      }
      const action: PlanAction = line.action;
      const wants = ACTION_SPEC[action].target;
      let targetId: string | undefined;
      if (wants === null) {
        if (line.tag !== null) {
          refuse('wrong-tag');
          continue;
        }
      } else {
        const tag = line.tag === null ? undefined : byTag.get(line.tag);
        if (line.tag === null) {
          refuse('wrong-tag');
          continue;
        }
        if (!tag) {
          refuse('unknown-tag');
          continue;
        }
        if (tag.kind !== wants) {
          refuse('wrong-tag');
          continue;
        }
        targetId = tag.id;
      }
      if (line.title.length > PLAN_TITLE_MAX) {
        refuse('title-too-long');
        continue;
      }
      item = {
        key: targetId ? `do:${action}:${targetId}` : `do:${action}`,
        kind: 'do',
        action,
        ...(targetId ? { targetId } : {}),
        title: line.title,
        reason: line.reason,
        until,
        untilGiven: line.until !== null,
      };
    }

    if (keys.has(item.key)) {
      refuse('duplicate');
      continue;
    }
    if (items.length >= PLAN_MAX_ITEMS) {
      refuse('too-many');
      continue;
    }
    keys.add(item.key);
    items.push({ ...item, rank: items.length + 1 });
  }

  const decision = items.length > 0 ? 'replace' : reply.clear ? 'clear' : 'keep';
  return { decision, items, refused };
}

// --- The pass's instructions -------------------------------------------------------

/** The tag letter each target kind is minted with (src/lib/home/day-facts.ts). */
const TAG_LETTER = { routine: 'w', reminder: 'r', experiment: 'e' } as const;

/** How the pass is shown the plan already standing, with today's tags for its pins. */
function describeCurrent(current: readonly EvaluatedItem[], tags: readonly FactTag[]): string[] {
  if (current.length === 0) return ['Current plan from your last pass: none.'];
  const tagOf = new Map(tags.filter((t) => t.kind === 'row').map((t) => [t.id, t.tag]));
  return [
    'Current plan from your last pass:',
    ...current.map((item) => {
      const what =
        item.kind === 'pin'
          ? `PIN ${tagOf.get(item.entryId ?? '') ?? '(row no longer open)'} "${item.title}"`
          : `DO ${item.action} "${item.title}"`;
      return `  ${item.rank}. ${what} — ${item.state}`;
    }),
  ];
}

/**
 * The block the pass's directive carries — ONE block, delimited, so a sibling
 * block (nudges, findings, proposals) can sit beside it without touching it.
 * It lives in the pass's USER message: outside the chat system prompt, outside
 * the tool schemas, outside the cached prefix and both ceilings in
 * db/coach-eval.test.mjs §6.
 *
 * It names no scenario. The facts are statements; the instruction is that the
 * top of Home is the Coach's call, and that time order is a fine answer.
 */
export function planInstructions(input: {
  clock: string;
  today: string;
  facts: readonly string[];
  summary: string;
  current: readonly EvaluatedItem[];
  tags: readonly FactTag[];
}): string[] {
  const actions = PLAN_ACTIONS.map((action) => {
    const target = ACTION_SPEC[action].target;
    return target === null ? action : `${action} <${TAG_LETTER[target]}-tag>`;
  }).join(' · ');
  return [
    '',
    '=== Top of Home ===',
    `It is ${input.clock} on ${input.today}. Facts about the day, gathered by code. None of them is a`,
    'recommendation: what matters today, and when, is your call.',
    ...input.facts,
    input.summary,
    ...describeCurrent(input.current, input.tags),
    'You decide what belongs at the top of Home now, if anything. Without a plan Home shows the open',
    'rows in time order, which is often right. To change that, end your reply with up to',
    `${PLAN_MAX_ITEMS} lines, most important first:`,
    'PLAN PIN <m-tag> [UNTIL HH:MM] | reason',
    'PLAN DO <action> [tag] [UNTIL HH:MM] | title | reason',
    `Actions: ${actions}.`,
    '- A DO item is yours, not a mission row: it never counts toward the mission or adherence. It',
    '  clears when its data lands (log_*: a weight, a meal, water; workouts: a session; open_reminder:',
    '  the reminder done), when tapped (the other open_* items), when dismissed, when UNTIL passes,',
    '  or when your next plan replaces it.',
    `- Title at most ${PLAN_TITLE_MAX} characters. The reason is optional: one plain sentence, at most`,
    `  ${PLAN_REASON_MAX} characters, shown under the item as yours. A line over either limit is dropped.`,
    '- UNTIL is a 24-hour time later today; without one the item holds until the day ends.',
    '- PLAN lines replace the current plan. Write none to keep it, or PLAN NONE to clear it.',
    '- PLAN lines are never shown in the thread and may follow SKIP. Write them bare, one per line,',
    '  with no heading, list or code block. Do not mention them in your note.',
    '=== end of Top of Home ===',
  ];
}
