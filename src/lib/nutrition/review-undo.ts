/**
 * Undo for the estimate review's × — the one removal of a food that had none
 * (owner, device, 2026-09-23: *"undo for removing a food"*; the gap an
 * independent check found after round 8, docs/nutrition-subapp.md §14).
 *
 * Photo and Describe land on the review sheet (`app/meal-estimate.tsx`), and so
 * does a correction (`app/meal-revise.tsx`). A mis-tapped × there dropped the
 * model's item — a composite's parts with it — with no way back short of
 * estimating the meal again, which is a second model call and a different
 * answer. Every removal of a LOGGED food already had an Undo
 * (src/lib/nutrition/undo-offers.ts); this is the draft's.
 *
 * ## Why this is not the logged Undo's slot
 *
 * Nothing on the review is saved, so there is nothing to write back and nothing
 * to hold on disk: the Undo is the rows as they were, in the screen's own
 * state, beside the rows themselves (src/hooks/use-review-draft.ts). Putting it
 * in `undo-store.ts`' module slot would have a draft × settle — and so finish —
 * a logged removal it has nothing to do with. What IS shared is what the row
 * says: `removalWords`, so both read `Removed Latte · 126 kcal` word for word.
 *
 * ## Exact, or not offered
 *
 * The Undo puts back the very row object that was removed, at the very index
 * it left — a composite with its parts, its count and its disclosure; a part
 * at its place among its siblings. Only the transient baselines of a field
 * being typed into when it went are dropped (a field that unmounted has no
 * focus left to snapshot from). So a row comes back with exactly the figures
 * it had, answered questions included, because an answer's effect is ON the
 * row.
 *
 * It stands only while putting it back is still exact:
 *
 * - **A top-level row** — a plain item, a whole dish, or a dish whose last part
 *   took it (0058 invariant 4) — stands while the list is the list the removal
 *   left. Edits to OTHER rows do not close it: a row's figures are its own, so
 *   the latte comes back right beside a croissant retyped from 60 to 80 g.
 * - **A part** stands only while its dish is exactly as the removal left it:
 *   the same parts, the same count, the same whole. A dish halved, re-counted
 *   or re-portioned since would take back a part priced for a different dish.
 * - **Any answered question closes it**, and so does a new estimate — the
 *   screens hand the question hook the CLOSING setter (`replaceDraft`).
 *   This is the question state staying consistent: answers are a trail whose
 *   entries hold the rows as they stood before each answer
 *   (`answerQuestion`, review-rows.ts). An answer given after the × was applied
 *   to rows without the row; putting the row back then would bring it back
 *   WITHOUT that answer's effect while its chip stayed lit — and the next
 *   change to the answer, rebuilt from that entry's base, would drop the row
 *   again. Closing is the precedent's own rule (the meal screen closes its
 *   offer on any other write made there). An Undo taken BEFORE any later answer
 *   is exact the other way round: the answers given before the × are already
 *   on the row, and their bases never lost it.
 *
 * One offer at a time: the next × replaces it, as on every list. No timer.
 *
 * Pure and DB-free, so db/nutrition-v2.test.mjs drives it headlessly.
 */
import {
  currentPortion,
  isComposite,
  removeRow,
  type ReviewItem,
  type ReviewRow,
  rolled,
} from './review-rows';
import { removalWords, type UndoWords } from './undo-store';

/** One × on the review, and what it takes to put it back. */
export type DraftRemoval =
  | {
      /** A top-level row went: a plain item, a whole dish (its header's ×), or
       *  a dish whose last part took it with it. */
      kind: 'row';
      /** Where it stood among the top-level rows. */
      index: number;
      /** The row itself, exactly as it was — a dish with its parts. */
      row: ReviewItem;
      /** The top-level keys the removal left, in order. */
      left: string[];
      name: string;
      kcal: number | null;
    }
  | {
      /** One part of a dish that still has others. */
      kind: 'part';
      parentKey: string;
      /** Where it stood among the dish's parts. */
      index: number;
      part: ReviewRow;
      left: string[];
      /** The dish as the removal left it — the Undo stands only while it is
       *  still exactly this. */
      leftParts: ReviewRow[];
      leftCount: number | null;
      leftWhole: number | null;
      name: string;
      kcal: number | null;
    };

/** The review's rows, and the one removal that can still be put back. */
export type ReviewDraft = { rows: ReviewItem[]; removed: DraftRemoval | null };

export const EMPTY_DRAFT: ReviewDraft = { rows: [], removed: null };

const keysOf = (rows: ReviewItem[]): string[] => rows.map((row) => row.key);

const sameKeys = (rows: ReviewItem[], keys: string[]): boolean =>
  rows.length === keys.length && rows.every((row, i) => row.key === keys[i]);

/** The same part OBJECTS — every edit in review-rows.ts builds a new part, so
 *  an unchanged reference is an unchanged part. */
const sameParts = (a: ReviewRow[], b: ReviewRow[]): boolean =>
  a.length === b.length && a.every((part, i) => part === b[i]);

/** What the row said it weighed in energy, as the Items total read it. */
const kcalOfRow = (row: ReviewItem): number | null =>
  isComposite(row) ? rolled(row).kcal : (currentPortion(row).kcal ?? null);

/**
 * The × — {@link removeRow}, remembered. A key that names nothing removes
 * nothing and leaves the open offer as it was.
 */
export function removeRowWithUndo(draft: ReviewDraft, key: string): ReviewDraft {
  const index = draft.rows.findIndex((row) => row.key === key);
  const row = draft.rows[index];
  if (row) {
    const rows = removeRow(draft.rows, key);
    return {
      rows,
      removed: {
        kind: 'row',
        index,
        row,
        left: keysOf(rows),
        name: row.name,
        kcal: kcalOfRow(row),
      },
    };
  }
  const parentIndex = draft.rows.findIndex((r) => r.components.some((c) => c.key === key));
  const parent = draft.rows[parentIndex];
  const partIndex = parent ? parent.components.findIndex((c) => c.key === key) : -1;
  const part = parent?.components[partIndex];
  if (!parent || !part) return draft;
  const rows = removeRow(draft.rows, key);
  // The name and the energy are the PART's, as the meal screen's receipt says
  // them (`takeMealItem`): it is the row that was tapped.
  const name = part.name;
  const kcal = currentPortion(part).kcal ?? null;
  if (parent.components.length === 1) {
    // Invariant 4: the dish went with its last part, so the dish comes back.
    return {
      rows,
      removed: { kind: 'row', index: parentIndex, row: parent, left: keysOf(rows), name, kcal },
    };
  }
  const after = rows.find((row) => row.key === parent.key);
  return {
    rows,
    removed: after
      ? {
          kind: 'part',
          parentKey: parent.key,
          index: partIndex,
          part,
          left: keysOf(rows),
          leftParts: after.components,
          leftCount: after.pieces?.count ?? null,
          leftWhole: after.wholeCount,
          name,
          kcal,
        }
      : null,
  };
}

/** Whether putting the removal back would still be exact (see the header). */
export function draftUndoStands(draft: ReviewDraft): boolean {
  const removed = draft.removed;
  if (!removed || !sameKeys(draft.rows, removed.left)) return false;
  if (removed.kind === 'row') return true;
  const dish = draft.rows.find((row) => row.key === removed.parentKey);
  return (
    dish !== undefined &&
    sameParts(dish.components, removed.leftParts) &&
    (dish.pieces?.count ?? null) === removed.leftCount &&
    dish.wholeCount === removed.leftWhole
  );
}

/** A row put back with no field focused on it: the figures stay, the
 *  baselines of a field that unmounted mid-edit go (review-rows.ts' invariant:
 *  `scaleFrom` and `countFrom` are always dropped together). */
function settled(row: ReviewItem): ReviewItem {
  return { ...row, scaleFrom: null, countFrom: null, countText: null, wholeText: null };
}

/**
 * Undo: the removed row back where it stood, exactly. A removal that no longer
 * stands puts nothing back and closes — the row that offered it is not drawn
 * by then ({@link draftUndoWords}), so this is the guard, not the path.
 */
export function undoDraftRemoval(draft: ReviewDraft): ReviewDraft {
  const removed = draft.removed;
  if (!removed || !draftUndoStands(draft)) return { rows: draft.rows, removed: null };
  if (removed.kind === 'row') {
    const rows = [...draft.rows];
    rows.splice(removed.index, 0, settled(removed.row));
    return { rows, removed: null };
  }
  return {
    rows: draft.rows.map((row) => {
      if (row.key !== removed.parentKey) return row;
      const components = [...row.components];
      components.splice(removed.index, 0, removed.part);
      // The parts changed back, so any baseline taken over the four is stale.
      return { ...row, components, scaleFrom: null, countFrom: null };
    }),
    removed: null,
  };
}

/**
 * A table edit — an amount, a count, a fraction chip, a disclosure. The
 * removal stays open while it is still exact, and closes the moment it is not.
 */
export function editDraft(
  draft: ReviewDraft,
  change: (rows: ReviewItem[]) => ReviewItem[]
): ReviewDraft {
  const next = { rows: change(draft.rows), removed: draft.removed };
  return draftUndoStands(next) ? next : { rows: next.rows, removed: null };
}

/** The rows replaced from outside the table — a fresh estimate, or an answered
 *  question. Always closes the removal (see the header, on the question trail). */
export function replaceDraftRows(rows: ReviewItem[]): ReviewDraft {
  return { rows, removed: null };
}

/**
 * The hook's `replace` setter as a pure step, so the suite drives the very
 * function the screens call. `next` is what a `setRows` receives — the rows, or
 * an updater over the rows as they stand (the question hook passes updaters).
 * It closes the removal EVEN when the rows come back with the same keys, as an
 * answer that only scales a row does: that is the case {@link editDraft} would
 * keep open, and the one that must not be.
 */
export function replaceDraft(
  draft: ReviewDraft,
  next: ReviewItem[] | ((rows: ReviewItem[]) => ReviewItem[])
): ReviewDraft {
  return replaceDraftRows(typeof next === 'function' ? next(draft.rows) : next);
}

/** What the Undo row says, or null when there is nothing to put back. */
export function draftUndoWords(draft: ReviewDraft): UndoWords | null {
  if (!draft.removed || !draftUndoStands(draft)) return null;
  return removalWords(draft.removed.name, draft.removed.kcal);
}
