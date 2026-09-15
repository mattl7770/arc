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
import type { CheckoffMode, LogEntryType, ProtocolType } from '../types';
import { addDays, cadenceLandsOn, daysBetween, weekStart } from '@/lib/protocols/cadence';
import { parseProtocolContent } from '@/lib/protocols/content';
import { phaseOn } from '@/lib/protocols/phase';
import type { ProtocolItem } from '@/lib/protocols/types';
import { getModeDefinition, type ModeItem, type ModeKey } from '@/lib/modes/registry';

import { activeModesIn, getActiveMode } from './day-modes';
import { experimentsRunningOn } from './experiments';
import {
  countMissionEntries,
  getOrCreateDailyLog,
  modeExcusesSkips,
  NOT_CARRIED_SQL,
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
  /**
   * This item asks the OS for a notification at its `scheduled_time` (C10).
   * Stamped on the ROW so the notification layer can read one uniform shape —
   * today's committed rows and a future day's computed plan entries alike —
   * instead of re-opening each protocol's live content to ask.
   */
  remind?: true;
  /**
   * ── The carry marks (0050) ───────────────────────────────────────────────
   * `carried` is the predicate flag {@link NOT_CARRIED_SQL} keys on, and it is
   * what holds this row out of every adherence denominator.
   */
  carried?: true;
  /** The day and row id this debt is owed from. */
  carried_from?: { date: string; entry: string };
  /** 1 on the first carry, 2 on the second … — what the row prints. */
  carried_days?: number;
  /**
   * On a NATIVE row whose own cadence superseded outstanding debts: how many
   * earlier days of this item are still untouched. Informational only — it
   * settles nothing, because completing today is not doing Monday.
   */
  missed_days?: number;
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

/**
 * One entry the day's plan calls for, before it exists as a row.
 *
 * Exported because {@link planForDay} is — the notification scheduler asks it
 * what a FUTURE day would contain, without committing anything, so that an
 * item's reminder can be set for its next occurrence rather than only for today
 * (src/lib/notifications/protocol-reminders.ts).
 */
export type PlannedEntry = {
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
 * How long a debt lives past the day it was missed (0050).
 *
 * The supersede rule already caps most cadences at the item's next occurrence,
 * so this only bites on items whose next occurrence is far away — a fortnightly
 * therapy, a Monday-only session. Seven days is the owner's call: an unbounded
 * carry is the failure mode of every task application, and a protocol item you
 * have not done in a week is a fact about the PROTOCOL, which is what
 * app/mission-history.tsx's "Where it's failing" already answers.
 *
 * The cap is enforced in ONE place — the window {@link outstandingCarries}
 * reads over — and deliberately writes nothing. Settling the aged-out original
 * as `skipped` was considered and rejected: an untouched row is already an
 * honest record of a miss (every adherence read counts it as one), and
 * rewriting week-old history on every app open to add an annotation no surface
 * needs is the worse trade. Out of the window simply means out of the window.
 */
export const CARRY_MAX_DAYS = 7;

/** One item's outstanding debt, as of a given day. */
type CarryDebt = {
  /** The MOST RECENT untouched day — what the carry's age counts from. */
  missedOn: string;
  /** That day's row id, so the carried row can name where it is owed from. */
  entryId: string;
  /** How many earlier days of this item are outstanding inside the window. */
  misses: number;
};

/**
 * Every protocol item with an untouched earlier day inside the carry window,
 * keyed like the quota count so the two can be read side by side.
 *
 * One query for the whole day, not one per item — the same shape
 * {@link quotaCompletionsThisWeek} settles on, and the reason the carry can sit
 * inside `planForDay` without turning it into an N+1.
 *
 * What counts as a debt, and each exclusion's reason:
 *
 *   - **`status = 'pending'` only.** A hand-tapped skip is a DECISION not to do
 *     it; re-levying it tomorrow would make the skip button meaningless, and it
 *     gives the user an explicit "not this one" gesture that needs no new
 *     control. A `partial` is real progress and is not re-offered whole either.
 *   - **Not an excused day.** `modeExcusesSkips` says a miss under Sick /
 *     Travel / Social was the right call; carrying it would re-levy a debt the
 *     mode just forgave and make Travel mode produce a pile of work waiting on
 *     the day you get home — exactly the nag the mode exists to prevent.
 *   - **Not itself carried** ({@link NOT_CARRIED_SQL}). The debt is always the
 *     ORIGINAL day; an untouched carried copy is a second view of the same
 *     obligation, and counting it would let one miss breed.
 *   - **Protocol rows only** (`protocol_id` and `value.item` both present). A
 *     mode item and an experiment's intervention belong to their day.
 *   - The two standing predicates, so "a planned row" means what it means
 *     everywhere else.
 *
 * `late_on` rows are excluded for free: settling a debt flips the original to
 * `skipped`.
 */
function outstandingCarries(db: Database, date: string): Map<string, CarryDebt> {
  const from = addDays(date, -CARRY_MAX_DAYS);
  // Resolved once in JS from the registry rather than restated in SQL, exactly
  // as missionBySource does it, so the excusal rule has one definition. `'0'` —
  // a false literal — covers the ordinary case of no excusing day in the
  // window; the list is bounded by CARRY_MAX_DAYS.
  const excusedDates = [...activeModesIn(db, from, addDays(date, -1))]
    .filter(([, mode]) => modeExcusesSkips(mode))
    .map(([day]) => day);
  const isExcusedDay =
    excusedDates.length > 0 ? `d.date IN (${excusedDates.map(() => '?').join(', ')})` : '0';

  const rows = db.all<{ id: string; protocolId: string; item: string; date: string }>(
    `SELECT e.id AS id,
            e.protocol_id AS protocolId,
            json_extract(e.value, '$.item') AS item,
            d.date AS date
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date >= ? AND d.date < ?
        AND e.status = 'pending'
        AND e.protocol_id IS NOT NULL
        AND json_extract(e.value, '$.item') IS NOT NULL
        AND NOT (${isExcusedDay})
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
        AND ${NOT_CARRIED_SQL}
      ORDER BY d.date`,
    [from, date, ...excusedDates]
  );

  const debts = new Map<string, CarryDebt>();
  for (const row of rows) {
    const key = quotaKey(row.protocolId, row.item);
    const seen = debts.get(key);
    // Rows arrive oldest-first, so the last one wins the anchor: the carry ages
    // from the MOST RECENT miss. Anchoring on the oldest would leave a stale
    // debt shadowing a fresher one that the user can actually still act on.
    debts.set(key, {
      missedOn: row.date,
      entryId: row.id,
      misses: (seen?.misses ?? 0) + 1,
    });
  }
  return debts;
}

/**
 * The most recent day each protocol item was COMPLETED, strictly before `date`
 * — the clock `checkoff_mode = 'adjusting'` re-bases `every_n_days` on.
 *
 * **Carried completions count**, which is the entire point: a debt paid late
 * IS the item's last completion, so under `adjusting` a late completion moves
 * the next occurrence and under `strict` it does not. That is the one place the
 * two toggles meet, and it is why {@link NOT_CARRIED_SQL} is deliberately
 * absent here — this asks what was DONE, not what was owed.
 *
 * **Strictly before `date`**, like the quota count and for the same reason: a
 * row already standing on `date` is preserved by the re-derive whatever this
 * says, so counting today's completion would compute the next occurrence as
 * `today + n` and have the plan remove the item from its own day.
 */
function lastCompletions(db: Database, date: string): Map<string, string> {
  const rows = db.all<{ protocolId: string; item: string; last: string }>(
    `SELECT e.protocol_id AS protocolId,
            json_extract(e.value, '$.item') AS item,
            max(d.date) AS last
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date < ?
        AND e.status = 'completed'
        AND e.protocol_id IS NOT NULL
        AND json_extract(e.value, '$.item') IS NOT NULL
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      GROUP BY e.protocol_id, json_extract(e.value, '$.item')`,
    [date]
  );
  const last = new Map<string, string>();
  for (const row of rows) last.set(quotaKey(row.protocolId, row.item), row.last);
  return last;
}

/**
 * Whether an item's cadence puts it on `date`. Everything except a quota — and,
 * under `adjusting`, an every-N-days item that has been completed at least once
 * — is decided by pure arithmetic in src/lib/protocols/cadence.ts; the two
 * exceptions need facts about `log_entries`, which is why they live here.
 *
 * A quota item lands on EVERY remaining day of the week until its quota is met,
 * then stops appearing — which also means that if the days left equal the quota
 * left, it is on every one of them. That is the whole behaviour: ARC surfaces
 * it, the user picks the days.
 *
 * `adjusting` re-reads `every_n_days` as *n days after the last completion*,
 * falling back to the phase clock when there has never been one — so an item
 * never completed behaves exactly as `strict` does, and nothing about
 * `protocols.started_on` or phase day 0 is touched (the invariant, pinned by a
 * test). It is deliberately a no-op for the other three kinds: `daily` has
 * n = 1, a weekday list is a calendar statement rather than an interval, and a
 * quota is already anchored to the calendar week.
 */
function landsOn(
  item: ProtocolItem,
  date: string,
  dayInPhase: number,
  protocolId: string,
  quotaDone: Map<string, number>,
  checkoffMode: CheckoffMode,
  lastDone: Map<string, string>
): boolean {
  if (checkoffMode === 'adjusting' && item.cadence.kind === 'every_n_days') {
    const last = lastDone.get(quotaKey(protocolId, item.id));
    if (last !== undefined) {
      const since = daysBetween(last, date);
      return since > 0 && since % item.cadence.n === 0;
    }
  }
  const pure = cadenceLandsOn(item.cadence, date, dayInPhase);
  if (pure !== null) return pure;
  const done = quotaDone.get(quotaKey(protocolId, item.id)) ?? 0;
  return item.cadence.kind === 'quota' ? done < item.cadence.per_week : true;
}

/**
 * What `date` SHOULD contain under its currently-active mode: every active
 * protocol's live PHASE's items whose CADENCE lands on this day, MINUS the
 * types the mode drops, PLUS the mode's own standard items, PLUS anything a
 * carry-over protocol still owes from an earlier day. Pure computation — reads,
 * never writes — so the first generation and the mid-day re-derive share ONE
 * definition of the day's plan and can't drift.
 *
 * ## The carry is a FOURTH SOURCE here and nowhere else (0050)
 *
 * That placement is the most important structural call in the feature. This
 * function is the one definition of "what this day should contain"; the first
 * generation and the re-derive both read it; a carry computed anywhere else
 * would drift from it inside a release. Everything the carry has to respect
 * then falls out for free rather than needing a rule of its own:
 *
 *   - **the phase boundary** — the loop below only ever sees the LIVE phase's
 *     items, so a debt from phase 1 cannot be carried into phase 2 (which asks
 *     for a different dose);
 *   - **a paused, ended, not-yet-started or version-less protocol** — filtered
 *     above, and its debts with it;
 *   - **a mode that drops the whole type** — `def.dropTypes` is checked before
 *     any of this;
 *   - **an item deleted in an edit** — the carried row is `generated` and
 *     `pending`, so the re-derive classifies it as replaceable and removes it.
 *
 * ## The supersede rule, stated once
 *
 * > **A carried item is dropped the moment its own cadence puts the item on
 * > that day.** A debt and its own recurrence are one obligation, and two rows
 * > for one obligation is the multiset-collision bug arriving through a new
 * > door.
 *
 * It is written below as one `if (lands)` / `else` and each cadence falls out
 * of it with no special case: `daily` lands every day, so it can never grow a
 * second row and instead marks today's own row with what is outstanding;
 * `weekdays` and `every_n_days` carry until the cap or their next occurrence,
 * whichever is sooner; `quota` never carries, because the quota already IS the
 * carry (`landsOn` puts it on every remaining day of the week until it is met)
 * and a second row would let `quotaCompletionsThisWeek` count one week's
 * session twice.
 */
export function planForDay(db: Database, date: string): PlannedEntry[] {
  const def = getModeDefinition(getActiveMode(db, date));
  const active = listProtocols(db).filter((p) => p.isActive && p.versionNumber !== null);
  const plan: PlannedEntry[] = [];
  const quotaDone = quotaCompletionsThisWeek(db, date);
  // Both are one query for the whole day, read only when a protocol on the
  // device actually asks for them — the default of every protocol is
  // `carry_over = 0, checkoff_mode = 'strict'`, which is a database with
  // neither behaviour and therefore neither query.
  const wantsCarry = active.some((p) => p.carryOver);
  const wantsAdjusting = active.some((p) => p.checkoffMode === 'adjusting');
  const carries = wantsCarry ? outstandingCarries(db, date) : new Map<string, CarryDebt>();
  const lastDone = wantsAdjusting ? lastCompletions(db, date) : new Map<string, string>();

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
      const lands = landsOn(
        item,
        date,
        dayInPhase,
        protocol.id,
        quotaDone,
        protocol.checkoffMode,
        lastDone
      );
      // A quota is its own carry mechanism, so it is excluded here rather than
      // inside the branch below: it must neither grow a carried row nor wear a
      // "missed" mark for days it deliberately left open.
      const debt =
        protocol.carryOver && item.cadence.kind !== 'quota'
          ? carries.get(quotaKey(protocol.id, item.id))
          : undefined;
      if (!lands && debt === undefined) continue;
      // Carried apart, not flattened. `dose ?? notes` threw away which one this
      // was one line before the hero had to know, and the hero guessed it back
      // from the string's shape.
      const dose = item.dose ?? undefined;
      const why = item.notes ?? undefined;
      const base: GeneratedExtras = {
        protocol: protocol.name,
        ...(dose ? { dose } : {}),
        ...(why ? { why } : {}),
        generated: true,
        item: item.id,
        ...(item.remind && item.scheduled_time ? ({ remind: true } as const) : {}),
      };
      plan.push({
        type,
        protocolId: protocol.id,
        title: item.title,
        scheduledTime: item.scheduled_time ?? null,
        extras: lands
          ? // Today's own occurrence. It SUPERSEDES the debt — one obligation,
            // one row — and merely says what is still outstanding behind it.
            // Completing it settles nothing earlier: you did not take Monday's
            // magnesium by taking Tuesday's.
            { ...base, ...(debt ? { missed_days: debt.misses } : {}) }
          : {
              ...base,
              carried: true,
              carried_from: { date: debt!.missedOn, entry: debt!.entryId },
              carried_days: Math.max(1, daysBetween(debt!.missedOn, date)),
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
  /** Replaceable rows that still match the new plan, kept in place (same id) —
   *  re-synced to the live plan's dose/why/scheduled_time when it changed. */
  kept: number;
  /** Rows protected because the user acted on them, or they weren't machine-made. */
  preserved: number;
};

/**
 * Identity of a plan entry for diffing: the same title under the same protocol.
 *
 * The delimiter is U+0000, chosen because it can occur in NEITHER half — a
 * protocol id is a UUID and a title is user text — so no title can forge a
 * collision with another protocol's entry. It is written as the six-character
 * ESCAPE below and must stay that way: this file was committed with the RAW
 * 0x00 byte, which made the whole blob binary to ripgrep and therefore
 * invisible to every recursive search over src/ — silently, exit 1, on the
 * file that generates Home's entire mission. Runtime-identical either way, and
 * db/mission-generate.test.mjs §8 asserts both halves of that: the delimiter is
 * still U+0000, and no tracked text file carries the byte again.
 *
 * The key is in-memory only — a Map key inside one call, never persisted, never
 * logged — so nothing ever depended on the byte reaching a screen or a row.
 */
export const planKey = (
  title: string,
  protocolId: string | null,
  /** Whether this entry is a CARRIED debt rather than the day's own occurrence. */
  carried = false
): string =>
  `${protocolId ?? '-'}\u0000${title}\u0000${carried ? 'carried' : 'native'}`;

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
    scheduled_time: string | null;
  };
  const rows = db.all<Row>(
    `SELECT id, title, protocol_id, type, status, value, scheduled_time FROM log_entries
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
  // `carried` is read off the row here and carried alongside it, because it is
  // the THIRD component of the match key below and the value json is already
  // being parsed once. A carried row and a native row of the same item under
  // the same protocol are two different obligations that happen to share a
  // title, and letting either claim the other's slot in the multiset would
  // either duplicate the item or silently delete today's own occurrence.
  type Classified = Row & { carried: boolean };
  const replaceable: Classified[] = [];
  const preservedRows: Classified[] = [];
  for (const row of rows) {
    let extras: { generated?: boolean; seed?: boolean; carried?: boolean } = {};
    try {
      extras = row.value ? (JSON.parse(row.value) as typeof extras) : {};
    } catch {
      extras = {}; // unparseable value → treat as hand-made, i.e. preserve it
    }
    const classified: Classified = { ...row, carried: extras.carried === true };
    if (row.status !== 'pending') {
      preservedRows.push(classified); // acted on: completed / skipped / partial
    } else if (extras.generated === true) {
      replaceable.push(classified); // ours — the plan decides whether it stays
    } else if (extras.seed === true && def.dropTypes.includes(row.type)) {
      // A mock row whose whole TYPE the mode pulls (Sick drops training) is the
      // one seed case worth removing — the mode is explicit about that type.
      replaceable.push(classified);
    } else {
      preservedRows.push(classified); // seed the mode doesn't touch, or hand-added
    }
  }

  // Match as a MULTISET, not a set: a protocol may legitimately list the same
  // title twice (two doses at different times). Keying by title alone and
  // collapsing would silently drop the second dose — permanently, since the
  // leftover-plan pass below would then also refuse to re-add it. Each key holds
  // a QUEUE of the plan entries under it, consumed as rows claim them, so a kept
  // row can be paired to the specific plan entry it should re-sync to.
  const planByKey = new Map<string, PlannedEntry[]>();
  for (const p of plan) {
    const key = planKey(p.title, p.protocolId, p.extras.carried === true);
    const queue = planByKey.get(key);
    if (queue) queue.push(p);
    else planByKey.set(key, [p]);
  }

  // Preserved rows already satisfy their plan entry, so a completed item is
  // never re-inserted as a duplicate pending row. ALL of them consume a slot,
  // including pending-but-not-ours ones (counting only settled rows would let a
  // preserved pending row be duplicated by its matching plan entry). They are
  // left untouched — settled or hand-made — so we drop the slot, never the row.
  for (const row of preservedRows) {
    planByKey.get(planKey(row.title, row.protocol_id, row.carried))?.shift();
  }

  // Replaceable (ours, pending) rows: KEEP and re-sync to the matching plan
  // entry when the plan still calls for one, else REMOVE. Re-syncing is what
  // commits a same-day protocol edit — a changed dose/why/scheduled_time — to
  // today: matching is by (title, protocol), so a pure dose/time edit leaves the
  // row matched, and without the UPDATE the row would keep its stale value and
  // time (Home's hero would still read the pre-edit dose for the rest of today).
  // Only rows whose stored payload actually moved are updated, so a re-derive
  // with no change stays a no-op and doesn't churn updated_at.
  const toRemove: string[] = [];
  const toUpdate: { id: string; value: string; scheduledTime: string | null }[] = [];
  for (const row of replaceable) {
    const entry = planByKey.get(planKey(row.title, row.protocol_id, row.carried))?.shift();
    if (!entry) {
      toRemove.push(row.id);
      continue;
    }
    // Both the stored value and the plan entry's extras are built by the same
    // planForDay shape, so JSON.stringify key order matches and a string compare
    // detects a real dose/why change.
    const value = JSON.stringify(entry.extras);
    if (value !== row.value || entry.scheduledTime !== row.scheduled_time) {
      toUpdate.push({ id: row.id, value, scheduledTime: entry.scheduledTime });
    }
  }

  // Whatever plan entries no row claimed are genuinely new.
  const toAdd: PlannedEntry[] = [];
  for (const queue of planByKey.values()) for (const entry of queue) toAdd.push(entry);

  const kept = replaceable.length - toRemove.length;
  if (toRemove.length === 0 && toAdd.length === 0 && toUpdate.length === 0) {
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
    for (const u of toUpdate) {
      // Same defence in depth as the DELETE: a stale id must never reach an
      // ad-hoc capture, an acted-on row, or another day.
      db.run(
        `UPDATE log_entries SET value = ?, scheduled_time = ?
         WHERE id = ? AND daily_log_id = ? AND status = 'pending' AND ${PLANNED_ROW_SQL}`,
        [u.value, u.scheduledTime, u.id, log.id]
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
