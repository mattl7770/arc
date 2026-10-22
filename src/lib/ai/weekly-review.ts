/**
 * The weekly review — WHEN it runs, WHAT the pass is told, and WHAT survives.
 *
 * Owner's decision (2026-10-21): on the first open after Sunday 18:00 (logical
 * day, local time), last week is summed up and the Coach returns at most three
 * decisions as proposals. Plan of record: docs/spikes/chief-of-staff-release.md
 * Track 2 item 5; the account of what was built is docs/ai-coach.md › The
 * weekly review and docs/reports-subapp.md §6b.
 *
 * This module is PURE over the {@link Database} interface (apart from its own
 * slot in `users.preferences`), and it never calls the model: the runner is
 * weekly-runner.ts, the model turn is coach-pass.ts's (`runCoachPass` with a
 * `weekly` input, so the pass's model and read tools are the pass's, whatever
 * a sibling branch makes them), and the drafts go through proposals.ts.
 *
 * ## Which week
 *
 * The week reviewed is the Monday–Sunday week whose Sunday 18:00 passed most
 * recently. On Sunday evening that is the week ending TODAY; from Monday on
 * (a missed Sunday) it is the week that ended last Sunday — the same week, so
 * a missed Sunday fires once on the next open and never again. A stored week
 * cursor that only moves forward makes "never twice for one week" hold under a
 * rolled-back clock too. A week older than the latest is never reviewed late:
 * a review is for the week ahead, and a fortnight-old one is history.
 *
 * Sunday evening's week includes today, so the report carries the self-
 * review's own honesty for that case: every ACCUMULATING total (adherence,
 * training minutes, steps, food) stops at Saturday and the report's
 * `todayNote` says so; single readings taken today count. Exactly what Data ›
 * Reports prints for a custom range ending today — the same assembler, the
 * same figures.
 *
 * ## The first sight is a baseline, not a review
 *
 * With no cursor stored (the build that brings this feature, or a fresh
 * install), the week currently due is recorded as seen and nothing runs. The
 * first review is the first Sunday 18:00 that passes after ARC has seen this
 * build. Without it the install itself would trigger a review of a week that
 * ended before the feature existed — mid-week, on whatever day the build
 * landed.
 *
 * ## Quiet hours and the lock
 *
 * The review waits out quiet hours (Settings › Coach), as the newer pass
 * triggers do: inside them it does not fire, and the next open after them
 * does. The app lock and the key are the pass store's gates, applied before
 * this module is consulted.
 */
import type { Database } from '@/lib/db/database';
import { forwardCursor, getDayStartsAt, shiftISODate, todayISODate, weekdayIndex } from '@/lib/db/date';
import { getNudgeSettings } from '@/lib/db/repositories/coach-nudges';
import { getReport } from '@/lib/db/repositories/reports';
import { getOrCreateUser } from '@/lib/db/repositories/user';
import { clockOf, inQuietHours } from '@/lib/notifications/nudge-plan';
import { formatRange, periodFromBounds } from '@/lib/reports/period';
import type { Period, SelfReviewData } from '@/lib/reports/types';

import { isEveningAt } from './pass-schedule';
import {
  findingsCitable,
  listProposals,
  proposalDirectiveFor,
  weeklyDrafts,
  writeToolSignatures,
  type ProposalDirective,
  type StoredProposal,
} from './proposals';
import { checkNumberProvenance } from './provenance';

/** At most this many decisions from one week's review (owner, 2026-10-21). */
export const WEEKLY_DECISIONS = 3;
/** The read is "a few lines" — more is cut. */
export const WEEKLY_READ_MAX_LINES = 5;
/** What the report is called on its own page and in the history. */
export const WEEKLY_PERIOD_LABEL = 'Weekly review';

/** One filed review — what Home's "Your week" reads. */
export type WeeklyRecord = {
  /** The reviewed week's Monday and Sunday. */
  weekStart: string;
  weekEnd: string;
  /** The logical day the review landed — Home shows it that day and the next. */
  day: string;
  /** The `reports` row it filed. */
  reportId: string;
  at: string;
};

export type WeeklyState = {
  /** The Monday of the last week reviewed (or baselined). Forward-only. */
  lastWeek: string | null;
  latest: WeeklyRecord | null;
};

// --- State (users.preferences.coachWeekly — no migration) ----------------------

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

function isRecord(value: unknown): value is WeeklyRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.weekStart === 'string' &&
    typeof r.weekEnd === 'string' &&
    typeof r.day === 'string' &&
    typeof r.reportId === 'string' &&
    typeof r.at === 'string'
  );
}

export function getWeeklyState(db: Database): WeeklyState {
  const section = parsePreferences(getOrCreateUser(db).preferences)['coachWeekly'];
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return { lastWeek: null, latest: null };
  }
  const record = section as Record<string, unknown>;
  return {
    lastWeek: typeof record.lastWeek === 'string' ? record.lastWeek : null,
    latest: isRecord(record.latest) ? record.latest : null,
  };
}

export function setWeeklyState(db: Database, state: WeeklyState): void {
  const user = getOrCreateUser(db);
  const preferences = parsePreferences(user.preferences);
  preferences.coachWeekly = state;
  db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(preferences), user.id]);
}

/** Record `weekStart` as reviewed (the cursor only moves forward), and its filing. */
export function markWeekReviewed(
  db: Database,
  weekStart: string,
  latest: WeeklyRecord | null
): void {
  const state = getWeeklyState(db);
  setWeeklyState(db, {
    lastWeek: forwardCursor(state.lastWeek, weekStart),
    latest: latest ?? state.latest,
  });
}

// --- When --------------------------------------------------------------------

/** The weekday the review belongs to, as `weekdayIndex` numbers it. */
const SUNDAY = 0;

/**
 * The week a review at `now` is about: the one ending today on Sunday evening,
 * otherwise the last complete one. Built through `periodFromBounds`, so it is
 * the same {@link Period} shape the Reports screen hands the assembler.
 */
export function reviewWeekFor(now: Date, dayStartsAt: string = getDayStartsAt()): Period {
  const today = todayISODate(now, dayStartsAt);
  const weekday = weekdayIndex(today);
  const sinceMonday = (weekday + 6) % 7;
  const thisMonday = shiftISODate(today, -sinceMonday);
  const closing = weekday === SUNDAY && isEveningAt(now, dayStartsAt);
  const start = closing ? thisMonday : shiftISODate(thisMonday, -7);
  const end = shiftISODate(start, 6);
  // 'last_week' bounds never fail to build; the label is the review's own.
  const period = periodFromBounds('last_week', start, end, now)!;
  return { ...period, label: WEEKLY_PERIOD_LABEL };
}

export type WeeklyDue = { period: Period; baseline: boolean };

/**
 * Is a weekly review due now? Null when the week was already reviewed (or the
 * clock was rolled back behind it), and inside quiet hours. `baseline` when
 * nothing was ever stored — the runner records the week and runs nothing.
 */
export function dueWeekly(db: Database, now: Date = new Date()): WeeklyDue | null {
  const dayStartsAt = getDayStartsAt();
  const period = reviewWeekFor(now, dayStartsAt);
  const state = getWeeklyState(db);
  if (state.lastWeek === null) return { period, baseline: true };
  if (state.lastWeek >= period.start) return null;
  const settings = getNudgeSettings(db);
  if (inQuietHours(clockOf(now), settings.quietStart, settings.quietEnd)) return null;
  return { period, baseline: false };
}

// --- What the pass is told ------------------------------------------------------

/**
 * The weekly allowance: three per reviewed week, counted whatever became of
 * them — so a review retried after a failure cannot draft a fourth. Pending
 * is the shared list, so the review does not re-draft what the daily pass
 * already has waiting; the refusals are the review's OWN (proposals.ts
 * `weeklyRefused`), which the daily pass neither reads nor overwrites.
 */
export function weeklyProposalDirectiveFor(
  db: Database,
  now: Date,
  week: string
): ProposalDirective {
  const shared = proposalDirectiveFor(db, now, 'weekly');
  const made = listProposals(db, now).filter((p) => p.weekly?.week === week).length;
  return { ...shared, remaining: Math.max(0, WEEKLY_DECISIONS - made) };
}

/**
 * The report as the model reads it: the whole deterministic snapshot minus its
 * document furniture (title, disclaimer, app version), on one line. The same
 * string is a provenance source for the read.
 */
export function reportForModel(data: SelfReviewData): string {
  const { meta: _meta, ...rest } = data;
  void _meta;
  return JSON.stringify(rest);
}

/** What coach-pass.ts hands the weekly directive. */
export type WeeklyPassInput = {
  rangeLabel: string;
  reportJson: string;
  proposals: ProposalDirective;
};

/**
 * The weekly pass's whole user message. It rides that message only — outside
 * both chat ceilings in db/coach-eval.test.mjs §6 and outside the cached
 * prefix — and names no scenario: what the week means is the model's call.
 * The rules it states (three decisions, the provenance of the read, cards
 * drawn by code) are ENFORCED by code; they are told so it does not waste a
 * line. `skip` is coach-pass.ts's sentinel, passed in so this module does not
 * import the pass.
 */
export function weeklyDirective(input: WeeklyPassInput, skip: string): string {
  const p = input.proposals;
  const waiting = [
    'Waiting on them:',
    ...(p.pending.length === 0 ? ['  none'] : p.pending.map((line) => `  ${line}`)),
    ...(p.refused.length > 0
      ? [
          'Not drafted from your last pass:',
          ...p.refused.map(({ line, reason }) => `  ${line} (${reason})`),
        ]
      : []),
  ];
  const decisions =
    p.remaining === 0
      ? ['', 'Decisions: this week’s are already drafted. Write no PROPOSE line.', ...waiting]
      : [
          '',
          `Decisions. You cannot change anything here, but you may draft up to ${p.remaining} decision${p.remaining === 1 ? '' : 's'} for the week ahead,`,
          'each one a change they approve with one tap, on Home and in the thread, open tonight and tomorrow.',
          'A decision follows from the week — it is not the read restated. Fewer is better; none is fine;',
          'never one they recently declined. One line each:',
          'PROPOSE tool_name {"its":"input as JSON, on one line"} one short sentence of why, citing the week',
          ...(findingsCitable()
            ? [
                '- Add "finding <id>" after PROPOSE when the draft fixes a finding; it is dropped once that is resolved.',
              ]
            : []),
          '- Code draws the card from the tool, exactly as in chat, and drops a draft it cannot draw.',
          '  Do not mention drafts in your read: the app shows them.',
          'The tools and their inputs, as in chat (? optional, n number, [..] a list of objects):',
          ...writeToolSignatures().map((signature) => `  ${signature}`),
          ...waiting,
          'Write PROPOSE lines bare, one per line, after your read (or SKIP), with no heading, list or code block.',
        ];
  return [
    '[Automatic weekly pass — the user did not type this.]',
    `This is your weekly review of ${input.rangeLabel}. ARC computed the self-review below from their`,
    'record; it is filed under Data › Reports and opens from Home, where your read and decisions land',
    'as "Your week". The user did not ask for this and is not waiting on a reply.',
    '',
    'Read the report, and whatever else you need with your tools — the state block above, get_insights,',
    'the snapshot. Do not narrate: call the tools without announcing them, and write nothing until you',
    'have the results.',
    '',
    'Then write your read of the week: 2 to 4 short lines, one sentence each, each on its own line, no',
    'heading, no list, no markdown. What held, what moved, what did not get done — lead with the thing.',
    'Quote a number only as the report or a tool result words it; a line with a number you did not read',
    'is dropped. Where the report says a change is within normal variation it is not a trend. Absences',
    'are facts, not failures. No medical advice and no diagnosis; flag uncertainty.',
    '',
    `If the week truly warrants no word, reply with exactly ${skip} (PROPOSE lines may still follow it).`,
    ...decisions,
    '',
    'The report (JSON, computed by ARC):',
    input.reportJson,
  ].join('\n');
}

// --- What survives ----------------------------------------------------------------

/**
 * The read, line by line, keeping only lines whose every number traces to what
 * the pass read — the report, the state block, a tool result — by the harness
 * the brief and the eval suite use (provenance.ts). A line carrying a figure
 * from nowhere is dropped WHOLE. Markdown bullets and emphasis off; at most
 * {@link WEEKLY_READ_MAX_LINES} kept.
 */
export function vetWeeklyRead(
  text: string,
  sources: string[]
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^[\s>*•-]*(?:\d{1,2}[.)]\s+)?/, '')
      .replace(/[*`#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line.length === 0) continue;
    if (checkNumberProvenance(line, sources).unsourced.length === 0) kept.push(line);
    else dropped.push(line);
  }
  return { kept: kept.slice(0, WEEKLY_READ_MAX_LINES), dropped };
}

/** The line that opens the review's record in the thread. */
export function weeklyThreadHead(rangeLabel: string): string {
  return `Your week, ${rangeLabel}:`;
}

// --- Home's "Your week" ------------------------------------------------------------

export type WeeklyCard = {
  /** The filed report, or null if he deleted it from Data › Reports. */
  reportId: string | null;
  rangeLabel: string;
  /** The vetted read, as stored with the report; null when the Coach had none. */
  read: string[] | null;
  /** The review's decisions, pending first. */
  drafts: StoredProposal[];
};

/**
 * What Home's Coach card shows under "Your week": the latest review, on the
 * logical day it landed and the next, and never otherwise. The read comes off
 * the report row (`narrative_text`), the one copy of it.
 */
export function weeklyCardFor(
  db: Database,
  items: StoredProposal[],
  now: Date = new Date()
): WeeklyCard | null {
  const latest = getWeeklyState(db).latest;
  if (!latest) return null;
  const today = todayISODate(now);
  if (today < latest.day || today > shiftISODate(latest.day, 1)) return null;
  const row = getReport(db, latest.reportId);
  const read =
    row?.narrative_text
      ?.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0) ?? [];
  return {
    reportId: row ? row.id : null,
    rangeLabel: formatRange(latest.weekStart, latest.weekEnd),
    read: read.length > 0 ? read : null,
    drafts: weeklyDrafts(items, latest.weekStart),
  };
}
