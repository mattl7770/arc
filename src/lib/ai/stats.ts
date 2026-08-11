/**
 * The small amount of real statistics the insights engine needs to stop crying
 * wolf.
 *
 * Before this, a detector fired on a threshold alone: HRV "down 5%" off three
 * readings versus three, and a correlation at |r| ≥ 0.5 with n = 8 — which is
 * p ≈ 0.20, so roughly one in five users with NO real effect would be told
 * their training tanks their recovery. A coach that says something untrue once
 * a week is worse than one that says less.
 *
 * No stats library: two small critical-value tables and Welch's t. Pure and
 * exact, headless-tested in db/insights.test.mjs.
 *
 * These gates decide only whether a difference is worth MENTIONING. They never
 * decide what it means — that judgment is the model's.
 */

/** Sample standard deviation (n−1). Null below two observations. */
export function stdev(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const ss = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(ss / (n - 1));
}

/**
 * Two-tailed t critical values at α = 0.05, by degrees of freedom. Sparse
 * table + step-down lookup: using the next LOWER df is conservative (a larger
 * critical value), which is the right direction for a detector that must not
 * over-fire.
 */
const T_CRITICAL_05: [df: number, t: number][] = [
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [6, 2.447],
  [7, 2.365],
  [8, 2.306],
  [10, 2.228],
  [12, 2.179],
  [15, 2.131],
  [20, 2.086],
  [25, 2.06],
  [30, 2.042],
  [40, 2.021],
  [60, 2.0],
  [120, 1.98],
];

export function tCritical(df: number): number {
  if (df < 1) return Infinity;
  // Step DOWN: use the largest tabulated df that does NOT exceed `df`. Fewer
  // degrees of freedom carry a LARGER critical value, so an untabulated df is
  // judged against a slightly stricter bar than it strictly needs — the safe
  // direction for a detector whose failure mode is crying wolf.
  //
  // The obvious loop (`if (df <= tableDf) return value`) steps UP instead, and
  // silently does the opposite: df = 11 would be judged at df = 12's 2.179
  // rather than df = 10's 2.228, loosening every gate that lands between two
  // table rows. df = 1 is the floor, so the seed below is never returned as-is.
  let critical = T_CRITICAL_05[0]![1];
  for (const [tableDf, value] of T_CRITICAL_05) {
    if (tableDf > df) break;
    critical = value;
  }
  // Past the last row the t distribution has all but converged on the normal
  // (1.96). We keep the table's 1.98 rather than dropping to the limit: it is
  // the same step-down rule, and being 1% strict on a 200-day window costs
  // nothing worth having.
  return critical;
}

/**
 * Two-tailed critical |r| at α = 0.05 for a Pearson correlation of n pairs.
 * Derived from the same t table: r_crit = t / sqrt(t² + df), df = n − 2.
 */
export function rCritical(n: number): number {
  const df = n - 2;
  if (df < 1) return 1;
  const t = tCritical(df);
  return t / Math.sqrt(t * t + df);
}

export type MeanDifference = {
  recentMean: number;
  baselineMean: number;
  /** Signed percent change of recent vs baseline. */
  changePct: number;
  /** True when the difference clears BOTH the practical and statistical bars. */
  significant: boolean;
};

/**
 * Compare two windows of observations.
 *
 * A difference must clear two independent bars to count:
 *
 *   PRACTICAL — at least `thresholdPct`. A statistically clean 0.4% HRV shift
 *   is real and utterly not worth a sentence.
 *
 *   STATISTICAL — Welch's t against the α = 0.05 critical value, so a swing
 *   inside the user's own day-to-day noise stays quiet. Welch (rather than
 *   Student's) because the two windows have different sizes and variances by
 *   construction: 7 days of recent data against 21 of baseline.
 *
 * Null when either window is too small to say anything at all.
 */
export function compareWindows(
  recent: number[],
  baseline: number[],
  thresholdPct: number,
  minPerWindow: number
): MeanDifference | null {
  if (recent.length < minPerWindow || baseline.length < minPerWindow) return null;

  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const baselineMean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  if (baselineMean === 0) return null;

  const changePct = ((recentMean - baselineMean) / Math.abs(baselineMean)) * 100;
  const practical = Math.abs(changePct) >= thresholdPct;

  const sdRecent = stdev(recent);
  const sdBaseline = stdev(baseline);
  if (sdRecent === null || sdBaseline === null) {
    return { recentMean, baselineMean, changePct, significant: false };
  }

  const varOverN = (sd: number, n: number) => (sd * sd) / n;
  const se = Math.sqrt(varOverN(sdRecent, recent.length) + varOverN(sdBaseline, baseline.length));

  // Zero variance in both windows: every reading identical. Any difference at
  // all is then as real as data gets, so the practical bar alone decides.
  if (se === 0) {
    return { recentMean, baselineMean, changePct, significant: practical };
  }

  const t = Math.abs(recentMean - baselineMean) / se;
  // Welch–Satterthwaite degrees of freedom.
  const numerator =
    (varOverN(sdRecent, recent.length) + varOverN(sdBaseline, baseline.length)) ** 2;
  const denominator =
    varOverN(sdRecent, recent.length) ** 2 / (recent.length - 1) +
    varOverN(sdBaseline, baseline.length) ** 2 / (baseline.length - 1);
  const df = denominator === 0 ? recent.length + baseline.length - 2 : numerator / denominator;

  return {
    recentMean,
    baselineMean,
    changePct,
    significant: practical && t >= tCritical(Math.floor(df)),
  };
}
