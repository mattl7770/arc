import { useCallback, useMemo, useState } from 'react';

import type { ReviewHandlers } from '@/components/nutrition/estimate-review';
import {
  beginCompositeScale,
  beginCountEdit,
  endCompositeScale,
  endCountEdit,
  type ReviewItem,
  scaleComposite,
  scaleCompositeTo,
  setCompositeCount,
  setCompositeWhole,
  setPiecesName,
  setRowAmount,
  toggleExpanded,
} from '@/lib/nutrition/review-rows';
import {
  draftUndoWords,
  EMPTY_DRAFT,
  editDraft,
  removeRowWithUndo,
  replaceDraft,
  type ReviewDraft,
  undoDraftRemoval,
} from '@/lib/nutrition/review-undo';
import type { UndoWords } from '@/lib/nutrition/undo-store';

/**
 * The estimate review's rows, and the Undo for its × — the state both
 * `app/meal-estimate.tsx` and `app/meal-revise.tsx` hold (2026-09-23).
 *
 * The rows and the one open removal are ONE piece of state, so a × computes
 * its removal from the rows as they are at that update, never from a render
 * that a blur landing in the same tick has already moved on from.
 *
 * Two setters, and which one a caller gets is the whole contract
 * (src/lib/nutrition/review-undo.ts):
 *
 * - `handlers` — every edit the table can make. An edit keeps the Undo open
 *   while putting the row back would still be exact, and the × is here too, so
 *   no screen can wire a removal without its Undo.
 * - `replace` — rows from OUTSIDE the table: a fresh estimate, and the question
 *   hook's answers (`useEstimateQuestions`' `setRows`). It always closes the
 *   Undo, so an answer given after a × can never leave a lit chip whose effect
 *   is not on the row the Undo would bring back.
 */
export type ReviewDraftState = {
  rows: ReviewItem[];
  handlers: ReviewHandlers;
  replace: React.Dispatch<React.SetStateAction<ReviewItem[]>>;
  /** What the Undo row says, or null when there is nothing to put back. */
  offer: UndoWords | null;
  undo: () => void;
};

export function useReviewDraft(): ReviewDraftState {
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY_DRAFT);

  const edit = useCallback(
    (change: (rows: ReviewItem[]) => ReviewItem[]) => setDraft((d) => editDraft(d, change)),
    []
  );
  // Closing, always: `replaceDraft` (pinned by db/screens-render.test.mjs §25
  // and driven headlessly in db/nutrition-v2.test.mjs §70).
  const replace = useCallback<React.Dispatch<React.SetStateAction<ReviewItem[]>>>(
    (next) => setDraft((d) => replaceDraft(d, next)),
    []
  );
  const undo = useCallback(() => setDraft(undoDraftRemoval), []);

  /** Every edit the review table can make — the shared plate's whole contract
   *  (src/components/nutrition/estimate-review.tsx). */
  const handlers = useMemo<ReviewHandlers>(
    () => ({
      onAmountChange: (key, text) => edit((rows) => setRowAmount(rows, key, text)),
      onRemove: (key) => setDraft((d) => removeRowWithUndo(d, key)),
      onToggle: (key) => edit((rows) => toggleExpanded(rows, key)),
      onScale: (key, factor) => edit((rows) => scaleComposite(rows, key, factor)),
      onScaleTo: (key, text) => edit((rows) => scaleCompositeTo(rows, key, text)),
      onScaleBegin: (key) => edit((rows) => beginCompositeScale(rows, key)),
      onScaleEnd: (key) => edit((rows) => endCompositeScale(rows, key)),
      onCountChange: (key, text) => edit((rows) => setCompositeCount(rows, key, text)),
      onWholeChange: (key, text) => edit((rows) => setCompositeWhole(rows, key, text)),
      onCountBegin: (key) => edit((rows) => beginCountEdit(rows, key)),
      onCountEnd: (key) => edit((rows) => endCountEdit(rows, key)),
      onPiecesName: (key, name) => edit((rows) => setPiecesName(rows, key, name)),
    }),
    [edit]
  );

  return { rows: draft.rows, handlers, replace, offer: draftUndoWords(draft), undo };
}
