/**
 * The per-turn "Current state" block — a deterministic, on-device synthesis of
 * where the user is right now, injected into every Coach turn as the second
 * (UNCACHED) system block (model-client.ts buildMessagesRequest).
 *
 * This exists so the model never starts a turn blind: readiness, mode, mission
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
import { todayISODate } from '@/lib/db/date';
import { recentDeclines } from '@/lib/db/repositories/ai-chat';
import { countActiveMemories, listMemories } from '@/lib/db/repositories/coach-memory';
import { getActiveMode } from '@/lib/db/repositories/day-modes';
import { consolidatedOpenList } from '@/lib/db/repositories/grocery';
import { activeExperiments } from '@/lib/db/repositories/experiments';
import { listMission } from '@/lib/db/repositories/mission';
import { getOrCreateUser, getPreferences } from '@/lib/db/repositories/user';
import { pickDailyMetric } from '@/lib/db/repositories/wearables';
import { deriveReadiness } from '@/lib/home/readiness';
import { getModeDefinition } from '@/lib/modes/registry';

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

  // --- Mode — tone/plan context before the first word is generated.
  const mode = getActiveMode(db, today);
  const modeDef = getModeDefinition(mode);
  lines.push(
    mode === 'normal'
      ? 'Mode: Normal'
      : `Mode: ${modeDef.label}${modeDef.heroFocus ? ` — ${modeDef.heroFocus}` : ''}` +
          `${modeDef.excusesSkips ? ' (skipped items are excused today)' : ''}`
  );

  // --- Readiness — the same derivation Home renders, so the two surfaces can
  // never disagree about the morning's facts.
  const readiness = deriveReadiness(db, today);
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
