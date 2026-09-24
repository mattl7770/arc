/**
 * The status sheet's header — one sentence, or nothing.
 *
 * *"Traveling since Sep 12 · Sick since today — skips excused · readiness
 * baselines exclude 4 status days"*
 *
 * ## Why it is said at all
 *
 * The forgotten open status is the failure mode the retired Modes system
 * actually shipped: a mode set once from a picker, open-ended, quietly
 * excusing every day for a month. This build answers it with **visibility
 * gated on the consequence, not on an expiry** — there is no automatic
 * timeout (a rule with a number about biology). `information-architecture.md`'s
 * *"never silently on"* rule is kept in two halves:
 *
 *   - **What is on** is on the status door itself, on Home and on the Coach
 *     tab, without opening anything (src/components/status/status-control.tsx).
 *   - **How long, and what it is doing to his numbers** is this sentence, the
 *     header of the sheet that door opens.
 *
 * ## Why it moved off Home (2026-09-23)
 *
 * Until then it was a mono line above Home's hero. The owner, on the device:
 * *"the message is there, but i think it would be better if the status button
 * just changed to say 'Sick' or whatever the currently active status is."* Once
 * the door names the status, a line naming it again just beneath the door is
 * the same fact twice, which CLAUDE.md §5 forbids — so the name went to the door
 * and the rest of the line came here, unchanged in wording. The sentence still
 * names every status, because the sheet holds more than one and each age has to
 * say whose it is.
 *
 * ## The last clause REPLACES, it does not accumulate
 *
 * Above zero excluded days it names the count. Once the exclusion is what is
 * stopping Recovery grading, it says that instead — one clause, escalating,
 * never two. And it is gated on `recoveryPausedByStatus` rather than on
 * "Recovery is unknown": on a phone with no watch Recovery has no verdict for
 * a reason that predates this morning's status by months, and blaming the
 * status there would be a lie the user could check (readiness.ts argues it
 * where the counterfactual is computed).
 *
 * Pure values in, one string out — no database, no clock, no React.
 */
import { shortDate } from '@/lib/experiments/format';

import { displayStatus } from './chips';

export type StatusLineInput = {
  /** Today's running statuses, newest started first. */
  open: readonly { label: string; start_date: string; excuses: number }[];
  today: string;
  /** From `deriveReadiness` — days in the baseline window a status barred. */
  excludedStatusDays: number;
  /** From `deriveReadiness` — is the status why Recovery cannot grade? */
  recoveryPausedByStatus: boolean;
};

/** The sentence, or null on an ordinary day — when the sheet prints nothing. */
export function statusLine(input: StatusLineInput): string | null {
  if (input.open.length === 0) return null;

  const named = input.open
    .map(
      (row) =>
        `${displayStatus(row.label)} since ${
          row.start_date === input.today ? 'today' : shortDate(row.start_date)
        }`
    )
    .join(' · ');

  // The day is excused if ANY open status excuses it — the same reading
  // `excusingStatusDaysIn` applies, and the reason it is stated at all is that
  // the flag is the Coach's to set (the owner's Q2(b)), so the user has to be
  // able to see which way it went without opening a thread.
  const excused = input.open.some((row) => row.excuses === 1);
  const parts = [named, excused ? 'skips excused' : 'skips still count'];

  if (input.recoveryPausedByStatus) parts.push('no recovery verdict until it ends');
  else if (input.excludedStatusDays > 0) {
    parts.push(
      `readiness baselines exclude ${input.excludedStatusDays} status day${
        input.excludedStatusDays === 1 ? '' : 's'
      }`
    );
  }

  // Em dash before the judgement, middle dot between facts — the same
  // punctuation the timezone line uses for the same two jobs.
  return `${parts[0]} — ${parts.slice(1).join(' · ')}`;
}
