/**
 * The Coach's read — the ONE place a language model may write into a report
 * (docs/reports-subapp.md §6a).
 *
 * Opt-in per report (⚑ MATT #5, decided 2026-08-12), self-review only, and
 * key-gated. Three constraints hold it in place, and each is structural rather
 * than a convention someone has to remember:
 *
 *   1. **Its entire context is the deterministic `ReportData` already
 *      assembled.** The model is not given database access and gets no tools
 *      (`tools: []`, and an `executeTool` that can only return an empty
 *      string), so it cannot reach a number ARC did not compute. It reads the
 *      report and writes about the report.
 *   2. **Its output never enters `data_json`.** It travels as a separate value
 *      to a separate column (0036's `narrative_text`), and both renderers take
 *      it as a separate parameter. There is no field on `ReportData` it could
 *      be written into.
 *   3. **The doctor pack cannot have one.** `renderDoctorPack` takes no
 *      narrative parameter and {@link generateCoachRead} rejects a doctor pack
 *      outright. Refusing at both ends means neither a UI bug nor a future
 *      caller can put model prose in front of a clinician.
 *
 * The model client is the Coach's own (`runCoachTurn`), never a second HTTP
 * stack — the same reuse `src/lib/labs/parse.ts` and `src/lib/nutrition/estimate.ts`
 * already make.
 */
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { runCoachTurn, type FetchLike, type WireMessage } from '@/lib/ai/model-client';

import type { CoachRead, ReportData, SelfReviewData } from './types';

/**
 * The rubric printed above the prose, verbatim, on every surface that shows it.
 *
 * Authored ONCE and re-applied on read (see `readNarrative` in
 * src/lib/db/repositories/reports.ts) rather than frozen into each row: the
 * model's words are the durable thing, the frame around them is ARC's copy, and
 * a clearer wording should reach reports already generated.
 */
export const COACH_READ_ATTRIBUTION =
  "Coach's read — written by the model over the numbers above. Everything numeric in " +
  'this report was computed by ARC, not the model.';

/** Thrown when no key is set, or the streaming fetch is absent (pre-rebuild). */
export class CoachReadUnavailableError extends Error {
  constructor() {
    super('The Coach needs an API key — Settings › Coach.');
    this.name = 'CoachReadUnavailableError';
  }
}

/**
 * `expo/fetch` streams response bodies in React Native (WHATWG fetch there does
 * not). Required lazily in a try/catch so this module can be imported by the
 * headless suites and by a route file without a module-scope native throw.
 */
function loadStreamingFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo/fetch') as { fetch?: unknown };
    return (mod.fetch ?? null) as FetchLike | null;
  } catch {
    return null;
  }
}

/**
 * The system prompt.
 *
 * Its whole job is restraint, the same way the meal-revision prompt's is. The
 * failure mode here is not a wrong number — the model has no way to produce
 * one — it is a model that pads three real observations into eight paragraphs
 * of wellness copy, or that quietly re-states a figure with a different
 * rounding and makes the reader wonder which one is right.
 */
export const COACH_READ_SYSTEM =
  'You are ARC Coach, reading a report that has already been computed. Your voice is calm, ' +
  'precise, evidence-seeking and slightly ruthless. Never generic, never hypey.\n\n' +
  'You are given the complete report as JSON. Every figure in it was computed by ' +
  'deterministic, tested code from the user\'s own device.\n\n' +
  'Write a short read of it — 120 to 200 words, plain prose, no headings, no bullet ' +
  'lists, no markdown.\n\n' +
  'RULES, in order of importance:\n' +
  '1. Do NOT restate figures the reader can see. Quote a number only when the point ' +
  'depends on it, and then quote it EXACTLY as the report words it — never re-round, ' +
  'never re-unit, never compute a new one (no percentages, ratios or totals of your own).\n' +
  '2. Say what the period actually shows: what held, what moved, what did not get done. ' +
  'Where a section says a comparison was within normal variation, treat it as no change — ' +
  'do not narrate it as a trend.\n' +
  '3. Name at most ONE thing worth changing, and only if the data supports it. If nothing ' +
  'does, say so plainly; an honest "nothing needs changing" is a real finding.\n' +
  '4. Absences are facts, not failures. Unlogged days and excused skips are information ' +
  'about the period, not a scolding opportunity.\n' +
  '5. Never give medical advice, never name a diagnosis, and flag uncertainty where it ' +
  'exists.\n' +
  '6. Write about THIS report only. You have no other context and must not imply you do.';

/** The user turn: the report, verbatim, as the model's entire evidence. */
export function buildCoachReadMessages(data: SelfReviewData): WireMessage[] {
  return [
    {
      role: 'user',
      content:
        `Here is the self-review for ${data.period.label} (${data.period.rangeLabel}), ` +
        `as the deterministic assembly produced it:\n\n` +
        `${JSON.stringify(data, null, 2)}\n\n` +
        'Write your read of it.',
    },
  ];
}

/**
 * Run the one model turn and return the attributed prose.
 *
 * Throws {@link CoachReadUnavailableError} when there is no key or no streaming
 * fetch — the caller disables the affordance up front and shows the honest
 * "add a key in Settings › Coach", so this is the belt to that braces.
 *
 * A doctor pack is refused here as well as being unrepresentable in the
 * renderer. Two independent refusals for one rule is deliberate: this is the
 * highest-cost mistake the feature could make.
 */
export async function generateCoachRead(
  data: ReportData,
  signal?: AbortSignal
): Promise<CoachRead> {
  if (data.kind !== 'self_review') {
    throw new Error('The doctor visit pack never carries model prose.');
  }
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new CoachReadUnavailableError();

  const model = apiKeyStore.getModel();
  let streamed = '';
  const result = await runCoachTurn(
    { apiKey, model, fetchImpl },
    { system: COACH_READ_SYSTEM, messages: buildCoachReadMessages(data), tools: [] },
    {
      onToken: (chunk) => {
        streamed += chunk;
      },
      signal,
      // No tools in a read turn; the model answers in text.
      executeTool: async () => ({ content: '' }),
    }
  );
  if (result.stopReason === 'refusal') {
    throw new Error('The model declined to write a read of this report.');
  }
  const text = (streamed.trim().length > 0 ? streamed : result.text).trim();
  if (text.length === 0) throw new Error('The model returned nothing to read.');
  return { text, attribution: COACH_READ_ATTRIBUTION, model };
}
