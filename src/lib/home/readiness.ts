/**
 * Readiness derivation — the seam that replaces Home's mock readiness/pillars/
 * metrics with real `wearable_data` (docs/wearables-subapp.md §6).
 *
 * PURE over the {@link Database} interface (headless-tested in
 * db/readiness.test.mjs). Deterministic, documented thresholds — no model call;
 * the Coach interprets, this derives. Evidence gates everywhere: a verdict
 * needs a ≥{@link BASELINE_MIN_DAYS}-day baseline or it is `unknown`, and every
 * missing signal renders as an honest gap ("—"), never a fake number.
 *
 * Data comes through the wearables repo's source-arbitrated day picks, so a
 * manual keypad HRV counts when it is all there is, and an Apple Watch (or a
 * future ring) wins when both exist.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';
import {
  dailyMetricSeries,
  deviceLabel,
  pickDailyMetric,
  type DailyMetricPoint,
} from '@/lib/db/repositories/wearables';
import { activeNutritionTargets, todayTotals } from '@/lib/db/repositories/nutrition';
import type { Metric, Pillar, Readiness, SignalLevel } from '@/types/home';

/** Days of history a baseline is computed over (today excluded). */
export const BASELINE_WINDOW_DAYS = 30;
/** Minimum baseline days before any verdict — n=2 baselines are noise. */
export const BASELINE_MIN_DAYS = 5;

/**
 * What Apple Health can deliver **in this binary** — three different facts that
 * an empty pillar cannot tell apart on its own, and which the reader needs
 * distinguished (00-design-spec.md §5: "no signal yet" and "not connected" are
 * not the same state).
 *
 *   - `unsupported` — the native module is not in this build. NOTHING can
 *     arrive, however well the vendor app is syncing into Apple Health. This is
 *     the state ARC has actually been in since the pipeline was written: the
 *     module rides an EAS rebuild that has not happened.
 *   - `disconnected` — the module is here, the user has not switched sync on.
 *   - `connected` — sync is on; an empty metric is a real gap, not a wiring one.
 *
 * Passed IN rather than read here, so this module stays pure over
 * {@link Database} and never touches the native seam (a static native import
 * under a path Expo Router can reach is an app-startup crash).
 */
export type HealthLink = 'unsupported' | 'disconnected' | 'connected';

/**
 * Hour of the local day after which the eating day is graded as finished.
 *
 * Before it, an intake below target is not yet a fact — a day at 11am is not a
 * failed day, and grading it as one is the same error as calling one logged
 * meal 'good'. Only the CEILING is judgable all day: calories already eaten
 * cannot be un-eaten.
 */
export const NUTRITION_DAY_CLOSE_HOUR = 20;

export type ReadinessOptions = {
  /** What the Apple Health link can deliver; defaults to `connected`. */
  link?: HealthLink;
  /** Local wall clock — injectable so the headless tests are deterministic. */
  now?: Date;
};

export type ReadinessView = {
  readiness: Readiness;
  pillars: Pillar[];
  metrics: Metric[];
  /** False when not a single wearable signal exists — Home's first-run state. */
  hasSignal: boolean;
};

const LEVEL_ORDER: SignalLevel[] = ['optimal', 'good', 'caution', 'poor'];

function worse(a: SignalLevel, b: SignalLevel): SignalLevel {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

function degrade(level: SignalLevel): SignalLevel {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? level : (LEVEL_ORDER[Math.min(index + 1, 3)] ?? level);
}

/** HRV today/baseline ratio → recovery level (spec §6). */
export function hrvLevel(ratio: number): SignalLevel {
  if (ratio >= 0.97) return 'optimal';
  if (ratio >= 0.9) return 'good';
  if (ratio >= 0.8) return 'caution';
  return 'poor';
}

/** RHR delta (bpm over baseline) → level, when HRV is absent. */
export function rhrLevel(delta: number): SignalLevel {
  if (delta <= 0) return 'optimal';
  if (delta <= 3) return 'good';
  if (delta <= 7) return 'caution';
  return 'poor';
}

/** Asleep minutes → sleep level. */
export function sleepLevel(minutes: number): SignalLevel {
  if (minutes >= 450) return 'optimal';
  if (minutes >= 390) return 'good';
  if (minutes >= 330) return 'caution';
  return 'poor';
}

/** Yesterday's load vs its baseline → strain level (low load = fresh). */
export function strainLevel(ratio: number): SignalLevel {
  if (ratio <= 0.75) return 'optimal';
  if (ratio <= 1.3) return 'good';
  if (ratio <= 1.7) return 'caution';
  return 'poor';
}

// --- Nutrition ----------------------------------------------------------------
//
// Until 2026-08-14 this pillar was `todayTotals(db, today).mealCount > 0 ?
// 'good' : 'unknown'` — logging ONE meal scored 'good'. That is a fact about
// whether the app was opened, not about nutrition, and it sat beside three
// pillars that are real derivations. The owner called it out; it is reworked
// here against the versioned targets that already exist (`nutrition_targets`,
// migration 0015, set in app/nutrition-targets.tsx).

/** Intake vs target → level. Symmetric: far UNDER is as wrong as far over. */
export function kcalLevel(ratio: number): SignalLevel {
  const off = Math.abs(1 - ratio);
  if (off <= 0.1) return 'optimal';
  if (off <= 0.2) return 'good';
  if (off <= 0.3) return 'caution';
  return 'poor';
}

/**
 * Protein vs target → level. One-sided on purpose, unlike calories: overshooting
 * a protein target is not a failure, so there is no upper band.
 */
export function proteinLevel(ratio: number): SignalLevel {
  if (ratio >= 1) return 'optimal';
  if (ratio >= 0.85) return 'good';
  if (ratio >= 0.7) return 'caution';
  return 'poor';
}

/** The calorie ratio past which the day has already overshot, whatever time it is. */
const KCAL_CEILING_RATIO = 1.1;

export type NutritionTotals = { kcal: number; protein_g: number; mealCount: number };
export type NutritionTargets = { kcal: number | null; protein_g: number | null };

/**
 * The nutrition pillar — graded against targets, and **honest about a day still
 * in progress**.
 *
 * Three states it must keep apart, none of which the old `mealCount > 0` rule
 * could express:
 *
 *   - *No targets set.* Nothing to grade against, so it says so rather than
 *     inventing a denominator. `nutrition_targets` deliberately seeds no default
 *     row (0015), so this is the honest first-run state, and the fix is one tap
 *     into the targets screen — which the note names.
 *   - *Day still open.* Falling short is not yet a fact. Only two things are:
 *     the calorie CEILING (already-eaten calories cannot be un-eaten) and a
 *     protein target already MET. Everything else waits, showing progress
 *     instead of a verdict, until {@link NUTRITION_DAY_CLOSE_HOUR}.
 *   - *Day closed.* Both halves grade, and the worse one wins — the same
 *     `worse()` rule the readiness verdict uses, so a hit protein target cannot
 *     paper over a 900-kcal overshoot.
 */
export function nutritionVerdict(
  totals: NutritionTotals,
  targets: NutritionTargets | null,
  dayClosed: boolean
): { level: SignalLevel; note?: string } {
  const hasTarget = targets && (targets.kcal !== null || targets.protein_g !== null);
  if (!hasTarget) {
    return { level: 'unknown', note: 'no daily targets set yet (Eat › Targets)' };
  }
  if (totals.mealCount === 0) {
    return { level: 'unknown', note: dayClosed ? 'nothing logged today' : 'nothing logged yet' };
  }

  const kcalTarget = targets.kcal;
  const proteinTarget = targets.protein_g;
  const kcal = kcalTarget !== null && kcalTarget > 0 ? kcalLevel(totals.kcal / kcalTarget) : null;
  const protein =
    proteinTarget !== null && proteinTarget > 0
      ? proteinLevel(totals.protein_g / proteinTarget)
      : null;

  if (dayClosed) {
    if (kcal === null && protein === null) return { level: 'unknown', note: 'no usable target' };
    const level = kcal === null ? protein! : protein === null ? kcal : worse(kcal, protein);
    return { level, note: nutritionProgressNote(totals, targets) };
  }

  // Day still open — only completed facts may grade it.
  if (kcalTarget !== null && kcalTarget > 0 && totals.kcal > kcalTarget * KCAL_CEILING_RATIO) {
    return {
      level: kcalLevel(totals.kcal / kcalTarget),
      note: `${fmtInt(totals.kcal - kcalTarget)} kcal over target already`,
    };
  }
  if (protein === 'optimal') {
    return { level: 'optimal', note: `protein target met · ${nutritionProgressNote(totals, targets)}` };
  }
  return { level: 'unknown', note: `${nutritionProgressNote(totals, targets)} · day in progress` };
}

/** "1,420 / 2,300 kcal · 94 / 180 g protein" — only the halves that have targets. */
function nutritionProgressNote(totals: NutritionTotals, targets: NutritionTargets): string {
  const parts: string[] = [];
  if (targets.kcal !== null && targets.kcal > 0) {
    parts.push(`${fmtInt(totals.kcal)} / ${fmtInt(targets.kcal)} kcal`);
  }
  if (targets.protein_g !== null && targets.protein_g > 0) {
    parts.push(`${fmtInt(totals.protein_g)} / ${fmtInt(targets.protein_g)} g protein`);
  }
  return parts.join(' · ');
}

/** Mean of the points strictly before `date`; null under the evidence gate. */
function baselineBefore(points: DailyMetricPoint[], date: string): number | null {
  const prior = points.filter((p) => p.date < date);
  if (prior.length < BASELINE_MIN_DAYS) return null;
  return prior.reduce((sum, p) => sum + p.value, 0) / prior.length;
}

function pointOn(points: DailyMetricPoint[], date: string): DailyMetricPoint | null {
  return points.find((p) => p.date === date) ?? null;
}

/** "1840" → "1,840" without Intl (Hermes-safe; same as use-data-overview). */
function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 432 → "7h 12m". */
function fmtSleep(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

/** "+4" / "−2" style signed delta. */
function fmtDelta(delta: number): string {
  const rounded = Math.round(delta);
  return rounded >= 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

/** "14% below your 30-day baseline" | "at your 30-day baseline" | above. */
function baselineSentence(ratio: number): string {
  const pct = Math.round(Math.abs(1 - ratio) * 100);
  if (pct < 1) return 'at your 30-day baseline';
  return ratio < 1 ? `${pct}% below your 30-day baseline` : `${pct}% above your 30-day baseline`;
}

/** The local day before a YYYY-MM-DD, parsed componentwise (never UTC-shifted). */
function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const prev = new Date(y, m - 1, d - 1);
  const mm = String(prev.getMonth() + 1).padStart(2, '0');
  const dd = String(prev.getDate()).padStart(2, '0');
  return `${prev.getFullYear()}-${mm}-${dd}`;
}

const VERDICT_LABEL: Record<SignalLevel, string> = {
  optimal: 'Primed',
  good: 'Ready',
  caution: 'Recovery low',
  poor: 'Back off today',
  unknown: 'No recovery signal yet',
};

/**
 * How many more days of history a baseline still needs. Zero once the
 * {@link BASELINE_MIN_DAYS} gate is cleared.
 *
 * This is the direct answer to the owner's *"do some of them just need a week or
 * two of data before they start transmitting?"* — no metric here needs a
 * fortnight. A baseline needs five prior days, so a verdict appears on the SIXTH
 * day of readings, and strain's sixth day is counted to yesterday rather than
 * today (it grades the load already completed), making it a seven-day wait from
 * a standing start.
 */
export function baselineDaysRemaining(points: DailyMetricPoint[], date: string): number {
  const prior = points.filter((p) => p.date < date).length;
  return Math.max(0, BASELINE_MIN_DAYS - prior);
}

/**
 * Why a derived pillar has no verdict — the authored half of an empty cell.
 *
 * The order matters: a wiring problem outranks a data problem. Telling someone
 * they need "5 more days of HRV" when the native module is not even in the
 * binary would be a true sentence pointing at the wrong thing, and they would
 * wait five days for nothing.
 */
function evidenceNote(opts: {
  link: HealthLink;
  hasHistory: boolean;
  daysRemaining: number;
  hasCurrent: boolean;
  /** What the signal is called: 'HRV or resting HR', 'activity', 'sleep'. */
  signal: string;
  /** What the current reading would cover: 'today', 'yesterday', 'last night'. */
  period: string;
}): string {
  if (!opts.hasHistory) {
    if (opts.link === 'unsupported') return 'Apple Health is not connected in this build';
    if (opts.link === 'disconnected') return 'Apple Health sync is switched off';
    return `no ${opts.signal} has arrived yet`;
  }
  if (opts.daysRemaining > 0) {
    const days = opts.daysRemaining === 1 ? 'day' : 'days';
    return `${opts.daysRemaining} more ${days} of ${opts.signal} before a baseline`;
  }
  return `no ${opts.signal} reading ${opts.period}`;
}

/** Derive the whole Home readiness view for `today`. */
export function deriveReadiness(
  db: Database,
  today: string = todayISODate(),
  options: ReadinessOptions = {}
): ReadinessView {
  const link: HealthLink = options.link ?? 'connected';
  const now = options.now ?? new Date();
  // --- Raw signals, source-arbitrated per day ------------------------------
  const hrvSeries = dailyMetricSeries(db, 'hrv', BASELINE_WINDOW_DAYS + 1, today);
  const rhrSeries = dailyMetricSeries(db, 'rhr', BASELINE_WINDOW_DAYS + 1, today);
  const hrvToday = pointOn(hrvSeries, today);
  const rhrToday = pointOn(rhrSeries, today);
  const hrvBaseline = baselineBefore(hrvSeries, today);
  const rhrBaseline = baselineBefore(rhrSeries, today);

  const sleepToday = pickDailyMetric(db, 'sleep_duration_min', today);
  const deepToday = pickDailyMetric(db, 'sleep_deep_min', today);

  const yesterday = dayBefore(today);
  const energySeries = dailyMetricSeries(db, 'active_energy_kcal', 29, yesterday);
  const energyYesterday = pointOn(energySeries, yesterday);
  const energyBaseline = baselineBefore(energySeries, yesterday);

  const stepsToday = pickDailyMetric(db, 'steps', today);

  const hasSignal =
    hrvSeries.length > 0 ||
    rhrSeries.length > 0 ||
    sleepToday !== null ||
    stepsToday !== null ||
    energySeries.length > 0;

  // --- Pillars ---------------------------------------------------------------
  const hrvRatio = hrvToday && hrvBaseline ? hrvToday.value / hrvBaseline : null;
  const rhrDelta = rhrToday && rhrBaseline !== null ? rhrToday.value - rhrBaseline : null;

  let recovery: SignalLevel = 'unknown';
  if (hrvRatio !== null) {
    recovery = hrvLevel(hrvRatio);
    // An elevated resting HR corroborates suppression — degrade one level.
    if (rhrDelta !== null && rhrDelta >= 5) recovery = degrade(recovery);
  } else if (rhrDelta !== null) {
    recovery = rhrLevel(rhrDelta);
  }

  const sleep: SignalLevel = sleepToday ? sleepLevel(sleepToday.value) : 'unknown';
  const strain: SignalLevel =
    energyYesterday && energyBaseline !== null && energyBaseline > 0
      ? strainLevel(energyYesterday.value / energyBaseline)
      : 'unknown';

  const targets = activeNutritionTargets(db, today);
  const nutrition = nutritionVerdict(
    todayTotals(db, today),
    targets ? { kcal: targets.kcal, protein_g: targets.protein_g } : null,
    now.getHours() >= NUTRITION_DAY_CLOSE_HOUR
  );

  // Recovery reads HRV first and falls back to RHR, so its evidence gap is
  // whichever of the two is FURTHEST along — reporting the HRV wait when RHR is
  // one day from a verdict would overstate how long is left.
  const recoveryDaysRemaining = Math.min(
    baselineDaysRemaining(hrvSeries, today),
    baselineDaysRemaining(rhrSeries, today)
  );

  const pillars: Pillar[] = [
    {
      label: 'Sleep',
      level: sleep,
      note:
        sleep === 'unknown'
          ? evidenceNote({
              link,
              hasHistory: sleepToday !== null,
              daysRemaining: 0,
              hasCurrent: false,
              signal: 'sleep',
              period: 'last night',
            })
          : undefined,
    },
    {
      label: 'Recovery',
      level: recovery,
      note:
        recovery === 'unknown'
          ? evidenceNote({
              link,
              hasHistory: hrvSeries.length > 0 || rhrSeries.length > 0,
              daysRemaining: recoveryDaysRemaining,
              hasCurrent: hrvToday !== null || rhrToday !== null,
              signal: 'HRV or resting heart rate',
              period: 'today',
            })
          : undefined,
    },
    { label: 'Nutrition', level: nutrition.level, note: nutrition.note },
    {
      label: 'Strain',
      level: strain,
      note:
        strain === 'unknown'
          ? evidenceNote({
              link,
              hasHistory: energySeries.length > 0,
              daysRemaining: baselineDaysRemaining(energySeries, yesterday),
              hasCurrent: energyYesterday !== null,
              signal: 'active energy',
              period: 'yesterday',
            })
          : undefined,
    },
  ];

  // --- Verdict -----------------------------------------------------------------
  const verdict = worse(recovery, sleep);
  let detail: string;
  if (hrvToday && hrvRatio !== null) {
    detail = `HRV ${Math.round(hrvToday.value)} ms · ${baselineSentence(hrvRatio)}`;
  } else if (rhrToday && rhrDelta !== null) {
    detail = `Resting HR ${Math.round(rhrToday.value)} bpm · ${fmtDelta(rhrDelta)} bpm vs your 30-day baseline`;
  } else if (sleepToday) {
    detail = `${fmtSleep(sleepToday.value)} asleep last night`;
  } else if (hasSignal) {
    // Something HAS arrived — steps, active energy, or an HRV reading still
    // short of its 5-day baseline — just nothing that grades into a recovery or
    // sleep verdict yet. Falling through to the link branches here would print
    // "no readings have arrived" while the metrics strip below is simultaneously
    // showing the number that did (00-design-spec §5: the copy must never deny
    // data the screen is displaying).
    detail = 'Readings arriving — building your baseline.';
  } else if (link === 'unsupported') {
    // The state ARC has actually been in the whole time this pipeline has
    // existed. Pointing at the Settings toggle here would be a lie the user
    // could act on and get nothing from: the switch is there, the native module
    // is not, so no amount of vendor syncing into Apple Health can reach ARC.
    detail =
      'Apple Health cannot be read in this build — the HealthKit module rides the next app build. Whatever your watch or ring is syncing into Apple Health is safe there and will land here once it does.';
  } else if (link === 'disconnected') {
    detail = 'Connect Apple Health in Settings to power readiness.';
  } else {
    detail =
      'Apple Health is connected but no readings have arrived. Check Settings → Privacy & Security → Health → ARC — iOS never tells apps whether read access was granted.';
  }

  const readiness: Readiness = {
    level: verdict,
    label: VERDICT_LABEL[verdict],
    detail,
  };

  // --- Metrics strip --------------------------------------------------------------
  const metrics: Metric[] = [
    {
      id: 'sleep',
      label: 'Sleep',
      value: sleepToday ? fmtSleep(sleepToday.value) : '—',
      detail: sleepToday
        ? deepToday
          ? `Deep ${Math.round(deepToday.value)}m`
          : deviceLabel(sleepToday.sourceDevice)
        : 'No data yet',
      level: sleep,
    },
    {
      id: 'hrv',
      label: 'HRV',
      value: hrvToday ? `${Math.round(hrvToday.value)} ms` : '—',
      detail: hrvToday
        ? hrvRatio !== null
          ? baselineSentence(hrvRatio).replace(' your 30-day', '')
          : 'no baseline yet'
        : 'No data yet',
      level: hrvRatio !== null ? hrvLevel(hrvRatio) : 'unknown',
    },
    {
      id: 'rhr',
      label: 'Resting HR',
      value: rhrToday ? `${Math.round(rhrToday.value)} bpm` : '—',
      detail: rhrToday
        ? rhrDelta !== null
          ? `${fmtDelta(rhrDelta)} vs baseline`
          : 'no baseline yet'
        : 'No data yet',
      level: rhrDelta !== null ? rhrLevel(rhrDelta) : 'unknown',
    },
    {
      id: 'steps',
      label: 'Steps',
      value: stepsToday ? fmtInt(stepsToday.value) : '—',
      detail: stepsToday ? 'today' : 'No data yet',
      level: 'unknown',
    },
  ];

  return { readiness, pillars, metrics, hasSignal };
}
