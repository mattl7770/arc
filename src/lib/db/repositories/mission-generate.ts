/**
 * The protocol → mission generator — the seam that turns ARC from a logger into
 * an operating system. The user's ACTIVE protocols' live versions ARE the plan;
 * this expands them into the day's `log_entries` (the mission Home renders and
 * the Coach reads via get_today_snapshot).
 *
 * Design:
 *  - A protocol's live version is ORDERED PHASES of items; the phase live on
 *    `date` is picked from `protocols.started_on` (0043, see
 *    src/lib/protocols/phase.ts). A protocol past its last bounded phase has
 *    ENDED and generates nothing.
 *  - Each item of that phase becomes one log_entry **if its CADENCE puts it on
 *    this day** — daily, specific weekdays, every N days, or an N-per-week
 *    flexible quota. `type` is mapped from the protocol's type, and the row is
 *    linked back to its source via `protocol_id` (ON DELETE SET NULL — deleting
 *    a protocol never destroys the day's execution history) and to the ITEM via
 *    `value.item`, which is what quota counting joins on. The dose rides the
 *    mission `dose`, the notes ride `why`, the protocol name rides `protocol`.
 *  - Idempotent per day: it does nothing if the day already has planned entries,
 *    so it is safe to call on every open. Committing today's plan once is what
 *    makes the day stable; a protocol edit is applied to today deliberately, by
 *    re-deriving (see {@link rederiveMissionForDay}), which preserves work.
 *  - Only ACTIVE protocols with a live version contribute; a paused or
 *    version-less protocol is skipped.
 *
 * Pure over the {@link Database} interface (never op-sqlite), so it runs on
 * device and against node:sqlite in db/mission-generate.test.mjs.
 */
import type { Database } from '../database';
import { newId } from '../id';
import type { LogEntryType, ProtocolType } from '../types';
import { cadenceLandsOn, weekStart } from '@/lib/protocols/cadence';
import { parseProtocolContent } from '@/lib/protocols/content';
import { phaseOn } from '@/lib/protocols/phase';
import type { ProtocolItem } from '@/lib/protocols/types';
import { getModeDefinition, type ModeItem, type ModeKey } from '@/lib/modes/registry';

import { getActiveMode } from './day-modes';
import { experimentsRunningOn } from './experiments';
import {
  countMissionEntries,
  getOrCreateDailyLog,
  NOT_REMOVED_SQL,
  PLANNED_ROW_SQL,
} from './mission';
import { ensureStartedOn, getCurrentVersion, listProtocols } from './protocols';

/** How each protocol kind lands as a mission entry type (log_entries CHECK). */
const LOG_TYPE_BY_PROTOCOL: Record<ProtocolType, LogEntryType> = {
  daily_routine: 'habit',
  supplement_stack: 'supplement',
  meal_template: 'meal',
  training_block: 'workout',
  therapy_protocol: 'therapy',
  sleep_protocol: 'habit',
  other: 'habit',
};

/**
 * The value-json a generated entry carries. `generated: true` distinguishes it
 * from a mock `seed: true` row and from an ad-hoc Log-tab capture (`adhoc`);
 * `protocol`, `category` + `why` are read back by `toMissionItem` for the
 * mission UI.
 *
 * `protocol` and `category` are the two ways a row says where it came from, and
 * they are deliberately exclusive:
 *
 *   - a PROTOCOL item sets `protocol` and lets `category` fall back to
 *     CATEGORY_BY_TYPE, so the row reads "TRAINING · STRENGTH BLOCK";
 *   - a MODE item sets `category` to the mode's label and no `protocol`, so the
 *     row reads "SICK" — one attribution, not "ROUTINE · SICK", which is what
 *     the earlier `protocol: def.label` produced. A mode is not a protocol and
 *     should not be dressed as one; naming the mode in the category slot also
 *     puts it in the hero's tag line ("Sick · Do this next").
 */
type GeneratedExtras = {
  protocol?: string;
  category?: string;
  /**
   * The quantity — `5g`, `400 mg`. Mono, and it joins the hero's dimension
   * figure beside the time. Kept apart from `why` because they are different
   * facts in different type voices; see the note on `MissionExtras` in
   * ./mission.ts for what went wrong while they shared one field.
   */
  dose?: string;
  /** Rationale prose. Serif italic. Never a quantity — that is `dose`. */
  why?: string;
  generated: true;
  /**
   * The `ProtocolItem.id` this row came from. Present on protocol items only.
   *
   * It is what makes an N-per-week QUOTA countable: "how many times has this
   * item been done this week" has to join on the item's IDENTITY, not on its
   * title, because a title is editable and a retitled item would restart its
   * own quota mid-week. `protocol_id` alone is not enough either — a stack has
   * many items and they hold separate quotas.
   */
  item?: string;
  /** Present on mode-injected items, absent on protocol items. */
  mode?: ModeKey;
  /** Present on a running experiment's intervention row (its experiment id). */
  experiment?: string;
};

/** Insert one generated mission entry; returns nothing, bumps the caller's count. */
function insertGenerated(
  db: Database,
  logId: string,
  args: {
    type: LogEntryType;
    protocolId: string | null;
    title: string;
    scheduledTime: string | null;
    extras: GeneratedExtras;
  }
): void {
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, protocol_id, title, status, scheduled_time, value, source)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'manual')`,
    [
      newId(db),
      logId,
      args.type,
      args.protocolId,
      args.title,
      args.scheduledTime,
      JSON.stringify(args.extras),
    ]
  );
}

/** One entry the day's plan calls for, before it exists as a row. */
type PlannedEntry = {
  type: LogEntryType;
  protocolId: string | null;
  title: string;
  scheduledTime: string | null;
  extras: GeneratedExtras;
};

/**
 * Identity of one quota-bearing item: its protocol AND its item id, because a
 * stack's items each hold their own quota. Same `\u0000` join as {@link planKey}
 * — written as an ESCAPE, never as a literal NUL byte in the source, which is a
 * mistake this file has had to have cleaned out of it before.
 */
const quotaKey = (protocolId: string | null, itemId: string): string =>
  `${protocolId ?? '-'}\u0000${itemId}`;

/**
 * How many times each protocol item has been COMPLETED so far in the calendar
 * week containing `date`, counting days strictly BEFORE `date`.
 *
 * Three deliberate choices:
 *   - **completed only.** A skip does not consume quota — that is the point of
 *     a flexible quota, and the owner said so in as many words. Neither does a
 *     `partial`: real progress, but not the session.
 *   - **before `date`, not up to and including it.** A row already standing on
 *     `date` is preserved by the re-derive whatever this says, so counting it
 *     would let a completed item be judged "quota met" and removed from its own
 *     day.
 *   - **the two shared mission predicates**, so "a planned row" means exactly
 *     what it means everywhere else (mission.ts owns both constants).
 *
 * One query per day, not one per item.
 */
function quotaCompletionsThisWeek(db: Database, date: string): Map<string, number> {
  const rows = db.all<{ protocolId: string | null; item: string | null; done: number }>(
    `SELECT e.protocol_id AS protocolId,
            json_extract(e.value, '$.item') AS item,
            count(*) AS done
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date >= ? AND d.date < ?
        AND e.status = 'completed'
        AND json_extract(e.value, '$.item') IS NOT NULL
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      GROUP BY e.protocol_id, json_extract(e.value, '$.item')`,
    [weekStart(date), date]
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.item === null) continue;
    counts.set(quotaKey(row.protocolId, row.item), row.done);
  }
  return counts;
}

/**
 * Whether an item's cadence puts it on `date`. Everything except a quota is
 * decided by pure arithmetic in src/lib/protocols/cadence.ts; a quota needs the
 * week's completions, which is why this one lives here.
 *
 * A quota item lands on EVERY remaining day of the week until its quota is met,
 * then stops appearing — which also means that if the days left equal the quota
 * left, it is on every one of them. That is the whole behaviour: ARC surfaces
 * it, the user picks the days.
 */
function landsOn(
  item: ProtocolItem,
  date: string,
  dayInPhase: number,
  protocolId: string,
  quotaDone: Map<string, number>
): boolean {
  const pure = cadenceLandsOn(item.cadence, date, dayInPhase);
  if (pure !== null) return pure;
  const done = quotaDone.get(quotaKey(protocolId, item.id)) ?? 0;
  return item.cadence.kind === 'quota' ? done < item.cadence.per_week : true;
}

/**
 * What `date` SHOULD contain under its currently-active mode: every active
 * protocol's live PHASE's items whose CADENCE lands on this day, MINUS the
 * types the mode drops, PLUS the mode's own standard items. Pure computation —
 * reads, never writes — so the first generation and the mid-day re-derive share
 * ONE definition of the day's plan and can't drift.
 */
function planForDay(db: Database, date: string): PlannedEntry[] {
  const def = getModeDefinition(getActiveMode(db, date));
  const active = listProtocols(db).filter((p) => p.isActive && p.versionNumber !== null);
  const plan: PlannedEntry[] = [];
  const quotaDone = quotaCompletionsThisWeek(db, date);

  for (const protocol of active) {
    const type = LOG_TYPE_BY_PROTOCOL[protocol.type];
    // Mode can pull a whole protocol type for the day (e.g. Sick drops workouts).
    if (def.dropTypes.includes(type)) continue;
    const content = parseProtocolContent(getCurrentVersion(db, protocol.id)?.content ?? null);
    // A NULL anchor is read as "starts today" — the same reading ensureStartedOn
    // then makes permanent. Doing it here as well keeps planForDay a pure
    // function of the database it is handed, so a caller that skipped the
    // anchoring step still gets phase 1 rather than a crash or an ended protocol.
    const state = phaseOn(content, protocol.startedOn ?? date, date);
    if (state.kind !== 'running') continue; // ended, or not started yet
    const { phase, dayInPhase } = state.window;
    for (const item of phase.items) {
      if (!landsOn(item, date, dayInPhase, protocol.id, quotaDone)) continue;
      // Carried apart, not flattened. `dose ?? notes` threw away which one this
      // was one line before the hero had to know, and the hero guessed it back
      // from the string's shape.
      const dose = item.dose ?? undefined;
      const why = item.notes ?? undefined;
      plan.push({
        type,
        protocolId: protocol.id,
        title: item.title,
        scheduledTime: item.scheduled_time ?? null,
        extras: {
          protocol: protocol.name,
          ...(dose ? { dose } : {}),
          ...(why ? { why } : {}),
          generated: true,
          item: item.id,
        },
      });
    }
  }
  // Mode-injected standard items, tagged with the mode so they're
  // distinguishable from protocol items and the mock seed.
  //
  // Their `scheduledTime` is REQUIRED by ModeItem and is load-bearing, not
  // decoration: the mission is one chronological list, and
  // src/lib/home/derive-mission.ts sorts an untimed item to MAX_SAFE_INTEGER.
  // When these carried no time they sank beneath every protocol item, so Sick's
  // "Rest — no training today" rendered at the BOTTOM of the day and the hero
  // still led with a protocol item — the mode changed the list without changing
  // the day. Timed, the 07:00 leads beat anything a protocol schedules and the
  // mode takes the hero slot, with no surface needing to special-case it.
  for (const item of def.addItems as ModeItem[]) {
    plan.push({
      type: item.type,
      protocolId: null,
      title: item.title,
      scheduledTime: item.scheduledTime,
      extras: {
        category: def.label,
        ...(item.why ? { why: item.why } : {}),
        generated: true,
        mode: def.key,
      },
    });
  }

  // A RUNNING experiment's intervention belongs on the day it is being tested.
  //
  // Without this the loop had a dead middle: the Coach could design an
  // experiment and read it out, but nothing between — the intervention never
  // appeared on the mission, so there was no adherence signal at all and the
  // readout could not tell "it didn't work" from "he didn't do it". As a
  // mission row it is visible, checkable, and skippable like anything else,
  // and the re-derive diff handles it for free.
  //
  // `experimentsRunningOn`, NOT `activeExperiments`: an experiment stays
  // `active` until it is concluded, so the latter includes ones that haven't
  // started and ones whose window closed days ago. Both would put a task on the
  // mission the user has no reason to do — and post-window adherence data
  // silently corrupts the very readout the row exists to feed.
  //
  // `category`, not `protocol`, by the exclusivity rule above: an experiment is
  // no more a protocol than a mode is, and one attribution reads better than
  // "ROUTINE · EXPERIMENT". It stays UNTIMED — unlike a mode's 07:00 lead, an
  // intervention has no natural hour, and inventing one to win the hero slot
  // would be a lie about the plan. The cost is that it sorts late in the day.
  for (const experiment of experimentsRunningOn(db, date)) {
    plan.push({
      type: 'habit',
      protocolId: null,
      title: experiment.intervention,
      scheduledTime: null,
      extras: {
        category: `Experiment · ${experiment.title}`,
        why: `Day ${dayNumberOf(experiment.start_date, date)} of this experiment`,
        generated: true,
        experiment: experiment.id,
      },
    });
  }
  return plan;
}

/** 1-based day number of `date` within an experiment that began `startDate`. */
function dayNumberOf(startDate: string, date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/**
 * Generate `date`'s mission from the active protocols' live versions, ADAPTED to
 * the day's mode (docs/information-architecture.md §Modes). The active mode
 * DROPS generated items whose type it excludes (Sick pulls training) and ADDS
 * its own standard items (Sick adds rest / fluids / immune support). Returns the
 * number of entries created — **0** when the day already has planned entries
 * (the idempotency guard) OR when there is nothing to generate (no active
 * protocols AND the mode injects nothing).
 *
 * A day already generated stays committed here; changing the mode mid-day
 * re-shapes it through {@link rederiveMissionForDay} instead, which preserves
 * work already done.
 */
export function generateMissionForDay(db: Database, date: string): number {
  const log = getOrCreateDailyLog(db, date);
  if (countMissionEntries(db, log.id) > 0) return 0;

  // Anchor any active protocol whose phase clock has never been set, BEFORE
  // reading the plan: the first day a protocol plans something is day 0 of its
  // phase 1, and stamping it here is what makes that permanent. Outside
  // planForDay deliberately — that stays a pure read.
  ensureStartedOn(db, date);
  const plan = planForDay(db, date);
  if (plan.length === 0) return 0;

  db.transaction(() => {
    for (const entry of plan) insertGenerated(db, log.id, entry);
  });
  return plan.length;
}

export type RederiveResult = {
  mode: ModeKey;
  /** New plan entries inserted (mode items, newly-applicable protocol items). */
  added: number;
  /** Untouched pending generated/seed rows the new mode no longer wants. */
  removed: number;
  /** Replaceable rows that still match the new plan, left in place (same id). */
  kept: number;
  /** Rows protected because the user acted on them, or they weren't machine-made. */
  preserved: number;
};

/** Identity of a plan entry for diffing: the same title under the same protocol. */
const planKey = (title: string, protocolId: string | null): string =>
  `${protocolId ?? '-'}\u0000${title}`;

/**
 * Re-shape `date`'s ALREADY-GENERATED mission to its currently-active mode
 * WITHOUT destroying work (docs/information-architecture.md §Modes — "setting it
 * visibly re-derives the mission").
 *
 * This is a DIFF, never a wipe-and-regenerate: it removes only untouched
 * `pending` machine-made rows the new plan no longer calls for, inserts the
 * entries the new plan adds, and leaves matching rows in place by id (so their
 * status and history survive). Explicitly PRESERVED:
 *   - anything the user acted on — `completed`, `skipped`, or `partial`. Note
 *     `partial` is real progress, which is why the guard is `status = 'pending'`
 *     and NOT `!isSettled` (derive-mission treats partial as unsettled);
 *   - ad-hoc Log-tab captures ({@link PLANNED_ROW_SQL} excludes them from every
 *     query here — omitting it would delete the user's notes/metrics);
 *   - **mock seed rows** (`seed: true`) except when the mode drops their whole
 *     TYPE. `planForDay` knows only about protocols + mode items, so a row it
 *     doesn't recognise is NOT evidence the row is unwanted — treating the seed
 *     as ours deleted the entire first-run mission on any mode change, with
 *     nothing to put it back (found by adversarial review, reproduced);
 *   - any other planned row that isn't `generated` (a future hand-added item).
 *
 * Matching is a MULTISET on (title, protocol): a protocol may list the same
 * title twice (two doses), and collapsing those to one key silently destroyed
 * the second, permanently.
 *
 * Safe to call repeatedly — a second call with no mode change is a no-op. On a
 * day with no planned rows yet it delegates to {@link generateMissionForDay}.
 *
 * This reads each protocol's LIVE version, which is now the POINT rather than a
 * caveat: **a protocol edit applies to today's mission immediately** (owner
 * call, 2026-08-25), and it applies through exactly this machinery, so an edit
 * and a mode change are one mechanism. Pending machine-made rows only; anything
 * completed, skipped, partial or ad-hoc is preserved untouched. An item whose
 * quota is already met today is therefore not re-added, and an item the edit
 * removed does not take its completed row with it.
 */
export function rederiveMissionForDay(db: Database, date: string): RederiveResult {
  const log = getOrCreateDailyLog(db, date);
  const mode = getActiveMode(db, date);
  // Same anchoring as the first generation — a protocol activated today and
  // edited an hour later must not be read as never having started.
  ensureStartedOn(db, date);

  type Row = {
    id: string;
    title: string;
    protocol_id: string | null;
    type: LogEntryType;
    status: string;
    value: string | null;
  };
  const rows = db.all<Row>(
    `SELECT id, title, protocol_id, type, status, value FROM log_entries
     WHERE daily_log_id = ? AND ${PLANNED_ROW_SQL}`,
    [log.id]
  );

  // Nothing planned yet → this is a first generation, not a re-derive.
  if (rows.length === 0) {
    return { mode, added: generateMissionForDay(db, date), removed: 0, kept: 0, preserved: 0 };
  }

  const def = getModeDefinition(mode);
  const plan = planForDay(db, date);

  // Classify every planned row. The re-derive OWNS only what it generated:
  // `planForDay` knows about protocols + mode items and nothing else, so a row
  // it doesn't recognise is not evidence the row is unwanted. The mock seed
  // (`seed: true`, planted by ensureTodaySeeded on a protocol-less first run) is
  // exactly such a row — treating it as ours would delete the entire first-run
  // mission on any mode change and nothing would ever put it back.
  const replaceable: Row[] = [];
  const preservedRows: Row[] = [];
  for (const row of rows) {
    let extras: { generated?: boolean; seed?: boolean } = {};
    try {
      extras = row.value ? (JSON.parse(row.value) as typeof extras) : {};
    } catch {
      extras = {}; // unparseable value → treat as hand-made, i.e. preserve it
    }
    if (row.status !== 'pending') {
      preservedRows.push(row); // acted on: completed / skipped / partial
    } else if (extras.generated === true) {
      replaceable.push(row); // ours — the plan decides whether it stays
    } else if (extras.seed === true && def.dropTypes.includes(row.type)) {
      // A mock row whose whole TYPE the mode pulls (Sick drops training) is the
      // one seed case worth removing — the mode is explicit about that type.
      replaceable.push(row);
    } else {
      preservedRows.push(row); // seed the mode doesn't touch, or hand-added
    }
  }

  // Match as a MULTISET, not a set: a protocol may legitimately list the same
  // title twice (two doses at different times). Keying by title alone and
  // collapsing would silently drop the second dose — permanently, since the
  // filter below would then also refuse to re-add it.
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const need = new Map<string, number>();
  for (const p of plan) bump(need, planKey(p.title, p.protocolId));
  // Preserved rows already satisfy their plan entry, so a completed item is
  // never re-inserted as a duplicate pending row. ALL of them count, including
  // pending-but-not-ours ones (a set keyed only on settled rows would let a
  // preserved pending row be duplicated by its matching plan entry).
  const have = new Map<string, number>();
  for (const row of preservedRows) bump(have, planKey(row.title, row.protocol_id));

  const toRemove: string[] = [];
  for (const row of replaceable) {
    const key = planKey(row.title, row.protocol_id);
    if ((have.get(key) ?? 0) < (need.get(key) ?? 0))
      bump(have, key); // still wanted → keep
    else toRemove.push(row.id);
  }

  const remaining = new Map(have);
  const toAdd = plan.filter((p) => {
    const key = planKey(p.title, p.protocolId);
    const n = remaining.get(key) ?? 0;
    if (n > 0) {
      remaining.set(key, n - 1);
      return false;
    }
    return true;
  });

  const kept = replaceable.length - toRemove.length;
  if (toRemove.length === 0 && toAdd.length === 0) {
    return { mode, added: 0, removed: 0, kept, preserved: preservedRows.length };
  }

  db.transaction(() => {
    if (toRemove.length > 0) {
      const placeholders = toRemove.map(() => '?').join(', ');
      // The id list is already correct; these extra predicates are defence in
      // depth on a DESTRUCTIVE statement — it must never be able to reach an
      // ad-hoc capture, an acted-on row, or another day, even by a bad id.
      db.run(
        `DELETE FROM log_entries
         WHERE id IN (${placeholders}) AND daily_log_id = ?
           AND status = 'pending' AND ${PLANNED_ROW_SQL}`,
        [...toRemove, log.id]
      );
    }
    for (const entry of toAdd) insertGenerated(db, log.id, entry);
  });

  return {
    mode,
    added: toAdd.length,
    removed: toRemove.length,
    kept,
    preserved: preservedRows.length,
  };
}
