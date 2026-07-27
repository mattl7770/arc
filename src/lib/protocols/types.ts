/**
 * Types for the Protocols domain. The row shapes themselves (ProtocolRow,
 * ProtocolVersionRow) mirror 0001 tables and live in src/lib/db/types.ts; this
 * file adds the version-content shape and the view types the screens consume,
 * following the same feature-local pattern as src/lib/nutrition/types.ts.
 */
import type { ProtocolType, TimeString, Timestamp } from '@/lib/db/types';

/**
 * One line of a protocol version — a supplement in a stack, a step in a
 * routine, a meal in a template. Field names are snake_case like the columns
 * they'll eventually generate (`log_entries.scheduled_time`), since this shape
 * is stored verbatim in `protocol_versions.content`.
 */
export type ProtocolItem = {
  title: string;
  /** Wall-clock 'HH:MM' the item is anchored to, or null for "any time". */
  scheduled_time: TimeString | null;
  /** Dose or short how-to ("2 caps", "with food", "4×8 @ RPE 7"). */
  dose: string | null;
  /** Longer context — reserved for the Coach / future editor detail. */
  notes: string | null;
};

/**
 * The `protocol_versions.content` JSON document. An object (not a bare array)
 * so future keys — mode variants, targets, schedule rules — extend it without
 * re-shaping every stored version.
 */
export type ProtocolContent = {
  items: ProtocolItem[];
};

/** What the app supplies to create a protocol; slug/id/flags are repo-owned. */
export type NewProtocol = {
  name: string;
  type: ProtocolType;
  description?: string | null;
};

/** One row of the Protocols list screen — protocol + its live version's stats. */
export type ProtocolListItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: ProtocolType;
  isActive: boolean;
  /** Live version number, or null while the protocol has no version yet. */
  versionNumber: number | null;
  /** Item count of the live version's content — 0 when there is no version. */
  itemCount: number;
  updatedAt: Timestamp;
};
