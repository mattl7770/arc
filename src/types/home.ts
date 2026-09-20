/**
 * View-model types for the Home Screen (docs/home-screen.md).
 *
 * These describe what the screen renders, not how it is stored. The mapping
 * from daily_logs / log_entries lands when this screen reads real data —
 * MissionStatus is deliberately identical to the log_entry_status enum so
 * that translation is a rename, not a redesign.
 */

export type SignalLevel = 'optimal' | 'good' | 'caution' | 'poor' | 'unknown';

/** Mirrors the `log_entry_status` enum in the database. */
export type MissionStatus = 'pending' | 'completed' | 'skipped' | 'partial';

export type MissionItem = {
  id: string;
  title: string;
  /**
   * 24-hour "HH:MM". Mirrors `log_entries.scheduled_time`, and doubles as the
   * chronological sort key — the mission is one time-ordered list, never
   * grouped by category (owner call, 2026-07-24). Undefined sorts to the end.
   */
  scheduledTime?: string;
  /** Nutrition, Training, Supplements, ... — a label on the row, not a group. */
  category: string;
  /**
   * The quantity — `5g`, `400 mg`, `2 caps`. A MEASURED value, so it is set in
   * mono and joins the hero's dimension figure beside the time and the duration
   * (src/components/home/hero-card.tsx).
   *
   * Separate from {@link why} on purpose, and the separation is the fix for a
   * real defect: the generator holds a protocol item's `dose` and `notes` as
   * distinct columns, flattened them into `why` with `dose ?? notes`, and the
   * hero then sniffed the string — leading digit, at most fourteen characters —
   * to guess which it had been handed. Carrying the fact makes the guess
   * unnecessary. `400 mg magnesium` is fifteen characters and would have come
   * back as prose.
   */
  dose?: string;
  /**
   * One line on why this matters — rationale PROSE, set in serif italic and
   * promoted to the hero card when this item is next. Never a quantity; that is
   * {@link dose}.
   */
  why?: string;
  /** Source protocol, if this item came from one. */
  protocol?: string;
  estimatedMinutes?: number;
  status: MissionStatus;
  /**
   * Deferred from the hero card. Still pending and still in the list — it just
   * stops claiming "do this next" so the screen keeps moving.
   */
  snoozed?: boolean;
  /**
   * This row is a DEBT carried forward from an earlier day (0050) — 1 on the
   * first carry, 2 on the second. It renders as one label-voice mark beside the
   * category ("SUPPLEMENTS · 2 DAYS LATE"), never as a signal colour: adherence
   * is behaviour, not biology.
   */
  carriedDays?: number;
  /**
   * This row is today's OWN occurrence, and it superseded an outstanding debt
   * of `missedDays` earlier days. A different fact from {@link carriedDays} —
   * "you are behind on this" rather than "this is the thing you are behind on"
   * — and the reason a `daily` item never grows a second row.
   */
  missedDays?: number;
  /**
   * ── What makes the row a DOOR rather than a dead end ─────────────────────
   *
   * Four facts every generated row has carried since the generator was written
   * and the view-model threw away. Without them a mission row could say which
   * protocol named it but not reach it, and the per-row verbs the repository
   * already implements — move, remove, skip a debt — had no caller: both
   * {@link moveMissionItem} and {@link removeMissionItem} take the DAY's
   * `dailyLogId`, which the screen did not have.
   *
   * All four are absent on a mode item, an experiment's intervention and the
   * mock seed, which is the check a surface makes before offering the verbs
   * that need a protocol behind them.
   */
  /** `log_entries.daily_log_id` — the day, which the move/remove guards take. */
  dailyLogId?: string;
  /** `log_entries.protocol_id` — the protocol to open. Null once it is deleted. */
  protocolId?: string;
  /** `value.item` — the `ProtocolItem.id`, the identity an edit is made against. */
  itemId?: string;
  /**
   * `value.carried_from` — the day and row id this debt is owed from. Present
   * on a carried copy only, and it is what lets the sheet say *owed from Mon
   * 14 Sep* and what {@link skipCarried} reaches through.
   */
  carriedFrom?: { date: string; entry: string };
  /**
   * How far the TICK was from the row — signed days, negative for early
   * (2026-09-19). A row ticked on the Plan screen two days before its own day
   * reads `-2` and prints "DONE 2 DAYS EARLY"; a past row backfilled this
   * morning reads `+1` and prints "TICKED 1 DAY LATER".
   *
   * Undefined on every ordinary row — a tick made on the day it belongs to
   * leaves nothing to say, and so does every row written before `value.done_on`
   * existed. Label voice beside the category, never a signal colour: this is
   * provenance about BEHAVIOUR, and the signal palette marks biology.
   */
  tickedDays?: number;
  /**
   * `value.done_on` — the logical day the completion was recorded, present only
   * when the row is completed. {@link tickedDays} is this fact as the number a
   * row prints; this is the fact itself, which the Coach's payload states.
   */
  doneOn?: string;
  /**
   * `value.late_on` — this row is the ORIGINAL of a debt that was finally paid
   * on a later day through a carried copy (0050). It stays `skipped`, because
   * the day it was missed is still a miss; the stamp is what lets a surface say
   * so out loud, and what makes a second tick on this row refusable.
   */
  lateOn?: string;
};

export type Readiness = {
  level: SignalLevel;
  /** Short enough to read in under a second: "Recovery low". */
  label: string;
  /** The number behind the label: "HRV 42 ms · 14% below baseline". */
  detail: string;
};

export type Pillar = {
  label: string;
  level: SignalLevel;
  /**
   * Why this pillar reads the way it does, when the reason is not self-evident
   * — almost always why it is `unknown`.
   *
   * An absent value must never render as an empty slot the reader has to
   * interpret (00-design-spec.md §5: empty is authored, never blank). "No
   * signal yet" and "not connected" are different facts, and "four more days
   * before a baseline exists" is a third — there the pillar is *correctly*
   * unknown, and saying how long is left is the difference between a screen
   * that looks broken and one that is visibly waiting.
   *
   * Short enough to sit in a joined line beneath the strip; the cell itself is
   * four abreast and has no room for a sentence.
   */
  note?: string;
};

export type Metric = {
  id: string;
  label: string;
  value: string;
  detail?: string;
  level?: SignalLevel;
};

export type HomeDay = {
  readiness: Readiness;
  pillars: Pillar[];
  /** Authored in any order; the mission derivation sorts it by time. */
  mission: MissionItem[];
  /** The Coach's daily brief. 3–6 sentences, calm and direct. */
  brief: string;
  metrics: Metric[];
};
