/**
 * View-model for the Log tab's "Logged today" feed (docs/information-architecture.md).
 * A flat, already-formatted row — the repository (src/lib/db/repositories/logs.ts)
 * does the unit conversion and unions the three source tables, so the component
 * just renders.
 */
export type LogFeedItem = {
  id: string;
  /** Local wall-clock "HH:MM" the entry was logged. */
  time: string;
  /** Display-ready, e.g. "178.2 lb", "16 oz", or a note's text. */
  title: string;
  /** "Weight", "Water", "Note", … — a label on the row, not a group. */
  category: string;
  /** A free note (no metric bucket): rendered in serif italic, "for Coach". */
  note?: boolean;
};
