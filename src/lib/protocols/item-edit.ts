/**
 * Writing ONE item into a protocol's live document.
 *
 * The per-item editor (app/protocol-item.tsx) is a form over a single item, but
 * a version is a whole document: the write is always "rebuild the live content
 * with this one item replaced, appended or removed". That rebuild is the
 * load-bearing part and it lives here — pure, so the rules below are pinned by
 * db/protocols.test.mjs rather than only by a render.
 *
 * The rule it exists to keep: **a per-item save must produce a document
 * byte-identical to the full editor's for the same change.** Both run through
 * `normalizeContent`, so there is one canonical shape; what this adds is the
 * placement, and the placement is where a second implementation would drift.
 */
import { normalizeContent } from './content';
import type { ProtocolContent, ProtocolItem } from './types';

export type ApplyItem = {
  /** Which phase the item should end up in. Clamped to the document. */
  phase: number;
  /** Take the item out instead of writing it. */
  remove?: boolean;
};

/**
 * The live document with `item` written into it.
 *
 * Three placements, and each one is a decision:
 *
 *   - **replace in place** where the item already sits in the target phase, so
 *     a dose edit never reorders the phase it belongs to;
 *   - **append** where it does not, so an item moved between phases lands at
 *     the end of the new one rather than at an invented index — order inside a
 *     phase is the full editor's job, and this form says so;
 *   - **remove from every phase** when asked, and also whenever the item is
 *     found outside the target phase, which is what makes a move a move rather
 *     than a duplication.
 *
 * A protocol with no version reads as one open-ended phase with no items
 * (`parseProtocolContent(null)`), so the add path needs no special case: the
 * item is appended to that phase and the save writes v1 — which is exactly what
 * the Coach's `update_protocol` does on the same protocol.
 */
export function applyItemToContent(
  live: ProtocolContent,
  item: ProtocolItem,
  opts: ApplyItem
): ProtocolContent {
  const remove = opts.remove === true;
  const last = Math.max(live.phases.length - 1, 0);
  const target = Math.min(Math.max(opts.phase, 0), last);
  return normalizeContent({
    phases: live.phases.map((phase, index) => {
      const without = phase.items.filter((existing) => existing.id !== item.id);
      if (remove || index !== target) return { ...phase, items: without };
      const held = phase.items.some((existing) => existing.id === item.id);
      return {
        ...phase,
        items: held
          ? phase.items.map((existing) => (existing.id === item.id ? item : existing))
          : [...without, item],
      };
    }),
  });
}

/** Which phase an item currently sits in, or −1 when the document has no such item. */
export function phaseOfItem(content: ProtocolContent, itemId: string | undefined): number {
  if (!itemId) return -1;
  return content.phases.findIndex((phase) => phase.items.some((item) => item.id === itemId));
}

/**
 * The auto-filled change note for a per-item save. Every item save IS a
 * version, so every one carries a note naming the item — a history of
 * unlabelled versions is a history nobody reads.
 */
export function itemChangeNote(
  title: string,
  kind: 'added' | 'edited' | 'removed'
): string {
  const verb = kind === 'added' ? 'Added' : kind === 'removed' ? 'Removed' : 'Edited';
  return `${verb} "${title}"`;
}
