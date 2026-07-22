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
  /** Time or window, pre-formatted for display: "07:15", "17:00–18:00". */
  window?: string;
  /** One line on why this matters. Promoted to the hero card when it is next. */
  why?: string;
  /** Source protocol, if this item came from one. */
  protocol?: string;
  estimatedMinutes?: number;
  status: MissionStatus;
  /**
   * Deferred from the hero card. Still pending and still in its section — it
   * just stops claiming "do this next" so the screen keeps moving.
   */
  snoozed?: boolean;
};

export type MissionSection = {
  id: string;
  /** Morning Protocol, Nutrition, Training, ... */
  title: string;
  items: MissionItem[];
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
  mission: MissionSection[];
  /** The Coach's daily brief. 3–6 sentences, calm and direct. */
  brief: string;
  metrics: Metric[];
};
