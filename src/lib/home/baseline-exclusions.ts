/**
 * **Which days get no vote on what "normal" looks like** — one list, several
 * sources.
 *
 * A baseline is a claim about what a normal day looks like for this person
 * (readiness.ts says so where it filters), so the interesting question is never
 * *"is this day odd"* but *"which kinds of odd does ARC know about"*. Today
 * there are two, and there will be more:
 *
 *   - **`timezone-change`** — the day the device's zone moved (D4, 0053). It was
 *     `24 + Δ` hours long, and a 29-hour day inflates steps and active energy by
 *     ~20% before you count that an airport day can triple the step count.
 *   - **`away`** — an ordinary 24 hours lived under someone else's sun, inside a
 *     derived trip (0060, src/lib/timezone/trips.ts). Not odd in LENGTH, odd in
 *     COHORT: a fortnight of jet-lagged mornings sitting unmarked in a 30-day
 *     window drags the home baseline down for a month after the return, and
 *     post-trip mornings then read `optimal` against a depressed mean.
 *
 * ## Why this is a module and not two filters at the call site
 *
 * Because the next source is already being built. `readiness.ts` had exactly one
 * predicate inlined beside its baselines; adding a second there, and a third
 * after it, is how a "days that don't count" rule ends up spelled three
 * different ways in three windows that are supposed to agree. The contract
 * instead is: **one set to filter on, and a named source for every day in it.**
 *
 * A new source is a key in {@link BaselineExclusionSource}, a block in
 * {@link baselineExclusionsIn}, and nothing else. In particular it must NOT add
 * a second excluded-set argument to `baselinePoints`, a second union at the
 * `deriveReadiness` call site, or its own copy of the window arithmetic — the
 * whole value here is that `days` stays the only thing a baseline filters on.
 *
 * `bySource` exists because the copy has to be honest about WHICH kind of day is
 * missing: *"paused while away from UTC−8"* is a different sentence from *"12%
 * below your 30-day baseline (home days)"*, and both are different again from
 * whatever a day the user himself marked will want to say. Asking `days` alone
 * cannot tell them apart.
 *
 * Pure over the {@link Database} interface; headless-tested in
 * db/timezone.test.mjs §14/§15.
 */
import type { Database } from '@/lib/db/database';
import { awayDaysIn, timezoneChangedDaysIn } from '@/lib/db/repositories/day-meta';

/** Why a day is barred from the baselines. Add a member, add a block. */
export type BaselineExclusionSource = 'timezone-change' | 'away';

export type BaselineExclusions = {
  /**
   * Every excluded day, whatever barred it — and the ONLY thing a baseline
   * filters on. A day may be named by more than one source; it appears once.
   */
  days: ReadonlySet<string>;
  /** The days each source contributed, for copy that has to name the reason. */
  bySource: ReadonlyMap<BaselineExclusionSource, ReadonlySet<string>>;
};

/** Nothing is excluded — the shared empty answer, so the common path allocates none. */
export const NO_EXCLUSIONS: BaselineExclusions = {
  days: new Set(),
  bySource: new Map(),
};

/**
 * The excluded days in the inclusive window `from … to`.
 *
 * **Excluded, never deleted.** Every one of these days still renders its own
 * reading in the metrics strip, still stands in every trend window (those are
 * fixed-length by construction, and a long day genuinely contained more), and
 * still carries its own Sleep and Recovery verdicts — four hours on a plane is a
 * reason to back off *because* it was four hours. They are barred from deciding
 * what normal means, and from nothing else.
 */
export function baselineExclusionsIn(
  db: Database,
  from: string,
  to: string,
  today?: string
): BaselineExclusions {
  if (to < from) return NO_EXCLUSIONS;

  const bySource = new Map<BaselineExclusionSource, ReadonlySet<string>>();
  const days = new Set<string>();
  const add = (source: BaselineExclusionSource, found: Set<string>): void => {
    if (found.size === 0) return;
    bySource.set(source, found);
    for (const day of found) days.add(day);
  };

  add('timezone-change', timezoneChangedDaysIn(db, from, to));
  add('away', awayDaysIn(db, from, to, today));

  return { days, bySource };
}

/** Does any day in the window come from this source? The copy's gate. */
export function hasExclusionSource(
  exclusions: BaselineExclusions,
  source: BaselineExclusionSource
): boolean {
  return (exclusions.bySource.get(source)?.size ?? 0) > 0;
}
