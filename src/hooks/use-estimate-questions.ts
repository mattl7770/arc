import { useRef, useState } from 'react';

import type { QuestionAnswers, QuestionHandlers } from '@/components/nutrition/estimate-review';
import { getDb } from '@/lib/db/client';
import {
  type EstimateQuestion,
  groundMealEstimate,
  MealEstimationUnavailableError,
  reviseMeal,
} from '@/lib/nutrition/estimate';
import {
  applyAnswer,
  carryWholes,
  type ReviewItem,
  rowsFromEstimate,
  rowsToRevisionSubject,
} from '@/lib/nutrition/review-rows';

/**
 * The clarifying-question state both estimator screens share (backlog C5).
 *
 * The owner's five rules land here: any AI logging method may ask, at most
 * three questions, every answer is a button, an unanswered question never
 * blocks Save, and the one typed answer costs a second call.
 *
 * ## Why the answers are applied from a per-question BASE
 *
 * Choosing an answer is arithmetic over the review rows — the effect travelled
 * with the estimate, so nothing is re-requested. But a user changes his mind,
 * and applying a second effect on top of the first would COMPOUND: "2 shots"
 * then "3 shots" would multiply the espresso twice.
 *
 * So the first time a question is answered, the rows as they stand are frozen
 * as that question's base, and every later answer to it is applied to that base
 * instead. Answering, then changing the answer, therefore produces exactly the
 * state that choosing the second option first would have — and Skip restores
 * the base, which is the unanswered estimate.
 *
 * The cost, stated because it is real: a hand-edit made between two answers to
 * the SAME question is lost when the answer changes. That is the price of "no
 * accumulation", and it is the right side of the trade — a silently doubled
 * portion is a wrong record, while a re-typed gram figure is an annoyance.
 */
export type EstimateQuestionsState = {
  questions: EstimateQuestion[];
  /** Install the questions a fresh estimate came back with (and clear the rest). */
  begin: (questions: EstimateQuestion[]) => void;
  answers: QuestionAnswers;
  otherFor: string | null;
  otherText: string;
  otherBusy: boolean;
  handlers: QuestionHandlers;
};

/** Marks a question answered by TYPING — no chip is lit, but the tally counts
 *  it and Undo restores the base, exactly as for a chip. */
const ANSWERED_BY_TYPING = -1;

export function useEstimateQuestions(opts: {
  rows: ReviewItem[];
  setRows: React.Dispatch<React.SetStateAction<ReviewItem[]>>;
  /** The meal's name, for the typed answer's second call. */
  mealName: () => string;
  /** How the screen shows a failed second call. */
  onError: (message: string) => void;
  /** The rows are a LOGGED meal's (the Adjust screen): a count that comes back
   *  from the typed answer is what was eaten, with no whole — see
   *  `rowsFromEstimate`. */
  countIsEaten?: boolean;
}): EstimateQuestionsState {
  const [questions, setQuestions] = useState<EstimateQuestion[]>([]);
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [otherFor, setOtherFor] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');
  const [otherBusy, setOtherBusy] = useState(false);
  // A ref, not state: the base is read inside the same updater that writes the
  // rows, and a state read there would see the previous render's value.
  const basesRef = useRef<Record<string, ReviewItem[]>>({});
  const abortRef = useRef<AbortController | null>(null);

  const begin = (next: EstimateQuestion[]) => {
    basesRef.current = {};
    setQuestions(next);
    setAnswers({});
    setOtherFor(null);
    setOtherText('');
    setOtherBusy(false);
  };

  const answer = (id: string, index: number | null) => {
    const question = questions.find((q) => q.id === id);
    if (!question) return;
    opts.setRows((prev) => {
      const base = basesRef.current[id] ?? prev;
      basesRef.current[id] = base;
      if (index === null) return base;
      const option = question.options[index];
      return option ? applyAnswer(base, option.effect) : prev;
    });
    setAnswers((prev) => ({ ...prev, [id]: index }));
    if (index === null && otherFor === id) {
      setOtherFor(null);
      setOtherText('');
    }
  };

  /**
   * The ONE second model call this feature makes: `reviseMeal`-shaped, over the
   * rows as they now stand plus the typed sentence. **Text only — the photo is
   * never resent**, because `messages` carries no prompt-cache breakpoint and a
   * resent image is billed in full every time.
   *
   * The reply's own questions are discarded: asking again in answer to a typed
   * answer is a loop.
   */
  const applyOther = async (id: string) => {
    const said = otherText.trim();
    if (said === '' || otherBusy) return;
    const question = questions.find((q) => q.id === id);
    if (!question) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setOtherBusy(true);
    // The base for this question, so a typed answer replaces a chip rather than
    // stacking on it — the same rule the chips follow.
    const base = basesRef.current[id] ?? opts.rows;
    basesRef.current[id] = base;
    try {
      const revised = groundMealEstimate(
        getDb(),
        await reviseMeal(
          rowsToRevisionSubject(opts.mealName(), base),
          `${question.ask} ${said}`,
          controller.signal
        )
      );
      // The model was sent each dish's count EATEN; `carryWholes` gives back the
      // "of 8" it was sent without, so `ate 3 of 8` does not return as `3 of 3`.
      opts.setRows(
        carryWholes(base, rowsFromEstimate(getDb(), revised, { countIsEaten: opts.countIsEaten }))
      );
      setAnswers((prev) => ({ ...prev, [id]: ANSWERED_BY_TYPING }));
      setOtherFor(null);
      setOtherText('');
    } catch (error) {
      if (controller.signal.aborted) return;
      opts.onError(
        error instanceof MealEstimationUnavailableError
          ? error.message
          : 'Couldn’t apply that answer. Pick one of the options, or edit the amounts by hand.'
      );
    } finally {
      setOtherBusy(false);
    }
  };

  return {
    questions,
    begin,
    answers,
    otherFor,
    otherText,
    otherBusy,
    handlers: {
      onAnswer: answer,
      onOpenOther: (id) => {
        setOtherFor(id);
        setOtherText('');
      },
      onOtherText: setOtherText,
      onApplyOther: (id) => void applyOther(id),
      onCancelOther: () => {
        setOtherFor(null);
        setOtherText('');
      },
    },
  };
}
