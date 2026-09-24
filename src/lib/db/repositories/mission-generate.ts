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

import { experimentsRunningOn } from './experiments';
import {
  CARRY_MAX_DAYS,
  carryDebtRows,
  countMissionEntries,
  getOrCreateDailyLog,
  NOT_REMOVED_SQL,
  PLANNED_ROW_SQL,
  setMissionStatus,
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
 *   - a row from the retired MODE system (0026, gone in 0061) set `category` to
 *     the mode's label and no `protocol`, so it read "SICK". Nothing writes one
 *     any more — a status injects nothing, because what a sick day should
 *     contain is the Coach's call — but rows written before the retirement are
 *     still on their days and still render.
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
  /**
   * Present on a MODE-injected row, absent on everything else. Modes were
   * retired in 0061 and nothing writes one any more; the field stays because
   * rows written before then still carry it and still render.
   */
  mode?: string;
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
  /**
   * ── The day-picker mark (2026-09-19) ─────────────────────────────────────
   * `true` on an entry computed for a day that has NOT happened — see
   * {@link planForDay}'s `today` option and `NOT_UNSEEN_SQL` in ./mission.ts.
   * It reaches `log_entries.value` only through {@link commitDayAhead}, and the
   * arrival re-derive strips it from every row still pending.
   */
  ahead?: true;
  /**
   * ── The hand-move mark (2026-09-23) ─────────────────────────────────────
   * Never computed by {@link planForDay}: it reaches `log_entries.value` only
   * through `moveMissionItem` (./mission.ts), and {@link rederiveMissionForDay}
   * carries it forward. A marked row keeps the time the user gave it.
   */
  moved?: true;
};

/**
 * Insert one generated mission entry; returns the id it minted.
 *
 * The id used to be minted inline inside the parameter list and discarded,
 * which was fine while the only caller counted rows. {@link commitPlan} needs
 * the ids in plan order, so it is hoisted to a local and returned — the whole
 * of the change, and nothing about what is written moved.
 */
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
): string {
  const id = newId(db);
  db.run(
    `INSERT INTO log_entries
       (id, daily_log_id, type, protocol_id, title, status, scheduled_time, value, source)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 'manual')`,
    [
      id,
      logId,
      args.type,
      args.protocolId,
      args.title,
      args.scheduledTime,
      JSON.stringify(args.extras),
    ]
  );
  return id;
}

/**
 * Write a whole plan under one daily_log, and hand back the row ids **in plan
 * order**.
 *
 * That ordering is the contract, and it is what {@link commitDayAhead} resolves
 * a tapped row through. The alternative — committing the day and then re-reading
 * it with `listMission`'s `ORDER BY … created_at, id` — cannot work: a stack is
 * inserted inside ONE transaction and `created_at` defaults to a millisecond
 * stamp (`0001_init.sql`), so several rows tie and the tiebreak is a random
 * UUID. Position is exact; a key is not, because {@link planKey} is a multiset
 * key by design.
 */
function commitPlan(db: Database, logId: string, plan: readonly PlannedEntry[]): string[] {
  return plan.map((entry) => insertGenerated(db, logId, entry));
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
 *
 * Exported because the screens that read {@link quotaDoneThisWeek} need to look
 * one item up in it, and a second key-building expression next to this one is
 * how the two definitions drift.
 */
export const quotaKey = (protocolId: string | null, itemId: string): string =>
  `${protocolId ?? '-'}\u0000${itemId}`;

/**
 * How many times each protocol item has been COMPLETED so far in the calendar
 * week containing `date`, counting days strictly BEFORE `date`.
 *
 * Three deliberate choices:
 *   - **completed only.** A skip does not consume quota — that is the point of
 *     a flexible quota, and the owner said so in as many words. Neither does a
 *     `partial`: real progress, but not the session.
 *   - **the whole of `date`'s week EXCEPT `date` itself**, not "everything
 *     before `date`". The exclusion of the row's own day is the original
 *     reason and is unchanged: a row already standing on `date` is preserved by
 *     the re-derive whatever this says, so counting it would let a completed
 *     item be judged "quota met" and removed from its own day. What changed on
 *     2026-09-19 is the other end. A strictly-backward bound was exactly right
 *     while nothing could be completed in the future, and a tick made AHEAD
 *     broke it: a Friday quota row ticked on Monday is invisible to Tuesday,
 *     Wednesday and Thursday, each of which then lands the item again, and a
 *     `per_week: 3` records four. A week is an allowance over a week; the
 *     arithmetic now reads the whole of it. Nothing completed after `date` can
 *     exist except through the Plan screen, so §§10, 11 and 21 of
 *     db/mission-generate.test.mjs are unmoved by the widening.
 *   - **the two shared mission predicates**, so "a planned row" means exactly
 *     what it means everywhere else (mission.ts owns both constants).
 *
 * One query per day, not one per item.
 *
 * Exported for the test that pins it against {@link quotaDoneThisWeek}: the two
 * differ only in that bound, the difference is deliberate, and an assertion
 * that cannot see both halves cannot prove it.
 */
export function quotaCompletionsThisWeek(db: Database, date: string): Map<string, number> {
  const rows = db.all<{ protocolId: string | null; item: string | null; done: number }>(
    `SELECT e.protocol_id AS protocolId,
            json_extract(e.value, '$.item') AS item,
            count(*) AS done
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date >= ? AND d.date <= ? AND d.date <> ?
        AND e.status = 'completed'
        AND json_extract(e.value, '$.item') IS NOT NULL
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      GROUP BY e.protocol_id, json_extract(e.value, '$.item')`,
    [weekStart(date), addDays(weekStart(date), 6), date]
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.item === null) continue;
    counts.set(quotaKey(row.protocolId, row.item), row.done);
  }
  return counts;
}

/**
 * How many times each protocol item has been completed in the calendar week
 * containing `today`, **including today** — what a surface prints when it says
 * `1 of 3 this week`.
 *
 * A SIBLING of {@link quotaCompletionsThisWeek}, deliberately not a call to it,
 * and the two bounds are the whole difference:
 *
 *   - the generator EXCLUDES the day it is planning **on purpose** — a row
 *     standing on its own day must not be judged by it, or a completed quota
 *     item would be computed "met" and removed from the day it was met on;
 *   - a DISPLAY that excluded today would under-report by exactly the session
 *     just ticked, which is the one the user is looking at. Tapping a 3×/wk
 *     session and watching the line still read `1 of 3` is the feature reading
 *     as broken.
 *
 * The far end differs too, and for the same reason from opposite sides: the
 * generator now reads the whole calendar week, because a session ticked AHEAD
 * on Friday is still a session of this week and every later day has to see it
 * (2026-09-19). This one stops at `today`, because a figure printed today must
 * not count a day that has not happened — *"2 of 3 this week"* with one of them
 * booked for Friday would be a claim about the future in the present tense.
 *
 * Nor can a display call the generator's query with `addDays(today, 1)` to fake
 * an inclusive bound: on a **Sunday** that is next Monday, `weekStart` moves
 * with it, and the range `[next Monday, next Monday)` is empty — the figure
 * would silently read `0 of 3` one day in seven.
 *
 * Everything else — completed-only, the two standing predicates, one grouped
 * query rather than one per item — is identical, for the same reasons.
 */
export function quotaDoneThisWeek(db: Database, today: string): Map<string, number> {
  const rows = db.all<{ protocolId: string | null; item: string | null; done: number }>(
    `SELECT e.protocol_id AS protocolId,
            json_extract(e.value, '$.item') AS item,
            count(*) AS done
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date >= ? AND d.date <= ?
        AND e.status = 'completed'
        AND json_extract(e.value, '$.item') IS NOT NULL
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      GROUP BY e.protocol_id, json_extract(e.value, '$.item')`,
    [weekStart(today), today]
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
 * (A hand-made skip of a carried copy writes inside the window, on the user's
 * tap — see `skipCarriedOriginal` in ./mission.ts.)
 *
 * DEFINED in ./mission.ts since 2026-09-23, because `carryDebtRows` reads the
 * window there and that module cannot import this one. Re-exported here, where
 * the carry lives and where every caller already imports it from.
 */
export { CARRY_MAX_DAYS };

/**
 * How far AHEAD the mission's Plan screen may look, and commit
 * (docs/spikes/mission-day-picker-and-future-checkoff.md §3.2).
 *
 * **Six: every weekday once**, which is the smallest horizon that can answer
 * "when does this next come round" for a weekday-list cadence. The owner's
 * call, taken over seven and fourteen because six is already inside the days
 * the notification scheduler reads, so nothing else in the app has to move.
 *
 * Three mechanisms need it small and FIXED rather than open-ended:
 *
 *   1. {@link lastCompletions}' prefilter opens `d.date` by exactly this much,
 *      which is what keeps the `adjusting` clock's query indexable;
 *   2. {@link rederiveDaysAhead} re-derives every committed day inside it after
 *      every status write;
 *   3. the scheduler walks its own horizon on every sync, against iOS's
 *      64-notification ceiling.
 *
 * It is deliberately NOT defined in terms of `PROTOCOL_REMINDER_HORIZON_DAYS`
 * and does not redefine it — a UI answer must not retune the notification
 * layer. What is asserted instead (db/reminders.test.mjs §7c) is the INVARIANT
 * between them: this must stay strictly below the scheduler's horizon, so every
 * day the picker can commit is a day the scheduler already reads.
 */
export const MISSION_HORIZON_DAYS = 6;

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
 *   - **Not an excused day** ({@link excusedDatesIn}, all three of its
 *     reasons). A miss on a day an open status forgave — or a frozen mode, or a
 *     timezone change — was the right call; carrying it would re-levy a debt the
 *     ledger just forgave and produce a pile of work waiting on the day you get
 *     home, which is exactly the nag a status exists to prevent.
 *   - **Not itself carried** ({@link NOT_CARRIED_SQL}). The debt is always the
 *     ORIGINAL day; an untouched carried copy is a second view of the same
 *     obligation, and counting it would let one miss breed.
 *   - **Not UNSEEN** ({@link NOT_UNSEEN_SQL}). A day committed ahead and then
 *     never opened owes nothing: its untouched rows are a morning the user did
 *     not have, not a morning he wasted. Without this, committing Friday on
 *     Wednesday to tick one thing would manufacture eight debts the moment
 *     Saturday came round.
 *   - **Protocol rows only** (`protocol_id` and `value.item` both present). A
 *     mode item and an experiment's intervention belong to their day.
 *   - The two standing predicates, so "a planned row" means what it means
 *     everywhere else.
 *
 * `late_on` rows are excluded for free: settling a debt flips the original to
 * `skipped`.
 *
 * The excusal read is the SHARED definition (`excusedDatesIn`) as of 0061,
 * where it used to apply a mode-only filter of its own. The deliberate
 * consequence, named rather than discovered: **nothing carries out of a
 * timezone-excused day either**, which C11 never considered. A day the ledger
 * forgave should not breed a debt, and having two answers to "was this day
 * excused" in one module was the older bug.
 *
 * ## The rows themselves come from `carryDebtRows` (./mission.ts, 2026-09-23)
 *
 * The query that applies every rule above moved there so a hand-made skip of
 * a carried copy can settle exactly the rows this function counted — every
 * miss the copy stands for, not only its anchor. It lives in ./mission.ts
 * because that is where the skip is, and this module imports that one.
 */
function outstandingCarries(db: Database, date: string): Map<string, CarryDebt> {
  const debts = new Map<string, CarryDebt>();
  for (const row of carryDebtRows(db, date)) {
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
 * The most recent day each protocol item was actually DONE, strictly before
 * `date` — the clock `checkoff_mode = 'adjusting'` re-bases `every_n_days` on.
 *
 * **Carried completions count**, which is the entire point: a debt paid late
 * IS the item's last completion, so under `adjusting` a late completion moves
 * the next occurrence and under `strict` it does not. That is the one place the
 * two toggles meet, and it is why {@link NOT_CARRIED_SQL} is deliberately
 * absent here — this asks what was DONE, not what was owed.
 *
 * ## "The day it was done" is not always the row's day (2026-09-19)
 *
 * A tick made AHEAD proves the item was done no later than the earlier of the
 * row's day and the day of the tap — you cannot do Friday's sauna on Wednesday
 * and have it be Friday's fact about your skin. So the done day is
 * `min(done_on, d.date)`, read through a COALESCE so that every row written
 * before `done_on` existed, and every ordinary same-day tick, still reads its
 * own day and this function answers exactly what it used to.
 *
 * The `min()` is not decoration either: a BACKFILL (a past row ticked today,
 * §3.8 of the spike) has `done_on` AFTER its row, and taking that literally
 * would let a correction made this morning claim the item was done today. The
 * row's day is the older and truer of the two claims there.
 *
 * **Strictly before `date`**, like the quota count and for the same reason: a
 * row already standing on `date` is preserved by the re-derive whatever this
 * says, so counting today's completion would compute the next occurrence as
 * `today + n` and have the plan remove the item from its own day. Note the
 * consequence, which is the feature: a Friday row ticked on Wednesday has done
 * day Wednesday, so on Friday it is `< Friday` and Friday STOPS being a native
 * occurrence of its own plan. The completed row stands anyway, because the
 * re-derive preserves acted-on rows — not because it lands.
 *
 * ## The prefilter, and why the horizon has to stay small and fixed
 *
 * `d.date < ?` on its own is gone, because a row on a LATER day can now carry
 * an earlier done day. Replacing it with a bare expression over `min(...)`
 * would make the whole thing unindexable on a query the reminder scheduler runs
 * six times per sync. So the range stays a plain comparison on `d.date`, opened
 * by exactly `MISSION_HORIZON_DAYS`: a tap can never be more than that many
 * days before the row it lands on, because {@link commitDayAhead} refuses
 * anything further out. The prefilter is therefore exact, not a heuristic —
 * and it is the first of the three mechanisms that need the horizon bounded.
 */
function lastCompletions(db: Database, date: string): Map<string, string> {
  // COALESCE onto the row's own day, then min() against it — see the header.
  const doneDay = `min(COALESCE(json_extract(e.value, '$.done_on'), d.date), d.date)`;
  const rows = db.all<{ protocolId: string; item: string; last: string }>(
    `SELECT e.protocol_id AS protocolId,
            json_extract(e.value, '$.item') AS item,
            max(${doneDay}) AS last
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date < ?
        AND ${doneDay} < ?
        AND e.status = 'completed'
        AND e.protocol_id IS NOT NULL
        AND json_extract(e.value, '$.item') IS NOT NULL
        AND ${PLANNED_ROW_SQL}
        AND ${NOT_REMOVED_SQL}
      GROUP BY e.protocol_id, json_extract(e.value, '$.item')`,
    [addDays(date, MISSION_HORIZON_DAYS + 1), date]
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
 *
 * ## `committing: false` — the same function, asked about a day that has not
 * happened
 *
 * `planForDay` has always been a pure read over ANY date, and the notification
 * scheduler already walks it six days ahead. **On a future date two of its four
 * sources produce artefacts**, and a visual list has neither of the scheduler's
 * accidental guards:
 *
 *   - **the carry.** `outstandingCarries(db, date)` reads `pending` rows in
 *     `[date − 7, date)`. Projected from today, every untouched row of TODAY
 *     reads as a debt on every future day — so tomorrow, Wednesday and Thursday
 *     would each show this morning's un-ticked creatine as owed. A debt is a
 *     fact about days that have HAPPENED; a day that has not happened cannot
 *     owe one.
 *   - **the quota.** `quotaCompletionsThisWeek` counts `[weekStart(date),
 *     date)`, so any day in NEXT week has `done = 0` and a 3×/wk item lands on
 *     every day of it. A quota is an ALLOWANCE, not a day: `1 of 3 this week`
 *     is the honest reading, and any surface that prints a day for one is
 *     printing this artefact.
 *
 * So `committing: false` never reads the carry and never places a quota item,
 * and — because `missed_days` is computed from the same carry read — no entry
 * wears that mark either.
 * **Everything else is byte-for-byte the committing path** — the
 * active-with-a-version filter, the mode's `dropTypes` for that date (a Travel
 * mode set through Sunday is a fact about the plan), `phaseOn`,
 * `cadenceLandsOn`, and the `adjusting` clock read from `lastCompletions` for
 * that date. That is the whole point of a flag rather than a sibling: the
 * docblock rule above says a plan computed anywhere else would drift from this
 * one inside a release, and it does not stop being true because the day is in
 * the future.
 *
 * ## `today` — the day the CALLER is standing on (2026-09-19)
 *
 * The Plan screen, {@link commitDayAhead} and the committed-ahead re-derive are
 * the only three callers that pass it, and it does three things, all of which
 * need a day this function cannot compute for itself:
 *
 *   - **it decides whether `date` is in the future**, and `date > today` turns
 *     `committing` off by itself. A caller that passes `today` therefore cannot
 *     forget the flag, and asking about TODAY with `{ today }` is still a
 *     committing read — which is what the arrival re-derive wants;
 *   - **it stamps `ahead: true`** on every entry of a future day, so a row that
 *     reaches `log_entries` through a commit carries the mark `NOT_UNSEEN_SQL`
 *     keys on (./mission.ts). Nothing stamps it on a day that has arrived, so
 *     the arrival re-derive's value re-sync strips it;
 *   - **it anchors a NULL-`started_on` protocol to TODAY, not to `date`.** The
 *     fallback below reads `protocol.startedOn ?? today ?? date`, which is the
 *     trap this option exists to close: were Friday the first day ever planned
 *     for a brand-new protocol, reading its anchor as Friday would make today
 *     `not_started` and empty Home.
 *
 * Every other caller — `projectDays`, the reminder scheduler, the ordinary
 * generation and re-derive — passes nothing and is byte-identical.
 *
 * The default is `true`, so every existing caller is unchanged.
 */
export function planForDay(
  db: Database,
  date: string,
  opts: { committing?: boolean; today?: string } = {}
): PlannedEntry[] {
  // A day AFTER the caller's today is a day that has not happened. It is never
  // a committing read, whatever the flag says, and every entry wears the mark.
  const ahead = opts.today !== undefined && date > opts.today;
  const committing = opts.committing !== false && !ahead;
  const active = listProtocols(db).filter((p) => p.isActive && p.versionNumber !== null);
  const plan: PlannedEntry[] = [];
  // Not read on a projection: no quota item is placed there, so the count that
  // would decide whether one lands is never consulted.
  const quotaDone = committing ? quotaCompletionsThisWeek(db, date) : new Map<string, number>();
  // Both are one query for the whole day, read only when a protocol on the
  // device actually asks for them — the default of every protocol is
  // `carry_over = 0, checkoff_mode = 'strict'`, which is a database with
  // neither behaviour and therefore neither query.
  const wantsCarry = committing && active.some((p) => p.carryOver);
  const wantsAdjusting = active.some((p) => p.checkoffMode === 'adjusting');
  const carries = wantsCarry ? outstandingCarries(db, date) : new Map<string, CarryDebt>();
  const lastDone = wantsAdjusting ? lastCompletions(db, date) : new Map<string, string>();

  for (const protocol of active) {
    const type = LOG_TYPE_BY_PROTOCOL[protocol.type];
    const content = parseProtocolContent(getCurrentVersion(db, protocol.id)?.content ?? null);
    // A NULL anchor is read as "starts today" — the same reading ensureStartedOn
    // then makes permanent. Doing it here as well keeps planForDay a pure
    // function of the database it is handed, so a caller that skipped the
    // anchoring step still gets phase 1 rather than a crash or an ended protocol.
    //
    // `?? opts.today ?? date` and not `?? date`: on a FUTURE day the honest
    // reading of "starts today" is the caller's today, not the day being looked
    // at. Reading it as `date` would show Friday as phase day 0 and then, when
    // the commit anchored the protocol to today as it must, silently reshape
    // the day the user had just been looking at.
    const state = phaseOn(content, protocol.startedOn ?? opts.today ?? date, date);
    if (state.kind !== 'running') continue; // ended, or not started yet
    const { phase, dayInPhase } = state.window;
    for (const item of phase.items) {
      // A quota has no day, only an allowance — see the header. Skipped BEFORE
      // `landsOn`, which is also what keeps the quota count unread above.
      if (!committing && item.cadence.kind === 'quota') continue;
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
        ...(ahead ? ({ ahead: true } as const) : {}),
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
        ...(ahead ? ({ ahead: true } as const) : {}),
      },
    });
  }
  return plan;
}

/** One projected day: what {@link planForDay} says it would contain. */
export type ProjectedDay = {
  date: string;
  entries: PlannedEntry[];
};

/**
 * How far forward a projection looks. The notification scheduler's horizon,
 * taken deliberately rather than coincidentally: both answer "when does this
 * next come round", and two different horizons would mean a reminder set for a
 * day no screen shows, or a screen naming a day no reminder covers.
 */
export const PROJECTION_DAYS = 6;

/**
 * The next `days` days, each under `planForDay(…, { committing: false })`.
 *
 * **Strictly forward-looking: `from` is TOMORROW.** Today is never projected,
 * because today is the committed rows — the day's plan already exists as
 * `log_entries`, and re-computing it would produce a second, subtly different
 * answer beside the one the user has been ticking. Any surface that wants
 * today's figure counts today's rows.
 *
 * That bound is also what makes the `adjusting` clock honest here. Each day's
 * `lastCompletions(db, date)` counts completions strictly before it, so
 * tomorrow's read includes a completion made this morning — exactly as
 * tomorrow's real generation will read it when tomorrow arrives.
 *
 * Cost, stated because it is paid per render: `days` flagged `planForDay`
 * calls, each one `getActiveMode` + `listProtocols` + one `getCurrentVersion`
 * per protocol + `experimentsRunningOn`, plus `lastCompletions` on any day
 * where a protocol runs `adjusting`. For six protocols that is on the order of
 * sixty small synchronous statements — read ONCE per screen and sliced per row,
 * never called inside a row loop.
 */
export function projectDays(
  db: Database,
  from: string,
  days: number = PROJECTION_DAYS
): ProjectedDay[] {
  const projection: ProjectedDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    projection.push({ date, entries: planForDay(db, date, { committing: false }) });
  }
  return projection;
}

/**
 * The first day in a projection that carries this item — "next Wed".
 *
 * **Null is a real answer, not a failure**, and there are four ways to get it:
 * a QUOTA item (never projected — it has an allowance, not a day), a protocol
 * that has ENDED or not started, a PAUSED protocol (filtered out of every
 * plan), and an item whose next occurrence is past the horizon. A surface must
 * print nothing rather than guess at any of them; the allowance is what a quota
 * row prints instead.
 *
 * Matched on `protocolId` AND `extras.item`, never on the title: two protocols
 * may name an item the same thing, and a retitled item keeps its id.
 */
export function nextOccurrence(
  projection: readonly ProjectedDay[],
  protocolId: string,
  itemId: string
): string | null {
  for (const day of projection) {
    const found = day.entries.some(
      (entry) => entry.protocolId === protocolId && entry.extras.item === itemId
    );
    if (found) return day.date;
  }
  return null;
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
    commitPlan(db, log.id, plan);
  });
  return plan.length;
}

/**
 * Commit a day AHEAD of today and tick one of its rows, in one transaction.
 *
 * ## Why the whole day, and not just the row
 *
 * A row must exist to be ticked, and there is exactly one mechanism in ARC for
 * bringing mission rows into existence. Materialising a single row instead
 * would be a second one — the door both the multiset-collision bug and the
 * seed-deletion bug came through (docs/spikes/protocol-carryover.md §3.3).
 * Committing the day is safe because the re-derive exists: a later edit, pause,
 * mode or completion still reaches it ({@link rederiveDaysAhead}), and the day
 * arriving re-derives it once more.
 *
 * ## `ordinal`, not a key
 *
 * The caller passes the POSITION of the row in the same `planForDay` order it
 * rendered, plus `expect` — the title, protocol and item it believes sits
 * there. {@link planKey} is a multiset key by design (a protocol may list one
 * title twice), and re-reading the committed day with `listMission`'s
 * `ORDER BY … created_at, id` cannot resolve a position either: the whole stack
 * is inserted in one transaction with tied millisecond stamps and a random id
 * as the tiebreak. Position over one recomputation of the same plan is exact.
 *
 * `expect` is the optimistic-concurrency half: the plan is recomputed here, and
 * if a protocol was saved between the render and the tap the row at `ordinal`
 * may be a different item. Nothing is written then, and the screen re-reads.
 *
 * ## The guards, each closing something specific
 *
 *   - `today < date <= today + MISSION_HORIZON_DAYS`. Past and present days are
 *     ordinary rows and go through the ordinary toggle; beyond the horizon,
 *     {@link lastCompletions}' prefilter would stop being exact.
 *   - `ensureStartedOn(db, today)` — **the logical today, never the viewed
 *     day**. `generateMissionForDay` anchors to whatever day it is handed, and
 *     handing it Friday would start a new protocol's clock on Friday and leave
 *     today reading `not_started`.
 *   - the day must still be uncommitted. A second tap that raced the first
 *     writes nothing rather than a second copy of the day.
 *
 * Returns the ticked row's id, or null when nothing was written.
 *
 * One `db.transaction`, and nothing inside opens another: `Database.transaction`
 * is a plain BEGIN that does not nest, and `setMissionStatus` opens none. So the
 * day cannot come into existence with nothing ticked on it.
 */
export function commitDayAhead(
  db: Database,
  date: string,
  today: string,
  at: { ordinal: number; expect: { title: string; protocolId: string | null; itemId?: string } }
): string | null {
  if (date <= today || date > addDays(today, MISSION_HORIZON_DAYS)) return null;
  // Committed-ness is asked of the DATE, not of a log row, so a refusal below
  // cannot leave an empty `daily_logs` row behind for a day nobody touched —
  // "nothing is written by looking" has to survive a refused tap too.
  const committed = db.get<{ one: number }>(
    `SELECT 1 AS one
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ? AND ${PLANNED_ROW_SQL}
      LIMIT 1`,
    [date]
  );
  if (committed) return null;

  ensureStartedOn(db, today);
  const plan = planForDay(db, date, { today });
  const entry = plan[at.ordinal];
  if (
    entry === undefined ||
    entry.title !== at.expect.title ||
    entry.protocolId !== at.expect.protocolId ||
    entry.extras.item !== at.expect.itemId
  ) {
    return null;
  }

  const log = getOrCreateDailyLog(db, date);
  let ticked: string | null = null;
  db.transaction(() => {
    const ids = commitPlan(db, log.id, plan);
    ticked = ids[at.ordinal] ?? null;
    if (ticked !== null) setMissionStatus(db, ticked, 'completed', today);
  });
  return ticked;
}

/**
 * Un-commit a day ahead — the other half of {@link commitDayAhead}, reached by
 * un-ticking the last thing ticked on it.
 *
 * A DELETE, deliberately, where {@link removeMissionItem} is a tombstone. That
 * precedent exists because a USER's removal was being resurrected by the next
 * re-derive; an un-commit removes nothing the user chose, and the day is meant
 * to go back to being computed rather than to being a committed empty day that
 * every later edit has to diff against.
 *
 * It refuses outright if any planned row on the day is not both `pending` and
 * machine-made — a day holding a completion, a skip or a hand-added row is a
 * day with something in it worth keeping, and the caller simply leaves it
 * committed. Returns whether it emptied the day.
 *
 * The DELETE carries the same defence in depth as the re-derive's: even with a
 * wrong id it cannot reach an ad-hoc capture, an acted-on row or another day.
 */
export function uncommitDayAhead(db: Database, date: string, today: string): boolean {
  if (date <= today) return false;
  const log = db.get<{ id: string }>('SELECT id FROM daily_logs WHERE date = ?', [date]);
  if (!log) return false;
  const rows = db.all<{ id: string; status: string; value: string | null }>(
    `SELECT id, status, value FROM log_entries
      WHERE daily_log_id = ? AND ${PLANNED_ROW_SQL}`,
    [log.id]
  );
  if (rows.length === 0) return false;
  for (const row of rows) {
    if (row.status !== 'pending') return false;
    let generated = false;
    try {
      generated = row.value
        ? (JSON.parse(row.value) as { generated?: boolean }).generated === true
        : false;
    } catch {
      generated = false;
    }
    if (!generated) return false;
  }
  db.run(
    `DELETE FROM log_entries
      WHERE daily_log_id = ? AND status = 'pending' AND ${PLANNED_ROW_SQL}`,
    [log.id]
  );
  return true;
}

export type RederiveResult = {
  /** New plan entries inserted (newly-applicable protocol items). */
  added: number;
  /** Untouched pending generated/seed rows the new plan no longer wants. */
  removed: number;
  /** Replaceable rows that still match the new plan, kept in place (same id) —
   *  re-synced to the live plan's dose/why/scheduled_time when it changed. A
   *  row MOVED by hand keeps its own time; everything else still follows. */
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
): string => `${protocolId ?? '-'}\u0000${title}\u0000${carried ? 'carried' : 'native'}`;

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
 * a re-derive are one mechanism. Pending machine-made rows only; anything
 * completed, skipped, partial or ad-hoc is preserved untouched. An item whose
 * quota is already met today is therefore not re-added, and an item the edit
 * removed does not take its completed row with it.
 */
export function rederiveMissionForDay(
  db: Database,
  date: string,
  opts: { today?: string } = {}
): RederiveResult {
  const log = getOrCreateDailyLog(db, date);
  // Same anchoring as the first generation — a protocol activated today and
  // edited an hour later must not be read as never having started.
  //
  // `opts.today ?? date`, because a re-derive of a day AHEAD must never anchor
  // a NULL-`started_on` protocol to that day: it would start the clock in the
  // future and leave today reading `not_started`. Every caller re-deriving a
  // future day passes `today`; every other caller is unchanged.
  ensureStartedOn(db, opts.today ?? date);

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

  // Nothing planned yet → this is a first generation, not a re-derive. Never on
  // a day ahead: an uncommitted future day is computed on view and commits on
  // the first tick, and generating it from here would commit a day nobody
  // touched — see {@link rederiveDaysAhead}, which only ever hands over
  // committed days.
  if (rows.length === 0) {
    if (opts.today !== undefined && date > opts.today) {
      return { added: 0, removed: 0, kept: 0, preserved: 0 };
    }
    return { added: generateMissionForDay(db, date), removed: 0, kept: 0, preserved: 0 };
  }

  const plan = planForDay(db, date, opts);

  // Classify every planned row. The re-derive OWNS only what it generated:
  // `planForDay` knows about protocols and experiments and nothing else, so a
  // row it doesn't recognise is not evidence the row is unwanted. The mock seed
  // (`seed: true`, planted by ensureTodaySeeded on a protocol-less first run) is
  // exactly such a row — treating it as ours would delete the entire first-run
  // mission on any re-derive and nothing would ever put it back.
  // `carried` is read off the row here and carried alongside it, because it is
  // the THIRD component of the match key below and the value json is already
  // being parsed once. A carried row and a native row of the same item under
  // the same protocol are two different obligations that happen to share a
  // title, and letting either claim the other's slot in the multiset would
  // either duplicate the item or silently delete today's own occurrence.
  // `moved` and `item` ride along for the same reason: a row moved by hand
  // keeps its time through the re-sync, and — when a retitle breaks the title
  // match — hands it to the entry that replaces it (below).
  type Classified = Row & { carried: boolean; moved: boolean; item: string | null };
  const replaceable: Classified[] = [];
  const preservedRows: Classified[] = [];
  for (const row of rows) {
    let extras: {
      generated?: boolean;
      seed?: boolean;
      carried?: boolean;
      moved?: boolean;
      item?: string;
    } = {};
    try {
      extras = row.value ? (JSON.parse(row.value) as typeof extras) : {};
    } catch {
      extras = {}; // unparseable value → treat as hand-made, i.e. preserve it
    }
    const classified: Classified = {
      ...row,
      carried: extras.carried === true,
      moved: extras.moved === true,
      item: typeof extras.item === 'string' ? extras.item : null,
    };
    if (row.status !== 'pending') {
      preservedRows.push(classified); // acted on: completed / skipped / partial
    } else if (extras.generated === true) {
      replaceable.push(classified); // ours — the plan decides whether it stays
    } else {
      // EVERY SEED ROW SURVIVES. The one case that used to be removed was a
      // mock row whose whole TYPE a mode pulled (Sick dropped training), and
      // that branch went with the modes in 0061: nothing in the deterministic
      // layer decides any more that a kind of thing does not belong on a day.
      // A status injects nothing and removes nothing; if today's workout should
      // come off, the Coach takes it off with adjust_today, which the user sees
      // and approves.
      preservedRows.push(classified); // a seed row, or something hand-added
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

  // Every row claims ONE entry from its key's queue. Preserved rows already
  // satisfy their plan entry, so a completed item is never re-inserted as a
  // duplicate pending row. ALL of them consume a slot, including
  // pending-but-not-ours ones (counting only settled rows would let a
  // preserved pending row be duplicated by its matching plan entry). They are
  // left untouched — settled or hand-made — so we drop the slot, never the row.
  //
  // ## A row claims its OWN item's entry first (2026-09-23)
  //
  // The key is (title, protocol, carried), so two doses under one title share
  // a queue, and the row used to take whichever entry was at its head. Which
  // dose a row re-synced to then depended on the order of the plan and of the
  // rows: an evening dose added after a morning one, or a completed evening
  // row claiming the morning slot, re-synced the pending morning row onto the
  // evening dose. A row moved by hand made it visible, because the move's time
  // went with the row onto the wrong dose. So the claim runs twice: first
  // every row takes the entry of its own `value.item`; then any row still
  // unpaired — no item on the row, or an item the plan no longer names —
  // takes the head of its queue, exactly as every row did before. Preserved
  // rows go first in both passes, as they always have.
  const claimed = new Map<string, PlannedEntry>();
  const claimants = [...preservedRows, ...replaceable];
  for (const ownItemOnly of [true, false]) {
    for (const row of claimants) {
      if (claimed.has(row.id)) continue;
      const queue = planByKey.get(planKey(row.title, row.protocol_id, row.carried));
      if (!queue || queue.length === 0) continue;
      const at = !ownItemOnly
        ? 0
        : row.item === null
          ? -1
          : queue.findIndex((entry) => entry.extras.item === row.item);
      if (at === -1) continue;
      claimed.set(row.id, queue.splice(at, 1)[0]!);
    }
  }

  // Replaceable (ours, pending) rows: KEEP and re-sync to the matching plan
  // entry when the plan still calls for one, else REMOVE. Re-syncing is what
  // commits a same-day protocol edit — a changed dose/why/scheduled_time — to
  // today: matching is by (title, protocol), so a pure dose/time edit leaves the
  // row matched, and without the UPDATE the row would keep its stale value and
  // time (Home's hero would still read the pre-edit dose for the rest of today).
  // Only rows whose stored payload actually moved are updated, so a re-derive
  // with no change stays a no-op and doesn't churn updated_at.
  //
  // ## A row MOVED BY HAND keeps its time (2026-09-23)
  //
  // `moveMissionItem` marks the row (`value.moved`), and here the mark wins
  // over the plan for exactly one field: `scheduled_time`. The dose and the
  // why-line still follow the item — a re-dose made after a move must reach
  // the row — and the mark is carried forward so the NEXT re-derive keeps the
  // time too. A row that was not moved follows a time edit to its item exactly
  // as before. The mark is appended LAST, which is also where the move's own
  // json_set put it, so an unchanged day still compares equal and writes
  // nothing.
  //
  // The mark belongs to the ITEM it was made on. A moved row that could only
  // be paired with a different item of the same title (its own is gone from
  // the plan) is re-synced to that item like any other row, time and all, and
  // its moved time goes to the retitle hand-off below in case its own item is
  // still in the plan under a new title. A row with no item id (written before
  // items had one, or an experiment's) cannot be told apart, and keeps its time.
  const toRemove: string[] = [];
  const toUpdate: { id: string; value: string; scheduledTime: string | null }[] = [];
  const unmatchedMoved: Classified[] = [];
  for (const row of replaceable) {
    const entry = claimed.get(row.id);
    if (!entry) {
      toRemove.push(row.id);
      if (row.moved) unmatchedMoved.push(row);
      continue;
    }
    const keepsTime = row.moved && (row.item === null || entry.extras.item === row.item);
    if (row.moved && !keepsTime) unmatchedMoved.push(row);
    // Both the stored value and the plan entry's extras are built by the same
    // planForDay shape, so JSON.stringify key order matches and a string compare
    // detects a real dose/why change.
    const value = JSON.stringify(keepsTime ? { ...entry.extras, moved: true } : entry.extras);
    const scheduledTime = keepsTime ? row.scheduled_time : entry.scheduledTime;
    if (value !== row.value || scheduledTime !== row.scheduled_time) {
      toUpdate.push({ id: row.id, value, scheduledTime });
    }
  }

  // Whatever plan entries no row claimed are genuinely new.
  const toAdd: PlannedEntry[] = [];
  for (const queue of planByKey.values()) for (const entry of queue) toAdd.push(entry);

  // A moved row the title match could not pair is, in the one case that
  // matters, an item RETITLED since the move: the diff keys on the title, so
  // the old row goes and a new one comes in. That is how every retitle has
  // always landed, and for an ordinary row nothing is lost by it — but a moved
  // row would lose its time through this door just as it used to through the
  // re-sync. So the entry replacing it — same protocol, same ITEM id, same
  // carried-ness — is inserted at the moved time, wearing the mark. An item
  // that is simply gone (edited out, paused, deleted) has no such entry, and
  // its row is removed like any other: the move said when, not whether.
  for (const row of unmatchedMoved) {
    const at = toAdd.findIndex(
      (entry) =>
        entry.protocolId === row.protocol_id &&
        row.item !== null &&
        entry.extras.item === row.item &&
        (entry.extras.carried === true) === row.carried &&
        entry.extras.moved !== true
    );
    if (at === -1) continue;
    const entry = toAdd[at]!;
    toAdd[at] = {
      ...entry,
      scheduledTime: row.scheduled_time,
      extras: { ...entry.extras, moved: true },
    };
  }

  const kept = replaceable.length - toRemove.length;
  if (toRemove.length === 0 && toAdd.length === 0 && toUpdate.length === 0) {
    return { added: 0, removed: 0, kept, preserved: preservedRows.length };
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
    added: toAdd.length,
    removed: toRemove.length,
    kept,
    preserved: preservedRows.length,
  };
}

/**
 * Is anything committed on a day AFTER `today`, inside the horizon?
 *
 * One indexed `LIMIT 1`, and the whole reason {@link rederiveDaysAhead} can sit
 * behind every status write in the app: a database with nothing committed ahead
 * — which is every database until the user first ticks something on the Plan
 * screen, and most databases most of the time — pays exactly this and stops.
 */
export function hasCommittedDaysAhead(db: Database, today: string): boolean {
  const row = db.get<{ one: number }>(
    `SELECT 1 AS one
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date > ? AND d.date <= ?
        AND ${PLANNED_ROW_SQL}
      LIMIT 1`,
    [today, addDays(today, MISSION_HORIZON_DAYS)]
  );
  return row !== undefined && row !== null;
}

/**
 * Re-derive every COMMITTED day in `(today, today + MISSION_HORIZON_DAYS]`.
 *
 * ## The invariant, stated exactly
 *
 * > **A day committed ahead never holds a plan that the protocols, modes,
 * > experiments and completions no longer make, from the moment the app itself
 * > changed one of them.**
 *
 * Only the carry source is outside it — a future day has none — and the day's
 * own arrival adds that.
 *
 * It runs after every status write as well as after every protocol edit,
 * because a COMPLETION changes later days too: under `adjusting` it moves an
 * every-N-days item's next occurrence, and under a quota it spends one of the
 * week's sessions. Without it, the most common gesture in the app would leave a
 * committed Friday holding a row the plan no longer makes — and that dead row
 * would keep its reminder.
 *
 * **Today is deliberately not re-derived here.** A row on `date` completed on
 * `date` cannot change `date`'s own plan: `lastCompletions` reads strictly
 * before the day, and the quota count excludes the day itself.
 *
 * The horizon is in the QUERY, not applied afterwards, so a day committed under
 * some larger horizon is left alone and picked up by its own arrival instead of
 * being half-maintained.
 */
export function rederiveDaysAhead(db: Database, today: string): void {
  if (!hasCommittedDaysAhead(db, today)) return;
  const days = db.all<{ date: string }>(
    `SELECT DISTINCT d.date AS date
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date > ? AND d.date <= ?
        AND ${PLANNED_ROW_SQL}
      ORDER BY d.date`,
    [today, addDays(today, MISSION_HORIZON_DAYS)]
  );
  for (const day of days) rederiveMissionForDay(db, day.date, { today });
}

/**
 * Re-derive TODAY and every committed day ahead of it — what every seam that
 * changes what a day should hold now calls instead of re-deriving today alone.
 *
 * `ensureStartedOn(db, today)` runs FIRST and is not decoration.
 * {@link rederiveMissionForDay} anchors to the day it is handed, and the days
 * ahead are handed `{ today }` precisely so they cannot anchor to themselves —
 * but the anchor has to be set by then, or today's own re-derive would be the
 * one doing it after a future day had already been planned against a NULL.
 * Anchoring once, here, makes the order of the rest irrelevant.
 */
export function rederiveMissionFromToday(db: Database, today: string): RederiveResult {
  ensureStartedOn(db, today);
  const result = rederiveMissionForDay(db, today);
  rederiveDaysAhead(db, today);
  return result;
}

/**
 * Why a past tick was refused, or `'ok'` when it was not.
 *
 * A total result rather than a boolean, because each refusal has a different
 * authored line and a screen that cannot tell them apart can only say "no".
 */
export type PastTickResult = 'ok' | 'not_found' | 'too_old' | 'carried' | 'settled_by_copy';

/**
 * Tick (or un-tick) a row on a day that has already passed — the **backfill**.
 *
 * ## What it is for, and the one thing it reverses
 *
 * Yesterday's untouched magnesium, remembered this morning. With carry-over on,
 * ticking TODAY's carried copy settles the original `skipped + late_on` — done
 * late, no credit (0050, the owner's 2026-09-14 call). Ticking the ORIGINAL on
 * its own day instead makes it `completed` there, with full credit. Those are
 * two different claims — *I did it today, late* versus *I did it yesterday and
 * forgot to tick* — and the second is the most common reason to look back. For
 * a `daily` item it is the ONLY correction available, because `daily` never
 * grows a carried row.
 *
 * The owner took option (a) on question 3: **yes, for the seven settled days
 * behind today**, stamped with the day of the tap and shown as *ticked N days
 * later*. Older days are read-only and say so.
 *
 * ## The three guards, and they ship WITH the gesture
 *
 * A tick without them corrupts the done-late ledger, which is why they are here
 * and not in a follow-up:
 *
 *  1. **The window.** Seven days, the carry window: a miss older than a week is
 *     a fact about the protocol, not a bookkeeping slip.
 *  2. **A CARRIED row is refused** (question 4, option a). The debt is live on
 *     today's copy, where the gesture belongs. Allowing it would stamp the
 *     original with `late_on = <the carried row's own day>` — a day on which
 *     nothing was asserted — and leave one row wearing both `carried_days` and
 *     `tickedDays`.
 *  3. **A row a carried copy already SETTLED is refused.** `late_on` is the
 *     late-completion form: flipping a `skipped + late_on` original to
 *     `completed` would leave the stamp in `value`, silently drop the
 *     `doneLate` annotation, and count the item done twice. `skipped_via` is
 *     the same fact by the other route (a copy that was hand-skipped), and it
 *     is guarded in the same breath rather than as a fourth rule: both mean
 *     "a copy has already spoken for this row", and both are undone from the
 *     copy.
 *
 * The allowed case triggers {@link rederiveMissionFromToday}, so today's
 * carried copy — a debt that no longer exists — is removed by the diff.
 */
export function backfillPastRow(db: Database, id: string, today: string): PastTickResult {
  const row = db.get<{ date: string; status: string; value: string | null }>(
    `SELECT d.date AS date, e.status AS status, e.value AS value
       FROM log_entries e
       JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE e.id = ? AND ${PLANNED_ROW_SQL} AND ${NOT_REMOVED_SQL}`,
    [id]
  );
  if (!row || row.date >= today) return 'not_found';
  if (daysBetween(row.date, today) > CARRY_MAX_DAYS) return 'too_old';

  let extras: { carried?: boolean; late_on?: string; skipped_via?: string } = {};
  try {
    extras = row.value ? (JSON.parse(row.value) as typeof extras) : {};
  } catch {
    extras = {};
  }
  if (extras.carried === true) return 'carried';
  if (extras.late_on !== undefined || extras.skipped_via !== undefined) return 'settled_by_copy';

  const settled = row.status === 'completed' || row.status === 'skipped';
  setMissionStatus(db, id, settled ? 'pending' : 'completed', today);
  // The correction reaches TODAY: a debt that has just been paid on its own day
  // is no longer outstanding, so the carried copy standing on today's mission is
  // removed by the same diff every other plan change goes through.
  rederiveMissionFromToday(db, today);
  return 'ok';
}
