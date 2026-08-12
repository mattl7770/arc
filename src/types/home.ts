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
