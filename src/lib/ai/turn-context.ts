/**
 * The per-turn "Current state" block — a deterministic, on-device synthesis of
 * where the user is right now, injected into every Coach turn as the second
 * (UNCACHED) system block (model-client.ts buildMessagesRequest).
 *
 * This exists so the model never starts a turn blind: readiness, status, mission
 * progress, running experiments, unit preferences, and the daily brief are all
 * already computed for the UI by pure functions — this composes them into a
 * few lines of prompt text. It PERCEIVES and GROUNDS only; it never decides.
 * What to do about a caution morning, a ready experiment, or a protein dip is
 * the model's judgment call, made with these facts plus its tools
 * (docs/coach-intelligence-review.md §4, "Where the intelligence lives").
 *
 * Pure over the {@link Database} interface — headless-tested in
 * db/turn-context.test.mjs. Every number here is arithmetic from the same
 * derivations the app renders (deriveReadiness, generateDailyBrief,
 * listMission, activeExperiments), so the Coach and the screens can never
 * disagree about the facts.
 */
import type { Database } from '@/lib/db/database';
import { shiftISODate, todayISODate } from '@/lib/db/date';
import { recentDeclines } from '@/lib/db/repositories/ai-chat';
import { countActiveMemories, listMemories } from '@/lib/db/repositories/coach-memory';
import { currentTrip, recentTimezoneChange } from '@/lib/db/repositories/day-meta';
import { consolidatedOpenList } from '@/lib/db/repositories/grocery';
import { activeExperiments } from '@/lib/db/repositories/experiments';
import { listMission } from '@/lib/db/repositories/mission';
import {
  openStatuses,
  scheduledStatuses,
  statusDayNumber,
  statusesIn,
} from '@/lib/db/repositories/statuses';
import { getOrCreateUser, getPreferences } from '@/lib/db/repositories/user';
import { pickDailyMetric } from '@/lib/db/repositories/wearables';
import { deriveReadiness } from '@/lib/home/readiness';
import { formatUtcOffset, offsetShift } from '@/lib/timezone/classify';
import { awayDayNumber } from '@/lib/timezone/trips';

import { generateDailyBrief } from './insights';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * How many open grocery lines the block will name before it gives up and points
 * at the tool. Self-limiting on purpose: this line is UNCACHED, so it is billed
 * at full rate on every request of every turn, and a 200-item shop must never
 * become a permanent tax on questions about sleep.
 */
const GROCERY_PROMPT_LIMIT = 30;

/** The weekday name of a YYYY-MM-DD, parsed componentwise (never UTC-shifted). */
function weekdayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? '';
}

/** Whole years between a YYYY-MM-DD birth date and today; null when unset. */
export function ageOn(dateOfBirth: string | null, today: string): number | null {
  if (!dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/**
 * Build the dynamic system block for one turn. Formatting is deliberately
 * plain "Label: fact" lines — stable to test, cheap in tokens, and unambiguous
 * to the model.
 */
export function buildTurnContext(db: Database, now: Date = new Date()): string {
  const today = todayISODate(now);
  const lines: string[] = [`Current date: ${today} (${weekdayOf(today)})`];

  // --- Who (profile + units) — so age/sex-dependent reasoning and every cited
  // unit are right from the first token.
  const user = getOrCreateUser(db);
  const units = getPreferences(db).units;
  const age = ageOn(user.date_of_birth, today);
  const who: string[] = [];
  if (user.biological_sex) who.push(user.biological_sex);
  if (age !== null) who.push(`${age}y`);
  lines.push(
    `User: ${who.length > 0 ? who.join(', ') : 'profile not filled in'} · units: ` +
      `weight ${units.weight}, volume ${units.volume}, length ${units.length}`
  );

  // --- Readiness, derived HERE rather than at its own line below, because the
  // status line one paragraph down has to say how many days it excluded. Only
  // the derivation moves; the lines stay in their order.
  const readiness = deriveReadiness(db, today);

  // --- Status (0061) — printed ONLY when there is one, the Timezone line's
  // economy rather than the `Mode: Normal` the retired system printed on every
  // turn forever.
  //
  // THE FACT, AND NOTHING ELSE. There is no heroFocus here and no tone
  // guidance, because a status has neither: it says what the user told ARC, and
  // what today should become is this turn's own work. That is the whole point
  // of the retirement — `Mode: Sick — Recover: sleep, fluids, rest.` was a
  // sentence a table wrote, handed to the model as if it were an observation.
  //
  // Two clauses the model cannot infer and would otherwise get wrong ride
  // along, and both are about ARC's own arithmetic rather than about the user:
  // which skips stopped counting, and which days stopped voting on what normal
  // looks like. Without the second, a model reads a flat HRV trend across a
  // fortnight of flu and explains it with something that is not true.
  const open = openStatuses(db, today);
  if (open.length > 0) {
    const described = open.map((row) => {
      const day = statusDayNumber(row, today);
      const age = day <= 1 ? 'since today' : `day ${day}`;
      const span = row.end_date === null ? 'open-ended' : `through ${row.end_date}`;
      const by = row.source === 'user' ? 'set by you' : 'set by me';
      // Named only when it is NOT the default, so the ordinary case costs
      // nothing and the exception is the thing that stands out.
      const counts = row.excuses === 1 ? '' : ', skips still count';
      return `${row.label} — ${age}, ${span} (${by}${counts})`;
    });
    let line =
      `Status: ${described.join(' · ')}. ` +
      'Status days leave the readiness baselines; their skips are excused unless marked.';
    if (readiness.excludedStatusDays > 0) {
      line += ` Baselines exclude ${readiness.excludedStatusDays} status day${
        readiness.excludedStatusDays === 1 ? '' : 's'
      }.`;
    }
    // The escalation. Once the baselines have starved, "excluded" is no longer
    // the honest word for what happened to Recovery.
    if (readiness.recoveryPausedByStatus) line += ' No recovery verdict until it ends.';
    lines.push(line);
  } else {
    // THE REVERT CUE, and the reason ending a status is worth a line at all: a
    // status the Coach bounded with update_protocol leaves a protocol version
    // behind, and nothing but this sentence tells it the window has closed.
    const yesterday = shiftISODate(today, -1);
    const justEnded = statusesIn(db, yesterday, yesterday).filter(
      (row) => row.end_date === yesterday
    );
    if (justEnded.length > 0) {
      lines.push(
        `Status: ${justEnded.map((r) => r.label).join(' and ')} ended yesterday — ` +
          'put back what it took out.'
      );
    }
  }
  // A status the Coach scheduled ahead ("I fly out Monday"). Costs nothing on
  // every other day, and without it a later session cannot see its own booking.
  const ahead = scheduledStatuses(db, today);
  if (ahead.length > 0) {
    lines.push(
      `Scheduled: ${ahead
        .map((r) => `${r.label} from ${r.start_date}${r.end_date ? ` through ${r.end_date}` : ''}`)
        .join(' · ')}.`
    );
  }

  // --- Timezone (D4) — ONE line, and only when there is something to say.
  //
  // The model is handed the FACT and nothing else: no "if jet lag then
  // melatonin" ladder, no prescribed change to training load. It sees the
  // readiness pillars right beside this, and it knows what a 9-hour eastbound
  // shift does to a circadian rhythm better than anything ARC could hardcode
  // (the standing rule at the top of this file — it perceives, it never
  // decides). The one clause ARC must add is the baseline note: without it the
  // model reads a flat HRV trend across a trip and explains it with something
  // that is not true.
  //
  // Costs ~20 uncached tokens on the days it appears and zero on every other
  // day, which is most of them. It self-limits twice over: the horizon is
  // TIMEZONE_COACH_HORIZON_DAYS (jet lag's practical span is about a day per
  // hour of shift; past that it is noise on every turn forever), and the fact
  // stays in the record either way, reachable by tools.
  //
  // Two shapes, and NEVER both (0060). A SEAM day prints the shipped line
  // below. An AWAY day — a day strictly inside a derived trip — prints the trip
  // instead, and does so even inside the shipped five-day tail, because it
  // carries the seam fact itself ("left 2026-09-12, 9h east") and the tail would
  // add nothing it does not already say. The tail prints only once the trip has
  // CLOSED. `currentTrip` returns null on a seam day by construction, so the
  // precedence is the data's rather than a rule laid over it.
  //
  // Why the away line may outlast the 5-day horizon: that horizon exists because
  // a SEAM is an event whose relevance decays. An away day is a STANDING STATE —
  // the readiness pillars on this same turn are graded against home days, and a
  // model not told that reads a fortnight of `caution` as a fact about the user,
  // which is the exact misreading the seam line's baseline clause exists to
  // prevent. It also changes every day (day 4 → day 5), so it is not the same
  // sentence re-sent, and it stops the day the trip closes — at 21 days at the
  // outside (TRIP_SETTLE_DAYS), or the day after a Traveling window ends.
  const trip = currentTrip(db, today);
  const tz = trip === null ? recentTimezoneChange(db, today) : null;
  if (trip) {
    lines.push(
      `Timezone: ${formatUtcOffset(trip.offsetMin)} — day ${awayDayNumber(trip, today)} away from ` +
        `${formatUtcOffset(trip.homeOffsetMin)} (left ${trip.startedOn}, ` +
        `${offsetShift(trip.homeOffsetMin, trip.offsetMin)}); ` +
        'readiness baseline is home days only'
    );
  } else if (tz) {
    const when = tz.to_local_date === today ? 'today' : tz.to_local_date;
    lines.push(
      `Timezone: ${formatUtcOffset(tz.to_offset_min)} — changed ${when} from ` +
        `${formatUtcOffset(tz.from_offset_min)} (${offsetShift(tz.from_offset_min, tz.to_offset_min)})` +
        (tz.to_local_date === today || tz.from_local_date === today
          ? "; this day's readings are excluded from baselines"
          : '')
    );
  }

  // --- Readiness — the same derivation Home renders, so the two surfaces can
  // never disagree about the morning's facts. Derived once, above, beside the
  // status line that reports how many days it excluded.
  if (readiness.hasSignal) {
    const pillars = readiness.pillars.map((p) => `${p.label.toLowerCase()} ${p.level}`).join(' · ');
    lines.push(`Readiness: ${readiness.readiness.label} — ${readiness.readiness.detail}`);
    lines.push(`Pillars: ${pillars}`);
  } else {
    lines.push('Readiness: no wearable signal yet');
  }

  // --- Today's actual wearable numbers.
  //
  // These are the single most-asked class of question ("how many steps have I
  // taken today?", "how did I sleep?"), and without them here the model had to
  // spend an ENTIRE extra round-trip on get_metric_series to read a number the
  // app already had on disk — re-sending the ~9k-token prefix to fetch one
  // integer. Measured at first live testing: ~10k tokens to answer "how many
  // steps today".
  //
  // Costs ~35 uncached tokens and removes a round-trip from the cheapest,
  // commonest turns. Only metrics with data for TODAY appear, so a quiet
  // morning adds nothing and the model still knows to reach for a tool.
  const todayFacts: string[] = [];
  const fact = (metricType: string, render: (v: number) => string): void => {
    const point = pickDailyMetric(db, metricType, today);
    if (point) todayFacts.push(render(point.value));
  };
  fact('steps', (v) => `${Math.round(v).toLocaleString('en-US')} steps`);
  fact('active_energy_kcal', (v) => `${Math.round(v)} kcal active`);
  fact(
    'sleep_duration_min',
    (v) => `slept ${Math.floor(v / 60)}h${String(Math.round(v % 60)).padStart(2, '0')}`
  );
  fact('sleep_deep_min', (v) => `${Math.round(v)} min deep`);
  fact('hrv', (v) => `HRV ${Math.round(v)} ms`);
  fact('rhr', (v) => `RHR ${Math.round(v)} bpm`);
  if (todayFacts.length > 0) {
    lines.push(`Today so far: ${todayFacts.join(' · ')}`);
  }

  // --- Mission progress — where the day stands and what is next.
  const mission = listMission(db, today);
  if (mission.length > 0) {
    const done = mission.filter((m) => m.status === 'completed').length;
    const next = mission.find((m) => m.status === 'pending');
    lines.push(
      `Mission: ${done} of ${mission.length} done` +
        (next
          ? ` · next: "${next.title}"${next.scheduledTime ? ` at ${next.scheduledTime}` : ''}`
          : '')
    );
  } else {
    lines.push('Mission: not generated yet today');
  }

  // --- Experiments — a ready readout is the improvement loop waiting on you.
  const experiments = activeExperiments(db, today);
  for (const exp of experiments) {
    // daysLeft counts days AFTER today, so 0 = the final day, still accruing
    // data — phrase it like the app does ("last day"), never "0 days left"
    // (which reads as closed and invites a premature readout).
    const remaining =
      exp.daysLeft === 0
        ? 'last day — window closes tonight'
        : `${exp.daysLeft} day${exp.daysLeft === 1 ? '' : 's'} left`;
    lines.push(
      exp.ready
        ? `Experiment "${exp.title}": window CLOSED (${exp.end_date}) — ready to read out`
        : `Experiment "${exp.title}": running, ${remaining}`
    );
  }

  // --- The deterministic brief — trends, gaps, reminders due today.
  lines.push(`Signals: ${generateDailyBrief(db, now)}`);

  // --- The standing grocery list, names only.
  //
  // Same round-trip economics as "Today so far" above, measured the same way
  // (db/measure-coach-request.mjs). "We need milk" cost the owner two tool
  // calls — get_grocery_list, then add_grocery_items — because the ONLY way to
  // honour the "never re-add an open duplicate" rail was to read the list
  // first. n tool calls means n+1 requests, and every request re-sends the
  // whole 14.6k-token prefix, so that read cost ~$0.008 to learn that milk was
  // not already listed.
  //
  // Names are all the duplicate check needs, so ids and quantities stay out
  // (a v4 UUID costs more tokens than the item it labels). Anything needing an
  // id — checking items off, changing a quantity — still reads the tool, and
  // the label says so rather than letting the model assume this is the whole
  // record.
  //
  // Past GROCERY_PROMPT_LIMIT the block reports the COUNT and sends the model
  // to the tool. A truncated list is worse than no list: the model cannot tell
  // "not shown" from "not on the list", and would confidently re-add a
  // duplicate. Honest about what it does not show, exactly like the memory
  // block below.
  const grocery = consolidatedOpenList(db);
  if (grocery.length === 0) {
    lines.push('Grocery list: empty');
  } else if (grocery.length <= GROCERY_PROMPT_LIMIT) {
    lines.push(
      `Grocery list (${grocery.length} open, names only — get_grocery_list for ids and ` +
        `quantities): ${grocery.map((line) => line.name).join(' · ')}`
    );
  } else {
    lines.push(
      `Grocery list: ${grocery.length} open items, too many to name here — ` +
        `call get_grocery_list before adding or checking off.`
    );
  }

  const sections = [
    `Current state (precomputed on-device from the user's data — trust it for ` +
      `orientation; read tools before citing specifics beyond it):\n` +
      lines.join('\n'),
  ];

  // --- What you know about this user (0028) — the durable half of memory.
  // These outlive every context window; without them the Coach meets Matt
  // again every thread.
  const memories = listMemories(db);
  if (memories.length > 0) {
    // Say when the list is cut short. Settings shows up to 200 memories, so a
    // silent cap meant the user could read a fact on screen and watch the Coach
    // behave as though it had never been told — with nothing anywhere to
    // explain the gap. If it is truncated, the Coach is told so, and told how
    // to reach the rest.
    const total = countActiveMemories(db);
    const hidden = total - memories.length;
    sections.push(
      `What you know about this user (durable memories — say so if one is now wrong, ` +
        `and use "forget" with its id):\n` +
        memories.map((m) => `- [${m.category}] ${m.content} (id: ${m.id})`).join('\n') +
        (hidden > 0
          ? `\n- (${hidden} older ${hidden === 1 ? 'memory is' : 'memories are'} not shown here — ` +
            `use search_history or get_memories if the user refers to something you cannot see)`
          : '')
    );
  }

  // --- Recently declined proposals. Without this the Coach re-proposes what
  // Matt already refused, every time the turn window rolls.
  const declined = recentDeclines(db, { now });
  if (declined.length > 0) {
    sections.push(
      `Recently declined by the user — do not re-propose these unless they bring it up:\n` +
        declined.map((d) => `- ${d}`).join('\n')
    );
  }

  return sections.join('\n\n');
}
