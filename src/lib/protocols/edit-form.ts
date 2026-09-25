/**
 * The protocol editor's form state — pure, so the rules that make a Save exact
 * are pinned by db/protocols.test.mjs rather than only by a render.
 *
 * The one editor (app/protocol-edit.tsx) holds a protocol's document as phases
 * of editable items, seeded once from the live version. Two properties carry
 * the whole design, and both are tested:
 *
 *   - **an untouched form builds the live document byte for byte**
 *     ({@link seedPhases} → {@link buildContent}), so Save is inert at rest and
 *     opening the form and leaving writes no version;
 *   - **an item keeps its id through everything the form can do to it** —
 *     editing, re-ordering and moving between phases ({@link moveToPhase}).
 *     The id is how the version diff says "changed" rather than "removed and
 *     added", how the quota counter and the carry find the item's rows, and how
 *     the save's merge (./rebase.ts) matches it against a version written
 *     elsewhere. Moving an item used to mean removing it and adding it again,
 *     which minted a new one.
 *
 * Ids are minted when an item or phase is ADDED, through the `mint` the screen
 * passes (`newId` over the database — Hermes has no `crypto`), so every row in
 * the form carries its final id from the first frame.
 */
import { normalizeTime } from './clock-time';
import { DAILY, normalizeContent } from './content';
import type { Cadence, ProtocolContent } from './types';

/** One item under edit. `key` is a mount-local id for React lists only. */
export type EditItem = {
  key: number;
  /** The stored item id — minted on add, kept through every edit and move. */
  id: string;
  title: string;
  /** `HH:MM`, or '' for any time. */
  time: string;
  dose: string;
  /** The why-line: the owner's writing, printed under the item on Home. */
  why: string;
  cadence: Cadence;
  /** Whether this item asks the OS for a notification at its time (C10). */
  remind: boolean;
};

/** One phase under edit. `days` is text so the field can be empty = open-ended. */
export type EditPhase = {
  key: number;
  id: string;
  title: string;
  days: string;
  items: EditItem[];
};

/** A whole number of days ≥ 1, or null for "not a length". */
export function parseDays(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

/** A fresh item, blank but for its identity. */
export function blankItem(key: number, id: string): EditItem {
  return { key, id, title: '', time: '', dose: '', why: '', cadence: DAILY, remind: false };
}

/**
 * The form's phases for a stored document. `nextKey` hands out mount-local
 * React keys. A phase with no items is seeded with none: in the one-line
 * layout an empty phase reads as its *Add item* row, not as a blank field.
 */
export function seedPhases(content: ProtocolContent, nextKey: () => number): EditPhase[] {
  return content.phases.map((phase) => ({
    key: nextKey(),
    id: phase.id,
    title: phase.title ?? '',
    days: phase.duration_days === null ? '' : String(phase.duration_days),
    items: phase.items.map((it) => ({
      key: nextKey(),
      id: it.id,
      title: it.title,
      time: it.scheduled_time ?? '',
      dose: it.dose ?? '',
      why: it.notes ?? '',
      cadence: it.cadence,
      remind: it.remind,
    })),
  }));
}

/**
 * The canonical document the form holds. An item with a blank title is not an
 * item yet — the row *Add item* opens — and is left out; every other rule is
 * `normalizeContent`'s, the same one every stored document is read through,
 * which is what makes an untouched form byte-identical to what it opened on.
 */
export function buildContent(phases: EditPhase[]): ProtocolContent {
  return normalizeContent({
    phases: phases.map((phase) => ({
      id: phase.id,
      title: phase.title.trim() || null,
      duration_days: parseDays(phase.days),
      items: phase.items
        .filter((it) => it.title.trim() !== '')
        .map((it) => ({
          id: it.id,
          title: it.title,
          scheduled_time: it.time.trim() === '' ? null : normalizeTime(it.time),
          dose: it.dose,
          notes: it.why,
          cadence: it.cadence,
          remind: it.remind,
        })),
    })),
  });
}

/** Swap `index` with its neighbour in `by` steps; the same array if it can't. */
export function moved<T>(list: T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const held = next[index]!;
  next[index] = next[to]!;
  next[to] = held;
  return next;
}

/**
 * Move one item to another phase, **keeping the item itself** — its key, its
 * id and every field — and placing it at the end of the target phase. Order
 * inside the phase is then the ↑ ↓ buttons', on the same screen. A no-op when
 * the item is already there or either key is unknown.
 */
export function moveToPhase(phases: EditPhase[], itemKey: number, phaseKey: number): EditPhase[] {
  const item = phases.flatMap((phase) => phase.items).find((it) => it.key === itemKey);
  const target = phases.find((phase) => phase.key === phaseKey);
  if (!item || !target || target.items.some((it) => it.key === itemKey)) return phases;
  return phases.map((phase) =>
    phase.key === phaseKey
      ? { ...phase, items: [...phase.items, item] }
      : { ...phase, items: phase.items.filter((it) => it.key !== itemKey) }
  );
}
