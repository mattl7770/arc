import { useEffect, useRef, useState } from 'react';

import type { QuestionAnswers, QuestionHandlers } from '@/components/nutrition/estimate-review';
import { getDb } from '@/lib/db/client';
import {
  type EstimateQuestion,
  groundMealEstimate,
  MealEstimationUnavailableError,
  reviseMeal,
} from '@/lib/nutrition/estimate';
import {
  type AnsweredQuestion,
  answerQuestion,
  answersOf,
  carryWholes,
  type ReviewItem,
  rowsBeforeAnswer,
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
 * ## Why the answers are a TRAIL (2026-09-23)
 *
 * Choosing an answer is arithmetic over the review rows — the effect travelled
 * with the estimate, so nothing is re-requested. But a user changes his mind,
 * and applying a second effect on top of the first would COMPOUND: "2 shots"
 * then "3 shots" would multiply the espresso twice.
 *
 * This hook used to freeze a base PER QUESTION and re-apply a changed answer to
 * that base alone — which fixed compounding and broke composing: answer the
 * milk, then the shots, then change the milk, and the shots were silently
 * undone while their chip stayed lit. The whole of the logic now lives in
 * `answerQuestion` (src/lib/nutrition/review-rows.ts), pure and tested
 * (db/nutrition-v2.test.mjs §57): answers are kept in the order they were first
 * given, each with the rows before it, and changing one replays every later one
 * on top. This hook holds the trail and the screen's rows, and nothing else.
 *
 * The cost, stated because it is real: a hand edit made after a question was
 * first answered is lost when that answer changes. That is the price of "no
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
  // Refs, not state: the typed answer resolves after an await, and must read
  // the trail and the rows as they stand THEN, not as this render saw them.
  const trailRef = useRef<AnsweredQuestion[]>([]);
  const rowsRef = useRef<ReviewItem[]>(opts.rows);
  // Committed rows only — a hand edit on the table lands here before the next
  // answer reads it.
  useEffect(() => {
    rowsRef.current = opts.rows;
  }, [opts.rows]);
  const abortRef = useRef<AbortController | null>(null);

  const begin = (next: EstimateQuestion[]) => {
    trailRef.current = [];
    setQuestions(next);
    setAnswers({});
    setOtherFor(null);
    setOtherText('');
    setOtherBusy(false);
  };

  const settle = (next: { trail: AnsweredQuestion[]; rows: ReviewItem[] }) => {
    trailRef.current = next.trail;
    rowsRef.current = next.rows;
    opts.setRows(next.rows);
    setAnswers(answersOf(next.trail));
  };

  const answer = (id: string, index: number | null) => {
    // A typed answer in flight was asked over the rows as they stood; a chip
    // tapped under it would be replayed over rows the reply knows nothing of.
    if (otherBusy) return;
    const question = questions.find((q) => q.id === id);
    if (!question) return;
    const option = index === null ? null : question.options[index];
    if (index !== null && !option) return;
    settle(
      answerQuestion(
        trailRef.current,
        rowsRef.current,
        id,
        option && index !== null ? { kind: 'option', index, effect: option.effect } : null
      )
    );
    if (index === null && otherFor === id) {
      setOtherFor(null);
      setOtherText('');
    }
  };

  /**
   * The ONE second model call this feature makes: `reviseMeal`-shaped, over the
   * rows as they stood before this question's own answer, plus the typed
   * sentence. **Text only — the photo is never resent**, because `messages`
   * carries no prompt-cache breakpoint and a resent image is billed in full
   * every time.
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
    // So a typed answer replaces a chip rather than stacking on it — the same
    // rule the chips follow.
    const base = rowsBeforeAnswer(trailRef.current, rowsRef.current, id);
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
      const back = rowsFromEstimate(getDb(), revised, { countIsEaten: opts.countIsEaten });
      const rows = carryWholes(base, back);
      settle(answerQuestion(trailRef.current, rowsRef.current, id, { kind: 'typed', rows }));
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
